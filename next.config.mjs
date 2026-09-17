const TRANSPORTS = ['livekit', 'p2p'];

// Falhar o build é de propósito. Um TRANSPORT digitado errado no painel da
// Vercel passaria despercebido até alguém abrir uma sala — e como o fallback
// é o LiveKit, a falha apareceria como cota queimada, não como erro.
const transport = (process.env.TRANSPORT ?? '').trim().toLowerCase();
if (transport !== '' && !TRANSPORTS.includes(transport)) {
  throw new Error(
    `TRANSPORT="${process.env.TRANSPORT}" é inválido. Use ${TRANSPORTS.join(' ou ')}.`,
  );
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
};

export default nextConfig;
