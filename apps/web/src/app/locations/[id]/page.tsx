import { LocationEditorPage } from "@/components/locations/location-editor-page";

export default async function LocationEditorRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <LocationEditorPage locationId={id} />;
}
