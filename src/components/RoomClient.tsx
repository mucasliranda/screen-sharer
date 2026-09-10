'use client';

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import {
  Room,
  RoomEvent,
  Track,
  TrackEvent,
  createLocalScreenTracks,
  type LocalTrack,
  type Participant,
} from 'livekit-client';
import { recallHostKey } from '@/lib/hostKeys';
import { postJson } from '@/lib/api';
import ShareTile from './ShareTile';

type Phase = 'form' | 'connecting' | 'live' | 'error';

/**
 * Toda transmissão sai em 1440p a 5fps. Fixo, sem seletor.
 *
 * O navegador NÃO consegue capturar mais pixels do que a tela de origem tem:
 * em um monitor 1080p isto entrega 1080p. Por isso medimos o que realmente
 * saiu (ver `capture`) em vez de assumir que o pedido foi atendido.
 */
const CAPTURE = { width: 2560, height: 1440, frameRate: 5 } as const;

/**
 * Bitrate derivado do preset h720fps5 do LiveKit (0,92 Mpx a 800 kbps, ou
 * ~0,87 Mbps por megapixel em conteúdo de tela a 5fps). 1440p tem 3,69 Mpx,
 * o que dá ~3,2 Mbps — arredondado para 3.
 *
 * Custo: ~1,35 GB por espectador-hora.
 */
const ENCODING = { maxBitrate: 3_000_000, maxFramerate: CAPTURE.frameRate } as const;

type CaptureInfo = { width: number; height: number; frameRate: number };

type Share = {
  key: string;
  identity: string;
  name: string;
  isLocal: boolean;
  track: Track;
};

/** Deriva o estado visível a partir da Room, em vez de espelhar em useState. */
function collectShares(room: Room): Share[] {
  const shares: Share[] = [];
  const everyone: Participant[] = [room.localParticipant, ...room.remoteParticipants.values()];

  for (const p of everyone) {
    for (const pub of p.trackPublications.values()) {
      if (pub.source !== Track.Source.ScreenShare) continue;
      if (!pub.track) continue;
      shares.push({
        key: p.identity + ':' + pub.trackSid,
        identity: p.identity,
        name: p.name || 'Anônimo',
        isLocal: p.isLocal,
        track: pub.track,
      });
    }
  }
  return shares;
}

function collectShareAudio(room: Room): Track[] {
  const out: Track[] = [];
  for (const p of room.remoteParticipants.values()) {
    for (const pub of p.trackPublications.values()) {
      if (pub.source === Track.Source.ScreenShareAudio && pub.track) out.push(pub.track);
    }
  }
  return out;
}

