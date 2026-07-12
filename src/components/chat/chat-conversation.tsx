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
import { parseChatSceneModel, type ChatActionId, type ChatSceneModel, type ChatSkipAmount } from "@/contracts";
import {
  charactersApi,
  chatsApi,
  sendChatMessage,
  type ChatMessage,
  type ChatRosterMember,
  type ChatStateSnapshot,
  type ChatStreamOutcome,
  type ChatTranscript,
} from "@/lib/client/api";
import { replyRevealHoldMs } from "@/lib/chat-pacing";
import { NARRATIVE_MODELS, resolveChatModelId } from "@/lib/narrative-models";
import { decideDraftSeed } from "@/components/hooks/draft-seed";
import { useAsyncData } from "@/components/hooks/use-async";
import { useIsAdmin } from "@/components/hooks/use-is-admin";
import { useIsMobile } from "@/components/hooks/use-is-mobile";
import { usePollWhile } from "@/components/hooks/use-poll-while";
import { AvatarPanel } from "@/components/avatar";
import { fileToAttachmentDataUrl } from "@/components/chat/attachment-file";
import { ChatPickupStrip } from "@/components/chat/chat-pickup-strip";
import { ChatRelationshipPanel } from "@/components/chat/chat-relationship-panel";
import { ChatRelationshipsEditor } from "@/components/chat/chat-relationships-editor";
import { ChatRosterPanel } from "@/components/chat/chat-roster-panel";
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
import { ImageLightbox } from "@/components/ui/image-lightbox";
import { Input } from "@/components/ui/input";
import { ModelSelect } from "@/components/ui/model-select";
import { Sheet } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";

/** Project an API transcript row onto the renderable line shape (takes + stopped + attachments ride along). */
const toLine = (m: ChatMessage): ChatLine => ({
  id: m.id,
  role: m.role,
  content: m.content,
  takes: m.takes,
  stopped: m.meta.stopped,
  attachmentIds: m.meta.attachments?.ids.length ? m.meta.attachments.ids : undefined,
});

/**
 * The full-screen conversation page (`/chat/[chatId]`,
 * character-chat-standalone.spec.md §2.2): mobile-first single column filling the
 * viewport below the 3.25rem app header (the bottom tab bar is suppressed on this
 * route — the composer owns the bottom edge). Header row: back to the Chats hub,
 * portrait, name/title, and a menu (bottom Sheet on phones, popover at ≥md) holding
 * the narrator-model pick, Scenario setup, State tools, Rename, Archive/Restore and
 * Delete. The scene strip sits in a disclosure under the header (collapsed by
 * default — the transcript keeps the room); the standing portrait is a fixed column
 * left of the transcript at ≥lg (desktop real estate) and hidden below that. Every
 * portrait affordance — header portrait, standing portrait, each reply's circular
 * avatar — opens the same ImageLightbox; the reply avatars are the phone's path to
 * a full-size portrait. Unlike the old editor tab there is no lazy create: the
 * conversation always exists — `chatId` is the address of record.
 */
