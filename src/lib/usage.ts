import { TrackSource, TrackType, type WebhookEvent } from 'livekit-server-sdk';
import { usageDb } from './supabase';

/**
 * Registro de uso. Duas regras que valem para o arquivo inteiro:
 *
 * 1. Medir nunca pode quebrar o produto. As escritas chamadas de dentro das
 *    rotas do app engolem o erro e seguem — uma sala não deixa de ser criada
 *    porque o Supabase piscou.
 * 2. A exceção é `ingestWebhookEvent`, que propaga: ali o erro precisa virar
 *    HTTP 500 para o LiveKit reenviar o evento. Engolir seria perder a
 *    medição de forma silenciosa, que é o pior dos dois mundos.
 */

/** Formato que a função `usage_ingest` espera. O SQL não conhece protobuf. */
type IngestPayload = {
  id: string;
  event: string;
  at: string;
  room?: { name?: string; sid?: string };
  participant?: {
    identity?: string;
    sid?: string;
    name?: string;
    isHost: boolean;
    disconnectReason?: string;
  };
  track?: { sid: string; kind: 'video' | 'audio'; width?: number; height?: number; mimeType?: string };
  raw: unknown;
};

/**
 * `/api/token` monta a identidade como `host-<uuid>` ou `viewer-<uuid>`, então
 * o papel viaja dentro dela e chega até aqui sem tabela de apoio.
 */
function isHostIdentity(identity: string | undefined): boolean {
  return typeof identity === 'string' && identity.startsWith('host-');
}

export function normalizeWebhookEvent(ev: WebhookEvent): IngestPayload | null {
  if (!ev.id || !ev.event) return null;

  // createdAt é int64 em segundos. Usamos o relógio do evento, e não now(),
  // porque a entrega pode atrasar ou chegar fora de ordem.
  const seconds = Number(ev.createdAt);
  const at = new Date((Number.isFinite(seconds) && seconds > 0 ? seconds : Date.now() / 1000) * 1000);

  // O JSON do protobuf traduz enum para o nome ("CLIENT_INITIATED"); o objeto
  // tipado só tem o número. Para disconnectReason o nome é o que interessa.
  const raw = ev.toJson() as { participant?: { disconnectReason?: string } };

  const payload: IngestPayload = {
    id: ev.id,
    event: ev.event,
    at: at.toISOString(),
    raw,
  };

  if (ev.room) payload.room = { name: ev.room.name, sid: ev.room.sid };

  if (ev.participant) {
    payload.participant = {
      identity: ev.participant.identity,
      sid: ev.participant.sid,
      name: ev.participant.name,
      isHost: isHostIdentity(ev.participant.identity),
      disconnectReason: raw.participant?.disconnectReason,
    };
  }

  if (ev.track) {
    // Só tela. Câmera e microfone não são publicados por este app hoje, mas
    // filtrar aqui evita que uma mudança futura contamine a contagem.
    const isScreen =
      ev.track.source === TrackSource.SCREEN_SHARE ||
      ev.track.source === TrackSource.SCREEN_SHARE_AUDIO;
    if (!isScreen) return payload;

    payload.track = {
      sid: ev.track.sid,
      kind: ev.track.type === TrackType.VIDEO ? 'video' : 'audio',
      width: ev.track.width || undefined,
      height: ev.track.height || undefined,
      mimeType: ev.track.mimeType || undefined,
    };
  }

  return payload;
}

/** Propaga o erro de propósito: o webhook precisa devolver 500 para o retry. */
export async function ingestWebhookEvent(ev: WebhookEvent): Promise<string> {
  // Normaliza antes de olhar a configuração: "ignored" é uma propriedade do
  // evento, não do ambiente, e assim a rota continua exercitando este caminho
  // mesmo com o Supabase desligado.
  const payload = normalizeWebhookEvent(ev);
  if (!payload) return 'ignored';

  const db = usageDb();
  if (!db) return 'disabled';

  const { data, error } = await db.rpc('usage_ingest', { p: payload });
  if (error) throw new Error(`usage_ingest: ${error.message}`);
  return (data as string) ?? 'ok';
}

/**
 * O LiveKit só materializa a sala quando alguém entra, então uma sala criada
 * e abandonada não existiria em lugar nenhum sem esta escrita.
 */
export async function registerRoom(slug: string): Promise<void> {
  const db = usageDb();
  if (!db) return;
  const { error } = await db.rpc('usage_register_room', { p_slug: slug });
  if (error) console.error('[usage] registerRoom falhou:', error.message);
}

/**
 * Distingue "parei de compartilhar" de "fui derrubado pelo próximo". O
 * track_unpublished chega depois e só preenche o ended_at; o motivo mais
 * específico gravado aqui é preservado.
 */
export async function markTakenOver(slug: string, identities: string[]): Promise<void> {
  if (identities.length === 0) return;
  const db = usageDb();
  if (!db) return;
  const { error } = await db.rpc('usage_mark_taken_over', {
    p_slug: slug,
    p_identities: identities,
  });
  if (error) console.error('[usage] markTakenOver falhou:', error.message);
}
