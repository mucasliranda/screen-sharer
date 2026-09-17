/**
 * Contrato entre a view da sala e os transportes.
 *
 * `RoomView` só conhece este tipo — nunca importa nada do LiveKit nem do
 * WebRTC cru. Cada transporte é um hook que devolve esta forma.
 */

/**
 * Liga uma mídia a um elemento e devolve a própria função de desligar.
 *
 * É uma closure, e não um `MediaStream`, porque o LiveKit precisa de
 * `track.attach(el)`: é assim que o adaptiveStream observa o tamanho e a
 * visibilidade do elemento, e é onde mora o retry de autoplay do SDK.
 * Passar o stream cru produziria imagem e desligaria essas duas coisas em
 * silêncio.
 */
export type AttachFn = (el: HTMLMediaElement) => () => void;

export type ShareStatus = 'connecting' | 'live' | 'failed';

export type Share = {
  /** Estável entre renders; usado como key do React. */
  key: string;
  peerId: string;
  name: string;
  isLocal: boolean;
  attach: AttachFn;
  /** No LiveKit é sempre 'live' — o SFU já entregou ou não há tile. */
  status: ShareStatus;
  /** Motivo legível quando status === 'failed'. */
  failureReason?: string;
  /** P2P entrega vídeo e áudio no mesmo stream, então não silencia. */
  muted: boolean;
};

export type Person = {
  peerId: string;
  name: string;
  isLocal: boolean;
  presenting: boolean;
  /** P2P: este par não conseguiu conectar comigo. */
  unreachable?: boolean;
};

export type CaptureInfo = { width: number; height: number; frameRate: number };

export type Phase = 'form' | 'connecting' | 'live' | 'error';

export type RoomTransport = {
  phase: Phase;
  error: string | null;
  /** Avisos que não impedem o uso (sem TURN, sala grande, sinalização caiu). */
  notice: string | null;

  isHost: boolean;
  canPublish: boolean;
  sharing: boolean;
  capture: CaptureInfo | null;
  takenOver: boolean;
  audioBlocked: boolean;

  shares: Share[];
  /** Só o LiveKit usa: áudio de tela chega em track separado. P2P devolve []. */
  shareAudio: AttachFn[];
  people: Person[];

  join: (name: string) => Promise<void>;
  startShare: () => Promise<void>;
  stopShare: () => Promise<void>;
  unblockAudio: () => void;
  ackTakenOver: () => void;
};
