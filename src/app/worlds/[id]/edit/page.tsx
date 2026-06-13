import { WorldEditPage } from "@/components/worlds/world-edit-page";

export default async function WorldEditRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <WorldEditPage worldId={id} />;
}