export function ChatConversation({ chatId }: { chatId: string }) {
  const router = useRouter();
  const toast = useToast();
  const isMobile = useIsMobile();

  // One GET settles the whole screen: transcript + chat header + character card.
  const bootstrap = useAsyncData<ChatTranscript>(() => chatsApi.transcript(chatId), [chatId]);
  const ready = !bootstrap.loading && bootstrap.error === null;

  // The conversation's scene images — ONE fetch/poll shared by the strip and the
  // inline transcript moments (slice 9). Polls while a render job is live server-side
  // (`rendering` — covers the slow composer step BEFORE the pending image row exists,
  // the painting-forever fix) or a pending row is visible; refetched after each settled
  // exchange (an auto scene may have queued).
  const scenes = useAsyncData(() => chatsApi.scenes(chatId), [chatId]);
  const sceneList = scenes.data?.scenes ?? [];
  const sceneRendering = scenes.data?.rendering ?? false;
  usePollWhile(
    sceneRendering || sceneList.some((s) => s.status === "pending"),
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
  // Roster sheet (multi-character-chat.plan.md slice 1) — the phone-width path to
  // the roster panel; desktop also gets it inline in the aside.
  const [rosterOpen, setRosterOpen] = useState(false);
  // Per-character sheet (followups ruling 13): tapping a roster member opens THEIR
  // sheet — their state fetched fresh on open, edited via characterId targeting.
  const [sheetMember, setSheetMember] = useState<ChatRosterMember | null>(null);
  const [sheetSnapshot, setSheetSnapshot] = useState<ChatStateSnapshot | null>(null);
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [archiveBusy, setArchiveBusy] = useState(false);
  // Attached photos staged for the next send (chat-image-input.plan.md): uploaded
  // eagerly on pick (the ids preview via the immutable file route), sent as ids.
  // Removing a staged photo only unstages it — the orphaned upload row is cleaned
  // up with the conversation, never surfaced anywhere.
  const [attachments, setAttachments] = useState<string[]>([]);
  const [attachBusy, setAttachBusy] = useState(false);
  const attachInputRef = useRef<HTMLInputElement | null>(null);
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
  // The scene-image disclosure: collapsed by default at every width — the
  // transcript keeps the room; a tap remembers the choice for this mount only.
  const [scenesOpen, setScenesOpen] = useState(false);
  // The character-portrait lightbox, openable from the header portrait, the desktop
  // standing portrait, and each reply's avatar (the mobile path to a big portrait).
  const [portraitOpen, setPortraitOpen] = useState(false);

  const stageRef = useRef<string | null>(null);
  const tempId = useRef(0);
  const mkId = () => `tmp-${tempId.current++}`;
  // Mirrors `sending` synchronously so the post-send id-reconcile can bail if a
  // new send started in the await window (state would be stale in the closure).
  const sendingRef = useRef(false);
  // The in-flight reply's AbortController (null when idle). Nothing aborts it anymore
  // (rerun stops the reply SERVER-side via the atomic rerun exchange, not a client
  // abort) — it is kept purely as the active-stream identity token: each stream owns it
  // while active, and a superseding stream (rerun starting while an old reply is still
  // settling) installs its own, so the stale one can't clear `sending` or refetch over
  // the new one's optimistic transcript.
  const abortRef = useRef<AbortController | null>(null);
  /** Bumped per chat-model pick so a superseded pick is skipped, plus the serializing chain. */
  const chatModelGenRef = useRef(0);
  const chatModelChainRef = useRef<Promise<void>>(Promise.resolve());
  const sceneModelGenRef = useRef(0);
  const sceneModelChainRef = useRef<Promise<void>>(Promise.resolve());
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

  // Per-character sheet (followups ruling 13): fetch the tapped member's own
  // snapshot on open — never the primary's cached one.
  useEffect(() => {
    if (!sheetMember) return;
    let cancelled = false;
    void chatsApi.state(chatId, sheetMember.characterId).then((r) => {
      if (cancelled || !r.ok) return;
      setSheetSnapshot(r.data);
    });
    return () => {
      cancelled = true;
    };
  }, [chatId, sheetMember]);

  // Auto-scroll the transcript (not the page) to the newest line as the
  // conversation grows / streams. Setting scrollTop directly keeps the scroll
  // contained — `scrollIntoView` bubbles to every ancestor incl. the window.
  // Pinning is stick-to-bottom: it holds only while the reader is AT the bottom
  // (scrolling up to reread stops the yanking), and a ResizeObserver on the
  // content column re-pins as async content (scene thumbnails, avatars) grows it
  // AFTER the lines effect ran — without it the initial load landed mid-transcript
  // once images finished, hiding the newest exchange below the fold.
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [lines]);
  useEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content) return;
    const observer = new ResizeObserver(() => {
      if (stickRef.current) el.scrollTop = el.scrollHeight;
    });
    // Both boxes matter: the content column grows as thumbnails/avatars land, and
    // the container itself shrinks when the sections above it (scene disclosure,
    // pickup strip) settle — either one un-bottoms a pinned reader.
    observer.observe(content);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

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
    body: {
      kind?: "send" | "open" | "continue" | "regenerate" | "rerun";
      content?: string;
      model?: string;
      cue?: string;
      messageId?: string;
      attachmentIds?: string[];
      initiative?: boolean;
    },
    opts: { userLine?: string; replaceId?: string; attachmentIds?: string[] } = {},
  ): Promise<ChatStreamOutcome> => {
    const { userLine, replaceId } = opts;
    // Any exchange consumes the reopen affordances (spec §8.1/§8.4) for this visit.
    setPickupDismissed(true);
    setWantsSay(false);
    // An exchange the player initiates re-pins the transcript (even from a scrolled-up
    // read) — the reply they asked for should stream into view.
    stickRef.current = true;
    const assistantId = replaceId ?? mkId();
    // The take being replaced, kept so a failed regenerate can put it back.
    const priorLine = replaceId !== undefined ? lines.find((l) => l.id === replaceId) : undefined;
    if (replaceId !== undefined) {
      setLines((prev) => prev.map((l) => (l.id === replaceId ? { ...l, content: "", stopped: false } : l)));
    } else {
      setLines((prev) => [
        ...prev,
        ...(userLine !== undefined
          ? [{ id: mkId(), role: "user" as const, content: userLine, attachmentIds: opts.attachmentIds }]
          : []),
        { id: assistantId, role: "assistant" as const, content: "" },
      ]);
    }
    const controller = new AbortController();
    abortRef.current = controller;
    sendingRef.current = true;
    setSending(true);
    setStopping(false); // a stuck Stop from a settle race must not disable this stream's button
    // Whether any token ever arrived: a stream that 200s and then ends EMPTY (the
    // server's first-token watchdog tripping on a stalled provider) persists no reply
    // row, so without an explicit signal the pending bubble would just vanish.
    let received = false;
    // Reply pacing (emotional-weather.plan.md slice 3, UI-only): hold the "…" bubble
    // briefly before revealing tokens — a cold or hurt character lets the message sit,
    // a warm one answers at once. Tokens buffer during the hold; nothing is lost.
    const holdUntil = Date.now() + replyRevealHoldMs(chatState ? { regard: chatState.regard, feeling: chatState.feeling.current } : null);
    let held = "";
    let holdTimer: ReturnType<typeof setTimeout> | null = null;
    const append = (text: string) =>
      setLines((prev) => prev.map((l) => (l.id === assistantId ? { ...l, content: l.content + text } : l)));
    const flushHeld = () => {
      if (holdTimer !== null) {
        clearTimeout(holdTimer);
        holdTimer = null;
      }
      if (held) {
        const text = held;
        held = "";
        append(text);
      }
    };
    const outcome = await sendChatMessage(
      chatId,
      body,
      (delta) => {
        received = true;
        if (Date.now() < holdUntil) {
          held += delta;
          holdTimer ??= setTimeout(flushHeld, holdUntil - Date.now());
          return;
        }
        flushHeld();
        append(delta);
      },
      controller.signal,
    );
    // Stream settled (success, stop, or failure): reveal anything still held so the
    // cleanup below sees the real content (a partial held mid-hold must survive).
    flushHeld();
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
    // Zero tokens on an otherwise-clean settle: the narrator produced nothing (the
    // server logged a first-token timeout and persisted no reply), so say so — the
    // transcript reload above already dropped the empty bubble.
    if (!received) {
      toast.push({
        title: `${who} didn't reply`,
        description: "The narrator model returned nothing — usually a timeout. Try again, or pick a different narrator model from the menu.",
        tone: "error",
      });
    }
    return outcome;
  };

  /** Downscale + upload picked files, staging the returned ids (cap 4 total). */
  const pickAttachments = async (files: FileList | null) => {
    if (!files?.length || archived) return;
    const picked = Array.from(files).slice(0, Math.max(0, 4 - attachments.length));
    if (!picked.length) return;
    setAttachBusy(true);
    try {
      for (const file of picked) {
        const dataUrl = await fileToAttachmentDataUrl(file);
        if (!dataUrl) {
          toast.push({ title: "Couldn't read that image", description: file.name, tone: "error" });
          continue;
        }
        const result = await chatsApi.uploadAttachment(chatId, dataUrl);
        if (result.ok) setAttachments((prev) => (prev.length < 4 ? [...prev, result.data.id] : prev));
        else toast.push({ title: "Upload failed", description: result.error.message, tone: "error" });
      }
    } finally {
      setAttachBusy(false);
    }
  };

  const send = async () => {
    const content = input.trim();
    // A photo-only send is legitimate — showing something IS the message.
    if ((!content && !attachments.length) || sendingRef.current || !ready || archived || attachBusy) return;
    const attachmentIds = attachments.length ? [...attachments] : undefined;
    setInput("");
    setAttachments([]);
    setOocActive(false);
    const outcome = await runStream(
      { content: content || undefined, model: chatModel, attachmentIds },
      { userLine: content, attachmentIds },
    );
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
   * Rerun a user message (data-loss-rerun fix): re-send this prompt for a fresh reply,
   * dropping only the lines AFTER it. This deletes NOTHING client-side and never
   * abort-and-hopes — the atomic `kind: "rerun"` exchange does it all server-side under
   * the chat lock (stop any in-flight reply, wait for the lock, then in one transaction
   * snip only the target's successors and reuse the target line itself). So on any
   * failure — a 409 because the lock couldn't be re-acquired, or anything else — the
   * server guarantees the transcript is byte-identical, and we simply restore the lines
   * we optimistically snipped. The target user line stays visible throughout.
   */
  const rerun = async (id: string) => {
    if (archived) return;
    const idx = lines.findIndex((l) => l.id === id);
    const target = lines[idx];
    if (!target || target.role !== "user" || target.id.startsWith("tmp-")) return;
    // Snapshot to restore if the server rejects (it changed nothing on a failure).
    const prevLines = lines;
    // Optimistically snip everything AFTER the target; the target line itself stays.
    setLines((prev) => prev.slice(0, idx + 1));
    const outcome = await runStream({ kind: "rerun", messageId: target.id, model: chatModel });
    if (!outcome.ok) {
      // Nothing was mutated server-side — put the transcript back exactly as it was.
      setLines(prevLines);
      if (!outcome.aborted) {
        toast.push({ title: "Rerun failed", description: outcome.error?.message, tone: "error" });
      }
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

  /**
   * Persist the scene-model pick immediately (save-on-select, the owner's hot-swap
   * dropdown on the scene strip) — same serialized-chain guarantees as the narrator
   * pick above. The PATCH returns the fresh snapshot, which replaces the local state
   * (a superseded pick never writes back).
   */
  const saveSceneModel = (model: ChatSceneModel) => {
    setChatState((current) => (current ? { ...current, sceneModel: model } : current));
    const gen = ++sceneModelGenRef.current;
    sceneModelChainRef.current = sceneModelChainRef.current.then(async () => {
      if (gen !== sceneModelGenRef.current) return; // a newer pick superseded this one
      const result = await chatsApi.editState(chatId, { sceneModel: model });
      if (gen !== sceneModelGenRef.current) return;
      if (result.ok) setChatState(result.data);
      else toast.push({ title: "Couldn't save the scene model", description: result.error.message, tone: "error" });
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
      onRoster={menuAction(() => setRosterOpen(true))}
    />
  );
  const roster = bootstrap.data?.roster ?? [];
  // The dialogue-tag vocabulary for rendering replies: every roster member's name (primary
  // first), so a group reply's non-primary `[Name]` tags attribute instead of leaking as
  // literal text. Falls back to the primary name on legacy/empty-roster payloads.
  const rosterNames = roster.length ? roster.map((m) => m.name) : name ? [name] : [];

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
            <button
              type="button"
              onClick={() => setPortraitOpen(true)}
              disabled={!character.avatarImageId}
              aria-label={`View ${who}'s portrait`}
              className="shrink-0 cursor-pointer rounded-full disabled:cursor-default"
            >
              <EntityImage imageId={character.avatarImageId} name={name} className="size-8 rounded-full text-xs" />
            </button>
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

      {/* Roster sheet (multi-character-chat.plan.md): the menu path to the roster
          panel + the relationship matrix (roster > 1). */}
      <Sheet open={rosterOpen} onClose={() => setRosterOpen(false)} side="bottom" title="Roster">
        <div className="flex flex-col gap-4 p-3">
          {roster.length > 0 ? (
            <ChatRosterPanel
              chatId={chatId}
              roster={roster}
              archived={archived}
              onChanged={() => bootstrap.reload({ silent: true })}
              onOpenSheet={(member) => {
                setRosterOpen(false);
                setSheetMember(member);
              }}
            />
          ) : null}
          {rosterOpen && roster.length > 1 ? <ChatRelationshipsEditor chatId={chatId} archived={archived} /> : null}
        </div>
      </Sheet>

      {archived ? (
        <div className="flex shrink-0 items-center justify-center gap-2 border-b border-ink-600 bg-ink-800/80 px-4 py-1 text-xs text-paper-400">
          <span>Archived — restore to continue.</span>
          <Button size="sm" variant="quiet" busy={archiveBusy} onClick={() => void toggleArchived()}>
            Restore
          </Button>
        </div>
      ) : null}

      {/* Scene strip: a disclosure, collapsed by default so the transcript keeps the room. */}
      <section className="shrink-0 border-b border-ink-600">
        <button
          type="button"
          aria-expanded={scenesOpen}
          onClick={() => setScenesOpen(!scenesOpen)}
          className="flex w-full cursor-pointer items-center justify-between px-4 py-1.5 text-xs font-medium tracking-wide text-paper-400 uppercase transition-colors hover:text-paper-200"
        >
          <span>Scene images</span>
          <svg
            viewBox="0 0 16 16"
            fill="none"
            aria-hidden
            className={cx("size-3.5 transition-transform", scenesOpen && "rotate-180")}
          >
            <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        {scenesOpen && ready && character ? (
          <div className="px-4 pb-3">
            <SceneStrip
              chatId={chatId}
              name={name}
              hasChat={lines.length > 0}
              scenes={sceneList}
              rendering={sceneRendering}
              onRefresh={() => scenes.reload({ silent: true })}
              sceneModel={parseChatSceneModel(chatState?.sceneModel)}
              onSceneModelChange={saveSceneModel}
            />
          </div>
        ) : null}
      </section>

      <div className="flex min-h-0 flex-1">
        {/* Standing portrait (≥lg only): the companion beside the story, using the
            desktop side real estate. Hidden below lg — phones reach the full-size
            portrait by tapping the header portrait or any reply's avatar instead. */}
        {ready && character ? (
          <aside className="hidden w-52 shrink-0 flex-col gap-4 p-4 lg:flex xl:w-64">
            <button
              type="button"
              onClick={() => setPortraitOpen(true)}
              disabled={!character.avatarImageId}
              aria-label={`View ${who}'s portrait`}
              title={character.avatarImageId ? "View full size" : undefined}
              className="block w-full cursor-pointer rounded-card transition-opacity hover:opacity-90 disabled:cursor-default disabled:hover:opacity-100"
            >
              <AvatarPanel name={name} avatarImageId={character.avatarImageId} className="w-full" />
            </button>
            {roster.length > 0 ? (
              <ChatRosterPanel
                chatId={chatId}
                roster={roster}
                archived={archived}
                onChanged={() => bootstrap.reload({ silent: true })}
                onOpenSheet={(member) => setSheetMember(member)}
              />
            ) : null}
          </aside>
        ) : null}
        <div
          ref={scrollRef}
          onScroll={(e) => {
            // Stick while within a small slack of the bottom; scrolling up releases.
            const el = e.currentTarget;
            stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          }}
          className="min-h-0 flex-1 overflow-y-auto px-4 py-4"
        >
          <div ref={contentRef} className="mx-auto flex max-w-3xl flex-col gap-3">
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
                      knownNames={rosterNames}
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
                      onEnlargeAvatar={character?.avatarImageId ? () => setPortraitOpen(true) : undefined}
                    />
                    {moments ? <SceneMomentRow images={moments} name={name} /> : null}
                  </div>
                );
              })
            )}
          </div>
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
              onInitiative={() => {
                // Reopen-opener initiative (chat-initiative.plan.md): a continue-kind
                // exchange whose cue the server builds from her loops/wants + the
                // "a life meanwhile" license. Player-tapped, never background (D3).
                void (async () => {
                  const outcome = await runStream({ kind: "continue", initiative: true, model: chatModel });
                  if (!outcome.ok) toast.push({ title: "Reply failed", description: outcome.error?.message, tone: "error" });
                })();
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
          {attachments.length ? (
            // Staged photos for the next send (chat-image-input.plan.md).
            <div className="flex flex-wrap items-center gap-1.5">
              {attachments.map((imageId) => (
                <div key={imageId} className="relative">
                  <EntityImage imageId={imageId} name="photo" alt="Photo to send" className="h-14 w-14 rounded-md object-cover" />
                  <button
                    type="button"
                    aria-label="Remove photo"
                    onClick={() => setAttachments((prev) => prev.filter((a) => a !== imageId))}
                    className="absolute -top-1.5 -right-1.5 flex size-5 cursor-pointer items-center justify-center rounded-full bg-ink-700 text-xs text-paper-300 hover:bg-ink-600 hover:text-paper-100"
                  >
                    ×
                  </button>
                </div>
              ))}
              {attachBusy ? <span className="text-xs text-paper-500">Uploading…</span> : null}
            </div>
          ) : attachBusy ? (
            <span className="text-xs text-paper-500">Uploading…</span>
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
              <>
                <input
                  ref={attachInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/avif"
                  multiple
                  hidden
                  onChange={(e) => {
                    void pickAttachments(e.currentTarget.files);
                    e.currentTarget.value = ""; // re-picking the same file must re-fire
                  }}
                />
                <button
                  type="button"
                  onClick={() => attachInputRef.current?.click()}
                  disabled={!ready || attachBusy || attachments.length >= 4}
                  aria-label="Attach a photo"
                  title={`Show ${who} a photo (up to 4 per message)`}
                  className="touch-target inline-flex cursor-pointer items-center justify-center rounded-md px-2 py-2 text-paper-500 transition-colors hover:text-accent-300 disabled:cursor-not-allowed disabled:text-paper-600"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden className="size-4.5">
                    <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                  </svg>
                </button>
              </>
            ) : null}
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
              <Button
                variant="primary"
                onClick={() => void send()}
                disabled={archived || !ready || attachBusy || (!input.trim() && !attachments.length)}
              >
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
          characterId={roster[0]?.characterId}
          presence={roster.length > 1 ? roster[0]?.presence : undefined}
          onPresenceChanged={() => bootstrap.reload({ silent: true })}
          snapshot={chatState}
          onSaved={(next) => {
            setChatState(next);
            stageRef.current = next.regardBand.label;
          }}
        />
      ) : null}

      {/* Per-character sheet (followups ruling 13): a roster member's own state,
          fetched fresh on open and edited via characterId targeting. */}
      {sheetMember && sheetSnapshot ? (
        <ChatStateToolsModal
          open
          onClose={() => {
            setSheetMember(null);
            setSheetSnapshot(null);
          }}
          chatId={chatId}
          who={sheetMember.name}
          characterId={sheetMember.characterId}
          presence={roster.length > 1 ? sheetMember.presence : undefined}
          onPresenceChanged={() => bootstrap.reload({ silent: true })}
          snapshot={sheetSnapshot}
          onSaved={(next) => {
            // Editing the PRIMARY through their sheet also refreshes the strip.
            if (sheetMember.characterId === roster[0]?.characterId) {
              setChatState(next);
              stageRef.current = next.regardBand.label;
            }
            setSheetMember(null);
            setSheetSnapshot(null);
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

      {/* One lightbox serves every portrait affordance (header / standing / reply avatars). */}
      <ImageLightbox
        imageId={portraitOpen ? (character?.avatarImageId ?? null) : null}
        alt={name}
        onClose={() => setPortraitOpen(false)}
      />
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
  onRoster,
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
  /** The roster panel (multi-character-chat.plan.md): add/remove members, presence toggles. */
  onRoster: () => void;
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
        Character sheet
      </MenuItem>
      <MenuItem onClick={onRoster}>Roster</MenuItem>
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
