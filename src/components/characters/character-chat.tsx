"use client";

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { ChatActionId } from "@/contracts";
import {
  chatsApi,
  chatStateSnapshotSchema,
  sendChatMessage,
  type ChatMessage,
  type ChatStateSnapshot,
  type ChatStreamOutcome,
} from "@/lib/client/api";
import { NARRATIVE_MODELS } from "@/lib/narrative-models";
import { useAsyncData } from "@/components/hooks/use-async";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { ErrorState } from "@/components/ui/error-state";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { AvatarPanel } from "@/components/avatar";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { MessageBubble, type ChatLine } from "./chat-message";
import { ChatScenarioModal } from "./chat-scenario-modal";
import { SceneStrip } from "./chat-scene-strip";
import { ChatStateToolsModal } from "./chat-state-tools";
import { ActionChips, StatusStrip } from "./chat-status";

export interface CharacterChatProps {
  characterId: string;
  name: string;
  avatarImageId: string | null;
  /**
   * The authored Starting Relationship (`playerRelationship.stage`) from the live editor
   * draft. A fresh chat (no stored state) previews it in the strip chip so changing the
   * dropdown updates the chip immediately — before it's even saved. Editable in the Scenario
   * setup modal, which writes it back through `onStartingStageChange`.
   */
  startingStage: string;
  /** Write a Starting Relationship change back to the character profile draft (editor SaveBar persists it). */
  onStartingStageChange: (stage: string) => void;
  /**
   * The narrator model the dropdown shows (a resolved `NARRATIVE_MODELS` id). Owned by
   * the page so it outlives this tab unmounting — picking a model here calls
   * `onChatModelChange`, which updates that state *and* persists it to the character
   * (`characters.chatModel`), so the choice is still selected on return.
   */
  chatModel: string;
  onChatModelChange: (modelId: string) => void;
}

/** What the mount-time bootstrap resolves: the adopted conversation (or none) + its transcript. */
interface ChatBootstrap {
  chatId: string | null;
  messages: ChatMessage[];
}

/**
 * Stand-in snapshot for a tab whose conversation doesn't exist yet: there is no state
 * row to read (and GET must not create one), so the pre-chat Scenario form seeds from
 * parsed defaults. The form only patches the fields the author touched, so the server's
 * profile seeding (authored stage, social cards) still applies when the row is created.
 */
const EMPTY_CHAT_STATE: ChatStateSnapshot = chatStateSnapshotSchema.parse({ persisted: false });

/**
 * The in-character chat tab (docs/developer-notes/character-chat-standalone.spec.md):
 * talk to a saved library character directly. Conversations are first-class rows now —
 * the tab adopts the character's most recent active conversation on mount, and a fresh
 * tab creates one lazily on the first action that needs it (`ensureChat`). Replies
 * stream token-by-token; a manual button renders a scene image from the recent exchange
 * (filed against the character, so it also lands in the Gallery under "Character chats").
 */
