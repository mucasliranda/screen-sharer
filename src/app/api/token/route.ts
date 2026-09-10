import { NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { isValidSlug, isValidHostKey, sanitizeName } from '@/lib/rooms';
import { mintToken, livekitConfig } from '@/lib/livekit';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  try {
    const body: unknown = await req.json().catch(() => ({}));
    const { slug, name, hostKey } = (body ?? {}) as Record<string, unknown>;

    if (typeof slug !== 'string' || !isValidSlug(slug)) {
      return NextResponse.json({ error: 'Sala inválida.' }, { status: 400 });
    }

    // Todo mundo na sala pode compartilhar tela. A exclusividade (só uma
    // transmissão por vez) é imposta em /api/takeover, não aqui — negar
    // canPublish no token exigiria reemitir credencial a cada troca de bastão.
    const isHost = isValidHostKey(slug, hostKey);
    const displayName = sanitizeName(name);

    // Identidade é gerada pelo servidor. O nome digitado é apenas rótulo:
    // duas pessoas podem se chamar "Lucas" sem colidir nem se passar uma pela outra.
    const identity = `${isHost ? 'host' : 'viewer'}-${randomUUID()}`;

    const token = await mintToken({ room: slug, identity, displayName, canPublish: true });

    return NextResponse.json({
      token,
      url: livekitConfig().url,
      identity,
      displayName,
      isHost,
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
