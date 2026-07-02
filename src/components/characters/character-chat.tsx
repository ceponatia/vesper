"use client";

import Link from "next/link";
import { useState } from "react";
import { PLAYER_RELATIONSHIP_NOTE_MAX, relationshipStages } from "@/contracts";
import { chatsApi } from "@/lib/client/api";
import { NARRATIVE_MODELS } from "@/lib/narrative-models";
import { timeAgo } from "@/lib/relative-time";
import { NewChatDialog } from "@/components/chat/new-chat-dialog";
import { useAsyncData } from "@/components/hooks/use-async";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ErrorState } from "@/components/ui/error-state";
import { Field } from "@/components/ui/field";
import { ModelSelect } from "@/components/ui/model-select";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";

export interface CharacterChatProps {
  characterId: string;
  name: string;
  /**
   * The authored Starting Relationship (`profile.playerRelationship`) from the live
   * editor draft: how the character regards the player when a chat begins, plus the
   * one-line note that pre-fills a new chat's premise. Both write back through the
   * setters into the draft — the editor SaveBar persists them with the character.
   */
  startingStage: string;
  onStartingStageChange: (stage: string) => void;
  startingNote: string;
  onStartingNoteChange: (note: string) => void;
  /**
   * The narrator model the dropdown shows (a resolved `NARRATIVE_MODELS` id). Owned by
   * the page so it outlives this tab unmounting — picking a model here calls
   * `onChatModelChange`, which updates that state *and* persists it to the character
   * (`characters.chatModel`), so the choice is still selected on return.
   */
  chatModel: string;
  onChatModelChange: (modelId: string) => void;
}

/**
 * The editor's Chat tab, post-standalone (character-chat-standalone.spec.md §2.2):
 * a summary surface, not the conversation itself — the editor is where you *author*,
 * the Chats page (`/chat`) where you *play*. Two cards: **Chat defaults** (the
 * narrator model + the authored Starting Relationship) and **Conversations** (this
 * character's active chats, each linking to its full-screen page, plus New
 * conversation). The embedded transcript/composer moved to
 * `components/chat/chat-conversation.tsx`.
 */
export function CharacterChat({
  characterId,
  name,
  startingStage,
  onStartingStageChange,
  startingNote,
  onStartingNoteChange,
  chatModel,
  onChatModelChange,
}: CharacterChatProps) {
  const who = name.trim() || "this character";
  const [newChatOpen, setNewChatOpen] = useState(false);
  const chats = useAsyncData(() => chatsApi.list({ characterId }), [characterId]);

  return (
    <div className="flex flex-col gap-5">
      <Card className="flex flex-col gap-4 p-4">
        <h3 className="text-xs font-medium tracking-wide text-paper-400 uppercase">Chat defaults</h3>
        <Field label="Narrator model" hint="Saves on pick — every conversation with this character uses it.">
          {(id) => (
            <ModelSelect
              id={id}
              ariaLabel="Narrator model"
              models={NARRATIVE_MODELS}
              value={chatModel}
              onChange={onChatModelChange}
              className="max-w-xs"
            />
          )}
        </Field>
        <Field
          label="Starting Relationship"
          hint={`How ${who} regards the player when a chat begins — saved with the character (use the page's Save).`}
        >
          {(id) => (
            <Select
              id={id}
              value={startingStage}
              onChange={(e) => onStartingStageChange(e.target.value)}
              className="max-w-xs"
            >
              {relationshipStages.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field
          label="Relationship note"
          hint="One line of shared history — it pre-fills a new conversation's premise."
        >
          {(id) => (
            <Textarea
              id={id}
              rows={2}
              value={startingNote}
              maxLength={PLAYER_RELATIONSHIP_NOTE_MAX}
              onChange={(e) => onStartingNoteChange(e.target.value)}
              placeholder={`e.g. "you grew up next door to ${who} and just moved back"…`}
            />
          )}
        </Field>
      </Card>

      <Card className="flex flex-col gap-3 p-4">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-xs font-medium tracking-wide text-paper-400 uppercase">Conversations</h3>
          <Button size="sm" onClick={() => setNewChatOpen(true)}>
            New conversation
          </Button>
        </div>
        {chats.loading ? (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : chats.error ? (
          <ErrorState error={chats.error} onRetry={() => chats.reload()} />
        ) : (chats.data ?? []).length === 0 ? (
          <p className="text-sm text-paper-500">
            No conversations yet — start one and {who} will speak from the saved profile and attributes.
          </p>
        ) : (
          <ul className="flex flex-col">
            {(chats.data ?? []).map((chat) => (
              <li key={chat.id}>
                <Link
                  href={`/chat/${chat.id}`}
                  className="flex flex-col gap-0.5 rounded-md px-2 py-2 transition-colors hover:bg-ink-700"
                >
                  <span className="flex items-baseline justify-between gap-3">
                    {/* Auto-title: an unnamed conversation is titled by its character. */}
                    <span className="truncate text-sm text-paper-100">{chat.title || name || "Untitled"}</span>
                    {chat.lastMessageAt ? (
                      <span className="shrink-0 text-[11px] text-paper-500">{timeAgo(chat.lastMessageAt)}</span>
                    ) : null}
                  </span>
                  <span className="truncate text-xs text-paper-500">{chat.lastLine ?? "No messages yet."}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <NewChatDialog open={newChatOpen} onClose={() => setNewChatOpen(false)} characterId={characterId} />
    </div>
  );
}
