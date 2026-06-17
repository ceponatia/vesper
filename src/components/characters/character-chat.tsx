"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { charactersApi, sendCharacterChat, type ImageRecord } from "@/lib/client/api";
import { useAsyncData } from "@/components/hooks/use-async";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { EntityImage } from "@/components/ui/entity-image";
import { ErrorState } from "@/components/ui/error-state";
import { ImageLightbox } from "@/components/ui/image-lightbox";
import { Skeleton } from "@/components/ui/skeleton";
import { Tag } from "@/components/ui/tag";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";

export interface CharacterChatProps {
  characterId: string;
  name: string;
  avatarImageId: string | null;
}

interface ChatLine {
  id: string;
  role: "user" | "assistant";
  content: string;
}

const POLL_MS = 2500;

function sceneError(image: ImageRecord): string | null {
  const error = image.meta?.error?.trim();
  return error ? error : null;
}

/**
 * The sessionless in-character chat tab (docs/developer-notes/character-chat.plan.md):
 * talk to a saved library character directly. Messages persist to
 * `character_chat_messages`; replies stream token-by-token; a manual button
 * renders a scene image from the recent exchange (filed against the character,
 * so it also lands in the Gallery under "Character chats").
 */
export function CharacterChat({ characterId, name, avatarImageId }: CharacterChatProps) {
  const toast = useToast();
  const who = name.trim() || "this character";

  const transcript = useAsyncData(() => charactersApi.chatTranscript(characterId), [characterId]);
  const [lines, setLines] = useState<ChatLine[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);
  const tempId = useRef(0);
  const mkId = () => `tmp-${tempId.current++}`;

  // Seed the editable transcript from the load exactly once per character (the
  // "adjust state while rendering" pattern) so a streamed/optimistic reply is
  // never clobbered by the fetch settling; switching characters re-seeds.
  const [seededFor, setSeededFor] = useState<string | null>(null);
  if (seededFor !== characterId && !transcript.loading && transcript.data) {
    setSeededFor(characterId);
    setLines(transcript.data.map((m) => ({ id: m.id, role: m.role, content: m.content })));
  }

  // Auto-scroll to the newest line as the conversation grows / streams.
  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [lines]);

  const send = async () => {
    const content = input.trim();
    if (!content || sending) return;
    setInput("");
    const assistantId = mkId();
    setLines((prev) => [
      ...prev,
      { id: mkId(), role: "user", content },
      { id: assistantId, role: "assistant", content: "" },
    ]);
    setSending(true);
    const outcome = await sendCharacterChat(characterId, { content }, (delta) => {
      setLines((prev) => prev.map((l) => (l.id === assistantId ? { ...l, content: l.content + delta } : l)));
    });
    setSending(false);
    if (!outcome.ok) {
      // Drop the empty reply bubble (a partial reply, if any streamed, stays).
      setLines((prev) => prev.filter((l) => !(l.id === assistantId && l.content === "")));
      toast.push({ title: "Reply failed", description: outcome.error?.message, tone: "error" });
    }
  };

  const onComposerKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  const clearChat = async () => {
    setClearing(true);
    const result = await charactersApi.clearChat(characterId);
    setClearing(false);
    setConfirmClear(false);
    if (result.ok) {
      setLines([]);
      toast.push({ title: "Chat cleared" });
    } else {
      toast.push({ title: "Clear failed", description: result.error.message, tone: "error" });
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <SceneStrip characterId={characterId} name={name} hasChat={lines.length > 0} />

      <div className="flex items-center justify-between gap-3">
        <h3 className="text-xs font-medium tracking-wide text-paper-400 uppercase">Conversation</h3>
        {lines.length > 0 ? (
          <Button size="sm" variant="quiet" onClick={() => setConfirmClear(true)}>
            Clear chat
          </Button>
        ) : null}
      </div>

      <div className="flex max-h-[28rem] min-h-48 flex-col gap-3 overflow-y-auto rounded-card border border-ink-600 bg-ink-950/40 p-4">
        {transcript.loading ? (
          <div className="flex flex-col gap-3">
            <Skeleton className="h-10 w-2/3" />
            <Skeleton className="h-10 w-1/2 self-end" />
          </div>
        ) : transcript.error ? (
          <ErrorState error={transcript.error} onRetry={() => transcript.reload()} />
        ) : lines.length === 0 ? (
          <p className="m-auto max-w-sm text-center text-sm text-paper-500">
            Say something to {who} to start the conversation. This chat lives only here — no world, no session.
          </p>
        ) : (
          <>
            {lines.map((line) => (
              <MessageBubble key={line.id} line={line} name={name} avatarImageId={avatarImageId} streaming={sending} />
            ))}
            <div ref={bottomRef} />
          </>
        )}
      </div>

      <div className="flex items-end gap-2">
        <Textarea
          rows={2}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onComposerKeyDown}
          placeholder={`Message ${who}…  (Enter to send, Shift+Enter for a new line)`}
          className="flex-1"
        />
        <Button variant="primary" onClick={send} busy={sending} disabled={!input.trim()}>
          Send
        </Button>
      </div>

      <Dialog
        open={confirmClear}
        onClose={() => {
          if (!clearing) setConfirmClear(false);
        }}
        title="Clear this conversation?"
        footer={
          <>
            <Button onClick={() => setConfirmClear(false)} disabled={clearing}>
              Cancel
            </Button>
            <Button variant="danger" busy={clearing} onClick={clearChat}>
              Clear
            </Button>
          </>
        }
      >
        This deletes every message in this chat. Generated scene images are kept (find them in the Gallery).
      </Dialog>
    </div>
  );
}

