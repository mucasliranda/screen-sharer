'use client';

import { createClient, type RealtimeChannel, type SupabaseClient } from '@supabase/supabase-js';
import { P2P } from '@/config';
import type { BatonEntry } from './baton';

/**
 * Canal de sinalização sobre o Supabase Realtime.
 *
 * Duas responsabilidades, deliberadamente separadas na cabeça de quem lê:
 *
 *  - PRESENCE é a verdade. É um CRDT sincronizado pelo servidor: todo cliente
 *    recebe o mesmo mapa completo. É daí que saem a lista de participantes e
 *    o dono do bastão.
 *  - BROADCAST é transporte de mensagens ponto a ponto (offer/answer/ice).
 *    É at-most-once: pode perder. Nada que precise ser durável mora aqui.
 */

export type Sig =
  | { t: 'hello'; from: string }
  | { t: 'offer'; from: string; to: string; sdp: RTCSessionDescriptionInit }
  | { t: 'answer'; from: string; to: string; sdp: RTCSessionDescriptionInit }
  | { t: 'ice'; from: string; to: string; candidates: RTCIceCandidateInit[] }
  | { t: 'bye'; from: string };

export type PresenceMeta = {
  peerId: string;
  name: string;
  isHost: boolean;
  joinedAt: number;
  claim: { n: number; at: number } | null;
  sharing: boolean;
};

export type SignalingHandlers = {
  onSig: (msg: Sig) => void;
  onPresence: (entries: PresenceMeta[]) => void;
  onStatus: (status: 'online' | 'offline') => void;
};

let cachedClient: SupabaseClient | null = null;
let cachedKey = '';

/** Memoizado por url+key: criar dois clientes abriria dois websockets. */
function browserClient(url: string, key: string): SupabaseClient {
  const id = url + '|' + key;
  if (cachedClient && cachedKey === id) return cachedClient;
  cachedClient = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { params: { eventsPerSecond: 20 } },
  });
  cachedKey = id;
  return cachedClient;
}

export type Signaling = {
  send: (msg: Sig) => void;
  queueIce: (to: string, candidate: RTCIceCandidateInit) => void;
  updateMeta: (patch: Partial<PresenceMeta>) => Promise<void>;
  entries: () => PresenceMeta[];
  batonEntries: () => BatonEntry[];
  destroy: () => Promise<void>;
};

export async function openSignaling(opts: {
  url: string;
  key: string;
  slug: string;
  meta: PresenceMeta;
  handlers: SignalingHandlers;
}): Promise<Signaling> {
  const { url, key, slug, handlers } = opts;
  const supabase = browserClient(url, key);
  const topic = `${P2P.channelPrefix}:${slug}`;

  let meta: PresenceMeta = { ...opts.meta };
  let snapshot: PresenceMeta[] = [];
  let destroyed = false;

  const channel: RealtimeChannel = supabase.channel(topic, {
    config: {
      presence: { key: meta.peerId },
      // self:false — não queremos ecoar nossas próprias mensagens de volta.
      broadcast: { self: false, ack: false },
    },
  });

  const readPresence = () => {
    const state = channel.presenceState<PresenceMeta>();
    snapshot = Object.values(state)
      .flat()
      .filter((m): m is PresenceMeta & { presence_ref: string } => Boolean(m && m.peerId));
    handlers.onPresence(snapshot);
  };

  channel
    .on('presence', { event: 'sync' }, readPresence)
    .on('presence', { event: 'join' }, readPresence)
    .on('presence', { event: 'leave' }, readPresence)
    .on('broadcast', { event: 'sig' }, ({ payload }) => {
      const msg = payload as Sig;
      if (!msg || typeof msg.t !== 'string') return;
      // Broadcast não tem roteamento por destinatário: todo mundo recebe
      // tudo e descarta o que não é para si.
      if ('to' in msg && msg.to !== meta.peerId) return;
      if (msg.from === meta.peerId) return;
      handlers.onSig(msg);
    });

  await new Promise<void>((resolve) => {
    channel.subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        handlers.onStatus('online');
        void channel.track(meta).then(() => resolve());
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        // Streams já estabelecidos continuam: a mídia não passa pelo Supabase.
        // O que para é a entrada de novos espectadores.
        handlers.onStatus('offline');
        resolve();
      }
    });
  });

  const send = (msg: Sig) => {
    if (destroyed) return;
    void channel.send({ type: 'broadcast', event: 'sig', payload: msg });
  };

  // Trickle ICE numa máquina com várias interfaces emite dezenas de
  // candidatos em rajada, vezes N espectadores. Sem lote isso bate no limite
  // de mensagens do Realtime, e a perda silenciosa parece problema de NAT.
  const pending = new Map<string, RTCIceCandidateInit[]>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const flushIce = (to: string) => {
    timers.delete(to);
    const candidates = pending.get(to);
    pending.delete(to);
    if (!candidates || candidates.length === 0) return;
    send({ t: 'ice', from: meta.peerId, to, candidates });
  };

  const queueIce = (to: string, candidate: RTCIceCandidateInit) => {
    const list = pending.get(to) ?? [];
    list.push(candidate);
    pending.set(to, list);
    if (!timers.has(to)) {
      timers.set(to, setTimeout(() => flushIce(to), P2P.iceBatchMs));
    }
  };

  const updateMeta = async (patch: Partial<PresenceMeta>) => {
    if (destroyed) return;
    meta = { ...meta, ...patch };
    await channel.track(meta);
  };

  const destroy = async () => {
    if (destroyed) return;
    destroyed = true;
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    pending.clear();
    try {
      send({ t: 'bye', from: meta.peerId });
      await channel.untrack();
    } catch {
      // Saindo de qualquer jeito.
    }
    await supabase.removeChannel(channel);
  };

  return {
    send,
    queueIce,
    updateMeta,
    entries: () => snapshot,
    batonEntries: () =>
      snapshot.map((m) => ({ peerId: m.peerId, claim: m.claim, sharing: m.sharing })),
    destroy,
  };
}
