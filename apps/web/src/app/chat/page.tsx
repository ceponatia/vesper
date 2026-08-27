import type { Metadata } from "next";
import { ChatsPage } from "@/components/chat/chats-page";

export const metadata: Metadata = { title: "Chats" };

/**
 * The Chats hub. `?new=<characterId>`
 * (library-card "Chat" action) opens the new-conversation dialog pre-picked —
 * read here server-side and passed down so the client component needs no
 * useSearchParams/Suspense plumbing.
 */
export default async function ChatsRoute({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const newParam = params["new"];
  return <ChatsPage newCharacterId={typeof newParam === "string" && newParam !== "" ? newParam : undefined} />;
}
