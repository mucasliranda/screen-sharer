import { NextResponse } from 'next/server';
import { TrackSource } from 'livekit-server-sdk';
import { isValidSlug } from '@/lib/rooms';
import { roomService } from '@/lib/livekit';
import { markTakenOver } from '@/lib/usage';

export const runtime = 'nodejs';

/**
 * Passa o bastão: quem acabou de publicar assume a tela e derruba as demais.
 *
 * A exclusividade é decidida aqui, no servidor, e não por acordo entre os
 * clientes. Se dois participantes clicarem ao mesmo tempo, o LiveKit processa
 * as duas chamadas em alguma ordem definida e a última vence — nunca as duas
 * caem, que é o que aconteceria se cada cliente derrubasse o outro ao ver um
 * `TrackPublished` remoto.
 *
 * Silenciamos (`mutePublishedTrack`) em vez de revogar `canPublish`: revogar
 * impediria a pessoa de retomar o bastão depois sem um novo token.
 */
export async function POST(req: Request) {
  try {
    const body: unknown = await req.json().catch(() => ({}));
    const { slug, identity } = (body ?? {}) as Record<string, unknown>;

    if (typeof slug !== 'string' || !isValidSlug(slug)) {
      return NextResponse.json({ error: 'Sala inválida.' }, { status: 400 });
    }
    if (typeof identity !== 'string' || identity.length === 0) {
      return NextResponse.json({ error: 'Participante não informado.' }, { status: 400 });
    }

    const svc = roomService();

    let participants;
    try {
      participants = await svc.listParticipants(slug);
    } catch (err) {
      // O LiveKit só materializa a sala quando alguém entra, e responde
      // "room does not exist" caso contrário. Se ela não existe, quem chamou
      // não pode estar nela — 403 diz isso melhor que um 500 com erro cru.
      if (/does not exist|not found/i.test((err as Error).message)) {
        return NextResponse.json({ error: 'Você não está nesta sala.' }, { status: 403 });
      }
      throw err;
    }

    // Confere que quem pediu está mesmo na sala: sem isso, qualquer um com o
    // slug poderia derrubar a transmissão alheia de fora.
    if (!participants.some((p) => p.identity === identity)) {
      return NextResponse.json({ error: 'Você não está nesta sala.' }, { status: 403 });
    }

    const displaced: string[] = [];

    for (const p of participants) {
      if (p.identity === identity) continue;
      for (const track of p.tracks) {
        const isScreen =
          track.source === TrackSource.SCREEN_SHARE ||
          track.source === TrackSource.SCREEN_SHARE_AUDIO;
        if (!isScreen || track.muted) continue;

        await svc.mutePublishedTrack(slug, p.identity, track.sid, true);
        if (!displaced.includes(p.identity)) displaced.push(p.identity);
      }
    }

    // Só aqui se sabe que a tela não parou sozinha: foi derrubada. O
    // track_unpublished que chega depois apenas fecha o ended_at.
    await markTakenOver(slug, displaced);

    return NextResponse.json({ ok: true, displaced });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
