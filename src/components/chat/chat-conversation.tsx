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
import type { ChatActionId, ChatSkipAmount } from "@/contracts";
import {
  charactersApi,
  chatsApi,
  sendChatMessage,
  type ChatMessage,
  type ChatStateSnapshot,
  type ChatStreamOutcome,
  type ChatTranscript,
} from "@/lib/client/api";
import { NARRATIVE_MODELS, resolveChatModelId } from "@/lib/narrative-models";
import { decideDraftSeed } from "@/components/hooks/draft-seed";
import { useAsyncData } from "@/components/hooks/use-async";
import { useIsAdmin } from "@/components/hooks/use-is-admin";
import { useIsMobile } from "@/components/hooks/use-is-mobile";
import { usePollWhile } from "@/components/hooks/use-poll-while";
import { AvatarPanel } from "@/components/avatar";
import { ChatPickupStrip } from "@/components/chat/chat-pickup-strip";
import { ChatRelationshipPanel } from "@/components/chat/chat-relationship-panel";
import { SceneMomentRow, scenesByAnchor } from "@/components/chat/chat-scene-moments";
import { MessageBubble, type ChatLine } from "@/components/characters/chat-message";
import { ChatScenarioModal } from "@/components/characters/chat-scenario-modal";
import { SceneStrip } from "@/components/characters/chat-scene-strip";
import { ChatStateToolsModal } from "@/components/characters/chat-state-tools";
import { ActionChips, StatusStrip } from "@/components/characters/chat-status";
import { caretInOocBlock } from "@/components/characters/message-markup";
import { Button } from "@/components/ui/button";
import { cx } from "@/components/ui/cx";
import { Dialog } from "@/components/ui/dialog";
import { EntityImage } from "@/components/ui/entity-image";
import { ErrorState } from "@/components/ui/error-state";
import { Input } from "@/components/ui/input";
import { ModelSelect } from "@/components/ui/model-select";
import { Sheet } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";

