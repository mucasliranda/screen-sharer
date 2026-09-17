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
import { CAPTURE, ENCODING } from '@/config';
import type { AttachFn, CaptureInfo, Person, Phase, RoomTransport, Share } from './types';

/**
 * Transporte LiveKit. É o código que morava em RoomClient.tsx, com o mesmo
 * comportamento — só passou a devolver `RoomTransport` em vez de renderizar.
 */
export function useLiveKitTransport(slug: string): RoomTransport {
  const [phase, setPhase] = useState<Phase>('form');
  const [error, setError] = useState<string | null>(null);
  const [isHost, setIsHost] = useState(false);
  const [canPublish, setCanPublish] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [capture, setCapture] = useState<CaptureInfo | null>(null);
  const [takenOver, setTakenOver] = useState(false);
  const [audioBlocked, setAudioBlocked] = useState(false);

  const roomRef = useRef<Room | null>(null);
  const hostKeyRef = useRef<string | null>(null);
  const [, bump] = useReducer((n: number) => n + 1, 0);

  /**
   * `attach` precisa ser referencialmente estável, senão o efeito do
   * ShareTile roda a cada render e o vídeo pisca.
   */
  const attachCache = useRef(new Map<Track, AttachFn>());
  const attachFor = useCallback((track: Track): AttachFn => {
    const cached = attachCache.current.get(track);
    if (cached) return cached;
    const fn: AttachFn = (el) => {
      track.attach(el);
      return () => {
        track.detach(el);
      };
    };
    attachCache.current.set(track, fn);
    return fn;
  }, []);

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
    bump();
  }, []);

  const join = useCallback(
    async (name: string) => {
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
        // é o servidor de mídia não estar acessível.
        const unreachable = /signal connection|failed to fetch|websocket|refused|timeout/i.test(raw);
        setError(
          unreachable
            ? 'Não foi possível conectar ao servidor de mídia. Confirme que NEXT_PUBLIC_LIVEKIT_URL aponta para um servidor no ar.'
            : raw,
        );
        setPhase('error');
      }
    },
    [slug, stopShare],
  );

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
          screenShareEncoding: {
            maxBitrate: ENCODING.maxBitrate,
            maxFramerate: ENCODING.maxFramerate,
          },
          videoCodec: 'vp9',
          scalabilityMode: ENCODING.scalabilityMode,
          simulcast: false,
          degradationPreference: 'maintain-resolution',
          // Fallback H.264 para quem não decodifica VP9.
          backupCodec: true,
        });

        if (isVideo) {
          // O que foi pedido nem sempre é o que a tela entrega: registramos
          // o resultado real para o host saber se caiu abaixo de 1080p.
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

  const unblockAudio = useCallback(() => {
    void roomRef.current?.startAudio();
  }, []);

  const ackTakenOver = useCallback(() => setTakenOver(false), []);

  // Deriva o estado visível a partir da Room a cada render, em vez de
  // espelhar em useState. NÃO memoizar: a Room é um objeto mutável que o SDK
  // altera no lugar, então nenhuma lista de dependências reflete as mudanças.
  // Quem força o recálculo é o `bump()` disparado pelos eventos.
  const room = roomRef.current;
  const shares: Share[] = [];
  const shareAudio: AttachFn[] = [];
  const people: Person[] = [];

  if (room && phase === 'live') {
    const everyone: Participant[] = [room.localParticipant, ...room.remoteParticipants.values()];

    for (const p of everyone) {
      for (const pub of p.trackPublications.values()) {
        if (!pub.track) continue;
        if (pub.source === Track.Source.ScreenShare) {
          shares.push({
            key: p.identity + ':' + pub.trackSid,
            peerId: p.identity,
            name: p.name || 'Anônimo',
            isLocal: p.isLocal,
            attach: attachFor(pub.track),
            status: 'live',
            // O áudio de tela chega em track próprio no LiveKit.
            muted: true,
          });
        } else if (pub.source === Track.Source.ScreenShareAudio && !p.isLocal) {
          shareAudio.push(attachFor(pub.track));
        }
      }
    }

    const presenting = new Set(shares.map((s) => s.peerId));
    for (const p of everyone) {
      people.push({
        peerId: p.identity,
        name: p.name || 'Anônimo',
        isLocal: p.isLocal,
        presenting: presenting.has(p.identity),
      });
    }
  }

  return {
    phase,
    error,
    notice: null,
    isHost,
    canPublish,
    sharing,
    capture,
    takenOver,
    audioBlocked,
    shares,
    shareAudio,
    people,
    join,
    startShare,
    stopShare,
    unblockAudio,
    ackTakenOver,
  };
}
