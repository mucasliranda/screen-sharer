-- Controle de uso: salas, conexoes, tempo de uso e telas compartilhadas.
--
-- A fonte da verdade sao os webhooks do LiveKit, nao o cliente: o navegador
-- nao tem como avisar de forma confiavel que a sessao terminou (aba fechada,
-- queda de rede, crash). Sem um "fim" confiavel, toda duracao seria ficcao.
--
-- As rotas do app complementam o que o LiveKit nao sabe: sala criada e nunca
-- usada (o LiveKit so materializa a sala no primeiro join) e o motivo
-- "taken_over" de uma tela derrubada.

-- ---------------------------------------------------------------- tabelas --

create table public.rooms (
  id               uuid primary key default gen_random_uuid(),
  slug             text not null unique,
  created_at       timestamptz not null default now(),
  livekit_sid      text,
  started_at       timestamptz,
  ended_at         timestamptz,
  last_event_at    timestamptz,
  duration_seconds int generated always as (
    case when started_at is not null and ended_at is not null
         then extract(epoch from (ended_at - started_at))::int end
  ) stored
);

comment on table  public.rooms is 'Uma linha por sala criada, mesmo que ninguem entre.';
comment on column public.rooms.created_at is 'POST /api/rooms.';
comment on column public.rooms.started_at is 'Webhook room_started: primeiro participante entrou.';
comment on column public.rooms.ended_at   is 'Webhook room_finished: sala esvaziou.';

create table public.participant_sessions (
  id                uuid primary key default gen_random_uuid(),
  room_id           uuid not null references public.rooms(id) on delete cascade,
  identity          text not null,
  livekit_sid       text,
  display_name      text,
  is_host           boolean not null default false,
  joined_at         timestamptz not null,
  left_at           timestamptz,
  disconnect_reason text,
  duration_seconds  int generated always as (
    case when left_at is not null
         then extract(epoch from (left_at - joined_at))::int end
  ) stored
);

-- Uma entrada = uma linha. Sem visitor_id, a mesma pessoa reconectando conta
-- duas vezes: count(distinct identity) e numero de ENTRADAS, nao de pessoas.
comment on table public.participant_sessions is
  'Uma linha por entrada na sala. Nao equivale a pessoa: sem identidade persistente, reconexao gera nova linha.';

create unique index participant_sessions_open_uniq
  on public.participant_sessions (room_id, identity) where left_at is null;
create index participant_sessions_room_idx   on public.participant_sessions (room_id);
create index participant_sessions_joined_idx on public.participant_sessions (joined_at desc);

create table public.screen_shares (
  id               uuid primary key default gen_random_uuid(),
  room_id          uuid not null references public.rooms(id) on delete cascade,
  session_id       uuid references public.participant_sessions(id) on delete set null,
  track_sid        text not null unique,
  kind             text not null check (kind in ('video','audio')),
  width            int,
  height           int,
  mime_type        text,
  started_at       timestamptz not null,
  ended_at         timestamptz,
  end_reason       text check (end_reason in ('stopped','taken_over','disconnected','stale')),
  duration_seconds int generated always as (
    case when ended_at is not null
         then extract(epoch from (ended_at - started_at))::int end
  ) stored
);

-- kind='audio' e o audio da tela, track separado do video. Conte so 'video'
-- para "quantas telas", senao um compartilhamento com som vira dois.
comment on column public.screen_shares.kind is
  'video = a tela; audio = o audio da tela (track separado). Conte apenas video.';

create index screen_shares_room_idx    on public.screen_shares (room_id);
create index screen_shares_session_idx on public.screen_shares (session_id);
create index screen_shares_started_idx on public.screen_shares (started_at desc);

create table public.webhook_events (
  id           text primary key,
  event        text not null,
  room_name    text,
  payload      jsonb not null,
  event_at     timestamptz not null,
  received_at  timestamptz not null default now(),
  processed_at timestamptz,
  error        text
);

comment on table public.webhook_events is
  'Log bruto. A PK e o id do evento LiveKit: garante idempotencia contra reenvio.';

create index webhook_events_unprocessed_idx
  on public.webhook_events (received_at) where processed_at is null;

