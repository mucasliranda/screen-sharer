import { NextResponse } from 'next/server';
import { newSlug, hostKeyFor } from '@/lib/rooms';

export const runtime = 'nodejs';

/** Cria uma sala. O hostKey volta só aqui — é o que prova a posse depois. */
export async function POST() {
  try {
    const slug = newSlug();
    return NextResponse.json({ slug, hostKey: hostKeyFor(slug) });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
