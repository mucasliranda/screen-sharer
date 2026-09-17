'use client';

import { useEffect, useRef } from 'react';
import type { AttachFn, ShareStatus } from '@/lib/transport/types';

export default function ShareTile({
  attach,
  label,
  audioOnly = false,
  concealed = false,
  status = 'live',
  failureReason,
  muted = true,
}: {
  /** Liga a mídia ao elemento e devolve o desligar. Ver AttachFn. */
  attach: AttachFn;
  label?: string;
  audioOnly?: boolean;
  /**
   * Só para a própria tela: esconde a prévia local. Não afeta ninguém — os
   * outros participantes continuam recebendo a transmissão normalmente.
   */
  concealed?: boolean;
  status?: ShareStatus;
  failureReason?: string;
  /**
   * No LiveKit o áudio de tela vem em track separado, então o vídeo é mudo.
   * No P2P vídeo e áudio chegam no mesmo stream e este precisa ser false.
   */
  muted?: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);

  const inert = concealed || status !== 'live';

  useEffect(() => {
    // Quando oculto não montamos o <video>: se ele existisse, estaria exibindo
    // a própria captura, que seria recapturada, e assim por diante — o espelho
    // infinito. Borrar não resolveria, só deixaria a recursão embaçada e ainda
    // faria o encoder ver movimento constante numa transmissão de 3fps.
    if (inert) return;

    const el = audioOnly ? audioRef.current : videoRef.current;
    if (!el) return;
    return attach(el);
  }, [attach, audioOnly, inert]);

  if (audioOnly) {
    return <audio ref={audioRef} autoPlay style={{ display: 'none' }} />;
  }

  if (concealed) {
    return (
      <div className="tile concealed">
        <div className="concealed-blur" />
        <div className="concealed-msg">
          <strong>Sua tela está sendo transmitida</strong>
          <span>
            A prévia está oculta aqui para não criar o efeito de espelho infinito. Quem está
            assistindo vê sua tela normalmente.
          </span>
        </div>
        {label && <span className="label">{label}</span>}
      </div>
    );
  }

  // Sem isso o espectador olharia para um retângulo preto sem saber se o
  // problema é a rede dele, a do apresentador, ou se ainda vai carregar.
  if (status !== 'live') {
    return (
      <div className="tile concealed">
        <div className="concealed-blur" />
        <div className="concealed-msg">
          <strong>
            {status === 'connecting'
              ? `Conectando à tela de ${label ?? 'quem está compartilhando'}…`
              : 'Não foi possível conectar'}
          </strong>
          {status === 'failed' && <span>{failureReason ?? 'A conexão direta falhou.'}</span>}
        </div>
        {label && <span className="label">{label}</span>}
      </div>
    );
  }

  return (
    <div className="tile">
      <video ref={videoRef} autoPlay playsInline muted={muted} />
      {label && <span className="label">{label}</span>}
    </div>
  );
}