-- -------------------------------------------------------------------- RLS --
-- Nenhuma policy, de proposito: so a service_role (server-side) enxerga isto.
-- anon e authenticated batem em RLS e nao leem nada.

alter table public.rooms                enable row level security;
alter table public.participant_sessions enable row level security;
alter table public.screen_shares        enable row level security;
alter table public.webhook_events       enable row level security;

-- -------------------------------------------------------------- auxiliares --

create or replace function public.usage_room_id(p_slug text, p_at timestamptz)
returns uuid language plpgsql security invoker set search_path = '' as $fn$
declare v_id uuid;
begin
  select id into v_id from public.rooms where slug = p_slug;
  if v_id is null then
    -- A sala pode nunca ter passado por POST /api/rooms (slug digitado a mao).
    insert into public.rooms (slug, created_at) values (p_slug, p_at)
    on conflict (slug) do nothing returning id into v_id;
    if v_id is null then
      select id into v_id from public.rooms where slug = p_slug;
    end if;
  end if;
  return v_id;
end $fn$;

create or replace function public.usage_session_id(
  p_room_id uuid, p_identity text, p_at timestamptz, p_participant jsonb
) returns uuid language plpgsql security invoker set search_path = '' as $fn$
declare v_id uuid;
begin
  select id into v_id from public.participant_sessions
   where room_id = p_room_id and identity = p_identity and left_at is null;
  if v_id is null then
    -- track_published pode chegar antes de participant_joined: os webhooks
    -- nao garantem ordem. Criamos a sessao para nao perder o compartilhamento.
    insert into public.participant_sessions
      (room_id, identity, livekit_sid, display_name, is_host, joined_at)
    values (p_room_id, p_identity, p_participant->>'sid', p_participant->>'name',
            coalesce((p_participant->>'isHost')::boolean, false), p_at)
    on conflict do nothing returning id into v_id;
    if v_id is null then
      select id into v_id from public.participant_sessions
       where room_id = p_room_id and identity = p_identity and left_at is null;
    end if;
  end if;
  return v_id;
end $fn$;

-- ---------------------------------------------------------------- ingestao --
--
-- Recebe o evento ja normalizado pela rota (a rota conhece o protobuf; o SQL
-- nao precisa conhecer). Retorna 'ok' | 'duplicate' | 'ignored'.

create or replace function public.usage_ingest(p jsonb)
returns text language plpgsql security invoker set search_path = '' as $fn$
declare
  v_id         text := coalesce(p->>'id', gen_random_uuid()::text);
  v_event      text := p->>'event';
  v_at         timestamptz := (p->>'at')::timestamptz;
  v_slug       text := p->'room'->>'name';
  v_identity   text := p->'participant'->>'identity';
  v_track_sid  text := p->'track'->>'sid';
  v_room_id    uuid;
  v_session_id uuid;
