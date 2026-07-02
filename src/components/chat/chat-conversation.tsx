"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import type { ChatActionId } from "@/contracts";
import {
  charactersApi,
  chatsApi,
  sendChatMessage,
  type ChatStateSnapshot,
  type ChatStreamOutcome,
  type ChatTranscript,
} from "@/lib/client/api";
import { NARRATIVE_MODELS, resolveChatModelId } from "@/lib/narrative-models";
import { useAsyncData } from "@/components/hooks/use-async";
import { useIsMobile } from "@/components/hooks/use-is-mobile";
import { AvatarPanel } from "@/components/avatar";
import { MessageBubble, type ChatLine } from "@/components/characters/chat-message";
import { ChatScenarioModal } from "@/components/characters/chat-scenario-modal";
import { SceneStrip } from "@/components/characters/chat-scene-strip";
import { ChatStateToolsModal } from "@/components/characters/chat-state-tools";
import { ActionChips, StatusStrip } from "@/components/characters/chat-status";
import { Button } from "@/components/ui/button";
import { cx } from "@/components/ui/cx";
import { Dialog } from "@/components/ui/dialog";
import { EntityImage } from "@/components/ui/entity-image";
import { ErrorState } from "@/components/ui/error-state";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Sheet } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";

/**
 * The full-screen conversation page (`/chat/[chatId]`,
 * character-chat-standalone.spec.md §2.2): mobile-first single column filling the
 * viewport below the 3.25rem app header (the bottom tab bar is suppressed on this
 * route — the composer owns the bottom edge). Header row: back to the Chats hub,
 * portrait, name/title, and a menu (bottom Sheet on phones, popover at ≥md) holding
 * the narrator-model pick, Scenario setup, State tools, Rename, Archive/Restore and
 * Delete. The portrait + scene strip sit in a collapsible section under the header
 * (collapsed by default on small screens). Unlike the old editor tab there is no
 * lazy create: the conversation always exists — `chatId` is the address of record.
 */
