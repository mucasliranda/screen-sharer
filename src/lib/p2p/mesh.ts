'use client';

import { P2P } from '@/config';
import { applySendPolicy, buildSendEncodings, preferredVideoCodecs } from './encoding';
import type { Sig } from './signaling';

/**
 * Malha de RTCPeerConnection, sem React.
 *
 * Decisão que elimina uma classe inteira de bugs: o APRESENTADOR É SEMPRE O
 * OFERTANTE, e cada PeerConnection vive exatamente o tempo de uma
 * transmissão. Quando o bastão troca ou a tela para, tudo é fechado e
 * recriado. Não há renegociação, não há onnegotiationneeded, não há glare
 * nem rollback — o preço é ~200ms de reconexão numa troca de bastão, que
 * acontece duas vezes por reunião.
 */

export type PeerState = 'connecting' | 'live' | 'failed';

export type MeshEvents = {
  onPeerState: (peerId: string, state: PeerState, reason?: string) => void;
  onRemoteStream: (peerId: string, stream: MediaStream | null) => void;
};

export type Mesh = {
  /** Apresentador: garante uma conexão com este espectador. Idempotente. */
  ensurePeer: (peerId: string) => void;
  handleSignal: (msg: Sig) => void;
  /** Define o que publicamos. `null` encerra todas as conexões. */
  setStream: (stream: MediaStream | null) => void;
  closePeer: (peerId: string) => void;
  closeAll: () => void;
  peerIds: () => string[];
};

type Entry = {
  pc: RTCPeerConnection;
  role: 'publisher' | 'viewer';
  /** Candidatos que chegaram antes do setRemoteDescription. */
  pendingIce: RTCIceCandidateInit[];
  watchdog: ReturnType<typeof setTimeout> | null;
  restarted: boolean;
};