begin
  insert into public.webhook_events (id, event, room_name, payload, event_at)
  values (v_id, v_event, v_slug, coalesce(p->'raw', p), v_at)
  on conflict (id) do nothing;

  -- Reenvio do LiveKit apos timeout: ja processamos, nao contamos de novo.
  if not found then
    return 'duplicate';
  end if;

  if v_slug is null then
    update public.webhook_events set processed_at = now() where id = v_id;
    return 'ignored';
  end if;

  v_room_id := public.usage_room_id(v_slug, v_at);

  case v_event
    when 'room_started' then
      update public.rooms
         set livekit_sid = coalesce(p->'room'->>'sid', livekit_sid),
             started_at  = least(coalesce(started_at, v_at), v_at)
       where id = v_room_id;

    when 'room_finished' then
      update public.rooms
         set ended_at = greatest(coalesce(ended_at, v_at), v_at)
       where id = v_room_id;

      -- Fim de sala e o fecho natural do que ficou aberto: se um cliente
      -- sumiu sem participant_left, e aqui que a duracao para de crescer.
      update public.participant_sessions
         set left_at = v_at,
             disconnect_reason = coalesce(disconnect_reason, 'ROOM_FINISHED')
       where room_id = v_room_id and left_at is null;

      update public.screen_shares
         set ended_at = v_at, end_reason = coalesce(end_reason, 'disconnected')
       where room_id = v_room_id and ended_at is null;

    when 'participant_joined' then
      insert into public.participant_sessions
        (room_id, identity, livekit_sid, display_name, is_host, joined_at)
      values (v_room_id, v_identity, p->'participant'->>'sid',
              p->'participant'->>'name',
              coalesce((p->'participant'->>'isHost')::boolean, false), v_at)
      on conflict do nothing;

    when 'participant_left' then
      update public.participant_sessions
         set left_at = v_at,
             disconnect_reason = coalesce(p->'participant'->>'disconnectReason',
                                          disconnect_reason)
       where room_id = v_room_id and identity = v_identity and left_at is null
      returning id into v_session_id;

      -- Quem cai levando a tela junto nem sempre gera track_unpublished.
      if v_session_id is not null then
        update public.screen_shares
           set ended_at = v_at, end_reason = coalesce(end_reason, 'disconnected')
         where session_id = v_session_id and ended_at is null;
      end if;

    when 'track_published' then
      if v_track_sid is not null then
        v_session_id := public.usage_session_id(v_room_id, v_identity, v_at,
                                                coalesce(p->'participant', '{}'::jsonb));
        insert into public.screen_shares
          (room_id, session_id, track_sid, kind, width, height, mime_type, started_at)
        values (v_room_id, v_session_id, v_track_sid,
                coalesce(p->'track'->>'kind', 'video'),
                nullif((p->'track'->>'width')::int, 0),
                nullif((p->'track'->>'height')::int, 0),
                p->'track'->>'mimeType', v_at)
        on conflict (track_sid) do nothing;
      end if;

    when 'track_unpublished' then
      update public.screen_shares
         set ended_at = v_at, end_reason = coalesce(end_reason, 'stopped')
       where track_sid = v_track_sid and ended_at is null;

    else
      null;
  end case;

  update public.rooms
     set last_event_at = greatest(coalesce(last_event_at, v_at), v_at)
   where id = v_room_id;

  update public.webhook_events set processed_at = now() where id = v_id;
  return 'ok';
end $fn$;

-- --------------------------------------------------------- escritas do app --

create or replace function public.usage_register_room(p_slug text)
returns void language sql security invoker set search_path = '' as $fn$
  insert into public.rooms (slug) values (p_slug) on conflict (slug) do nothing;
$fn$;

-- Chamada por /api/takeover. O track_unpublished chega depois e so preenche
-- ended_at; o coalesce no ingest preserva este motivo, que e mais especifico.
create or replace function public.usage_mark_taken_over(p_slug text, p_identities text[])
returns void language sql security invoker set search_path = '' as $fn$
  update public.screen_shares sh
     set end_reason = 'taken_over'
    from public.participant_sessions s, public.rooms r
   where sh.session_id = s.id
     and s.room_id = r.id
     and r.slug = p_slug
     and s.identity = any(p_identities)
     and sh.ended_at is null;
$fn$;

-- Rede de seguranca para quando o proprio LiveKit morre e nem room_finished
-- chega. Rode manualmente ou agende com pg_cron.
create or replace function public.usage_close_stale(p_hours int default 12)
returns int language plpgsql security invoker set search_path = '' as $fn$
declare v_n int;
begin
  update public.screen_shares
     set ended_at = started_at, end_reason = 'stale'
   where ended_at is null and started_at < now() - make_interval(hours => p_hours);

  update public.participant_sessions
     set left_at = joined_at, disconnect_reason = 'STALE'
   where left_at is null and joined_at < now() - make_interval(hours => p_hours);
  get diagnostics v_n = row_count;
  return v_n;
end $fn$;

revoke execute on function public.usage_ingest(jsonb)              from public;
revoke execute on function public.usage_room_id(text, timestamptz) from public;
revoke execute on function public.usage_session_id(uuid, text, timestamptz, jsonb) from public;
revoke execute on function public.usage_register_room(text)           from public;
revoke execute on function public.usage_mark_taken_over(text, text[]) from public;
revoke execute on function public.usage_close_stale(int)              from public;

