"use client";

import Link from "next/link";
import { charactersApi, chatsApi, sessionsApi } from "@/lib/client/api";
import { ChatSayMarker } from "@/components/chat/chats-page";
import { useAsyncData } from "@/components/hooks/use-async";
import { PageContainer } from "@/components/shell/app-shell";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { EntityImage } from "@/components/ui/entity-image";
import { ErrorState } from "@/components/ui/error-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Tag } from "@/components/ui/tag";

/**
 * Dashboard (docs/ui.md): conversations lead (the companion experience is the
 * front door — character-chat-standalone D12), then the continue-session hero,
 * recent worlds, cast strip.
 */
export function Dashboard() {
  const chats = useAsyncData(() => chatsApi.list(), []);
  const sessions = useAsyncData(() => sessionsApi.recent(), []);
  const cast = useAsyncData(() => charactersApi.list(), []);

  const recent = sessions.data ?? [];
  const latest = recent[0];
  const freshInstall = !sessions.loading && !chats.loading && recent.length === 0 && (chats.data ?? []).length === 0;

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
                  {/* "Has something to say" (§8.4) — the dot opens the chat with ?say=1 */}
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

      {/* Hero */}
      <section className="mb-10">
        {sessions.loading ? (
          <Skeleton className="h-36" />
        ) : freshInstall ? (
          <div className="rounded-card border border-ink-600 bg-ink-800 px-8 py-12 text-center shadow-lift">
            <h1 className="prose-display text-3xl">Welcome to Vesper</h1>
            <p className="mx-auto mt-2 max-w-lg text-sm text-paper-400">
              Forge a character, start a conversation — or spin up a living world on the new engine and
              step into it.
            </p>
            <div className="mt-6 flex justify-center gap-3">
              <Link
                href="/characters/forge"
                className="inline-flex h-9 items-center rounded-md bg-accent-500 px-4 text-sm font-medium text-ink-950 hover:bg-accent-400"
              >
                Forge a character ✦
              </Link>
              <Link
                href="/worlds"
                className="inline-flex h-9 items-center rounded-md border border-ink-600 px-4 text-sm text-paper-200 hover:bg-ink-800"
              >
                Create a world
              </Link>
            </div>
          </div>
        ) : latest ? (
          <Link href={`/sessions/${latest.id}`} className="group block">
            <Card interactive className="flex items-center justify-between gap-6 px-8 py-8">
              <div className="min-w-0">
                <p className="text-xs tracking-wide text-paper-500 uppercase">Continue</p>
                <h1 className="prose-display mt-1 truncate text-3xl group-hover:text-accent-300">
                  {latest.title}
                </h1>
                <p className="mt-1.5 flex items-center gap-2 text-sm text-paper-400">
                  {latest.worldName ? <span>{latest.worldName}</span> : null}
                  <Tag tone={latest.status === "ready" ? "ok" : "accent"}>{latest.status}</Tag>
                </p>
              </div>
              <span className="prose-display shrink-0 text-4xl text-paper-500 transition-transform group-hover:translate-x-1 group-hover:text-accent-300">
                →
              </span>
            </Card>
          </Link>
        ) : (
          <EmptyState
            title="No sessions yet"
            description="Pick a world and begin — the narrator takes it from there."
            action={
              <Link
                href="/sessions/new"
                className="inline-flex h-9 items-center rounded-md bg-accent-500 px-4 text-sm font-medium text-ink-950 hover:bg-accent-400"
              >
                New session
              </Link>
            }
          />
        )}

        {recent.length > 1 ? (
          <ul className="mt-3 flex flex-col gap-1.5">
            {recent.slice(1, 5).map((session) => (
              <li key={session.id}>
                <Link
                  href={`/sessions/${session.id}`}
                  className="flex items-center gap-3 rounded-md px-3 py-2 text-sm text-paper-300 hover:bg-ink-800"
                >
                  <span className="truncate">{session.title}</span>
                  {session.worldName ? <span className="text-xs text-paper-500">{session.worldName}</span> : null}
                  <span className="ml-auto text-xs text-paper-500">{session.status}</span>
                </Link>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      {/* Worlds — the successor engine's front door (the legacy world-model
          library that lived here was deleted 2026-07-22; engine.rollout.plan.md). */}
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
