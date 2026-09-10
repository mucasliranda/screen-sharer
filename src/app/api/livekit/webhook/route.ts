import { NextResponse } from 'next/server';
import { WebhookReceiver } from 'livekit-server-sdk';
import { livekitConfig } from '@/lib/livekit';
import { ingestWebhookEvent } from '@/lib/usage';

export const runtime = 'nodejs';
// Sem cache: cada POST é um evento distinto.
export const dynamic = 'force-dynamic';

/**
 * Recebe os webhooks do LiveKit — é daqui que sai todo o controle de uso.
 *
 * Por que não medir no cliente: o navegador não consegue avisar de forma
 * confiável que a sessão acabou. Aba fechada, máquina suspensa, Wi-Fi caiu —
 * o `unload` não chega. Já o LiveKit sabe quando o participante sumiu, e
 * conta isso do lado dele.
 */
export async function POST(req: Request) {
  // O corpo precisa ser lido CRU. A assinatura é calculada sobre os bytes
  // exatos; um req.json() seguido de re-serialização quebra a validação.
  const body = await req.text();
  const authHeader =
    req.headers.get('authorization') ?? req.headers.get('authorize') ?? undefined;

  let event;
  try {
    const { apiKey, apiSecret } = livekitConfig();
    const receiver = new WebhookReceiver(apiKey, apiSecret);
    event = await receiver.receive(body, authHeader);
  } catch (err) {
    // Endpoint público: quem não assina com o segredo do projeto não entra.
    console.error('[webhook] assinatura rejeitada:', (err as Error).message);
    return NextResponse.json({ error: 'Assinatura inválida.' }, { status: 401 });
  }

  try {
    const result = await ingestWebhookEvent(event);
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    // 500 de propósito: o LiveKit reenvia, e o `id` do evento é a chave
    // primária de webhook_events, então reprocessar não duplica nada.
    console.error('[webhook] falha ao gravar', event.event, (err as Error).message);
    return NextResponse.json({ error: 'Falha ao registrar o evento.' }, { status: 500 });
  }
}
