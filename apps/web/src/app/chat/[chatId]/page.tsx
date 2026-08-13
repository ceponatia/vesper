import type { Metadata } from "next";
import { ChatConversation } from "@/components/chat/chat-conversation";

export const metadata: Metadata = { title: "Chat" };

/** The full-screen conversation (docs/character-chat/). All data flows through the client component. */
export default async function ChatConversationRoute({ params }: { params: Promise<{ chatId: string }> }) {
  const { chatId } = await params;
  return <ChatConversation chatId={chatId} />;
}
