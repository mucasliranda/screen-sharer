/**
 * `scalabilityMode` existe no navegador mas não no lib.dom.d.ts do TypeScript
 * 5.9 — `RTCRtpEncodingParameters` lá tem só active, maxBitrate, maxFramerate,
 * networkPriority, priority e scaleResolutionDownBy.
 *
 * O próprio livekit-client contorna isso com `@ts-ignore` no bundle. Preferimos
 * declarar: assim o campo é tipado no projeto inteiro em vez de silenciar o
 * compilador ponto a ponto.
 *
 * Sem import/export no topo, este arquivo é ambiente e a interface faz merge
 * com a global.
 */
interface RTCRtpEncodingParameters {
  scalabilityMode?: string;
}
