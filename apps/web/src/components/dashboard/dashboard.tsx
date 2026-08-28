"use client";

import Link from "next/link";
import { charactersApi, chatsApi } from "@/lib/client/api";
import { ChatSayMarker } from "@/components/chat/chats-page";
import { useAsyncData } from "@/components/hooks/use-async";
import { PageContainer } from "@/components/shell/app-shell";
import { Card } from "@/components/ui/card";
import { EntityImage } from "@/components/ui/entity-image";
import { ErrorState } from "@/components/ui/error-state";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Dashboard (docs/ui/pages.md §The route map): conversations lead (the
 * companion experience is the
 * front door — D12), then the successor-engine worlds entry and the cast strip.
 * (The legacy world/session hero was deleted with the session lane, 2026-07-22.)
 */
export function Dashboard() {
  const chats = useAsyncData(() => chatsApi.list(), []);
  const cast = useAsyncData(() => charactersApi.list(), []);

  const recentChats = chats.data ?? [];
  const latestChat = recentChats[0];

  return (
    <PageContainer wide>
      {/* Conversations (D12: the dashboard leads with chats — hidden entirely until one exists) */}
      {latestChat ? (
        <section className="mb-10">
          <div className="mb-3 flex items-baseline justify-between">
            <h2 className="prose-display text-xl">Conversations</h2>
            <Link href="/chat" className="text-sm text-paper-400 hover:text-paper-100">
              All chats →
            </Link>
          </div>
          <Link href={`/chat/${latestChat.id}`} className="group block">
            <Card interactive className="flex items-center gap-5 px-6 py-5">
              <EntityImage
                imageId={latestChat.avatarImageId}
                name={latestChat.characterName}
                className="size-16 shrink-0 rounded-full border border-ink-600 text-lg"
              />
              <div className="min-w-0">
                <p className="text-xs tracking-wide text-paper-500 uppercase">Continue talking to</p>
                <div className="mt-0.5 flex items-center gap-2">
                  <h1 className="prose-display min-w-0 truncate text-2xl group-hover:text-accent-300">
                    {latestChat.characterName}
                    {latestChat.title ? <span className="text-paper-400"> — {latestChat.title}</span> : null}
                  </h1>
                  {/* "Has something to say" — the dot opens the chat with ?say=1 */}
                  {latestChat.say ? <ChatSayMarker chatId={latestChat.id} say={latestChat.say} /> : null}
                </div>
                {latestChat.lastLine ? (
                  <p className="mt-1 truncate text-sm text-paper-400">{latestChat.lastLine}</p>
                ) : null}
              </div>
              <span className="prose-display ml-auto shrink-0 text-3xl text-paper-500 transition-transform group-hover:translate-x-1 group-hover:text-accent-300">
                →
              </span>
            </Card>
          </Link>
          {recentChats.length > 1 ? (
            <ul className="mt-3 flex flex-col gap-1.5">
              {recentChats.slice(1, 5).map((chat) => (
                <li key={chat.id}>
                  <Link
                    href={`/chat/${chat.id}`}
                    className="flex items-center gap-3 rounded-md px-3 py-2 text-sm text-paper-300 hover:bg-ink-800"
                  >
                    <EntityImage
                      imageId={chat.avatarImageId}
                      name={chat.characterName}
                      className="size-7 shrink-0 rounded-full text-[10px]"
                    />
                    <span className="shrink-0">{chat.characterName}</span>
                    {chat.lastLine ? <span className="truncate text-xs text-paper-500">{chat.lastLine}</span> : null}
                    {chat.say ? <ChatSayMarker chatId={chat.id} say={chat.say} className="ml-auto" /> : null}
                  </Link>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}

      {/* Worlds — the successor engine's front door (the legacy world-model
          library that lived here was deleted 2026-07-22). */}
      <section className="mb-10">
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="prose-display text-xl">Worlds</h2>
          <Link href="/worlds" className="text-sm text-paper-400 hover:text-paper-100">
            All worlds →
          </Link>
        </div>
        <Link href="/worlds" className="group block">
          <Card interactive className="px-6 py-5">
            <p className="text-sm text-paper-300">
              Living worlds on the new engine — a place, a clock, and your character living in it.{" "}
              <span className="text-accent-300 group-hover:text-accent-200">Create one and step in →</span>
            </p>
          </Card>
        </Link>
      </section>

      {/* Cast strip */}
      <section>
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="prose-display text-xl">Cast</h2>
          <Link href="/characters" className="text-sm text-paper-400 hover:text-paper-100">
            All characters →
          </Link>
        </div>
        {cast.loading ? (
          <div className="flex gap-4">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="size-20 rounded-full" />
            ))}
          </div>
        ) : cast.error ? (
          <ErrorState error={cast.error} onRetry={() => cast.reload()} />
        ) : (cast.data ?? []).length === 0 ? (
          <p className="text-sm text-paper-500">
            No characters yet —{" "}
            <Link href="/characters/forge" className="text-accent-300 hover:text-accent-400">
              forge someone
            </Link>
            .
          </p>
        ) : (
          <div className="flex gap-5 overflow-x-auto pb-2">
            {(cast.data ?? []).slice(0, 14).map((character) => (
              <Link
                key={character.id}
                href={`/characters/${character.id}`}
                className="group flex w-20 shrink-0 flex-col items-center gap-1.5"
              >
                <EntityImage
                  imageId={character.avatarImageId}
                  name={character.name}
                  className="size-20 rounded-full border border-ink-600 text-xl group-hover:border-accent-500/60"
                />
                <span className="w-full truncate text-center text-xs text-paper-400 group-hover:text-paper-100">
                  {character.name}
                </span>
              </Link>
            ))}
          </div>
        )}
      </section>
    </PageContainer>
  );
}
