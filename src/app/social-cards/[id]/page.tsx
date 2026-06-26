import { SocialCardEditorPage } from "@/components/social-cards/social-card-editor-page";

export default async function SocialCardEditorRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <SocialCardEditorPage cardId={id} />;
}