export default function RoomClient({ slug }: { slug: string }) {
  const [phase, setPhase] = useState<Phase>('form');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isHost, setIsHost] = useState(false);
  const [canPublish, setCanPublish] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [capture, setCapture] = useState<CaptureInfo | null>(null);
  const [takenOver, setTakenOver] = useState(false);
  // Padrão oculto: mostrar a própria captura de volta na tela capturada é o
  // que produz o espelho infinito.
  const [showSelf, setShowSelf] = useState(false);
  const [audioBlocked, setAudioBlocked] = useState(false);
  const [copied, setCopied] = useState(false);

  const roomRef = useRef<Room | null>(null);
  const hostKeyRef = useRef<string | null>(null);
  const [, bump] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    hostKeyRef.current = recallHostKey(slug);
    setIsHost(Boolean(hostKeyRef.current));
  }, [slug]);

  // Desconecta ao sair da página.
  useEffect(() => {
    return () => {
      roomRef.current?.disconnect();
      roomRef.current = null;
    };
  }, []);

  const stopShare = useCallback(async () => {
    const room = roomRef.current;
    if (!room) return;
    for (const pub of room.localParticipant.trackPublications.values()) {
      const isScreen =
        pub.source === Track.Source.ScreenShare || pub.source === Track.Source.ScreenShareAudio;
      if (isScreen && pub.track) {
        await room.localParticipant.unpublishTrack(pub.track, true);
      }
    }
    setSharing(false);
    setCapture(null);
    setShowSelf(false);
    bump();
  }, []);

  const join = useCallback(async () => {
    setPhase('connecting');
    setError(null);
    try {
      const data = await postJson<{ token: string; url: string; isHost: boolean }>('/api/token', {
        slug,
        name,
        hostKey: hostKeyRef.current,
      });

      const room = new Room({ adaptiveStream: true, dynacast: true });

      // Qualquer um destes eventos muda o que a tela precisa mostrar.
      const redraw = () => bump();
      room
        .on(RoomEvent.TrackSubscribed, redraw)
        .on(RoomEvent.TrackUnsubscribed, redraw)
        .on(RoomEvent.LocalTrackPublished, redraw)
        .on(RoomEvent.LocalTrackUnpublished, redraw)
        .on(RoomEvent.ParticipantConnected, redraw)
        .on(RoomEvent.ParticipantDisconnected, redraw)
        .on(RoomEvent.ConnectionStateChanged, redraw)
        .on(RoomEvent.TrackMuted, (pub, participant) => {
          // É assim que descobrimos que perdemos o bastão: /api/takeover
          // silencia nossa tela quando outra pessoa começa a compartilhar.
          if (!participant.isLocal) return;
          if (pub.source !== Track.Source.ScreenShare) return;
          setTakenOver(true);
          void stopShare();
        })
        .on(RoomEvent.AudioPlaybackStatusChanged, () => {
          setAudioBlocked(!room.canPlaybackAudio);
          bump();
        })
        .on(RoomEvent.ParticipantPermissionsChanged, () => {
          setCanPublish(room.localParticipant.permissions?.canPublish ?? false);
          bump();
        })
        .on(RoomEvent.Disconnected, () => {
          setPhase('error');
          setError('Você foi desconectado da sala.');
        });

      await room.connect(data.url, data.token);

      roomRef.current = room;
      setIsHost(Boolean(data.isHost));
      setCanPublish(room.localParticipant.permissions?.canPublish ?? Boolean(data.isHost));
      setAudioBlocked(!room.canPlaybackAudio);
      setPhase('live');
    } catch (err) {
      const raw = (err as Error).message;
      // O SDK devolve mensagens cruas em inglês; a falha mais comum de longe
      // é o servidor de mídia não estar no ar.
      const unreachable = /signal connection|failed to fetch|websocket|refused|timeout/i.test(raw);
      setError(
        unreachable
          ? 'Não foi possível conectar ao servidor de mídia. Confirme que o LiveKit está rodando (docker compose up -d) e que NEXT_PUBLIC_LIVEKIT_URL aponta para ele.'
          : raw,
      );
      setPhase('error');
    }
  }, [slug, name, stopShare]);

  const startShare = useCallback(async () => {
    const room = roomRef.current;
    if (!room) return;
    setError(null);
    setTakenOver(false);

    try {
      const tracks: LocalTrack[] = await createLocalScreenTracks({
        audio: true,
        video: true,
        resolution: CAPTURE,
        // Diz ao encoder que é conteúdo estático com detalhe fino. Sem isso
        // ele borra o texto para preservar taxa de quadros.
        contentHint: 'text',
      });

      for (const track of tracks) {
        const isVideo = track.kind === Track.Kind.Video;
        await room.localParticipant.publishTrack(track, {
          source: isVideo ? Track.Source.ScreenShare : Track.Source.ScreenShareAudio,
          stream: 'screen',
          screenShareEncoding: ENCODING,
          videoCodec: 'vp9',
          // L1T3: UMA camada espacial (a resolução nunca é reduzida) com três
          // camadas temporais. Quem estiver em rede ruim recebe menos quadros
          // — 5, 2,5 ou 1,25fps — mas sempre em 1440p, que é o requisito.
          // L2/L3 aqui reintroduziriam downscale e quebrariam essa garantia.
          scalabilityMode: 'L1T3',
          simulcast: false,
          degradationPreference: 'maintain-resolution',
          // Fallback H.264 para quem não decodifica VP9.
          backupCodec: true,
        });

        if (isVideo) {
          // O que foi pedido nem sempre é o que a tela entrega: registramos
          // o resultado real para o host saber se caiu abaixo de 1440p.
          const s = track.mediaStreamTrack.getSettings();
          setCapture({
            width: s.width ?? 0,
            height: s.height ?? 0,
            frameRate: Math.round(s.frameRate ?? 0),
          });

          // O usuário pode parar pelo próprio controle do navegador.
          track.once(TrackEvent.Ended, () => {
            void stopShare();
          });
        }
      }

      setSharing(true);
      bump();

      // Só agora, com a nossa tela já no ar, derrubamos a anterior — assim
      // não existe intervalo em que a sala fique sem imagem nenhuma.
      await postJson('/api/takeover', { slug, identity: room.localParticipant.identity });
    } catch (err) {
      const msg = (err as Error).message;
      // Cancelar o seletor de tela não é erro.
      if (!/permission denied|dismissed|aborted/i.test(msg)) setError(msg);
    }
  }, [slug, stopShare]);

  const copyLink = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('Não consegui copiar. Copie o link da barra de endereços.');
    }
  }, []);

  // ---------- entrada ----------
  if (phase !== 'live') {
    return (
      <main className="center">
        <div className="card">
          <h1>{isHost ? 'Sua transmissão' : 'Entrar na transmissão'}</h1>
          <p className="sub">
            {isHost
              ? 'Escolha como quer aparecer para os espectadores.'
              : 'Informe um nome para entrar. Não é preciso criar conta.'}
          </p>

          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              if (phase !== 'connecting') void join();
            }}
          >
            {error && <div className="error">{error}</div>}
            <input
              autoFocus
              value={name}
              maxLength={32}
              placeholder="Seu nome"
              onChange={(e) => setName(e.target.value)}
            />
            <button className="primary" type="submit" disabled={phase === 'connecting'}>
              {phase === 'connecting' ? 'Conectando…' : 'Entrar'}
            </button>
            <p className="hint">Sala: {slug}</p>
          </form>
        </div>
      </main>
    );
  }

  // ---------- sala ao vivo ----------
  const room = roomRef.current;
  if (!room) return null;

  const shares = collectShares(room);
  const shareAudio = collectShareAudio(room);
  const viewers = [...room.remoteParticipants.values()];

  // O pedido de 1440p é um teto, não uma garantia: um monitor 1080p entrega 1080p.
  const belowTarget = capture !== null && capture.height < CAPTURE.height;

  const presenters = new Set(shares.map((s) => s.identity));

  return (
    <div className="room">
      <header className="topbar">
        <span className="badge">
          <span className={shares.length > 0 ? 'dot live' : 'dot'} />
          {shares.length > 0 ? 'Ao vivo' : 'Aguardando'}
        </span>
        <span className="badge">{viewers.length + 1} na sala</span>
        <div className="spacer" />

        {audioBlocked && <button onClick={() => void room.startAudio()}>Ativar áudio</button>}

        {canPublish && !sharing && (
          <button className="primary" onClick={() => void startShare()}>
            Compartilhar tela
          </button>
        )}

        {canPublish && sharing && (
          <>
            {capture && (
              <span className={belowTarget ? 'badge warn' : 'badge'}>
                {capture.width}×{capture.height} · {capture.frameRate}fps
                {belowTarget && ' — sua tela não chega a 1440p'}
              </span>
            )}
            <button onClick={() => setShowSelf((v) => !v)}>
              {showSelf ? 'Ocultar minha tela' : 'Ver minha tela'}
            </button>
            <button className="danger" onClick={() => void stopShare()}>
              Parar de compartilhar
            </button>
          </>
        )}

        <button onClick={() => void copyLink()}>{copied ? 'Copiado!' : 'Copiar link'}</button>
      </header>

      {error && (
        <div style={{ padding: '10px 16px' }}>
          <div className="error">{error}</div>
        </div>
      )}

      {takenOver && (
        <div style={{ padding: '10px 16px' }}>
          <div className="notice">
            Outra pessoa assumiu a tela, então sua transmissão foi encerrada. Clique em
            “Compartilhar tela” para retomar.
            <button onClick={() => setTakenOver(false)}>Ok</button>
          </div>
        </div>
      )}

      <main className={shares.length > 1 ? 'stage multi' : 'stage'}>
        {shares.length === 0 ? (
          <div className="empty">
            Ninguém está compartilhando a tela. Qualquer pessoa na sala pode começar.
          </div>
        ) : (
          shares.map((s) => (
            <ShareTile
              key={s.key}
              track={s.track}
              label={s.isLocal ? s.name + ' (você)' : s.name}
              concealed={s.isLocal && !showSelf}
            />
          ))
        )}
      </main>

      {/* Áudio da tela compartilhada, sem UI própria. */}
      {shareAudio.map((t, i) => (
        <ShareTile key={'audio-' + i} track={t} audioOnly />
      ))}

      <footer className="people">
        <span className="hint" style={{ marginRight: 4 }}>
          Na sala:
        </span>
        {[room.localParticipant, ...viewers].map((p) => (
          <span className="person" key={p.identity}>
            {(p.name || 'Anônimo') + (p.isLocal ? ' (você)' : '')}
            {presenters.has(p.identity) && <span className="tag">compartilhando</span>}
          </span>
        ))}
      </footer>
    </div>
  );
}
