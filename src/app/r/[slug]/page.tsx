import RoomClient from '@/components/RoomClient';

export default async function RoomPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <RoomClient slug={slug} />;
}
