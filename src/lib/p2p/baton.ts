/**
 * Bastão de apresentação em P2P, sem servidor.
 *
 * No modo LiveKit quem arbitra é /api/takeover. Aqui não existe registro de
 * participantes no servidor, então a exclusividade vem de uma ORDEM TOTAL
 * calculada localmente: contador tipo Lamport, desempatado pelo peerId.
 *
 * Por que uma ordem total resolve: o comentário em /api/takeover descreve o
 * modo de falha a evitar — "as duas caem, que é o que aconteceria se cada
 * cliente derrubasse o outro ao ver um TrackPublished remoto". Aquilo é
 * causado por SIMETRIA (derrubada mútua). Uma ordem total é assimétrica por
 * construção: um lado ganha, o outro cede, e todos calculam o mesmo vencedor.
 *
 * A fonte da verdade é o presence do Supabase Realtime, que é sincronizado
 * pelo servidor: todo cliente recebe o mesmo mapa completo e portanto chega
 * ao mesmo resultado. O broadcast de `claim` é só um atalho de latência — se
 * ele se perder, o próximo sync conserta. Se o claim vivesse SÓ no broadcast,
 * uma mensagem perdida deixaria dois tiles para sempre.
 *
 * Funções puras, sem I/O, de propósito: a corrida inteira cabe em um teste.
 */

export type Claim = { n: number; at: number };

export type BatonEntry = {
  peerId: string;
  claim: Claim | null;
  sharing: boolean;
};

/** Próximo número de claim: um acima do maior que já vi. */
export function nextClaimN(entries: readonly BatonEntry[]): number {
  let max = 0;
  for (const e of entries) {
    if (e.claim && e.claim.n > max) max = e.claim.n;
  }
  return max + 1;
}

/**
 * Quem está com o bastão. Maior `n` vence; empate desempata pelo maior
 * peerId. Determinístico e idêntico em todos os clientes.
 */
export function batonHolder(entries: readonly BatonEntry[]): string | null {
  let best: BatonEntry | null = null;

  for (const e of entries) {
    if (!e.claim || !e.sharing) continue;
    if (best === null) {
      best = e;
      continue;
    }
    if (e.claim.n > best.claim!.n) {
      best = e;
    } else if (e.claim.n === best.claim!.n && e.peerId > best.peerId) {
      best = e;
    }
  }

  return best ? best.peerId : null;
}