grant execute on function public.usage_ingest(jsonb)                  to service_role;
grant execute on function public.usage_register_room(text)            to service_role;
grant execute on function public.usage_mark_taken_over(text, text[])  to service_role;
grant execute on function public.usage_close_stale(int)               to service_role;

-- ------------------------------------------------------------------ views --
-- security_invoker: a view respeita a RLS de quem consulta, entao anon
-- continua sem ver nada mesmo tendo select na view.

-- Uma linha por sala. Os dois LATERAL evitam o fan-out que um join direto de
-- sessoes com telas causaria: as somas seriam multiplicadas uma pela outra.
create view public.v_salas with (security_invoker = true) as
select
  r.slug,
  r.created_at            as criada_em,
  r.started_at            as iniciada_em,
  r.ended_at              as encerrada_em,
  r.duration_seconds      as sala_segundos,
  p.sessoes,
  p.sessoes_abertas,
  p.participante_segundos,
  t.telas,
  t.tela_segundos
from public.rooms r
left join lateral (
  select count(*)::int                                        as sessoes,
         count(*) filter (where left_at is null)::int          as sessoes_abertas,
         coalesce(sum(duration_seconds), 0)::int               as participante_segundos
  from public.participant_sessions where room_id = r.id
) p on true
left join lateral (
  select count(*) filter (where kind = 'video')::int                          as telas,
         coalesce(sum(duration_seconds) filter (where kind = 'video'), 0)::int as tela_segundos
  from public.screen_shares where room_id = r.id
) t on true;

create view public.v_sessoes with (security_invoker = true) as
select
  r.slug,
  s.display_name    as nome,
  s.is_host         as host,
  s.joined_at       as entrou_em,
  s.left_at         as saiu_em,
  s.duration_seconds as segundos,
  s.disconnect_reason as motivo_saida,
  s.identity
from public.participant_sessions s
join public.rooms r on r.id = s.room_id
order by s.joined_at desc;

create view public.v_telas with (security_invoker = true) as
select
  r.slug,
  s.display_name     as compartilhada_por,
  sh.width,
  sh.height,
  sh.mime_type,
  sh.started_at      as iniciou_em,
  sh.ended_at        as terminou_em,
  sh.duration_seconds as segundos,
  sh.end_reason      as motivo_fim
from public.screen_shares sh
join public.rooms r on r.id = sh.room_id
left join public.participant_sessions s on s.id = sh.session_id
where sh.kind = 'video'
order by sh.started_at desc;

-- O dia e o dia civil em Sao Paulo, nao em UTC: uma sala das 22h de sexta
-- pertence a sexta para quem le o relatorio.
create view public.v_uso_diario with (security_invoker = true) as
with dias as (
  select distinct dia from (
    select (created_at at time zone 'America/Sao_Paulo')::date as dia from public.rooms
    union all
    select (joined_at  at time zone 'America/Sao_Paulo')::date from public.participant_sessions
    union all
    select (started_at at time zone 'America/Sao_Paulo')::date from public.screen_shares
  ) u
)
select
  d.dia,
  (select count(*) from public.rooms r
    where (r.created_at at time zone 'America/Sao_Paulo')::date = d.dia)   as salas_criadas,
  (select count(*) from public.rooms r
    where (r.started_at at time zone 'America/Sao_Paulo')::date = d.dia)   as salas_usadas,
  (select count(*) from public.participant_sessions s
    where (s.joined_at at time zone 'America/Sao_Paulo')::date = d.dia)    as sessoes,
  (select coalesce(sum(s.duration_seconds), 0) from public.participant_sessions s
    where (s.joined_at at time zone 'America/Sao_Paulo')::date = d.dia)    as participante_segundos,
  (select count(*) from public.screen_shares sh
    where sh.kind = 'video'
      and (sh.started_at at time zone 'America/Sao_Paulo')::date = d.dia)  as telas,
  (select coalesce(sum(sh.duration_seconds), 0) from public.screen_shares sh
    where sh.kind = 'video'
      and (sh.started_at at time zone 'America/Sao_Paulo')::date = d.dia)  as tela_segundos
from dias d
order by d.dia desc;

revoke select on public.v_salas, public.v_sessoes, public.v_telas, public.v_uso_diario
  from anon, authenticated;
