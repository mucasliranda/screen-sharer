import { NextResponse } from 'next/server';
import { newSlug, hostKeyFor } from '@/lib/rooms';
import { registerRoom } from '@/lib/usage';

export const runtime = 'nodejs';

/** Cria uma sala. O hostKey volta só aqui — é o que prova a posse depois. */
export async function POST() {
  try {
    const slug = newSlug();

    // Antes de responder, para que uma sala criada e nunca usada também
    // apareça no relatório — o LiveKit só a conhece a partir do primeiro
    // join. `registerRoom` não lança: medir não pode impedir criar.
    await registerRoom(slug);

    return NextResponse.json({ slug, hostKey: hostKeyFor(slug) });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
