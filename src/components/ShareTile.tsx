'use client';

import { useEffect, useRef } from 'react';
import type { Track } from 'livekit-client';

export default function ShareTile({
  track,
  label,
  audioOnly = false,
  concealed = false,
}: {
  track: Track;
  label?: string;
  audioOnly?: boolean;
  /**
   * Só para a própria tela: esconde a prévia local. Não afeta ninguém — os
   * outros participantes continuam recebendo a transmissão normalmente.
   */
  concealed?: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    // Quando oculto não montamos o <video>: se ele existisse, estaria exibindo
    // a própria captura, que seria recapturada, e assim por diante — o espelho
    // infinito. Borrar não resolveria, só deixaria a recursão embaçada e ainda
    // faria o encoder ver movimento constante numa transmissão de 3fps.
    if (concealed) return;

    const el = audioOnly ? audioRef.current : videoRef.current;
    if (!el) return;
    track.attach(el);
    return () => {
      track.detach(el);
    };
  }, [track, audioOnly, concealed]);

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

  return (
    <div className="tile">
      <video ref={videoRef} autoPlay playsInline muted />
      {label && <span className="label">{label}</span>}
    </div>
  );
}
