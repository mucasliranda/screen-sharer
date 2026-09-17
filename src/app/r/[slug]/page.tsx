import { currentTransport } from '@/config';
import RoomSwitch from '@/components/RoomSwitch';

/**
 * A escolha do transporte acontece aqui, no servidor.
 *
 * Fazer isso num Server Component em vez de uma flag NEXT_PUBLIC_ tem dois
 * ganhos: o valor não vira segunda fonte de verdade embutida no bundle, e o
 * navegador só baixa o chunk do transporte escolhido — o cliente do LiveKit
 * sozinho passa de 1 MB.
 */
export default async function RoomPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { transport, error } = currentTransport();

  // Cair para o LiveKit em silêncio gastaria justamente a cota que o modo p2p
  // existe para poupar. Então quando a configuração está errada, a sala não
  // abre: ela diz o que está errado.
  if (error) {
    return (
      <main className="center">
        <div className="card">
          <h1>Configuração inválida</h1>
          <p className="sub">A sala não foi aberta para você não transmitir no modo errado.</p>
          <div className="error">{error}</div>
        </div>
      </main>
    );
  }

  return <RoomSwitch slug={slug} transport={transport} />;
}