export function CharacterChat({
  characterId,
  name,
  avatarImageId,
  startingStage,
  onStartingStageChange,
  chatModel,
  onChatModelChange,
}: CharacterChatProps) {
  const toast = useToast();
  const who = name.trim() || "this character";

  // Adopt the most recent active conversation for this character (or none), and load
  // its transcript in the same fetch so the tab settles in one shape. The full Chats
  // hub / picker is a later slice — the editor tab shows a single conversation.
  const bootstrap = useAsyncData<ChatBootstrap>(async () => {
    const chats = await chatsApi.list(characterId);
    if (!chats.ok) return chats;
    const latest = chats.data[0]?.id ?? null;
    if (latest === null) return { ok: true, data: { chatId: null, messages: [] } };
    const transcript = await chatsApi.transcript(latest);
    if (!transcript.ok) return transcript;
    return { ok: true, data: { chatId: latest, messages: transcript.data } };
  }, [characterId]);
  // Actions are held until the adopt-or-none lookup settles, so a send can never
  // create a second conversation while the existing one is still resolving.
  const ready = !bootstrap.loading && bootstrap.error === null;

  // The active conversation id: seeded from the bootstrap, null for a fresh tab
  // (created lazily by ensureChat), reset to null by Delete chat.
  const [chatId, setChatId] = useState<string | null>(null);
  const [lines, setLines] = useState<ChatLine[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // Light chat state (character-chat-state.spec.md): the strip + premise. Held in
  // local state (not useAsyncData) so a post-send refresh can drive the
  // stage-change toast off the value it just fetched.
  const [chatState, setChatState] = useState<ChatStateSnapshot | null>(null);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [scenarioOpen, setScenarioOpen] = useState(false);
  const [actionBusy, setActionBusy] = useState<ChatActionId | null>(null);
  const stageRef = useRef<string | null>(null);
  const tempId = useRef(0);
  const mkId = () => `tmp-${tempId.current++}`;
  // Mirrors `sending` synchronously so the post-send id-reconcile can bail if a
  // new send started in the await window (state would be stale in the closure).
  const sendingRef = useRef(false);
  // The in-flight reply's AbortController (null when idle). Rerun aborts it so the
  // UI stops expecting tokens; the server still drains + persists the reply, and the
  // post-resend transcript reload reconciles. Each stream owns it while active —
  // a superseding stream (rerun) installs its own, so a stale one can't clear it.
  const abortRef = useRef<AbortController | null>(null);

  // Single-flight lazy create (character-chat-standalone.spec.md §2): every "first
  // action that needs a conversation" funnels through this promise, so rapid actions
  // can't double-create. It stays resolved after success (later calls reuse the id);
  // a failure clears it so the next action retries.
  const createRef = useRef<Promise<string | null> | null>(null);
  const ensureChat = useCallback((): Promise<string | null> => {
    if (chatId) return Promise.resolve(chatId);
    createRef.current ??= chatsApi.create({ characterId, memory: "shared" }).then((result) => {
      if (!result.ok) {
        createRef.current = null; // allow the next action to retry
        return null;
      }
      setChatId(result.data.id);
      return result.data.id;
    });
    return createRef.current;
  }, [chatId, characterId]);

  // A character switch invalidates any settled/in-flight create for the old one.
  useEffect(() => {
    createRef.current = null;
  }, [characterId]);

  // Seed the conversation + transcript from the bootstrap exactly once per character
  // (the "adjust state while rendering" pattern) so a streamed/optimistic reply is
  // never clobbered by the fetch settling; switching characters re-seeds.
  const [seededFor, setSeededFor] = useState<string | null>(null);
  if (seededFor !== characterId && !bootstrap.loading && bootstrap.data) {
    setSeededFor(characterId);
    setChatId(bootstrap.data.chatId);
    setLines(bootstrap.data.messages.map((m) => ({ id: m.id, role: m.role, content: m.content })));
  }

  // Load the light state once a conversation exists. With no chat there is no state
  // row to read (and GET must not create one), so the strip/state UI simply waits.
  // Keyed on chatState too: a settled write (modal save, post-send refresh) cancels a
  // straggling initial GET instead of letting it clobber the fresher snapshot.
  useEffect(() => {
    if (!chatId || chatState !== null) return;
    let cancelled = false;
    void chatsApi.state(chatId).then((r) => {
      if (cancelled || !r.ok) return;
      setChatState(r.data);
      stageRef.current = r.data.stage.label;
    });
    return () => {
      cancelled = true;
    };
  }, [chatId, chatState]);

  // Auto-scroll the message *list* (not the page) to the newest line as the
  // conversation grows / streams. Setting the container's scrollTop directly keeps
  // the scroll contained: `scrollIntoView` bubbles to every ancestor incl. the
  // window, which shoved the composer below the fold on each send.
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  /** Refetch the state strip; toast when the affinity stage changed (the romance arc made visible). */
  const refreshState = async (id: string) => {
    const prior = stageRef.current;
    const result = await chatsApi.state(id);
    if (!result.ok) return;
    setChatState(result.data);
    if (prior && result.data.stage.label !== prior) {
      toast.push({ title: `${who} now regards you as ${result.data.stage.label.toLowerCase()}.` });
    }
    stageRef.current = result.data.stage.label;
  };

  /**
   * Shared streaming flow for both a normal send and the Prompt Character opening
   * beat: append an optimistic assistant bubble (and a user line, if any), resolve
   * the conversation (creating it lazily on this first action), stream the reply
   * into it, then reconcile temp-ids against the persisted transcript and refresh
   * the state strip. `userLine` omitted ⇒ the opening beat (no player line).
   */
  const runStream = async (
    body: { content?: string; model?: string; open?: boolean },
    userLine?: string,
  ): Promise<ChatStreamOutcome> => {
    const assistantId = mkId();
    setLines((prev) => [
      ...prev,
      ...(userLine !== undefined ? [{ id: mkId(), role: "user" as const, content: userLine }] : []),
      { id: assistantId, role: "assistant" as const, content: "" },
    ]);
    const controller = new AbortController();
    abortRef.current = controller;
    sendingRef.current = true;
    setSending(true);
    const id = await ensureChat();
    if (id === null) {
      if (abortRef.current === controller) {
        abortRef.current = null;
        sendingRef.current = false;
        setSending(false);
      }
      setLines((prev) => prev.filter((l) => !(l.id === assistantId && l.content === "")));
      return {
        ok: false,
        error: { status: 0, code: "chat_create_failed", message: "The conversation couldn't be created." },
      };
    }
    const outcome = await sendChatMessage(
      id,
      body,
      (delta) => {
        setLines((prev) => prev.map((l) => (l.id === assistantId ? { ...l, content: l.content + delta } : l)));
      },
      controller.signal,
    );
    // Only release the busy state if we're still the active stream — a rerun may
    // have aborted us and installed its own controller, which now owns `sending`.
    const superseded = abortRef.current !== controller;
    if (!superseded) {
      abortRef.current = null;
      sendingRef.current = false;
      setSending(false);
    }
    if (outcome.aborted || superseded) {
      // Cancelled by a rerun: drop our empty bubble and let the newer flow own the UI.
      setLines((prev) => prev.filter((l) => !(l.id === assistantId && l.content === "")));
      return outcome;
    }
    if (!outcome.ok) {
      // Drop the empty reply bubble (a partial reply, if any streamed, stays).
      setLines((prev) => prev.filter((l) => !(l.id === assistantId && l.content === "")));
      return outcome;
    }
    // Swap the optimistic temp-ids for the persisted ids so the exchange just sent
    // is immediately editable/deletable. Skip if another send already started.
    const fresh = await chatsApi.transcript(id);
    if (fresh.ok && !sendingRef.current) {
      setLines(fresh.data.map((m) => ({ id: m.id, role: m.role, content: m.content })));
    }
    // The pulse + drift settle server-side as the stream finalizes; refetch the
    // strip so the disposition (and any stage change) shows after the exchange.
    await refreshState(id);
    return outcome;
  };

  const send = async () => {
    const content = input.trim();
    if (!content || sendingRef.current || !ready) return;
    setInput("");
    const outcome = await runStream({ content, model: chatModel }, content);
    if (!outcome.ok) toast.push({ title: "Reply failed", description: outcome.error?.message, tone: "error" });
  };

  /** Overwrite one message's text in place; updates the line on success. */
  const editLine = async (id: string, content: string): Promise<boolean> => {
    if (!chatId) return false;
    const result = await chatsApi.editMessage(chatId, id, content);
    if (result.ok) {
      setLines((prev) => prev.map((l) => (l.id === id ? { ...l, content } : l)));
      return true;
    }
    toast.push({ title: "Edit failed", description: result.error.message, tone: "error" });
    return false;
  };

  /** Delete a single message; removes the line on success. */
  const deleteLine = async (id: string) => {
    if (!chatId) return;
    const result = await chatsApi.deleteMessage(chatId, id);
    if (result.ok) {
      setLines((prev) => prev.filter((l) => l.id !== id));
    } else {
      toast.push({ title: "Delete failed", description: result.error.message, tone: "error" });
    }
  };

  /**
   * Rerun a user message: cancel any in-flight reply, snip this line and everything
   * after it out of the transcript, then re-send the same prompt for a fresh reply.
   * Aborting only stops the UI waiting — inference already running can't be stopped,
   * so the server still drains/persists that reply; we delete its row here and the
   * post-resend transcript reload reconciles to server truth. The user line is
   * deleted too because the resend re-inserts it (the POST always appends the line),
   * so keeping it would duplicate it.
   */
  const rerun = async (id: string) => {
    if (!chatId) return;
    const idx = lines.findIndex((l) => l.id === id);
    const target = lines[idx];
    if (!target || target.role !== "user") return;
    const content = target.content;
    // Cancel the in-flight reply (if any) so its stream stops updating the UI.
    abortRef.current?.abort();
    // Drop this line + everything after it optimistically, and delete the persisted
    // rows server-side (temp/streaming lines have no row yet — skip them; ignore 404s).
    const doomed = lines.slice(idx).filter((l) => !l.id.startsWith("tmp-"));
    setLines((prev) => prev.slice(0, idx));
    await Promise.all(doomed.map((l) => chatsApi.deleteMessage(chatId, l.id)));
    const outcome = await runStream({ content, model: chatModel }, content);
    if (!outcome.ok && !outcome.aborted) {
      toast.push({ title: "Rerun failed", description: outcome.error?.message, tone: "error" });
    }
  };

  const onComposerKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  /** Apply a one-click test-bed action chip (offer a drink → intoxication↑, etc.). */
  const runAction = async (action: ChatActionId) => {
    if (!chatId) return;
    setActionBusy(action);
    const result = await chatsApi.applyAction(chatId, action);
    setActionBusy(null);
    if (result.ok) {
      setChatState(result.data);
      stageRef.current = result.data.stage.label;
    } else {
      toast.push({ title: "Action failed", description: result.error.message, tone: "error" });
    }
  };

  /** Prompt Character (opening beat): stream a character-authored opening turn (the premise comes from chat state). */
  const promptCharacter = async () => {
    if (sendingRef.current || !ready) return;
    const outcome = await runStream({ open: true, model: chatModel });
    if (!outcome.ok) toast.push({ title: "Couldn't open the scene", description: outcome.error?.message, tone: "error" });
  };

  /**
   * Delete chat (character-chat-standalone.spec.md §1.4): hard-delete the conversation
   * row — transcript, summary, state, and its memory go with it — then reset to the
   * fresh-tab shape (a next action lazily creates a new conversation).
   */
  const deleteChat = async () => {
    if (!chatId) return;
    setDeleting(true);
    const result = await chatsApi.remove(chatId);
    setDeleting(false);
    setDeleteOpen(false);
    if (!result.ok) {
      toast.push({ title: "Delete failed", description: result.error.message, tone: "error" });
      return;
    }
    createRef.current = null; // the settled create points at the deleted row
    setChatId(null);
    setLines([]);
    setChatState(null);
    stageRef.current = null;
    toast.push({ title: "Chat deleted" });
  };

  return (
    <div className="flex flex-col gap-5">
      <SceneStrip chatId={chatId} ensureChat={ensureChat} name={name} hasChat={lines.length > 0} />

      {/* The standing companion portrait sits beside the conversation. */}
      <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:gap-6">
        {ready ? (
          <AvatarPanel
            name={name}
            avatarImageId={avatarImageId}
            className="mx-auto w-full max-w-56 lg:mx-0 lg:w-60 lg:max-w-none lg:shrink-0"
          />
        ) : null}

        <div className="flex min-w-0 flex-1 flex-col gap-5">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-xs font-medium tracking-wide text-paper-400 uppercase">Conversation</h3>
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Select
                aria-label="Narrator model"
                value={chatModel}
                onChange={(e) => onChatModelChange(e.target.value)}
                className="h-8 w-44 text-xs"
              >
                {NARRATIVE_MODELS.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </Select>
              {ready ? (
                <Button size="sm" variant="quiet" disabled={sending} onClick={promptCharacter} title={`Let ${who} open the scene`}>
                  Prompt {who}
                </Button>
              ) : null}
              {ready ? (
                <Button size="sm" variant="quiet" onClick={() => setScenarioOpen(true)}>
                  Scenario setup
                </Button>
              ) : null}
              {chatState ? (
                <Button size="sm" variant="quiet" onClick={() => setToolsOpen(true)}>
                  State tools
                </Button>
              ) : null}
              {chatId ? (
                <Button size="sm" variant="quiet" onClick={() => setDeleteOpen(true)}>
                  Delete chat…
                </Button>
              ) : null}
            </div>
          </div>

          <div
            ref={scrollRef}
            className="flex max-h-[28rem] min-h-48 flex-col gap-3 overflow-y-auto rounded-card border border-ink-600 bg-ink-950/40 p-4"
          >
            {bootstrap.loading ? (
              <div className="flex flex-col gap-3">
                <Skeleton className="h-10 w-2/3" />
                <Skeleton className="h-10 w-1/2 self-end" />
              </div>
            ) : bootstrap.error ? (
              <ErrorState error={bootstrap.error} onRetry={() => bootstrap.reload()} />
            ) : lines.length === 0 ? (
              <p className="m-auto max-w-sm text-center text-sm text-paper-500">
                Say something to {who} to start the conversation. This chat lives only here — no world, no session.
              </p>
            ) : (
              lines.map((line) => (
                <MessageBubble
                  key={line.id}
                  line={line}
                  name={name}
                  avatarImageId={avatarImageId}
                  streaming={sending}
                  onEdit={editLine}
                  onDelete={deleteLine}
                  onRerun={rerun}
                />
              ))
            )}
          </div>

          {chatState ? (
            <div className="flex flex-col gap-2">
              <StatusStrip state={chatState} startingStage={startingStage} />
              <ActionChips busy={actionBusy} disabled={sending} onAction={runAction} />
            </div>
          ) : null}

          <div className="flex items-end gap-2">
            <Textarea
              rows={2}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onComposerKeyDown}
              placeholder={`Message ${who}…  (Enter to send, Shift+Enter for a new line)`}
              className="flex-1"
            />
            <Button variant="primary" onClick={send} busy={sending} disabled={!input.trim() || !ready}>
              Send
            </Button>
          </div>
        </div>
      </div>

      <Dialog
        open={deleteOpen}
        onClose={() => {
          if (!deleting) setDeleteOpen(false);
        }}
        title="Delete this chat?"
        footer={
          <div className="flex justify-end gap-2">
            <Button onClick={() => setDeleteOpen(false)} disabled={deleting}>
              Cancel
            </Button>
            <Button variant="danger" onClick={deleteChat} disabled={deleting}>
              {deleting ? "Deleting…" : "Delete chat"}
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-3 text-sm text-paper-400">
          <p>
            This deletes the conversation and its memory: the transcript, the running summary, {who}&rsquo;s
            disposition (affinity, mood, scenario), and everything {who} remembers about you from it. A new chat
            starts fresh from the authored defaults — this can&rsquo;t be undone.
          </p>
          <p className="text-xs text-paper-500">Generated scene images are kept — find them in the Gallery.</p>
        </div>
      </Dialog>

      {chatState ? (
        <ChatStateToolsModal
          open={toolsOpen}
          onClose={() => setToolsOpen(false)}
          chatId={chatId}
          ensureChat={ensureChat}
          who={who}
          snapshot={chatState}
          onSaved={(next) => {
            setChatState(next);
            stageRef.current = next.stage.label;
          }}
        />
      ) : null}

      {ready ? (
        <ChatScenarioModal
          open={scenarioOpen}
          onClose={() => setScenarioOpen(false)}
          chatId={chatId}
          ensureChat={ensureChat}
          who={who}
          snapshot={chatState ?? EMPTY_CHAT_STATE}
          startingStage={startingStage}
          onStartingStageChange={onStartingStageChange}
          onSaved={(next) => {
            setChatState(next);
            stageRef.current = next.stage.label;
          }}
        />
      ) : null}
    </div>
  );
}
