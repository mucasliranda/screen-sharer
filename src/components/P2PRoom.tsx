'use client';

import { useP2PTransport } from '@/lib/p2p/useP2PTransport';
import RoomView from './RoomView';

export default function P2PRoom({ slug }: { slug: string }) {
  const t = useP2PTransport(slug);
  return <RoomView slug={slug} t={t} />;
}
