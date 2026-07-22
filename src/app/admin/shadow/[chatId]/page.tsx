import type { Metadata } from "next";
import { ShadowParityChatPage } from "@/components/admin/shadow-parity-page";

export const metadata: Metadata = { title: "Shadow parity" };

/** One chat's shadow-parity report + rows + verdict controls (R4). */
export default async function ShadowParityChatRoute({ params }: { params: Promise<{ chatId: string }> }) {
  const { chatId } = await params;
  return <ShadowParityChatPage chatId={chatId} />;
}
