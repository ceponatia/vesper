import { CharacterEditorPage } from "@/components/characters/character-editor-page";

export default async function CharacterEditorRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <CharacterEditorPage characterId={id} />;
}
