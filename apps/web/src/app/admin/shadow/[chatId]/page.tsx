import type { Metadata } from "next";
import { EngineComparisonChatPage } from "@/components/admin/shadow-parity-page";

export const metadata: Metadata = { title: "Engine Comparison" };

/** One chat's Engine Comparison report, rows, and review controls (R4). */
export default async function EngineComparisonChatRoute({ params }: { params: Promise<{ chatId: string }> }) {
  const { chatId } = await params;
  return <EngineComparisonChatPage chatId={chatId} />;
}
