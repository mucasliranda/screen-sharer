import { CAPTURE, ENCODING, VIDEO_CODEC_ORDER } from '@/config';

/**
 * Tradução da política de captura/codificação do SDK do LiveKit para WebRTC
 * cru. Mesmos números, APIs diferentes:
 *
 *   resolution            -> constraints do getDisplayMedia
 *   contentHint           -> propriedade direta do MediaStreamTrack
 *   screenShareEncoding   -> sendEncodings[0] + reafirmação via setParameters
 *   scalabilityMode       -> sendEncodings[0].scalabilityMode
 *   simulcast: false      -> automático: um único sendEncoding, sem rid
 *   degradationPreference -> RTCRtpSendParameters (NÃO é por encoding)
 *   videoCodec + backup   -> transceiver.setCodecPreferences antes do offer
 */

export async function captureScreen(): Promise<MediaStream> {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: {
      width: { ideal: CAPTURE.width },
      height: { ideal: CAPTURE.height },
      frameRate: { ideal: CAPTURE.frameRate, max: CAPTURE.frameRate },
    },
    audio: true,
  });

  // Diz ao encoder que é conteúdo estático com detalhe fino. Sem isso ele
  // borra o texto para preservar taxa de quadros.
  const video = stream.getVideoTracks()[0];
  if (video) video.contentHint = 'text';

  return stream;
}

export function buildSendEncodings(): RTCRtpEncodingParameters[] {
  // Um único encoding, sem rid e sem scaleResolutionDownBy: é isto que
  // garante que não existe camada espacial menor para onde cair.
  return [
    {
      maxBitrate: ENCODING.maxBitrate,
      maxFramerate: ENCODING.maxFramerate,
      scalabilityMode: ENCODING.scalabilityMode,
    },
  ];
}

/**
 * VP9 primeiro, H.264 depois, resto no fim. Manter o H.264 na lista é o
 * equivalente cru de `backupCodec: true`: quem não decodifica VP9 negocia
 * H.264 em vez de falhar.
 */
export function preferredVideoCodecs(): RTCRtpCodec[] | null {
  const caps = RTCRtpSender.getCapabilities('video');
  if (!caps) return null;

  const pick = (mime: string) =>
    caps.codecs.filter((c) => c.mimeType.toLowerCase() === mime.toLowerCase());

  const preferred = VIDEO_CODEC_ORDER.flatMap(pick);
  const rest = caps.codecs.filter(
    (c) => !VIDEO_CODEC_ORDER.some((m) => m.toLowerCase() === c.mimeType.toLowerCase()),
  );

  return preferred.length > 0 ? [...preferred, ...rest] : null;
}

/**
 * setParameters só aceita o objeto devolvido pelo getParameters mais recente
 * (ele carrega um transactionId), e duas chamadas concorrentes no mesmo sender
 * dão InvalidStateError. Por isso: nunca montar params do zero, e serializar
 * por sender. O LiveKit mantém um lock exatamente por isto.
 */
const senderLocks = new WeakMap<RTCRtpSender, Promise<void>>();

export function applySendPolicy(sender: RTCRtpSender): Promise<void> {
  const previous = senderLocks.get(sender) ?? Promise.resolve();

  const next = previous.then(async () => {
    try {
      const params = sender.getParameters();

      // Sob pressão de CPU ou banda, derruba quadros — nunca resolução.
      params.degradationPreference = 'maintain-resolution';

      if (params.encodings && params.encodings.length > 0) {
        params.encodings[0] = {
          ...params.encodings[0],
          maxBitrate: ENCODING.maxBitrate,
          maxFramerate: ENCODING.maxFramerate,
          scalabilityMode: ENCODING.scalabilityMode,
        };
      }

      await sender.setParameters(params);
    } catch (err) {
      // Melhor esforço. O suporte a degradationPreference e scalabilityMode
      // varia entre navegadores, e uma rejeição aqui deve custar qualidade,
      // não derrubar a transmissão.
      //
      // Vale notar: mesmo que scalabilityMode seja ignorado, o resultado é
      // L1T1 — ainda UMA camada espacial, ainda 1080p. A garantia de
      // resolução vem do encoding único + maintain-resolution, não do L1T3.
      console.warn('[p2p] setParameters parcial:', (err as Error).message);
    }
  });

  senderLocks.set(sender, next);
  return next;
}