export function createMesh(opts: {
  selfId: string;
  iceServers: RTCIceServer[];
  hasTurn: boolean;
  send: (msg: Sig) => void;
  queueIce: (to: string, candidate: RTCIceCandidateInit) => void;
  events: MeshEvents;
}): Mesh {
  const { selfId, iceServers, hasTurn, send, queueIce, events } = opts;
  const peers = new Map<string, Entry>();
  let stream: MediaStream | null = null;

  const failureReason = () =>
    hasTurn
      ? 'A conexão falhou mesmo com o servidor de retransmissão. Verifique se o TURN está acessível.'
      : 'Sua rede bloqueia conexões diretas e não há servidor TURN configurado. Tente outra rede — 4G do celular costuma funcionar.';

  function disarm(entry: Entry) {
    if (entry.watchdog !== null) {
      clearTimeout(entry.watchdog);
      entry.watchdog = null;
    }
  }

  function teardown(peerId: string) {
    const entry = peers.get(peerId);
    if (!entry) return;
    disarm(entry);
    entry.pc.onicecandidate = null;
    entry.pc.onconnectionstatechange = null;
    entry.pc.ontrack = null;
    try {
      entry.pc.close();
    } catch {
      // Fechar duas vezes é no-op; só não queremos que exploda no StrictMode.
    }
    peers.delete(peerId);
  }

  function newConnection(peerId: string, role: Entry['role']): Entry {
    const pc = new RTCPeerConnection({ iceServers, bundlePolicy: 'max-bundle' });

    const entry: Entry = { pc, role, pendingIce: [], watchdog: null, restarted: false };
    peers.set(peerId, entry);

    pc.onicecandidate = (ev) => {
      if (ev.candidate) queueIce(peerId, ev.candidate.toJSON());
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      if (state === 'connected') {
        disarm(entry);
        events.onPeerState(peerId, 'live');
        return;
      }
      if (state === 'failed') {
        // Uma tentativa de recuperação, e só. O apresentador é sempre o
        // ofertante, então reiniciar o ICE aqui não corre risco de glare.
        if (role === 'publisher' && !entry.restarted && stream) {
          entry.restarted = true;
          void renegotiate(peerId, entry, true);
          return;
        }
        disarm(entry);
        events.onPeerState(peerId, 'failed', failureReason());
      } else if (state === 'closed') {
        events.onRemoteStream(peerId, null);
      }
    };

    if (role === 'viewer') {
      pc.ontrack = (ev) => {
        events.onRemoteStream(peerId, ev.streams[0] ?? null);
      };
    }

    entry.watchdog = setTimeout(() => {
      if (pc.connectionState !== 'connected') {
        events.onPeerState(peerId, 'failed', failureReason());
      }
    }, P2P.connectTimeoutMs);

    events.onPeerState(peerId, 'connecting');
    return entry;
  }

  async function renegotiate(peerId: string, entry: Entry, iceRestart: boolean) {
    try {
      const offer = await entry.pc.createOffer({ iceRestart });
      await entry.pc.setLocalDescription(offer);

      // Depois do setLocalDescription: só aí os senders existem com params.
      for (const sender of entry.pc.getSenders()) {
        if (sender.track?.kind === 'video') await applySendPolicy(sender);
      }

      send({ t: 'offer', from: selfId, to: peerId, sdp: entry.pc.localDescription! });
    } catch (err) {
      events.onPeerState(peerId, 'failed', (err as Error).message);
    }
  }

  function ensurePeer(peerId: string) {
    if (peerId === selfId || !stream) return;

    const existing = peers.get(peerId);
    // Idempotente: sem isto, presence `join` e `hello` criariam dois PCs para
    // o mesmo espectador e um deles vazaria em cada troca de bastão.
    if (existing && existing.pc.connectionState !== 'closed') return;
    if (existing) teardown(peerId);

    const entry = newConnection(peerId, 'publisher');

    const video = stream.getVideoTracks()[0];
    const audio = stream.getAudioTracks()[0];

    if (video) {
      const transceiver = entry.pc.addTransceiver(video, {
        direction: 'sendonly',
        // Mesmo stream para vídeo e áudio: o espectador recebe um MediaStream
        // só e toca os dois no mesmo <video>.
        streams: [stream],
        sendEncodings: buildSendEncodings(),
      });

      // Precisa vir ANTES do createOffer.
      const codecs = preferredVideoCodecs();
      if (codecs) {
        try {
          transceiver.setCodecPreferences(codecs);
        } catch {
          // Navegador sem suporte negocia na ordem padrão. Não é fatal.
        }
      }
    }

    if (audio) {
      entry.pc.addTransceiver(audio, { direction: 'sendonly', streams: [stream] });
    }

    void renegotiate(peerId, entry, false);
  }

  async function flushIce(peerId: string, entry: Entry) {
    const queued = entry.pendingIce;
    entry.pendingIce = [];
    for (const candidate of queued) {
      try {
        await entry.pc.addIceCandidate(candidate);
      } catch {
        // Candidato obsoleto depois de um restart. Ignorar é o correto.
      }
    }
  }

  function handleSignal(msg: Sig) {
    void (async () => {
      if (msg.t === 'offer') {
        // Espectador. Um offer novo do mesmo par substitui a conexão antiga.
        let entry = peers.get(msg.from);
        if (entry && entry.role === 'viewer' && entry.pc.signalingState !== 'closed') {
          // Renegociação (ex.: ICE restart) reaproveita a conexão.
        } else {
          if (entry) teardown(msg.from);
          entry = newConnection(msg.from, 'viewer');
        }

        try {
          await entry.pc.setRemoteDescription(msg.sdp);
          // addIceCandidate antes do setRemoteDescription rejeita, e como
          // offer e ICE viajam pelo mesmo broadcast sem ordem garantida, os
          // candidatos ÀS VEZES chegam primeiro. Este flush é o que segura.
          await flushIce(msg.from, entry);
          const answer = await entry.pc.createAnswer();
          await entry.pc.setLocalDescription(answer);
          send({ t: 'answer', from: selfId, to: msg.from, sdp: entry.pc.localDescription! });
        } catch (err) {
          events.onPeerState(msg.from, 'failed', (err as Error).message);
        }
        return;
      }

      if (msg.t === 'answer') {
        const entry = peers.get(msg.from);
        if (!entry) return;
        try {
          await entry.pc.setRemoteDescription(msg.sdp);
          await flushIce(msg.from, entry);
          // Reafirma a política: alguns navegadores reescrevem os parâmetros
          // ao aplicar a resposta.
          for (const sender of entry.pc.getSenders()) {
            if (sender.track?.kind === 'video') await applySendPolicy(sender);
          }
        } catch (err) {
          events.onPeerState(msg.from, 'failed', (err as Error).message);
        }
        return;
      }

      if (msg.t === 'ice') {
        const entry = peers.get(msg.from);
        if (!entry) return;
        if (!entry.pc.remoteDescription) {
          entry.pendingIce.push(...msg.candidates);
          return;
        }
        for (const candidate of msg.candidates) {
          try {
            await entry.pc.addIceCandidate(candidate);
          } catch {
            // idem
          }
        }
        return;
      }

      if (msg.t === 'bye') {
        teardown(msg.from);
        events.onRemoteStream(msg.from, null);
      }
    })();
  }

  function setStream(next: MediaStream | null) {
    stream = next;
    if (next === null) closeAll();
  }

  function closePeer(peerId: string) {
    teardown(peerId);
    events.onRemoteStream(peerId, null);
  }

  function closeAll() {
    for (const peerId of [...peers.keys()]) {
      teardown(peerId);
      events.onRemoteStream(peerId, null);
    }
  }

  return {
    ensurePeer,
    handleSignal,
    setStream,
    closePeer,
    closeAll,
    peerIds: () => [...peers.keys()],
  };
}
