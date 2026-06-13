import { WorldDetailPage } from "@/components/worlds/world-detail-page";

export default async function WorldDetailRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <WorldDetailPage worldId={id} />;
}
