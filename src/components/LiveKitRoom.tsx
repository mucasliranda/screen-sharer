'use client';

import { useLiveKitTransport } from '@/lib/transport/useLiveKitTransport';
import RoomView from './RoomView';

export default function LiveKitRoom({ slug }: { slug: string }) {
  const t = useLiveKitTransport(slug);
  return <RoomView slug={slug} t={t} />;
}
