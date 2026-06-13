import type { Metadata } from "next";
import { PlayScreen } from "@/components/play/play-screen";

export const metadata: Metadata = { title: "Session" };

/** The play screen (docs/ui.md). All data flows through the client hook. */
export default async function SessionRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <PlayScreen sessionId={id} />;
}
