/**
 * Configuração do projeto, em um lugar só.
 *
 * O que está aqui são literais versionados no repositório, com override por
 * variável de ambiente onde faz sentido. A ideia é que dê para ler e mudar o
 * comportamento do app sem caçar `process.env` espalhado pelo código.
 */

export const TRANSPORTS = ['livekit', 'p2p'] as const;
export type Transport = (typeof TRANSPORTS)[number];

export const TRANSPORT_DEFAULT: Transport = 'livekit';

/**
 * Nunca lança. Um valor inválido cai no padrão, mas devolve o erro junto — a
 * página precisa DIZER que caiu, porque voltar para o LiveKit em silêncio
 * queimaria exatamente a cota que o modo p2p existe para economizar.
 */
export function resolveTransport(raw: string | undefined): {
  transport: Transport;
  error: string | null;
} {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === '') return { transport: TRANSPORT_DEFAULT, error: null };

  if ((TRANSPORTS as readonly string[]).includes(value)) {
    return { transport: value as Transport, error: null };
  }

  return {
    transport: TRANSPORT_DEFAULT,
    error:
      `TRANSPORT="${raw}" não é um valor válido (use "livekit" ou "p2p"). ` +
      `A sala caiu para "${TRANSPORT_DEFAULT}".`,
  };
}

/** Lido apenas no servidor. Ver src/app/r/[slug]/page.tsx. */
export function currentTransport() {
  return resolveTransport(process.env.TRANSPORT);
}

// ---------------------------------------------------------------------------
// Captura e codificação — idênticas nos dois transportes, de propósito.
// ---------------------------------------------------------------------------

/**
 * Toda transmissão sai em 1080p a 3fps. Fixo, sem seletor.
 *
 * O navegador NÃO consegue capturar mais pixels do que a tela de origem tem:
 * num monitor menor isto entrega menos. Por isso medimos o que realmente
 * saiu em vez de assumir que o pedido foi atendido.
 */
export const CAPTURE = { width: 1920, height: 1080, frameRate: 3 } as const;

/**
 * Bitrate derivado do preset h720fps5 do LiveKit (0,92 Mpx a 800 kbps, ou
 * ~0,87 Mbps por megapixel em conteúdo de tela a 5fps). 1080p tem 2,07 Mpx,
 * o que dá ~1,8 Mbps a 5fps; a 3fps sobra folga, então fechamos em 1,5.
 *
 * Este teto é o que de fato limita a banda. Resolução e fps mudam o que o
 * encoder QUER gastar; o maxBitrate é o que ele PODE — sem baixá-lo junto,
 * conteúdo em movimento continuaria saturando o valor antigo.
 *
 * Custo no pior caso: ~0,68 GB por espectador-hora. Em tela parada, que é o
 * caso comum, o consumo real fica bem abaixo disso.
 *
 * `scalabilityMode` L1T3: UMA camada espacial (a resolução nunca é reduzida)
 * com três camadas temporais. Quem estiver em rede ruim recebe menos quadros
 * — 3, 1,5 ou 0,75fps — mas sempre em 1080p, que é o requisito.
 */
export const ENCODING = {
  maxBitrate: 1_500_000,
  maxFramerate: CAPTURE.frameRate,
  scalabilityMode: 'L1T3',
} as const;

// ---------------------------------------------------------------------------
// Modo peer-to-peer
// ---------------------------------------------------------------------------

export const P2P = {
  /**
   * Sem TURN. Decisão explícita: TURN faz relay da mídia e reintroduziria o
   * custo de banda que o modo p2p existe para eliminar. O preço é que
   * espectadores em NAT simétrico ou rede corporativa não conectam — a UI
   * diz isso na cara em vez de mostrar tela preta (ver ShareTile status).
   *
   * Para habilitar TURN depois, a lista de ICE servers já vem de
   * /api/p2p/session, então basta o servidor devolver mais entradas.
   */
  stunUrls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'],

  /** Quanto esperar por uma conexão antes de declarar falha. */
  connectTimeoutMs: 15_000,

  /**
   * Candidatos ICE saem em lote. Trickle ICE numa máquina com várias
   * interfaces emite dezenas de candidatos em rajada, vezes N espectadores —
   * sem lote, isso bate no limite de mensagens do Realtime e as perdas
   * silenciosas parecem problema de NAT.
   */
  iceBatchMs: 50,

  /**
   * Aviso, não bloqueio. Em malha o upload do apresentador é N × 1,5 Mbps;
   * a partir daqui a subida dele vira o gargalo e a falha aparece como
   * engasgo, não como erro.
   */
  softViewerCap: 8,

  /** Prefixo do canal de sinalização, para não colidir com nada no projeto. */
  channelPrefix: 'ss',
} as const;

/** Ordem de preferência de codec. H.264 depois de VP9 é o "backupCodec". */
export const VIDEO_CODEC_ORDER = ['video/VP9', 'video/H264'] as const;
