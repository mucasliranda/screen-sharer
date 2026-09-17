'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { recallHostKey } from '@/lib/hostKeys';
import { postJson } from '@/lib/api';
import { P2P } from '@/config';
import type {
  AttachFn,
  CaptureInfo,
  Person,
  Phase,
  RoomTransport,
  Share,
  ShareStatus,
} from '@/lib/transport/types';
import { batonHolder, nextClaimN } from './baton';
import { captureScreen } from './encoding';
import { createMesh, type Mesh } from './mesh';
import { openSignaling, type PresenceMeta, type Signaling } from './signaling';

type SessionResponse = {
  peerId: string;
  displayName: string;
  isHost: boolean;
  ice: RTCIceServer[];
  realtime: { url: string; key: string };
};

type Session = {
  peerId: string;
  displayName: string;
  signaling: Signaling;
  mesh: Mesh;
  stream: MediaStream | null;
};

export function useP2PTransport(slug: string): RoomTransport {
  const [phase, setPhase] = useState<Phase>('form');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [isHost, setIsHost] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [capture, setCapture] = useState<CaptureInfo | null>(null);
  const [takenOver, setTakenOver] = useState(false);
  const [audioBlocked, setAudioBlocked] = useState(false);

  const [presence, setPresence] = useState<PresenceMeta[]>([]);
  const [remote, setRemote] = useState<Map<string, MediaStream>>(new Map());
  const [peerState, setPeerState] = useState<Map<string, { state: ShareStatus; reason?: string }>>(
    new Map(),
  );
  const [signalingOnline, setSignalingOnline] = useState(true);

  const sessionRef = useRef<Session | null>(null);
  const hostKeyRef = useRef<string | null>(null);
  const claimingRef = useRef(false);

  useEffect(() => {
    hostKeyRef.current = recallHostKey(slug);
    setIsHost(Boolean(hostKeyRef.current));
  }, [slug]);

  /** attach precisa ser estável por stream, senão o vídeo pisca a cada render. */
  const attachCache = useRef(new Map<MediaStream, AttachFn>());
  const attachFor = useCallback((stream: MediaStream): AttachFn => {
    const cached = attachCache.current.get(stream);
    if (cached) return cached;
    const fn: AttachFn = (el) => {
      el.srcObject = stream;
      void el.play().catch((err: DOMException) => {
        // Autoplay bloqueado enquanto não houver interação do usuário.
        if (err.name === 'NotAllowedError') setAudioBlocked(true);
      });
      return () => {
        el.srcObject = null;
      };
    };
    attachCache.current.set(stream, fn);
    return fn;
  }, []);

  const releaseCapture = useCallback(() => {
    const session = sessionRef.current;
    if (!session?.stream) return;
    for (const track of session.stream.getTracks()) track.stop();
    session.stream = null;
    session.mesh.setStream(null);
  }, []);

  const stopShare = useCallback(async () => {
    const session = sessionRef.current;
    if (!session) return;
    releaseCapture();
    setSharing(false);
    setCapture(null);
    await session.signaling.updateMeta({ claim: null, sharing: false });
  }, [releaseCapture]);

  // Desconecta ao sair da página. Estrutura espelhada do transporte LiveKit:
  // join() vem de um submit, teardown vive num efeito separado — é o que
  // mantém o StrictMode (que invoca efeitos duas vezes) inofensivo.
  useEffect(() => {
    return () => {
      const session = sessionRef.current;
      sessionRef.current = null;
      if (!session) return;
      if (session.stream) for (const t of session.stream.getTracks()) t.stop();
      session.mesh.closeAll();
      void session.signaling.destroy();
    };
  }, []);

  /**
   * Reage ao presence. Aqui mora a reação ao bastão: todo cliente calcula o
   * mesmo vencedor a partir do mesmo mapa, então não há negociação.
   */
  const onPresence = useCallback(
    (entries: PresenceMeta[]) => {
      setPresence(entries);

      const session = sessionRef.current;
      if (!session) return;

      const holder = batonHolder(
        entries.map((m) => ({ peerId: m.peerId, claim: m.claim, sharing: m.sharing })),
      );
      const iAmHolder = holder === session.peerId;

      if (session.stream && !iAmHolder && !claimingRef.current) {
        // Perdi o bastão: outra pessoa reivindicou depois de mim.
        releaseCapture();
        setSharing(false);
        setCapture(null);
        setTakenOver(true);
        void session.signaling.updateMeta({ claim: null, sharing: false });
        return;
      }

      if (iAmHolder && session.stream) {
        // Abre conexão com quem ainda não tem. ensurePeer é idempotente.
        for (const entry of entries) {
          if (entry.peerId !== session.peerId) session.mesh.ensurePeer(entry.peerId);
        }
        const others = entries.length - 1;
        setNotice(
          others > P2P.softViewerCap
            ? `${others} espectadores em modo P2P — sua conexão de subida é o limite, cada um consome mais 1,5 Mbps.`
            : null,
        );
      } else {
        // Fecha conexões com quem não é mais o apresentador nem está presente.
        const present = new Set(entries.map((e) => e.peerId));
        for (const peerId of session.mesh.peerIds()) {
          if (!present.has(peerId) || (holder !== null && peerId !== holder && !iAmHolder)) {
            session.mesh.closePeer(peerId);
          }
        }
      }
    },
    [releaseCapture],
  );

  const join = useCallback(
    async (name: string) => {
      setPhase('connecting');
      setError(null);
      try {
        const data = await postJson<SessionResponse>('/api/p2p/session', {
          slug,
          name,
          hostKey: hostKeyRef.current,
        });

        const hasTurn = data.ice.some((s) =>
          (Array.isArray(s.urls) ? s.urls : [s.urls]).some((u) => u.startsWith('turn')),
        );

        const mesh = createMesh({
          selfId: data.peerId,
          iceServers: data.ice,
          hasTurn,
          send: (msg) => sessionRef.current?.signaling.send(msg),
          queueIce: (to, candidate) => sessionRef.current?.signaling.queueIce(to, candidate),
          events: {
            onPeerState: (peerId, state, reason) =>
              setPeerState((prev) => new Map(prev).set(peerId, { state, reason })),
            onRemoteStream: (peerId, stream) =>
              setRemote((prev) => {
                const next = new Map(prev);
                if (stream) next.set(peerId, stream);
                else next.delete(peerId);
                return next;
              }),
          },
        });

        const meta: PresenceMeta = {
          peerId: data.peerId,
          name: data.displayName,
          isHost: data.isHost,
          joinedAt: Date.now(),
          claim: null,
          sharing: false,
        };

        const signaling = await openSignaling({
          url: data.realtime.url,
          key: data.realtime.key,
          slug,
          meta,
          handlers: {
            onSig: (msg) => {
              // `hello` é o gatilho confiável: presence pode disparar no
              // apresentador antes de o recém-chegado terminar de assinar, e
              // o offer cairia no vazio.
              if (msg.t === 'hello') {
                sessionRef.current?.mesh.ensurePeer(msg.from);
                return;
              }
              mesh.handleSignal(msg);
            },
            onPresence,
            onStatus: (status) => setSignalingOnline(status === 'online'),
          },
        });

        sessionRef.current = {
          peerId: data.peerId,
          displayName: data.displayName,
          signaling,
          mesh,
          stream: null,
        };

        setIsHost(data.isHost);
        signaling.send({ t: 'hello', from: data.peerId });
        setPhase('live');
      } catch (err) {
        setError((err as Error).message);
        setPhase('error');
      }
    },
    [slug, onPresence],
  );

  const startShare = useCallback(async () => {
    const session = sessionRef.current;
    if (!session) return;
    setError(null);
    setTakenOver(false);

    let stream: MediaStream;
    try {
      stream = await captureScreen();
    } catch (err) {
      const msg = (err as Error).message;
      // Cancelar o seletor de tela não é erro.
      if (!/permission denied|dismissed|aborted/i.test(msg)) setError(msg);
      return;
    }

    // Captura primeiro, reivindica depois, e só desmonta se perder — igual ao
    // modo LiveKit, que publica antes de chamar /api/takeover justamente para
    // a sala nunca ficar sem imagem no intervalo.
    claimingRef.current = true;
    session.stream = stream;
    session.mesh.setStream(stream);

    const video = stream.getVideoTracks()[0];
    if (video) {
      const s = video.getSettings();
      setCapture({
        width: s.width ?? 0,
        height: s.height ?? 0,
        frameRate: Math.round(s.frameRate ?? 0),
      });
      // O usuário pode parar pelo próprio controle do navegador.
      video.onended = () => void stopShare();
    }

    const n = nextClaimN(session.signaling.batonEntries());
    await session.signaling.updateMeta({ claim: { n, at: Date.now() }, sharing: true });
    setSharing(true);

    // Abre com quem já está na sala sem esperar o próximo sync de presence.
    for (const entry of session.signaling.entries()) {
      if (entry.peerId !== session.peerId) session.mesh.ensurePeer(entry.peerId);
    }

    claimingRef.current = false;
  }, [stopShare]);

  const unblockAudio = useCallback(() => {
    setAudioBlocked(false);
    // Recria os attach para o ShareTile remontar e tentar play() de novo,
    // agora com a interação do usuário no histórico da aba.
    attachCache.current = new Map();
    setRemote((prev) => new Map(prev));
  }, []);

  const ackTakenOver = useCallback(() => setTakenOver(false), []);

  // ---------- estado derivado ----------
  const session = sessionRef.current;
  const selfId = session?.peerId ?? '';

  const holder = batonHolder(
    presence.map((m) => ({ peerId: m.peerId, claim: m.claim, sharing: m.sharing })),
  );

  const shares: Share[] = [];

  if (sharing && session?.stream) {
    shares.push({
      key: 'local',
      peerId: selfId,
      name: session.displayName,
      isLocal: true,
      attach: attachFor(session.stream),
      status: 'live',
      muted: true,
    });
  } else if (holder && holder !== selfId) {
    const stream = remote.get(holder);
    const state = peerState.get(holder);
    const name = presence.find((p) => p.peerId === holder)?.name ?? 'Anônimo';

    if (stream && state?.state !== 'failed') {
      shares.push({
        key: `remote:${holder}`,
        peerId: holder,
        name,
        isLocal: false,
        attach: attachFor(stream),
        status: 'live',
        // P2P entrega vídeo e áudio no mesmo stream.
        muted: false,
      });
    } else {
      shares.push({
        key: `pending:${holder}`,
        peerId: holder,
        name,
        isLocal: false,
        attach: () => () => {},
        status: state?.state === 'failed' ? 'failed' : 'connecting',
        failureReason: state?.reason,
        muted: true,
      });
    }
  }

  const people: Person[] = presence.map((m) => ({
    peerId: m.peerId,
    name: m.name,
    isLocal: m.peerId === selfId,
    presenting: m.peerId === holder,
    unreachable: peerState.get(m.peerId)?.state === 'failed',
  }));

  const offlineNotice = signalingOnline
    ? null
    : 'Sinalização offline — quem já está conectado continua vendo, mas novos espectadores não conseguem entrar.';

  return {
    phase,
    error,
    notice: offlineNotice ?? notice,
    isHost,
    // Em P2P todo mundo pode compartilhar: não há token restringindo.
    canPublish: phase === 'live',
    sharing,
    capture,
    takenOver,
    audioBlocked,
    shares,
    shareAudio: [],
    people,
    join,
    startShare,
    stopShare,
    unblockAudio,
    ackTakenOver,
  };
}