/** Project an API transcript row onto the renderable line shape (takes + stopped ride along). */
const toLine = (m: ChatMessage): ChatLine => ({
  id: m.id,
  role: m.role,
  content: m.content,
  takes: m.takes,
  stopped: m.meta.stopped,
});

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

  // The conversation's scene images — ONE fetch/poll shared by the strip and the
  // inline transcript moments (slice 9). Polls only while a render is pending;
  // refetched after each settled exchange (an auto scene may have queued).
  const scenes = useAsyncData(() => chatsApi.scenes(chatId), [chatId]);
  const sceneList = scenes.data ?? [];
  usePollWhile(
    sceneList.some((s) => s.status === "pending"),
    () => scenes.reload({ silent: true }),
    2500,
  );
  const sceneAnchors = scenesByAnchor(sceneList);
  const character = bootstrap.data?.character ?? null;
  const name = character?.name ?? "";
  const who = name.trim() || "this character";

  const [lines, setLines] = useState<ChatLine[]>([]);
  // Mutable chat header (rename / archive write through these mirrors).
  const [title, setTitle] = useState("");
  const [archived, setArchived] = useState(false);
  const [chatModel, setChatModel] = useState(() => resolveChatModelId(null));
  const [input, setInput] = useState("");
  // True while the composer caret sits inside a `((…))` OOC block — drives the
  // amber affordance (player-input-perception slice 5). A plain flag, not caret
  // state: recomputed from the live textarea on every edit / selection change.
  const [oocActive, setOocActive] = useState(false);
  const [sending, setSending] = useState(false);
  // True from a Stop click until the truncated stream settles (disables the button).
  const [stopping, setStopping] = useState(false);
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
  // "Remember this" (spec §6.4): the pinned-note dialog, openable from the composer
  // affordance (blank) or a message hover action (prefilled with that line).
  const [rememberOpen, setRememberOpen] = useState(false);
  const [rememberText, setRememberText] = useState("");
  const [rememberBusy, setRememberBusy] = useState(false);
  // The Relationship panel (spec §7) + the reopen pickup strip / time skips (spec §8.1).
  const [relationshipOpen, setRelationshipOpen] = useState(false);
  const [pickupDismissed, setPickupDismissed] = useState(false);
  const [skipBusy, setSkipBusy] = useState(false);
  // "Has something to say" (spec §8.4): a marker tap arrives as ?say=1 — surfaced as a
  // one-tap opener banner (generation stays player-triggered), the param stripped so a
  // reload doesn't re-offer it.
  const [wantsSay, setWantsSay] = useState(false);
  const isAdmin = useIsAdmin();
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
  // (decideDraftSeed via the "adjust state while rendering" pattern) so a
  // streamed/optimistic reply is never clobbered by the fetch settling. "seed"
  // only fires once the fetched payload is *this* chat's (loadedId === chatId), so
  // a stale previous-chat payload can never seed during a chatId switch; "clear"
  // drops the previous chat's transcript/header immediately on that switch instead
  // of letting them linger until the new fetch lands.
  const [seededFor, setSeededFor] = useState<string | null>(null);
  const seedAction = decideDraftSeed({
    entityId: chatId,
    seededId: seededFor,
    loadedId: bootstrap.data?.chat.id ?? null,
  });
  if (seedAction === "seed" && bootstrap.data) {
    setSeededFor(chatId);
    setLines(bootstrap.data.messages.map(toLine));
    setTitle(bootstrap.data.chat.title);
    setArchived(bootstrap.data.chat.archivedAt !== null);
    setChatModel(resolveChatModelId(bootstrap.data.character.chatModel));
    // Resetting chatState (not stageRef — refs can't be written in render) re-runs
    // the load effect below, which re-seeds stageRef from the fresh snapshot before
    // any send can compare against it.
    setChatState(null);
  } else if (seedAction === "clear") {
    setSeededFor(null);
    setLines([]);
    setTitle("");
    setArchived(false);
    setChatModel(resolveChatModelId(null));
    setChatState(null);
    setPickupDismissed(false);
    setWantsSay(false);
  }

  // Read (and strip) the ?say=1 marker-tap param once per chat mount (spec §8.4).
  // Deferred past a microtask per the strict hooks rule (no sync setState in effects).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await Promise.resolve();
      if (cancelled) return;
      const url = new URL(window.location.href);
      if (url.searchParams.get("say") === "1") {
        window.history.replaceState(null, "", url.pathname);
        setWantsSay(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [chatId]);

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
      stageRef.current = r.data.regardBand.label;
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

  /** Refetch the state strip; toast when the regard band changed (the romance arc made visible). */
  const refreshState = async () => {
    const prior = stageRef.current;
    const result = await chatsApi.state(chatId);
    if (!result.ok) return;
    setChatState(result.data);
    if (prior && result.data.regardBand.label !== prior) {
      toast.push({ title: `${who} now regards you as ${result.data.regardBand.label.toLowerCase()}.` });
    }
    stageRef.current = result.data.regardBand.label;
  };

  /**
   * Shared streaming flow for every reply kind — send, opening beat, Go on, and
   * Another take: stream the reply into an assistant bubble, then reconcile against
   * the persisted transcript and refresh the state strip. `userLine` appends the
   * player's optimistic line first (a normal send); omitted ⇒ a character-only beat.
   * `replaceId` (Another take, spec §4.1) streams into the EXISTING last reply
   * instead of appending — the server updates that row in place, and the post-settle
   * transcript reload picks up the recorded takes.
   */
  const runStream = async (
    body: { kind?: "send" | "open" | "continue" | "regenerate"; content?: string; model?: string; cue?: string },
    opts: { userLine?: string; replaceId?: string } = {},
  ): Promise<ChatStreamOutcome> => {
    const { userLine, replaceId } = opts;
    // Any exchange consumes the reopen affordances (spec §8.1/§8.4) for this visit.
    setPickupDismissed(true);
    setWantsSay(false);
    const assistantId = replaceId ?? mkId();
    // The take being replaced, kept so a failed regenerate can put it back.
    const priorLine = replaceId !== undefined ? lines.find((l) => l.id === replaceId) : undefined;
    if (replaceId !== undefined) {
      setLines((prev) => prev.map((l) => (l.id === replaceId ? { ...l, content: "", stopped: false } : l)));
    } else {
      setLines((prev) => [
        ...prev,
        ...(userLine !== undefined ? [{ id: mkId(), role: "user" as const, content: userLine }] : []),
        { id: assistantId, role: "assistant" as const, content: "" },
      ]);
    }
    const controller = new AbortController();
    abortRef.current = controller;
    sendingRef.current = true;
    setSending(true);
    setStopping(false); // a stuck Stop from a settle race must not disable this stream's button
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
      setStopping(false);
    }
    if (outcome.aborted || superseded || !outcome.ok) {
      if (priorLine !== undefined) {
        // Failed before any tokens (4xx — the server never touched the row): put the
        // prior take back. A superseding rerun already snipped the line ⇒ no-op map.
        const restore = priorLine;
        setLines((prev) => prev.map((l) => (l.id === replaceId && l.content === "" ? restore : l)));
      } else {
        // Cancelled or failed: drop our empty bubble (a partial reply, if any, stays).
        setLines((prev) => prev.filter((l) => !(l.id === assistantId && l.content === "")));
      }
      // The server 409s sends into an archived conversation — flip to read-only.
      if (!outcome.ok && outcome.error?.code === "chat_archived") setArchived(true);
      return outcome;
    }
    // Swap the optimistic temp-ids for the persisted ids so the exchange just sent
    // is immediately editable/deletable (and pick up recorded takes + stop marks).
    // Skip if another send already started.
    const fresh = await chatsApi.transcript(chatId);
    if (fresh.ok && !sendingRef.current) {
      setLines(fresh.data.messages.map(toLine));
    }
    // The pulse + drift settle server-side as the stream finalizes; refetch the
    // strip so the disposition (and any stage change) shows after the exchange —
    // and the scene list, since a big moment may have auto-queued a render (slice 9).
    await refreshState();
    scenes.reload({ silent: true });
    return outcome;
  };

  const send = async () => {
    const content = input.trim();
    if (!content || sendingRef.current || !ready || archived) return;
    setInput("");
    setOocActive(false);
    const outcome = await runStream({ content, model: chatModel }, { userLine: content });
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
    const outcome = await runStream({ content, model: chatModel }, { userLine: content });
    if (!outcome.ok && !outcome.aborted) {
      toast.push({ title: "Rerun failed", description: outcome.error?.message, tone: "error" });
    }
  };

  /** Recompute the OOC affordance from the textarea's live value + caret. */
  const refreshOoc = (el: HTMLTextAreaElement) => {
    setOocActive(caretInOocBlock(el.value, el.selectionStart));
  };

  /**
   * Place the caret after a controlled-value edit (the auto-close / collapse below).
   * Deferred to the next frame so React has committed the new value onto the node —
   * setting the range in the same tick would fight the controlled re-render. Mirrors
   * the play composer's `requestAnimationFrame(() => …focus())` pattern.
   */
  const applyCaret = (el: HTMLTextAreaElement, caret: number) => {
    requestAnimationFrame(() => {
      el.setSelectionRange(caret, caret);
      refreshOoc(el);
    });
  };

  const onComposerKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
      return;
    }
    // The composer assist only manages a collapsed caret (no selection).
    const pos = el.selectionStart;
    if (pos !== el.selectionEnd) return;
    const value = el.value;
    // OOC discoverability: typing the second "(" completes "((" → auto-insert the
    // closing "))" with the caret between them. Skipped when "))" already follows
    // (so an already-paired block isn't over-closed).
    if (e.key === "(" && value[pos - 1] === "(" && value.slice(pos, pos + 2) !== "))") {
      e.preventDefault();
      setInput(value.slice(0, pos) + "(" + "))" + value.slice(pos));
      applyCaret(el, pos + 1);
      return;
    }
    // Backspace with the caret between "(" and "))" removes the whole auto-inserted
    // pair instead of stranding the "))" (undo of the auto-close).
    if (e.key === "Backspace" && value[pos - 1] === "(" && value.slice(pos, pos + 2) === "))") {
      e.preventDefault();
      setInput(value.slice(0, pos - 1) + value.slice(pos + 2));
      applyCaret(el, pos - 1);
    }
  };

  /** Apply a one-click test-bed action chip (offer a drink → intoxication↑, etc.). */
  const runAction = async (action: ChatActionId) => {
    setActionBusy(action);
    const result = await chatsApi.applyAction(chatId, action);
    setActionBusy(null);
    if (result.ok) {
      setChatState(result.data);
      stageRef.current = result.data.regardBand.label;
    } else {
      toast.push({ title: "Action failed", description: result.error.message, tone: "error" });
    }
  };

  /** Prompt Character (opening beat): stream a character-authored opening turn (the premise comes from chat state). */
  const promptCharacter = async () => {
    if (sendingRef.current || !ready || archived) return;
    const outcome = await runStream({ kind: "open", model: chatModel });
    if (!outcome.ok) toast.push({ title: "Couldn't open the scene", description: outcome.error?.message, tone: "error" });
  };

  /**
   * Stop (spec §4.2): cut the streaming reply short SERVER-side — the model stream
   * aborts there, what already streamed persists as the reply (`meta.stopped`), and
   * our reader ends naturally with the truncated text. Deliberately NOT a client
   * abort: `abortRef` stays untouched so the settled prefix keeps its bubble. A 404
   * means the reply settled before the click landed — nothing to stop, ignore it.
   */
  const stopReply = async () => {
    if (stopping) return;
    setStopping(true);
    const result = await chatsApi.stop(chatId);
    if (!result.ok && result.error.status !== 404) {
      setStopping(false);
      toast.push({ title: "Couldn't stop the reply", description: result.error.message, tone: "error" });
    }
  };

  /** Go on (spec §4.2): ask for the character's next beat — no user line, same streaming flow as the opening beat. */
  const goOn = async () => {
    if (sendingRef.current || !ready || archived) return;
    const outcome = await runStream({ kind: "continue", model: chatModel });
    if (!outcome.ok) toast.push({ title: "Couldn't continue", description: outcome.error?.message, tone: "error" });
  };

  /** Another take (spec §4.1): regenerate the last reply in place; earlier takes stay browsable via the pager. */
  const anotherTake = async (id: string) => {
    if (sendingRef.current || !ready || archived) return;
    const outcome = await runStream({ kind: "regenerate", model: chatModel }, { replaceId: id });
    if (!outcome.ok) {
      toast.push({ title: "Couldn't get another take", description: outcome.error?.message, tone: "error" });
    }
  };

  /**
   * Show a different recorded take (spec §4.1) — display-only: state/memory follow
   * the newest generated take, so this just swaps the row's content + activeId.
   */
  const switchTake = async (messageId: string, takeId: string) => {
    const result = await chatsApi.switchTake(chatId, messageId, takeId);
    if (!result.ok) {
      toast.push({ title: "Couldn't switch takes", description: result.error.message, tone: "error" });
      return;
    }
    setLines((prev) =>
      prev.map((l) =>
        l.id === messageId
          ? { ...l, content: result.data.content, takes: l.takes ? { ...l.takes, activeId: takeId } : l.takes }
          : l,
      ),
    );
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

  /** Open the "Remember this" dialog, optionally prefilled from a message line. */
  const openRemember = (prefill: string) => {
    setRememberText(prefill.trim().slice(0, 500));
    setRememberOpen(true);
  };

  /** Pin the note into the chat's long-term memory (spec §6.4, D15). */
  const saveRemember = async () => {
    const content = rememberText.trim();
    if (!content) return;
    setRememberBusy(true);
    const result = await chatsApi.remember(chatId, content);
    setRememberBusy(false);
    if (!result.ok) {
      toast.push({ title: "Couldn't save the note", description: result.error.message, tone: "error" });
      return;
    }
    setRememberOpen(false);
    setRememberText("");
    toast.push({ title: "Noted", description: `${who} will always remember that.` });
  };

  /** Apply a player time skip (spec §8.1) — from the pickup strip or the header menu. */
  const skipTime = async (amount: ChatSkipAmount) => {
    if (skipBusy || archived) return;
    setSkipBusy(true);
    const result = await chatsApi.timeSkip(chatId, amount);
    setSkipBusy(false);
    setPickupDismissed(true);
    if (!result.ok) {
      toast.push({ title: "Time skip failed", description: result.error.message, tone: "error" });
      return;
    }
    setChatState(result.data);
    stageRef.current = result.data.regardBand.label;
    toast.push({ title: "Time passes…", description: `${who} will pick the scene up from there.` });
  };

  /** "Mark this moment" (spec §7.2): pin a player milestone on a message. */
  const markMoment = async (messageId: string) => {
    const result = await chatsApi.markMoment(chatId, messageId);
    if (result.ok) {
      toast.push({ title: "Moment marked", description: "It now shows in the Relationship panel." });
    } else {
      toast.push({ title: "Couldn't mark the moment", description: result.error.message, tone: "error" });
    }
  };

  /** The §8.4 opener: let the character speak about their top open loop. */
  const letThemSpeak = async () => {
    const cue = chatState?.openLoops[0];
    const outcome = await runStream({ kind: "continue", model: chatModel, cue });
    if (!outcome.ok) toast.push({ title: "Reply failed", description: outcome.error?.message, tone: "error" });
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
      skipBusy={skipBusy || sending}
      onScenario={menuAction(() => setScenarioOpen(true))}
      onStateTools={menuAction(() => setToolsOpen(true))}
      onRelationship={menuAction(() => setRelationshipOpen(true))}
      onTimeSkip={(amount) => {
        setMenuOpen(false);
        void skipTime(amount);
      }}
      onRename={menuAction(() => setRenameOpen(true))}
      onArchiveToggle={() => void toggleArchived()}
      onDelete={menuAction(() => setDeleteOpen(true))}
      onInspector={isAdmin ? menuAction(() => router.push(`/chat/${chatId}/inspector`)) : undefined}
    />
  );

  const premise = chatState?.premise.trim() ?? "";
  // Another take targets the last assistant reply (spec §4.1) — only there, only idle.
  const lastAssistantId = [...lines].reverse().find((l) => l.role === "assistant")?.id ?? null;
  // Go on (spec §4.2): the newest SETTLED message is a reply and nothing is streaming.
  const lastLine = lines[lines.length - 1];
  const canGoOn =
    !sending && ready && !archived && lastLine?.role === "assistant" && !lastLine.id.startsWith("tmp-");

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
              <SceneStrip
                chatId={chatId}
                name={name}
                hasChat={lines.length > 0}
                scenes={sceneList}
                onRefresh={() => scenes.reload({ silent: true })}
              />
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
            lines.map((line) => {
              const moments = sceneAnchors.get(line.id);
              return (
                <div key={line.id} className="flex flex-col gap-2">
                  <MessageBubble
                    line={line}
                    name={name}
                    avatarImageId={character?.avatarImageId ?? null}
                    streaming={sending}
                    takeTarget={!archived && line.id === lastAssistantId}
                    onEdit={editLine}
                    onDelete={deleteLine}
                    onRerun={(id) => void rerun(id)}
                    onAnotherTake={(id) => void anotherTake(id)}
                    onSwitchTake={switchTake}
                    onRemember={archived ? undefined : openRemember}
                    onMarkMoment={archived ? undefined : (id) => void markMoment(id)}
                  />
                  {moments ? <SceneMomentRow images={moments} name={name} /> : null}
                </div>
              );
            })
          )}
        </div>
      </div>

      <div className="shrink-0 border-t border-ink-600 bg-ink-900/95 px-4 pt-2.5 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
        <div className="mx-auto flex max-w-3xl flex-col gap-2">
          {/* Reopen pickup (spec §8.1): a lightweight, dismissable choice — Continue is the default no-op. */}
          {ready && !archived && lines.length > 0 && !pickupDismissed && !sending ? (
            <ChatPickupStrip
              who={who}
              busy={skipBusy}
              onPick={(amount) => {
                if (amount === null) setPickupDismissed(true);
                else void skipTime(amount);
              }}
            />
          ) : null}
          {/* "Has something to say" opener (spec §8.4): the tapped marker's one-tap beat. */}
          {wantsSay && !archived && !sending && (chatState?.openLoops.length ?? 0) > 0 ? (
            <div className="flex items-center justify-between gap-2 rounded-card border border-accent-500/30 bg-accent-500/10 px-3 py-1.5 text-xs text-paper-300">
              <span className="truncate" title={chatState?.openLoops[0]}>
                {who} has something on their mind.
              </span>
              <Button size="sm" variant="quiet" onClick={() => void letThemSpeak()}>
                Let {who} speak
              </Button>
            </div>
          ) : null}
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
              {lines.length === 0 ? (
                <Button
                  size="sm"
                  variant="quiet"
                  disabled={sending || !ready}
                  onClick={() => void promptCharacter()}
                  title={`Let ${who} open the scene`}
                >
                  Prompt {who}
                </Button>
              ) : canGoOn ? (
                <Button
                  size="sm"
                  variant="quiet"
                  onClick={() => void goOn()}
                  title={`Let ${who} continue without a reply from you`}
                >
                  Go on <span aria-hidden>→</span>
                </Button>
              ) : (
                <span />
              )}
            </div>
          ) : null}
          {chatState && !archived ? <ActionChips busy={actionBusy} disabled={sending} onAction={(a) => void runAction(a)} /> : null}
          {/* OOC affordance (slice 5): a clear amber signal the caret is inside a
              ((…)) block — a note to the storyteller no one in the scene hears. */}
          {oocActive && !archived ? (
            <div className="flex items-center gap-1.5 text-[11px]">
              <span className="rounded-sm bg-accent-500/15 px-1.5 py-0.5 font-medium tracking-wide text-accent-300 uppercase">
                OOC
              </span>
              <span className="text-paper-500">To the storyteller — no one in the scene hears this.</span>
            </div>
          ) : null}
          <div className="flex items-end gap-2">
            <Textarea
              rows={2}
              value={input}
              onChange={(e) => {
                setInput(e.currentTarget.value);
                refreshOoc(e.currentTarget);
              }}
              onKeyDown={onComposerKeyDown}
              onSelect={(e) => refreshOoc(e.currentTarget)}
              disabled={archived}
              placeholder={
                archived ? "This conversation is archived." : `Message ${who}…  (Enter to send, Shift+Enter for a new line)`
              }
              className={cx("flex-1", oocActive && "border-accent-500 ring-1 ring-accent-500/40")}
            />
            {!archived ? (
              <button
                type="button"
                onClick={() => openRemember("")}
                disabled={!ready}
                aria-label="Remember this…"
                title={`Tell ${who} something to always remember`}
                className="touch-target inline-flex cursor-pointer items-center justify-center rounded-md px-2 py-2 text-paper-500 transition-colors hover:text-accent-300 disabled:cursor-not-allowed disabled:text-paper-600"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden className="size-4.5">
                  <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
                </svg>
              </button>
            ) : null}
            {sending ? (
              // Stop swaps in for Send while a reply streams (spec §4.2): the server
              // truncates honestly; what's on screen stays as the settled reply.
              <Button variant="ghost" busy={stopping} onClick={() => void stopReply()} title="Stop the reply — keeps what has streamed so far">
                Stop
              </Button>
            ) : (
              <Button variant="primary" onClick={() => void send()} disabled={archived || !ready || !input.trim()}>
                Send
              </Button>
            )}
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
            disposition (regard, mood, scenario), and everything {who} remembers about you from it. Archiving
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

      <Dialog
        open={rememberOpen}
        onClose={() => {
          if (!rememberBusy) setRememberOpen(false);
        }}
        title="Remember this"
        footer={
          <div className="flex justify-end gap-2">
            <Button onClick={() => setRememberOpen(false)} disabled={rememberBusy}>
              Cancel
            </Button>
            <Button variant="primary" busy={rememberBusy} onClick={() => void saveRemember()} disabled={!rememberText.trim()}>
              Remember
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-2">
          <p className="text-sm text-paper-400">
            {who} will always keep this in mind — it outranks anything picked up in play, and only you can change it.
          </p>
          <Textarea
            rows={3}
            value={rememberText}
            maxLength={500}
            onChange={(e) => setRememberText(e.target.value)}
            placeholder="e.g. I'm allergic to peanuts. / My brother's name is Jonas."
            autoFocus
          />
        </div>
      </Dialog>

      {chatState ? (
        <ChatStateToolsModal
          open={toolsOpen}
          onClose={() => setToolsOpen(false)}
          chatId={chatId}
          who={who}
          snapshot={chatState}
          onSaved={(next) => {
            setChatState(next);
            stageRef.current = next.regardBand.label;
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
            stageRef.current = next.regardBand.label;
          }}
        />
      ) : null}

      <ChatRelationshipPanel chatId={chatId} who={who} open={relationshipOpen} onClose={() => setRelationshipOpen(false)} />
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
  skipBusy,
  onScenario,
  onStateTools,
  onRelationship,
  onTimeSkip,
  onRename,
  onArchiveToggle,
  onDelete,
  onInspector,
}: {
  chatModel: string;
  onChatModelChange: (modelId: string) => void;
  hasState: boolean;
  archived: boolean;
  archiveBusy: boolean;
  skipBusy: boolean;
  onScenario: () => void;
  onStateTools: () => void;
  /** The Relationship panel (spec §7): stage, sparkline, milestones, story so far. */
  onRelationship: () => void;
  /** Mid-conversation time skip (spec §8.1) — the same options as the pickup strip. */
  onTimeSkip: (amount: ChatSkipAmount) => void;
  onRename: () => void;
  onArchiveToggle: () => void;
  onDelete: () => void;
  /** Admin-only (spec §6.1): navigate to the dev memory inspector. Absent ⇒ item hidden. */
  onInspector?: () => void;
}) {
  return (
    <div className="flex flex-col p-2">
      <label className="flex flex-col gap-1 px-2 pt-1 pb-2">
        <span className="text-xs font-medium tracking-wide text-paper-400 uppercase">Narrator model</span>
        <ModelSelect
          ariaLabel="Narrator model"
          models={NARRATIVE_MODELS}
          value={chatModel}
          onChange={onChatModelChange}
          className="h-8 text-xs"
        />
      </label>
      <div className="my-1 border-t border-ink-600" />
      <MenuItem onClick={onScenario} disabled={!hasState}>
        Scenario setup
      </MenuItem>
      <MenuItem onClick={onRelationship} disabled={!hasState}>
        Relationship
      </MenuItem>
      <MenuItem onClick={onStateTools} disabled={!hasState}>
        State tools
      </MenuItem>
      {onInspector ? <MenuItem onClick={onInspector}>Inspector</MenuItem> : null}
      {!archived ? (
        <div className="flex flex-col gap-1 px-2 py-1.5">
          <span className="text-xs font-medium tracking-wide text-paper-400 uppercase">Let time pass</span>
          <div className="flex flex-wrap gap-1.5">
            {(
              [
                ["moments", "Moments"],
                ["hours", "Hours"],
                ["overnight", "Overnight"],
                ["days", "Days"],
              ] as const
            ).map(([amount, label]) => (
              <button
                key={amount}
                type="button"
                disabled={skipBusy}
                onClick={() => onTimeSkip(amount)}
                className="cursor-pointer rounded-md border border-ink-600 px-2 py-1 text-xs text-paper-300 transition-colors hover:border-accent-500/50 hover:text-paper-100 disabled:cursor-not-allowed disabled:text-paper-600"
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      ) : null}
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
