import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';

export function livekitConfig() {
  const url = process.env.NEXT_PUBLIC_LIVEKIT_URL;
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  if (!url || !apiKey || !apiSecret) {
    throw new Error(
      'Faltam NEXT_PUBLIC_LIVEKIT_URL, LIVEKIT_API_KEY ou LIVEKIT_API_SECRET. Copie o .env.example para .env.local.',
    );
  }
  return { url, apiKey, apiSecret };
}

export async function mintToken(opts: {
  room: string;
  identity: string;
  displayName: string;
  canPublish: boolean;
}): Promise<string> {
  const { apiKey, apiSecret } = livekitConfig();
  const at = new AccessToken(apiKey, apiSecret, {
    identity: opts.identity,
    name: opts.displayName,
    ttl: '4h',
  });
  at.addGrant({
    roomJoin: true,
    room: opts.room,
    canPublish: opts.canPublish,
    canSubscribe: true,
    canPublishData: true,
    canUpdateOwnMetadata: false,
  });
  return at.toJwt();
}

/** Usado para promover/rebaixar publicadores ao vivo, sem reconexão. */
export function roomService(): RoomServiceClient {
  const { url, apiKey, apiSecret } = livekitConfig();
  const httpUrl = url.replace(/^ws/, 'http');
  return new RoomServiceClient(httpUrl, apiKey, apiSecret);
}
