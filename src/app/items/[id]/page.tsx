import { ItemEditorPage } from "@/components/items/item-editor-page";

export default async function ItemEditorRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ItemEditorPage itemId={id} />;
}
