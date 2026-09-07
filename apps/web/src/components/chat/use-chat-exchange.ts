"use client";

import { useLayoutEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { ChatActionId } from "@/contracts";
import { chatsApi, sendChatMessage, type ChatStreamOutcome } from "@/lib/client/api";
import { replyRevealHoldMs } from "@/lib/chat-pacing";
import { useToast } from "@/components/ui/toast";
import { PER_CHAT_DEFAULTS, type PerChatState } from "./chat-conversation-state";
import { replyFailureToast } from "./reply-failure";
import type { useChatTranscript } from "./use-chat-transcript";

type Setter<K extends keyof PerChatState> = Dispatch<SetStateAction<PerChatState[K]>>;
interface ExchangeOptions {
  chatId: string;
  transcript: Pick<ReturnType<typeof useChatTranscript>, "lines" | "setLines" | "isCurrent" | "sendingRef" | "reloadTranscript">;
  ready: boolean;
  archived: boolean;
  setArchived: Setter<"archived">;
  chatModel: string;
  chatState: PerChatState["chatState"];
  input: string;
  setInput: Setter<"input">;
  narratorMode: boolean;
  attachments: string[];
  setAttachments: Setter<"attachments">;
  setOocActive: Setter<"oocActive">;
  attachBusy: boolean;
  skipBusy: boolean;
  setPickupDismissed: Setter<"pickupDismissed">;
  setWantsSay: Setter<"wantsSay">;
  pin: () => void;
  refreshState: () => Promise<void>;
  refreshScenes: () => void;
  refreshWorld: () => void;
  who: string;
}

/** Reply lifecycle and optimistic rows share the transcript owner's chat identity. */
export function useChatExchange({ chatId, transcript, ready, archived, setArchived,
  chatModel, chatState, input, setInput, narratorMode, attachments, setAttachments,
  setOocActive, attachBusy, skipBusy, setPickupDismissed, setWantsSay, pin,
  refreshState, refreshScenes, refreshWorld, who }: ExchangeOptions) {
  const { lines, setLines, isCurrent, sendingRef, reloadTranscript } = transcript;
  const toast = useToast();
  const [sending, setSending] = useState(PER_CHAT_DEFAULTS.sending);
  const [stopping, setStopping] = useState(PER_CHAT_DEFAULTS.stopping);
  const [actionBusy, setActionBusy] = useState(PER_CHAT_DEFAULTS.actionBusy);
  const tempId = useRef(0);
  const mkId = () => `tmp-${tempId.current++}`;
  // Active-stream identity only: Stop and rerun are server-side operations.
  const abortRef = useRef<AbortController | null>(null);
  useLayoutEffect(() => {
    abortRef.current = null;
  }, [chatId]);
  /**
   * Shared streaming flow for every reply kind — send, opening beat, Go on, and
   * Another take: stream the reply into an assistant bubble, then reconcile against
   * the persisted transcript and refresh the state strip. `userLine` appends the
   * player's optimistic line first (a normal send); omitted ⇒ a character-only beat.
   * `replaceId` (Another take) streams into the EXISTING last reply
   * instead of appending — the server updates that row in place, and the post-settle
   * transcript reload picks up the recorded takes.
   */
  const runStream = async (
    body: {
      kind?: "send" | "open" | "continue" | "action_beat" | "regenerate" | "rerun";
      content?: string;
      model?: string;
      cue?: string;
      messageId?: string;
      attachmentIds?: string[];
      initiative?: boolean;
      inputMode?: "player" | "narrator";
      action?: ChatActionId;
    },
    opts: { userLine?: string; replaceId?: string; attachmentIds?: string[]; narrator?: boolean } = {},
  ): Promise<ChatStreamOutcome> => {
    const { userLine, replaceId } = opts;
    // Any exchange consumes the reopen affordances (the pickup strip and the
    // "has something to say" opener) for this visit.
    setPickupDismissed(true);
    setWantsSay(false);
    // An exchange the player initiates re-pins the transcript (even from a scrolled-up
    // read) — the reply they asked for should stream into view.
    pin();
    const assistantId = replaceId ?? mkId();
    // The take being replaced, kept so a failed regenerate can put it back.
    const priorLine = replaceId !== undefined ? lines.find((l) => l.id === replaceId) : undefined;
    if (replaceId !== undefined) {
      setLines((prev) => prev.map((l) => (l.id === replaceId ? { ...l, content: "", stopped: false } : l)));
    } else {
      setLines((prev) => [
        ...prev,
        ...(userLine !== undefined
          ? [{ id: mkId(), role: "user" as const, content: userLine, attachmentIds: opts.attachmentIds, narrator: opts.narrator }]
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
    // Reply pacing (UI-only): hold the "…" bubble
    // briefly before revealing tokens — a cold or hurt character lets the message sit,
    // a warm one answers at once. Tokens buffer during the hold; nothing is lost.
    const holdUntil = Date.now() + replyRevealHoldMs(chatState ? { regard: chatState.regard, feeling: chatState.feeling.current } : null);
    let held = "";
    let holdTimer: ReturnType<typeof setTimeout> | null = null;
    const append = (text: string) => {
      if (!isCurrent() || abortRef.current !== controller) return;
      setLines((prev) => prev.map((l) => (l.id === assistantId ? { ...l, content: l.content + text } : l)));
    };
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
        // The sim lane's transport keepalive (a zero-width space every 8s while
        // the successor turn thinks) is not content: counting it as received
        // would silence the no-reply failure popup below, and appending it
        // would leave invisible characters in the bubble.
        const text = delta.replace(/\u200B/g, "");
        if (!text) return;
        received = true;
        if (Date.now() < holdUntil) {
          held += text;
          holdTimer ??= setTimeout(flushHeld, holdUntil - Date.now());
          return;
        }
        flushHeld();
        append(text);
      },
      controller.signal,
    );
    // Stream settled (success, stop, or failure): reveal anything still held so the
    // cleanup below sees the real content (a partial held mid-hold must survive).
    flushHeld();
    // Only release the busy state if we're still the active stream — a rerun may
    // have superseded us and installed its own controller, which now owns `sending`,
    // or a chat switch may have cleared the token out from under us (this reply
    // belongs to a conversation that is no longer on screen).
    const superseded = !isCurrent() || abortRef.current !== controller;
    if (superseded) return outcome;
    abortRef.current = null;
    sendingRef.current = false;
    setSending(false);
    setStopping(false);
    if (outcome.aborted || !outcome.ok) {
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
      // Superseded streams have already returned without changing this chat.
      if (!outcome.ok && outcome.error?.code === "chat_archived") setArchived(true);
      return outcome;
    }
    // Swap the optimistic temp-ids for the persisted ids so the exchange just sent
    // is immediately editable/deletable (and pick up recorded takes + stop marks) —
    // and any world beat the successor turn wrote (slice 2). Skip if another send
    // already started. This resets to the newest page — history the reader paged in
    // collapses (they're at the bottom after their own exchange; Load earlier brings
    // it back), and the cursor re-syncs.
    const fresh = await reloadTranscript();
    // The pulse + drift settle server-side as the stream finalizes; refetch the
    // strip so the disposition (and any stage change) shows after the exchange —
    // and the scene list, since a big moment may have auto-queued a render (slice 9).
    if (!isCurrent()) return outcome;
    await refreshState();
    if (!isCurrent()) return outcome;
    refreshScenes();
    // A successor turn may have moved the world (arrival, scene end) — track it.
    refreshWorld();
    // Zero tokens on an otherwise-clean settle: the narrator produced nothing and
    // persisted no reply. The exchange recorded WHY on the chat row before the
    // stream closed (`last_reply_failure`), and the transcript refetch above just
    // read it back — so the popup names the actual cause (timeout, out of credits,
    // moderation block, …) instead of guessing. The reload already dropped the
    // empty bubble.
    if (!received) {
      toast.push({
        ...replyFailureToast(who, fresh.ok ? fresh.data.chat.lastReplyFailure : null),
        tone: "error",
      });
    }
    return outcome;
  };

  const send = async () => {
    const content = input.trim();
    // A photo-only send is legitimate — showing something IS the message. Narrator
    // mode needs text (narration is words) and never carries photos (a player-POV act).
    const narrator = narratorMode && !attachments.length;
    if (narratorMode && !content) return;
    // `skipBusy` blocks the composer while a world skip/command is draining — parity
    // with the world-card chips (which disable on `skipBusy || sending`), so a typed
    // turn can't race a clock-advance still in flight (command-integrity A1/A2).
    if ((!content && !attachments.length) || sendingRef.current || !ready || archived || attachBusy || skipBusy) return;
    const attachmentIds = attachments.length ? [...attachments] : undefined;
    setInput("");
    setAttachments([]);
    setOocActive(false);
    const outcome = await runStream(
      {
        content: content || undefined,
        model: chatModel,
        attachmentIds,
        ...(narrator ? { inputMode: "narrator" as const } : {}),
      },
      { userLine: content, attachmentIds, narrator },
    );
    if (!isCurrent()) return;
    if (!outcome.ok) toast.push({ title: "Reply failed", description: outcome.error?.message, tone: "error" });
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
    if (!isCurrent()) return;
    if (!outcome.ok) {
      // Nothing was mutated server-side — put the transcript back exactly as it was.
      setLines(prevLines);
      if (!outcome.aborted) {
        toast.push({ title: "Rerun failed", description: outcome.error?.message, tone: "error" });
      }
    }
  };

  /**
   * Tap an action chip: a narrated `action_beat` exchange —
   * the character plays a small beat and the paired deterministic state effect applies
   * pre-narration server-side (the post-settle refresh shows the shift). No player line
   * is persisted; `actionBusy` marks which chip is streaming.
   */
  const runAction = async (action: ChatActionId) => {
    if (sendingRef.current || !ready || archived) return;
    setActionBusy(action);
    const outcome = await runStream({ kind: "action_beat", action, model: chatModel });
    if (!isCurrent()) return;
    setActionBusy(null);
    if (!outcome.ok) toast.push({ title: "Action failed", description: outcome.error?.message, tone: "error" });
  };

  /** Prompt Character (opening beat): stream a character-authored opening turn (the premise comes from chat state). */
  const promptCharacter = async () => {
    if (sendingRef.current || !ready || archived) return;
    const outcome = await runStream({ kind: "open", model: chatModel });
    if (!isCurrent()) return;
    if (!outcome.ok) toast.push({ title: "Couldn't open the scene", description: outcome.error?.message, tone: "error" });
  };

  /**
   * Stop: cut the streaming reply short SERVER-side — the model stream
   * aborts there, what already streamed persists as the reply (`meta.stopped`), and
   * our reader ends naturally with the truncated text. Deliberately NOT a client
   * abort: `abortRef` stays untouched so the settled prefix keeps its bubble. A 404
   * means the reply settled before the click landed — nothing to stop, ignore it.
   */
  const stopReply = async () => {
    if (stopping) return;
    setStopping(true);
    const result = await chatsApi.stop(chatId);
    if (!isCurrent()) return;
    if (!result.ok && result.error.status !== 404) {
      setStopping(false);
      toast.push({ title: "Couldn't stop the reply", description: result.error.message, tone: "error" });
    }
  };

  /** Go on: ask for the character's next beat — no user line, same streaming flow as the opening beat. */
  const goOn = async () => {
    if (sendingRef.current || !ready || archived) return;
    const outcome = await runStream({ kind: "continue", model: chatModel });
    if (!isCurrent()) return;
    if (!outcome.ok) toast.push({ title: "Couldn't continue", description: outcome.error?.message, tone: "error" });
  };

  /** Another take: regenerate the last reply in place; earlier takes stay browsable via the pager. */
  const anotherTake = async (id: string) => {
    if (sendingRef.current || !ready || archived) return;
    const outcome = await runStream({ kind: "regenerate", model: chatModel }, { replaceId: id });
    if (!isCurrent()) return;
    if (!outcome.ok) {
      toast.push({ title: "Couldn't get another take", description: outcome.error?.message, tone: "error" });
    }
  };

  /**
   * Show a different recorded take — display-only: state/memory follow
   * the newest generated take, so this just swaps the row's content + activeId.
   */
  const switchTake = async (messageId: string, takeId: string) => {
    const result = await chatsApi.switchTake(chatId, messageId, takeId);
    if (!isCurrent()) return;
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
   * The "has something to say" opener: let the character speak about their top
   * open loop. With no loops standing (a milestone-keyed marker tap), fall through to the
   * full initiative opener: the server builds her material (loops/wants/the
   * unseen shift) itself.
   */
  const letThemSpeak = async () => {
    const cue = chatState?.openLoops[0];
    const outcome = await runStream(
      cue ? { kind: "continue", model: chatModel, cue } : { kind: "continue", model: chatModel, initiative: true },
    );
    if (!isCurrent()) return;
    if (!outcome.ok) toast.push({ title: "Reply failed", description: outcome.error?.message, tone: "error" });
  };

  /** Player-tapped reopen initiative; the server builds the cue from their state. */
  const requestInitiative = async () => {
    const outcome = await runStream({ kind: "continue", initiative: true, model: chatModel });
    if (!isCurrent()) return;
    if (!outcome.ok) toast.push({ title: "Reply failed", description: outcome.error?.message, tone: "error" });
  };

  return { sending, setSending, stopping, setStopping, actionBusy, setActionBusy,
    requestInitiative, send, rerun, runAction, promptCharacter, stopReply, goOn, anotherTake, switchTake, letThemSpeak };
}
