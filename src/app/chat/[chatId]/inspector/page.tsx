import type { Metadata } from "next";
import { ChatInspectorPage } from "@/components/chat/chat-inspector-page";

export const metadata: Metadata = { title: "Chat inspector" };

/**
 * The dev memory inspector (character-chat-standalone.spec.md §6.1) — admin-gated
 * client-side; the /api/dev/chat-inspector family it reads is 404 in production.
 */
export default async function ChatInspectorRoute({ params }: { params: Promise<{ chatId: string }> }) {
  const { chatId } = await params;
  return <ChatInspectorPage chatId={chatId} />;
}
