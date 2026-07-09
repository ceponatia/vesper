import type { Metadata } from "next";
import { ChatInspectorPage } from "@/components/chat/chat-inspector-page";

export const metadata: Metadata = { title: "Chat inspector" };

/**
 * The memory inspector (character-chat-standalone.spec.md §6.1) — admin-gated
 * client-side; the /api/admin/chat-inspector family it reads role-gates server-side
 * (404 for non-admins), so it works on the deployed build.
 */
export default async function ChatInspectorRoute({ params }: { params: Promise<{ chatId: string }> }) {
  const { chatId } = await params;
  return <ChatInspectorPage chatId={chatId} />;
}
