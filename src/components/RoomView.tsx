'use client';

import { useCallback, useState } from 'react';
import { CAPTURE } from '@/config';
import type { RoomTransport } from '@/lib/transport/types';
import ShareTile from './ShareTile';

/**
 * Toda a interface da sala. Não conhece transporte nenhum — recebe um
 * `RoomTransport` e desenha. É o que impede os dois modos de divergirem
 * visualmente com o tempo.
 *
 * O que fica aqui e NÃO no transporte: nome digitado, "copiado!" e a escolha
 * de ver a própria tela. São estados puramente de interface.
 */
export default function RoomView({ slug, t }: { slug: string; t: RoomTransport }) {
  const [name, setName] = useState('');
  const [copied, setCopied] = useState(false);
  // Padrão oculto: mostrar a própria captura de volta na tela capturada é o
  // que produz o espelho infinito.
  const [showSelf, setShowSelf] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);

  const copyLink = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopyError('Não consegui copiar. Copie o link da barra de endereços.');
    }
  }, []);

  // ---------- entrada ----------
  if (t.phase !== 'live') {
    return (
      <main className="center">
        <div className="card">
          <h1>{t.isHost ? 'Sua transmissão' : 'Entrar na transmissão'}</h1>
          <p className="sub">
            {t.isHost
              ? 'Escolha como quer aparecer para os espectadores.'
              : 'Informe um nome para entrar. Não é preciso criar conta.'}
          </p>

          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              if (t.phase !== 'connecting') void t.join(name);
            }}
          >
            {t.error && <div className="error">{t.error}</div>}
            {t.notice && <div className="notice">{t.notice}</div>}
            <input
              autoFocus
              value={name}
              maxLength={32}
              placeholder="Seu nome"
              onChange={(e) => setName(e.target.value)}
            />
            <button className="primary" type="submit" disabled={t.phase === 'connecting'}>
              {t.phase === 'connecting' ? 'Conectando…' : 'Entrar'}
            </button>
            <p className="hint">Sala: {slug}</p>
          </form>
        </div>
      </main>
    );
  }

  // ---------- sala ao vivo ----------
  const live = t.shares.some((s) => s.status !== 'failed');
  const belowTarget = t.capture !== null && t.capture.height < CAPTURE.height;

  return (
    <div className="room">
      <header className="topbar">
        <span className="badge">
          <span className={live ? 'dot live' : 'dot'} />
          {live ? 'Ao vivo' : 'Aguardando'}
        </span>
        <span className="badge">{t.people.length} na sala</span>
        <div className="spacer" />

        {t.audioBlocked && <button onClick={t.unblockAudio}>Ativar áudio</button>}

        {t.canPublish && !t.sharing && (
          <button className="primary" onClick={() => void t.startShare()}>
            Compartilhar tela
          </button>
        )}

        {t.canPublish && t.sharing && (
          <>
            {t.capture && (
              <span className={belowTarget ? 'badge warn' : 'badge'}>
                {t.capture.width}×{t.capture.height} · {t.capture.frameRate}fps
                {belowTarget && ` — sua tela não chega a ${CAPTURE.height}p`}
              </span>
            )}
            <button onClick={() => setShowSelf((v) => !v)}>
              {showSelf ? 'Ocultar minha tela' : 'Ver minha tela'}
            </button>
            <button className="danger" onClick={() => void t.stopShare()}>
              Parar de compartilhar
            </button>
          </>
        )}

        <button onClick={() => void copyLink()}>{copied ? 'Copiado!' : 'Copiar link'}</button>
      </header>

      {(t.error || copyError) && (
        <div style={{ padding: '10px 16px' }}>
          <div className="error">{t.error ?? copyError}</div>
        </div>
      )}

      {t.notice && (
        <div style={{ padding: '10px 16px' }}>
          <div className="notice">{t.notice}</div>
        </div>
      )}

      {t.takenOver && (
        <div style={{ padding: '10px 16px' }}>
          <div className="notice">
            Outra pessoa assumiu a tela, então sua transmissão foi encerrada. Clique em
            “Compartilhar tela” para retomar.
            <button onClick={t.ackTakenOver}>Ok</button>
          </div>
        </div>
      )}

      <main className={t.shares.length > 1 ? 'stage multi' : 'stage'}>
        {t.shares.length === 0 ? (
          <div className="empty">
            Ninguém está compartilhando a tela. Qualquer pessoa na sala pode começar.
          </div>
        ) : (
          t.shares.map((s) => (
            <ShareTile
              key={s.key}
              attach={s.attach}
              label={s.isLocal ? s.name + ' (você)' : s.name}
              concealed={s.isLocal && !showSelf}
              status={s.status}
              failureReason={s.failureReason}
              muted={s.muted}
            />
          ))
        )}
      </main>

      {/* Áudio da tela compartilhada, sem UI própria. Só o LiveKit usa. */}
      {t.shareAudio.map((attach, i) => (
        <ShareTile key={'audio-' + i} attach={attach} audioOnly />
      ))}

      <footer className="people">
        <span className="hint" style={{ marginRight: 4 }}>
          Na sala:
        </span>
        {t.people.map((p) => (
          <span className="person" key={p.peerId}>
            {p.name + (p.isLocal ? ' (você)' : '')}
            {p.presenting && <span className="tag">compartilhando</span>}
            {p.unreachable && <span className="tag warn">sem conexão</span>}
          </span>
        ))}
      </footer>
    </div>
  );
}
