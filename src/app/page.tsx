'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { rememberHostKey } from '@/lib/hostKeys';
import { postJson } from '@/lib/api';

export default function Home() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function createRoom() {
    setBusy(true);
    setError(null);
    try {
      const data = await postJson<{ slug: string; hostKey: string }>('/api/rooms');
      rememberHostKey(data.slug, data.hostKey);
      router.push(`/r/${data.slug}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <main className="center">
      <div className="card">
        <h1>Compartilhar tela</h1>
        <p className="sub">
          Crie uma sala, envie o link e as pessoas assistem ao vivo. Elas só informam
          um nome — sem cadastro, sem instalar nada.
        </p>

        <div className="stack">
          {error && <div className="error">{error}</div>}
          <button className="primary" onClick={createRoom} disabled={busy}>
            {busy ? 'Criando…' : 'Criar transmissão'}
          </button>
          <p className="hint">
            Você será o apresentador. Guarde o link — quem tiver ele entra.
          </p>
        </div>
      </div>
    </main>
  );
}
