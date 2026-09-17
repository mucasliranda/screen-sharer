'use client';

import dynamic from 'next/dynamic';
import type { Transport } from '@/config';

/**
 * Escolhe o transporte com import dinâmico de verdade.
 *
 * Medido: com import estático dos dois componentes no Server Component, o
 * webpack junta tudo num chunk compartilhado e o navegador baixava os 532 KB
 * do cliente do LiveKit mesmo em modo p2p. `dynamic()` cria um ponto de
 * code-split real, então só o transporte escolhido é buscado.
 *
 * Custo: um waterfall de ~100ms ao abrir a sala, escondido atrás do
 * formulário de nome que o usuário precisa preencher de qualquer jeito.
 */

const loading = () => (
  <main className="center">
    <div className="card">
      <p className="sub" style={{ margin: 0 }}>
        Carregando a sala…
      </p>
    </div>
  </main>
);

const LiveKitRoom = dynamic(() => import('./LiveKitRoom'), { ssr: false, loading });
const P2PRoom = dynamic(() => import('./P2PRoom'), { ssr: false, loading });

export default function RoomSwitch({ slug, transport }: { slug: string; transport: Transport }) {
  return transport === 'p2p' ? <P2PRoom slug={slug} /> : <LiveKitRoom slug={slug} />;
}
