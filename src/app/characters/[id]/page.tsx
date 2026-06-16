import { CharacterEditPage } from "@/components/characters/character-edit-page";

export default async function CharacterEditorRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <CharacterEditPage characterId={id} />;
}