export function ChatConversation({ chatId }: { chatId: string }) {
  const router = useRouter();
  const toast = useToast();
  const isMobile = useIsMobile();

  // One GET settles the whole screen: transcript + chat header + character card.
  const bootstrap = useAsyncData<ChatTranscript>(() => chatsApi.transcript(chatId), [chatId]);
  const ready = !bootstrap.loading && bootstrap.error === null;
  const character = bootstrap.data?.character ?? null;
  const name = character?.name ?? "";
  const who = name.trim() || "this character";

  const [lines, setLines] = useState<ChatLine[]>([]);
  // Mutable chat header (rename / archive write through these mirrors).
  const [title, setTitle] = useState("");
  const [archived, setArchived] = useState(false);
  const [chatModel, setChatModel] = useState(() => resolveChatModelId(null));
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  // Light chat state (character-chat-state.spec.md): the strip + premise. Held in
  // local state (not useAsyncData) so a post-send refresh can drive the
  // stage-change toast off the value it just fetched.
  const [chatState, setChatState] = useState<ChatStateSnapshot | null>(null);
  const [actionBusy, setActionBusy] = useState<ChatActionId | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [scenarioOpen, setScenarioOpen] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [archiveBusy, setArchiveBusy] = useState(false);
  // The portrait/scene disclosure: null = breakpoint default (collapsed on phones,
  // open at ≥md); a tap remembers the choice for this mount only (component state).
  const [panelChoice, setPanelChoice] = useState<boolean | null>(null);
  const panelOpen = panelChoice ?? !isMobile;

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
  /** Bumped per chat-model pick so a superseded pick is skipped, plus the serializing chain. */
  const chatModelGenRef = useRef(0);
  const chatModelChainRef = useRef<Promise<void>>(Promise.resolve());
  /** Wraps the menu trigger + desktop popover, for the popover's outside-click test. */
  const menuWrapRef = useRef<HTMLDivElement>(null);

  // Seed the transcript + chat header from the bootstrap exactly once per chatId
  // (the "adjust state while rendering" pattern) so a streamed/optimistic reply is
  // never clobbered by the fetch settling. `!loading` keeps a stale previous-chat
  // payload from seeding during a chatId switch.
  const [seededFor, setSeededFor] = useState<string | null>(null);
  if (seededFor !== chatId && !bootstrap.loading && bootstrap.data) {
    setSeededFor(chatId);
    setLines(bootstrap.data.messages.map((m) => ({ id: m.id, role: m.role, content: m.content })));
    setTitle(bootstrap.data.chat.title);
    setArchived(bootstrap.data.chat.archivedAt !== null);
    setChatModel(resolveChatModelId(bootstrap.data.character.chatModel));
    // Resetting chatState (not stageRef — refs can't be written in render) re-runs
    // the load effect below, which re-seeds stageRef from the fresh snapshot before
    // any send can compare against it.
    setChatState(null);
  }

  // Load the light state (the conversation always exists, so GET always returns a
  // snapshot — a seed-on-read pre-first-exchange). Keyed on chatState too: a settled
  // write (modal save, post-send refresh) cancels a straggling initial GET instead
  // of letting it clobber the fresher snapshot.
  useEffect(() => {
    if (chatState !== null) return;
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

  // Auto-scroll the transcript (not the page) to the newest line as the
  // conversation grows / streams. Setting scrollTop directly keeps the scroll
  // contained — `scrollIntoView` bubbles to every ancestor incl. the window.
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  /** Refetch the state strip; toast when the affinity stage changed (the romance arc made visible). */
  const refreshState = async () => {
    const prior = stageRef.current;
    const result = await chatsApi.state(chatId);
    if (!result.ok) return;
    setChatState(result.data);
    if (prior && result.data.stage.label !== prior) {
      toast.push({ title: `${who} now regards you as ${result.data.stage.label.toLowerCase()}.` });
    }
    stageRef.current = result.data.stage.label;
  };

  /**
   * Shared streaming flow for a normal send and the Prompt Character opening beat:
   * append an optimistic assistant bubble (and a user line, if any), stream the
   * reply into it, then reconcile temp-ids against the persisted transcript and
   * refresh the state strip. `userLine` omitted ⇒ the opening beat.
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
    const outcome = await sendChatMessage(
      chatId,
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
    if (outcome.aborted || superseded || !outcome.ok) {
      // Cancelled or failed: drop our empty bubble (a partial reply, if any, stays).
      setLines((prev) => prev.filter((l) => !(l.id === assistantId && l.content === "")));
      // The server 409s sends into an archived conversation — flip to read-only.
      if (!outcome.ok && outcome.error?.code === "chat_archived") setArchived(true);
      return outcome;
    }
    // Swap the optimistic temp-ids for the persisted ids so the exchange just sent
    // is immediately editable/deletable. Skip if another send already started.
    const fresh = await chatsApi.transcript(chatId);
    if (fresh.ok && !sendingRef.current) {
      setLines(fresh.data.messages.map((m) => ({ id: m.id, role: m.role, content: m.content })));
    }
    // The pulse + drift settle server-side as the stream finalizes; refetch the
    // strip so the disposition (and any stage change) shows after the exchange.
    await refreshState();
    return outcome;
  };

  const send = async () => {
    const content = input.trim();
    if (!content || sendingRef.current || !ready || archived) return;
    setInput("");
    const outcome = await runStream({ content, model: chatModel }, content);
    if (!outcome.ok) toast.push({ title: "Reply failed", description: outcome.error?.message, tone: "error" });
  };

  /** Overwrite one message's text in place; updates the line on success. */
  const editLine = async (id: string, content: string): Promise<boolean> => {
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
   * deleted too because the resend re-inserts it (the POST always appends the line).
   */
  const rerun = async (id: string) => {
    if (archived) return;
    const idx = lines.findIndex((l) => l.id === id);
    const target = lines[idx];
    if (!target || target.role !== "user") return;
    const content = target.content;
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

  const onComposerKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  /** Apply a one-click test-bed action chip (offer a drink → intoxication↑, etc.). */
  const runAction = async (action: ChatActionId) => {
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
    if (sendingRef.current || !ready || archived) return;
    const outcome = await runStream({ open: true, model: chatModel });
    if (!outcome.ok) toast.push({ title: "Couldn't open the scene", description: outcome.error?.message, tone: "error" });
  };

  /**
   * Persist the narrator pick immediately (save-on-update), same guarantees as the
   * editor tab: PATCHes serialize through a promise chain so rapid picks can't land
   * out of order server-side; a pick superseded before its turn is skipped entirely.
   */
  const saveChatModel = (modelId: string) => {
    const characterId = character?.id;
    if (!characterId) return;
    setChatModel(modelId);
    const gen = ++chatModelGenRef.current;
    chatModelChainRef.current = chatModelChainRef.current.then(async () => {
      if (gen !== chatModelGenRef.current) return; // a newer pick superseded this one
      const result = await charactersApi.update(characterId, { chatModel: modelId });
      if (gen !== chatModelGenRef.current) return;
      if (!result.ok) {
        toast.push({ title: "Couldn't save the chat model", description: result.error.message, tone: "error" });
      }
    });
  };

  /** Archive shelves (read-only, restorable); restore reopens — the everyday lifecycle pair. */
  const toggleArchived = async () => {
    const next = !archived;
    setArchiveBusy(true);
    const result = await chatsApi.update(chatId, { archived: next });
    setArchiveBusy(false);
    setMenuOpen(false);
    if (result.ok) {
      setArchived(next);
      toast.push({ title: next ? "Conversation archived" : "Conversation restored" });
    } else {
      toast.push({ title: "Update failed", description: result.error.message, tone: "error" });
    }
  };

  const renameChat = async (nextTitle: string): Promise<boolean> => {
    const result = await chatsApi.update(chatId, { title: nextTitle });
    if (result.ok) {
      setTitle(nextTitle);
      return true;
    }
    toast.push({ title: "Rename failed", description: result.error.message, tone: "error" });
    return false;
  };

  /** Hard delete (spec §1.4): transcript, summary, state and memory go; back to the hub. */
  const deleteChat = async () => {
    setDeleting(true);
    const result = await chatsApi.remove(chatId);
    setDeleting(false);
    if (!result.ok) {
      setDeleteOpen(false);
      toast.push({ title: "Delete failed", description: result.error.message, tone: "error" });
      return;
    }
    toast.push({ title: "Chat deleted" });
    router.push("/chat");
  };

  /** Menu actions close the menu, then open their surface (dialog/modal). */
  const menuAction = (open: () => void) => () => {
    setMenuOpen(false);
    open();
  };
  const menuBody = (
    <ConversationMenu
      chatModel={chatModel}
      onChatModelChange={saveChatModel}
      hasState={chatState !== null}
      archived={archived}
      archiveBusy={archiveBusy}
      onScenario={menuAction(() => setScenarioOpen(true))}
      onStateTools={menuAction(() => setToolsOpen(true))}
      onRename={menuAction(() => setRenameOpen(true))}
      onArchiveToggle={() => void toggleArchived()}
      onDelete={menuAction(() => setDeleteOpen(true))}
    />
  );

  const premise = chatState?.premise.trim() ?? "";

  return (
    // Fills the viewport below the 3.25rem app header (see app-shell.tsx — do not
    // let that constant drift); the transcript scrolls internally, the composer
    // owns the bottom edge (the bottom tab bar is suppressed on /chat/[chatId]).
    <div className="flex h-[calc(100dvh-3.25rem)] min-h-0 flex-col">
      <header className="flex shrink-0 items-center gap-2.5 border-b border-ink-600 bg-ink-900/95 px-3 py-2 sm:px-4">
        <Link
          href="/chat"
          aria-label="Back to chats"
          className="touch-target -ml-1 inline-flex shrink-0 items-center justify-center rounded-md px-1.5 py-1 text-paper-400 transition-colors hover:text-paper-100"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden className="size-5">
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </Link>
        {character ? (
          <>
            <EntityImage imageId={character.avatarImageId} name={name} className="size-8 shrink-0 rounded-full text-xs" />
            <div className="min-w-0 flex-1">
              {/* Auto-title: an unnamed conversation is titled by its character. */}
              <p className="truncate text-sm text-paper-100">{title || name}</p>
              {title ? <p className="truncate text-[11px] text-paper-500">{name}</p> : null}
            </div>
          </>
        ) : (
          <Skeleton className="h-8 flex-1" />
        )}
        <div ref={menuWrapRef} className="relative shrink-0">
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label="Conversation menu"
            disabled={!ready}
            className="touch-target inline-flex cursor-pointer items-center justify-center rounded-md px-2 py-1 text-paper-400 transition-colors hover:text-paper-100 disabled:cursor-not-allowed disabled:text-paper-600"
          >
            <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden className="size-5">
              <circle cx="5" cy="12" r="1.6" />
              <circle cx="12" cy="12" r="1.6" />
              <circle cx="19" cy="12" r="1.6" />
            </svg>
          </button>
          {!isMobile && menuOpen ? (
            <MenuPopover wrapRef={menuWrapRef} onClose={() => setMenuOpen(false)}>
              {menuBody}
            </MenuPopover>
          ) : null}
        </div>
      </header>

      {isMobile ? (
        <Sheet open={menuOpen} onClose={() => setMenuOpen(false)} side="bottom" title="Conversation">
          {menuBody}
        </Sheet>
      ) : null}

      {archived ? (
        <div className="flex shrink-0 items-center justify-center gap-2 border-b border-ink-600 bg-ink-800/80 px-4 py-1 text-xs text-paper-400">
          <span>Archived — restore to continue.</span>
          <Button size="sm" variant="quiet" busy={archiveBusy} onClick={() => void toggleArchived()}>
            Restore
          </Button>
        </div>
      ) : null}

      {/* Portrait + scene strip: a disclosure so the transcript keeps the room on phones. */}
      <section className="shrink-0 border-b border-ink-600">
        <button
          type="button"
          aria-expanded={panelOpen}
          onClick={() => setPanelChoice(!panelOpen)}
          className="flex w-full cursor-pointer items-center justify-between px-4 py-1.5 text-xs font-medium tracking-wide text-paper-400 uppercase transition-colors hover:text-paper-200"
        >
          <span>Portrait &amp; scenes</span>
          <svg
            viewBox="0 0 16 16"
            fill="none"
            aria-hidden
            className={cx("size-3.5 transition-transform", panelOpen && "rotate-180")}
          >
            <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        {panelOpen && ready && character ? (
          <div className="flex flex-col gap-4 px-4 pb-3 sm:flex-row sm:items-start">
            <AvatarPanel
              name={name}
              avatarImageId={character.avatarImageId}
              className="mx-auto w-32 shrink-0 sm:mx-0 sm:w-40"
            />
            <div className="min-w-0 flex-1">
              <SceneStrip chatId={chatId} name={name} hasChat={lines.length > 0} />
            </div>
          </div>
        ) : null}
      </section>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="mx-auto flex max-w-3xl flex-col gap-3">
          {bootstrap.loading ? (
            <div className="flex flex-col gap-3">
              <Skeleton className="h-10 w-2/3" />
              <Skeleton className="h-10 w-1/2 self-end" />
              <Skeleton className="h-10 w-3/5" />
            </div>
          ) : bootstrap.error ? (
            <ErrorState error={bootstrap.error} onRetry={() => bootstrap.reload()} />
          ) : lines.length === 0 ? (
            <p className="m-auto max-w-sm py-10 text-center text-sm text-paper-500">
              Say something to {who} to start the conversation — or let them open the scene with Prompt {who} below.
            </p>
          ) : (
            lines.map((line) => (
              <MessageBubble
                key={line.id}
                line={line}
                name={name}
                avatarImageId={character?.avatarImageId ?? null}
                streaming={sending}
                onEdit={editLine}
                onDelete={deleteLine}
                onRerun={(id) => void rerun(id)}
              />
            ))
          )}
        </div>
      </div>

      <div className="shrink-0 border-t border-ink-600 bg-ink-900/95 px-4 pt-2.5 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
        <div className="mx-auto flex max-w-3xl flex-col gap-2">
          {premise && !archived ? (
            <button
              type="button"
              onClick={() => setScenarioOpen(true)}
              title={premise}
              className="cursor-pointer truncate text-left text-xs text-paper-500 transition-colors hover:text-paper-300"
            >
              Scenario: {premise}
            </button>
          ) : null}
          {!archived ? (
            <div className="flex flex-wrap items-center justify-between gap-2">
              {chatState ? <StatusStrip state={chatState} /> : <span />}
              <Button
                size="sm"
                variant="quiet"
                disabled={sending || !ready}
                onClick={() => void promptCharacter()}
                title={`Let ${who} open the scene`}
              >
                Prompt {who}
              </Button>
            </div>
          ) : null}
          {chatState && !archived ? <ActionChips busy={actionBusy} disabled={sending} onAction={(a) => void runAction(a)} /> : null}
          <div className="flex items-end gap-2">
            <Textarea
              rows={2}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onComposerKeyDown}
              disabled={archived}
              placeholder={
                archived ? "This conversation is archived." : `Message ${who}…  (Enter to send, Shift+Enter for a new line)`
              }
              className="flex-1"
            />
            <Button variant="primary" onClick={() => void send()} busy={sending} disabled={archived || !ready || !input.trim()}>
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
            <Button variant="danger" onClick={() => void deleteChat()} disabled={deleting}>
              {deleting ? "Deleting…" : "Delete chat"}
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-3 text-sm text-paper-400">
          <p>
            This deletes the conversation and its memory: the transcript, the running summary, {who}&rsquo;s
            disposition (affinity, mood, scenario), and everything {who} remembers about you from it. Archiving
            keeps all of that — this can&rsquo;t be undone.
          </p>
          <p className="text-xs text-paper-500">Generated scene images are kept — find them in the Gallery.</p>
        </div>
      </Dialog>

      {renameOpen ? (
        <RenameDialog
          title={title}
          placeholder={name}
          onClose={() => setRenameOpen(false)}
          onRename={renameChat}
        />
      ) : null}

      {chatState ? (
        <ChatStateToolsModal
          open={toolsOpen}
          onClose={() => setToolsOpen(false)}
          chatId={chatId}
          who={who}
          snapshot={chatState}
          onSaved={(next) => {
            setChatState(next);
            stageRef.current = next.stage.label;
          }}
        />
      ) : null}

      {chatState ? (
        <ChatScenarioModal
          open={scenarioOpen}
          onClose={() => setScenarioOpen(false)}
          chatId={chatId}
          who={who}
          snapshot={chatState}
          onSaved={(next) => {
            setChatState(next);
            stageRef.current = next.stage.label;
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * The header menu body, shared by the two hosts (bottom Sheet on phones, popover at
 * ≥md): the narrator-model pick + the conversation's lifecycle actions.
 */
function ConversationMenu({
  chatModel,
  onChatModelChange,
  hasState,
  archived,
  archiveBusy,
  onScenario,
  onStateTools,
  onRename,
  onArchiveToggle,
  onDelete,
}: {
  chatModel: string;
  onChatModelChange: (modelId: string) => void;
  hasState: boolean;
  archived: boolean;
  archiveBusy: boolean;
  onScenario: () => void;
  onStateTools: () => void;
  onRename: () => void;
  onArchiveToggle: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="flex flex-col p-2">
      <label className="flex flex-col gap-1 px-2 pt-1 pb-2">
        <span className="text-xs font-medium tracking-wide text-paper-400 uppercase">Narrator model</span>
        <Select value={chatModel} onChange={(e) => onChatModelChange(e.target.value)} className="h-8 text-xs">
          {NARRATIVE_MODELS.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </Select>
      </label>
      <div className="my-1 border-t border-ink-600" />
      <MenuItem onClick={onScenario} disabled={!hasState}>
        Scenario setup
      </MenuItem>
      <MenuItem onClick={onStateTools} disabled={!hasState}>
        State tools
      </MenuItem>
      <MenuItem onClick={onRename}>Rename…</MenuItem>
      <MenuItem onClick={onArchiveToggle} disabled={archiveBusy}>
        {archived ? "Restore" : "Archive"}
      </MenuItem>
      <div className="my-1 border-t border-ink-600" />
      <MenuItem onClick={onDelete} danger>
        Delete chat…
      </MenuItem>
    </div>
  );
}

function MenuItem({
  onClick,
  disabled,
  danger,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cx(
        "touch-target block w-full cursor-pointer rounded-md px-2 py-2 text-left text-sm transition-colors disabled:cursor-not-allowed disabled:text-paper-600",
        danger ? "text-danger-300 hover:bg-danger-500/10" : "text-paper-200 hover:bg-ink-700",
      )}
    >
      {children}
    </button>
  );
}

/**
 * Desktop popover host: outside-click + Escape close (the AccountMenu pattern).
 * `wrapRef` is the container holding the trigger *and* this panel — testing
 * containment against the panel alone would treat a trigger click as "outside",
 * closing on mousedown and re-opening on the click's toggle.
 */
function MenuPopover({
  wrapRef,
  onClose,
  children,
}: {
  wrapRef: RefObject<HTMLDivElement | null>;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    function onDocPointer(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", onDocPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [wrapRef, onClose]);
  return (
    <div className="absolute top-full right-0 z-50 mt-1 w-64 overflow-hidden rounded-card border border-ink-600 bg-ink-800 shadow-lift">
      {children}
    </div>
  );
}

/** Rename form: mounts fresh per open, so `useState` seeds from the current title without an effect. */
function RenameDialog({
  title,
  placeholder,
  onClose,
  onRename,
}: {
  title: string;
  placeholder: string;
  onClose: () => void;
  onRename: (next: string) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState(title);
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    const ok = await onRename(draft.trim());
    setSaving(false);
    if (ok) onClose();
  };
  return (
    <Dialog
      open
      onClose={() => {
        if (!saving) onClose();
      }}
      title="Rename conversation"
      footer={
        <>
          <Button onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" busy={saving} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-1.5">
        <Input
          value={draft}
          maxLength={120}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={placeholder}
          autoFocus
        />
        <p className="text-xs text-paper-500">Leave empty to fall back to the character&rsquo;s name.</p>
      </div>
    </Dialog>
  );
}
