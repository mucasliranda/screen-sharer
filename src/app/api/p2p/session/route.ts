import { NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { isValidSlug, isValidHostKey, sanitizeName } from '@/lib/rooms';
import { P2P } from '@/config';

export const runtime = 'nodejs';

/**
 * Equivalente de /api/token para o modo p2p: mesmo contrato de entrada, para
 * o fluxo de entrada na sala ser simétrico entre os transportes.
 *
 * Devolve as credenciais do Realtime em vez de expô-las como NEXT_PUBLIC_.
 * Não é segredo (a chave publicável é feita para o cliente), mas mantém uma
 * única fonte de verdade no servidor e permite trocar de projeto sem rebuild.
 */
export async function POST(req: Request) {
  try {
    const body: unknown = await req.json().catch(() => ({}));
    const { slug, name, hostKey } = (body ?? {}) as Record<string, unknown>;

    if (typeof slug !== 'string' || !isValidSlug(slug)) {
      return NextResponse.json({ error: 'Sala inválida.' }, { status: 400 });
    }

    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.SUPABASE_ANON_KEY;
    if (!url || !key) {
      return NextResponse.json(
        {
          error:
            'O modo p2p precisa de SUPABASE_URL e SUPABASE_PUBLISHABLE_KEY para a sinalização. Veja o .env.example.',
        },
        { status: 500 },
      );
    }

    const isHost = isValidHostKey(slug, hostKey);
    const displayName = sanitizeName(name);

    // Mesmo esquema de identidade do /api/token. O prefixo "host-" é lido por
    // src/lib/usage.ts:37, então manter a convenção deixa qualquer telemetria
    // futura funcionando igual nos dois transportes.
    const peerId = `${isHost ? 'host' : 'viewer'}-${randomUUID()}`;

    // Só STUN, por decisão explícita: TURN faz relay da mídia e reintroduz o
    // custo de banda que este modo existe para eliminar. A lista sai daqui
    // justamente para que habilitar TURN depois não exija tocar no cliente.
    const ice: RTCIceServer[] = [{ urls: [...P2P.stunUrls] }];

    return NextResponse.json({
      peerId,
      displayName,
      isHost,
      ice,
      realtime: { url, key },
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