/** One chat line: the user on the right, the character (with avatar) on the left. */
function MessageBubble({
  line,
  name,
  avatarImageId,
  streaming,
}: {
  line: ChatLine;
  name: string;
  avatarImageId: string | null;
  streaming: boolean;
}) {
  const isUser = line.role === "user";
  const pending = !isUser && line.content === "" && streaming;
  return (
    <div className={`flex gap-2.5 ${isUser ? "flex-row-reverse" : "flex-row"}`}>
      {!isUser ? (
        <EntityImage imageId={avatarImageId} name={name} className="mt-0.5 size-8 shrink-0 rounded-full text-xs" />
      ) : null}
      <div
        className={`max-w-[80%] rounded-card px-3 py-2 text-sm whitespace-pre-wrap ${
          isUser ? "bg-accent-500/15 text-paper-100" : "bg-ink-800 text-paper-200"
        }`}
      >
        {pending ? <span className="text-paper-500">…</span> : line.content}
      </div>
    </div>
  );
}

/** Manual scene-image renderer + history strip for the chat. */
function SceneStrip({ characterId, name, hasChat }: { characterId: string; name: string; hasChat: boolean }) {
  const toast = useToast();
  const scenes = useAsyncData(() => charactersApi.chatScenes(characterId), [characterId]);
  const [generating, setGenerating] = useState(false);
  const [enlarged, setEnlarged] = useState<{ id: string; caption: string | null } | null>(null);
  const baselineRef = useRef(0);

  const sceneList = scenes.data ?? [];
  const hasPending = sceneList.some((s) => s.status === "pending") || generating;

  // Latest-ref so the poll calls the current reload without re-subscribing.
  const reloadRef = useRef(scenes.reload);
  useEffect(() => {
    reloadRef.current = scenes.reload;
  });
  useEffect(() => {
    if (!hasPending) return;
    const timer = setInterval(() => reloadRef.current({ silent: true }), POLL_MS);
    return () => clearInterval(timer);
  }, [hasPending]);

  // Release the button spinner once the queued row materialises; its own
  // pending tile then tracks progress (mirrors the portrait studio).
  useEffect(() => {
    if (generating && sceneList.length > baselineRef.current) setGenerating(false);
  }, [sceneList.length, generating]);

  const generate = async () => {
    baselineRef.current = sceneList.length;
    setGenerating(true);
    const result = await charactersApi.generateChatScene(characterId);
    if (!result.ok) {
      setGenerating(false);
      toast.push({ title: "Scene failed to queue", description: result.error.message, tone: "error" });
      return;
    }
    toast.push({ title: "Scene queued", description: "Rendering from the recent conversation." });
    scenes.reload({ silent: true });
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-xs font-medium tracking-wide text-paper-400 uppercase">Scene images</h3>
        <Button
          size="sm"
          onClick={generate}
          busy={generating}
          disabled={!hasChat}
          title={hasChat ? undefined : "Say something first — the scene is composed from the conversation"}
        >
          Generate scene
        </Button>
      </div>
      {sceneList.length === 0 ? (
        <p className="text-sm text-paper-500">
          No scenes yet. “Generate scene” paints the current moment from your recent exchange.
        </p>
      ) : (
        <div className="flex gap-2.5 overflow-x-auto pb-1">
          {sceneList.map((img) => {
            const error = sceneError(img);
            return (
              <div key={img.id} className="w-28 shrink-0">
                {img.status === "pending" ? (
                  <Skeleton className="aspect-[3/4] w-full rounded-card" />
                ) : img.status === "failed" ? (
                  <div className="flex aspect-[3/4] w-full flex-col justify-center gap-1.5 rounded-card border border-ink-600 bg-ink-950/60 px-2 py-3">
                    <Tag tone="danger" className="self-start">
                      failed
                    </Tag>
                    <p className="max-h-20 overflow-y-auto text-[11px] break-words text-paper-400" title={error ?? undefined}>
                      {error ?? "The image provider returned an error."}
                    </p>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setEnlarged({ id: img.id, caption: img.prompt || null })}
                    aria-label="Enlarge scene image"
                    className="block w-full cursor-pointer overflow-hidden rounded-card border border-ink-600 transition-colors hover:border-accent-500/60"
                  >
                    <EntityImage imageId={img.id} name={name} className="aspect-[3/4] w-full" />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      <ImageLightbox
        imageId={enlarged?.id ?? null}
        alt={name}
        caption={enlarged?.caption ?? null}
        onClose={() => setEnlarged(null)}
      />
    </div>
  );
}
