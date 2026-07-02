"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  CHAT_ACTIONS,
  meterDefinitions,
  meterStateCue,
  MOOD_BRIGHT_MIN,
  MOOD_LOW_MAX,
  NEUTRAL_MOOD_METER,
  stageById,
  stageMidpoint,
  type ChatActionId,
} from "@/contracts";
import { charactersApi, sendCharacterChat, type ChatStateSnapshot, type ImageRecord } from "@/lib/client/api";
import { NARRATIVE_MODELS } from "@/lib/narrative-models";
import { useAsyncData } from "@/components/hooks/use-async";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { EntityImage } from "@/components/ui/entity-image";
import { ErrorState } from "@/components/ui/error-state";
import { ImageLightbox } from "@/components/ui/image-lightbox";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { MoodChip } from "@/components/ui/mood-chip";
import { AvatarPanel } from "@/components/avatar";
import { Tag, type TagTone } from "@/components/ui/tag";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { ChatScenarioModal } from "./chat-scenario-modal";
import { ChatStateToolsModal } from "./chat-state-tools";

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

  const transcript = useAsyncData(() => charactersApi.chatTranscript(characterId), [characterId]);
  const [lines, setLines] = useState<ChatLine[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [resetting, setResetting] = useState(false);
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

  // Seed the editable transcript from the load exactly once per character (the
  // "adjust state while rendering" pattern) so a streamed/optimistic reply is
  // never clobbered by the fetch settling; switching characters re-seeds.
  const [seededFor, setSeededFor] = useState<string | null>(null);
  if (seededFor !== characterId && !transcript.loading && transcript.data) {
    setSeededFor(characterId);
    setLines(transcript.data.map((m) => ({ id: m.id, role: m.role, content: m.content })));
  }

  // Load the light state once per character (the premise pre-fills from the
  // authored default). Writes happen past the await, so no in-render setState.
  useEffect(() => {
    let cancelled = false;
    void charactersApi.chatState(characterId).then((r) => {
      if (cancelled || !r.ok) return;
      setChatState(r.data);
      stageRef.current = r.data.stage.label;
    });
    return () => {
      cancelled = true;
    };
  }, [characterId]);

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
  const refreshState = async () => {
    const prior = stageRef.current;
    const result = await charactersApi.chatState(characterId);
    if (!result.ok) return;
    setChatState(result.data);
    if (prior && result.data.stage.label !== prior) {
      toast.push({ title: `${who} now regards you as ${result.data.stage.label.toLowerCase()}.` });
    }
    stageRef.current = result.data.stage.label;
  };

  /**
   * Shared streaming flow for both a normal send and the Prompt Character opening
   * beat: append an optimistic assistant bubble (and a user line, if any), stream
   * the reply into it, then reconcile temp-ids against the persisted transcript and
   * refresh the state strip. `userLine` omitted ⇒ the opening beat (no player line).
   */
  const runStream = async (body: { content?: string; model?: string; open?: boolean }, userLine?: string) => {
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
    const outcome = await sendCharacterChat(
      characterId,
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
    const fresh = await charactersApi.chatTranscript(characterId);
    if (fresh.ok && !sendingRef.current) {
      setLines(fresh.data.map((m) => ({ id: m.id, role: m.role, content: m.content })));
    }
    // The pulse + drift settle server-side as the stream finalizes; refetch the
    // strip so the disposition (and any stage change) shows after the exchange.
    await refreshState();
    return outcome;
  };

  const send = async () => {
    const content = input.trim();
    if (!content || sendingRef.current) return;
    setInput("");
    const outcome = await runStream({ content, model: chatModel }, content);
    if (!outcome.ok) toast.push({ title: "Reply failed", description: outcome.error?.message, tone: "error" });
  };

  /** Overwrite one message's text in place; updates the line on success. */
  const editLine = async (id: string, content: string): Promise<boolean> => {
    const result = await charactersApi.editChatMessage(characterId, id, content);
    if (result.ok) {
      setLines((prev) => prev.map((l) => (l.id === id ? { ...l, content } : l)));
      return true;
    }
    toast.push({ title: "Edit failed", description: result.error.message, tone: "error" });
    return false;
  };

  /** Delete a single message; removes the line on success. */
  const deleteLine = async (id: string) => {
    const result = await charactersApi.deleteChatMessage(characterId, id);
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
    await Promise.all(doomed.map((l) => charactersApi.deleteChatMessage(characterId, l.id)));
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
    setActionBusy(action);
    const result = await charactersApi.applyChatAction(characterId, action);
    setActionBusy(null);
    if (result.ok) {
      setChatState(result.data);
      stageRef.current = result.data.stage.label;
    } else {
      toast.push({ title: "Action failed", description: result.error.message, tone: "error" });
    }
  };

  /** Prompt Character (opening beat): save the premise, then stream a character-authored opening turn. */
  const promptCharacter = async () => {
    if (sendingRef.current) return;
    // The premise now lives in chat-state (saved via the Scenario modal); the server reads it.
    const outcome = await runStream({ open: true, model: chatModel });
    if (!outcome.ok) toast.push({ title: "Couldn't open the scene", description: outcome.error?.message, tone: "error" });
  };

  /** The single Clear Chat (character-chat-primary.spec.md §4): wipes transcript, summary, state, and memory. */
  const clearChat = async () => {
    setResetting(true);
    const result = await charactersApi.resetChat(characterId);
    setResetting(false);
    setResetOpen(false);
    if (!result.ok) {
      toast.push({ title: "Clear failed", description: result.error.message, tone: "error" });
      return;
    }
    setLines([]);
    const fresh = await charactersApi.chatState(characterId);
    if (fresh.ok) {
      setChatState(fresh.data);
      stageRef.current = fresh.data.stage.label;
    }
    toast.push({ title: "Chat cleared" });
  };

  const hasAnything =
    lines.length > 0 || (chatState !== null && (chatState.affinity !== 0 || chatState.premise.trim().length > 0));

  return (
    <div className="flex flex-col gap-5">
      <SceneStrip characterId={characterId} name={name} hasChat={lines.length > 0} />

      {/* The standing companion portrait sits beside the conversation. */}
      <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:gap-6">
        {chatState ? (
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
              {chatState ? (
                <Button size="sm" variant="quiet" disabled={sending} onClick={promptCharacter} title={`Let ${who} open the scene`}>
                  Prompt {who}
                </Button>
              ) : null}
              {chatState ? (
                <Button size="sm" variant="quiet" onClick={() => setScenarioOpen(true)}>
                  Scenario setup
                </Button>
              ) : null}
              {chatState ? (
                <Button size="sm" variant="quiet" onClick={() => setToolsOpen(true)}>
                  State tools
                </Button>
              ) : null}
              {hasAnything ? (
                <Button size="sm" variant="quiet" onClick={() => setResetOpen(true)}>
                  Clear chat…
                </Button>
              ) : null}
            </div>
          </div>

          <div
            ref={scrollRef}
            className="flex max-h-[28rem] min-h-48 flex-col gap-3 overflow-y-auto rounded-card border border-ink-600 bg-ink-950/40 p-4"
          >
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
            <Button variant="primary" onClick={send} busy={sending} disabled={!input.trim()}>
              Send
            </Button>
          </div>
        </div>
      </div>

      <Dialog
        open={resetOpen}
        onClose={() => {
          if (!resetting) setResetOpen(false);
        }}
        title="Clear this chat?"
        footer={
          <div className="flex justify-end gap-2">
            <Button onClick={() => setResetOpen(false)} disabled={resetting}>
              Cancel
            </Button>
            <Button variant="danger" onClick={clearChat} disabled={resetting}>
              {resetting ? "Clearing…" : "Clear chat"}
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-3 text-sm text-paper-400">
          <p>
            This erases everything for your conversation with {who}: the transcript, the running summary,{" "}
            {who}&rsquo;s disposition (affinity, mood, scenario), and everything {who} remembers about you. It starts
            fresh from the authored defaults and can&rsquo;t be undone.
          </p>
          <p className="text-xs text-paper-500">Generated scene images are kept — find them in the Gallery.</p>
        </div>
      </Dialog>

      {chatState ? (
        <ChatStateToolsModal
          open={toolsOpen}
          onClose={() => setToolsOpen(false)}
          characterId={characterId}
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
          characterId={characterId}
          who={who}
          snapshot={chatState}
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

/** Test-bed action chips (character-chat-state.spec.md slice 4): one-click state nudges. */
function ActionChips({
  busy,
  disabled,
  onAction,
}: {
  busy: ChatActionId | null;
  disabled: boolean;
  onAction: (action: ChatActionId) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {CHAT_ACTIONS.map((action) => (
        <Button
          key={action.id}
          size="sm"
          variant="quiet"
          busy={busy === action.id}
          disabled={disabled || busy !== null}
          onClick={() => onAction(action.id)}
        >
          {action.label}
        </Button>
      ))}
    </div>
  );
}

/** Presentation tone per meter; band vocabulary itself lives in the registry. */
const PIP_TONES: Record<string, TagTone> = { stress: "danger", arousal: "accent", intoxication: "accent" };

/**
 * Compact, off-baseline meter pips for the status strip (only what's worth saying).
 * Bands + labels come from the meters registry (`pipLabel` on each threshold), so a
 * registry edit moves this strip and the narration cues together — the old hardcoded
 * copies silently desynced (codebase-review A10). Mood is the deliberate exception:
 * it has no registry thresholds (derived descriptor instead), so it reads the shared
 * valence band cuts.
 */
function meterPips(meters: Record<string, number>): { id: string; label: string; tone: TagTone }[] {
  const pips: { id: string; label: string; tone: TagTone }[] = [];
  for (const def of meterDefinitions) {
    const value = meters[def.id];
    if (value === undefined) continue;
    const cue = meterStateCue(def.id, value);
    if (!cue?.pipLabel) continue;
    pips.push({ id: def.id, label: cue.pipLabel, tone: PIP_TONES[def.id] ?? "default" });
  }
  const mood = meters.mood ?? NEUTRAL_MOOD_METER;
  if (mood >= MOOD_BRIGHT_MIN) pips.push({ id: "mood", label: "bright", tone: "ok" });
  else if (mood <= MOOD_LOW_MAX) pips.push({ id: "mood", label: "low", tone: "default" });
  return pips;
}

/**
 * The status strip above the composer: an affinity stage chip (heart) + meter
 * pips, shown only when off-baseline so casual chats stay clean
 * (character-chat-state.spec.md §7). Fed by GET …/chat/state, refetched per send.
 */
function StatusStrip({ state, startingStage }: { state: ChatStateSnapshot; startingStage: string }) {
  const pips = meterPips(state.meters);
  // A fresh chat (no stored row) previews the authored Starting Relationship, so editing
  // the dropdown moves the chip at once. Once the chat has its own disposition we show
  // that — the seed is then inert (Reset state re-seeds from the authored default).
  const seed = state.persisted ? undefined : stageById(startingStage);
  const stageLabel = seed?.label ?? state.stage.label;
  const affinity = seed ? stageMidpoint(startingStage) : state.affinity;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <MoodChip emotion={state.emotion} className="text-xs" />
      <Tag tone="accent" title={`Affinity ${affinity}`}>
        <span aria-hidden>♥</span> {stageLabel}
      </Tag>
      {pips.map((p) => (
        <Tag key={p.id} tone={p.tone}>
          {p.label}
        </Tag>
      ))}
    </div>
  );
}

/** Circular-arrow "rerun" glyph (stroke-based, 24×24 box — matches the nav icons). */
function RerunIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={className}
    >
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 3v5h-5" />
    </svg>
  );
}

/**
 * One chat line: the user on the right, the character (with avatar) on the left.
 * Hovering a persisted line reveals Edit / Delete — the recovery levers for a
 * refusal (edit rewrites the line in place; delete snips it out of the window) —
 * and, on the user's own lines, Rerun: re-send this prompt for a fresh reply,
 * dropping everything after it (and cancelling any in-flight reply). Rerun stays
 * available while a reply streams, precisely so it can interrupt one; Edit/Delete
 * don't (mutating mid-stream is ambiguous). Optimistic / still-streaming temp-id
 * lines expose no actions: there is no server row to target until ids reconcile.
 */
function MessageBubble({
  line,
  name,
  avatarImageId,
  streaming,
  onEdit,
  onDelete,
  onRerun,
}: {
  line: ChatLine;
  name: string;
  avatarImageId: string | null;
  streaming: boolean;
  onEdit: (id: string, content: string) => Promise<boolean>;
  onDelete: (id: string) => Promise<void>;
  onRerun: (id: string) => void;
}) {
  const isUser = line.role === "user";
  const pending = !isUser && line.content === "" && streaming;
  const persisted = !pending && !line.id.startsWith("tmp-");
  // Edit/Delete only on a settled line; Rerun also mid-stream so it can interrupt.
  const canModify = persisted && !streaming;
  const canRerun = isUser && persisted;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(line.content);
  const [saving, setSaving] = useState(false);

  const startEdit = () => {
    setDraft(line.content);
    setEditing(true);
  };

  const save = async () => {
    const next = draft.trim();
    if (!next || next === line.content) {
      setEditing(false);
      return;
    }
    setSaving(true);
    const ok = await onEdit(line.id, next);
    setSaving(false);
    if (ok) setEditing(false);
  };

  return (
    <div className={`group flex gap-2.5 ${isUser ? "flex-row-reverse" : "flex-row"}`}>
      {!isUser ? (
        <EntityImage imageId={avatarImageId} name={name} className="mt-0.5 size-8 shrink-0 rounded-full text-xs" />
      ) : null}
      <div className={`flex max-w-[80%] flex-col gap-1 ${isUser ? "items-end" : "items-start"}`}>
        {editing ? (
          <div className="flex w-full min-w-64 flex-col gap-1.5">
            <Textarea
              rows={2}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              className="field-sizing-content max-h-[60vh] w-full text-sm"
              autoFocus
            />
            <div className="flex justify-end gap-1.5">
              <Button size="sm" variant="quiet" onClick={() => setEditing(false)} disabled={saving}>
                Cancel
              </Button>
              <Button size="sm" variant="primary" busy={saving} onClick={save}>
                Save
              </Button>
            </div>
          </div>
        ) : (
          <>
            <div
              className={`rounded-card px-3 py-2 text-sm whitespace-pre-wrap ${
                isUser ? "bg-accent-500/15 text-paper-100" : "bg-ink-800 text-paper-200"
              }`}
            >
              {pending ? <span className="text-paper-500">…</span> : line.content}
            </div>
            {canModify || canRerun ? (
              // `.hover-reveal` (globals.css): hover-gated on pointer devices,
              // always shown on touch — the only way these reach a phone. Padded
              // so each is a comfortable finger target, not an 11px glyph.
              <div className="hover-reveal -mx-1 flex items-center gap-1">
                {canModify ? (
                  <>
                    <button
                      type="button"
                      onClick={startEdit}
                      className="rounded px-2 py-1 text-[11px] text-paper-500 hover:text-paper-200"
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => void onDelete(line.id)}
                      className="rounded px-2 py-1 text-[11px] text-paper-500 hover:text-danger-400"
                    >
                      Delete
                    </button>
                  </>
                ) : null}
                {canRerun ? (
                  <button
                    type="button"
                    onClick={() => onRerun(line.id)}
                    aria-label="Rerun from here"
                    title="Re-send this message — replaces everything after it with a fresh reply"
                    className="rounded px-2 py-1 text-paper-500 hover:text-accent-300"
                  >
                    <RerunIcon className="size-3.5" />
                  </button>
                ) : null}
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

/** Manual scene-image renderer + history strip for the chat. */
function SceneStrip({ characterId, name, hasChat }: { characterId: string; name: string; hasChat: boolean }) {
  const toast = useToast();
  const scenes = useAsyncData(() => charactersApi.chatScenes(characterId), [characterId]);
  const [generating, setGenerating] = useState(false);
  const [enlarged, setEnlarged] = useState<{ id: string; prompt: string | null } | null>(null);
  const baselineRef = useRef(0);

  const sceneList = scenes.data ?? [];
  const hasPendingRow = sceneList.some((s) => s.status === "pending");
  const hasPending = hasPendingRow || generating;
  // Show an immediate placeholder the instant "Generate" is clicked — the image
  // row doesn't exist until the (slow) composer step finishes, so without this
  // the strip would give no feedback during compose. Once the pending row lands,
  // its own labeled tile takes over (and `generating` is released below).
  const showComposing = generating && !hasPendingRow;

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
        <div className="flex items-center gap-2">
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
      </div>
      {sceneList.length === 0 && !showComposing ? (
        <p className="text-sm text-paper-500">
          No scenes yet. “Generate scene” paints the current moment from your recent exchange.
        </p>
      ) : (
        <div className="flex gap-2.5 overflow-x-auto pb-1">
          {showComposing ? (
            <div className="w-28 shrink-0">
              <PendingSceneTile />
            </div>
          ) : null}
          {sceneList.map((img) => {
            const error = sceneError(img);
            return (
              <div key={img.id} className="w-28 shrink-0">
                {img.status === "pending" ? (
                  <PendingSceneTile />
                ) : img.status === "failed" ? (
                  <div className="flex aspect-[3/4] w-full flex-col justify-center gap-1.5 rounded-card border border-danger-500/40 bg-ink-950/60 px-2 py-3">
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
                    onClick={() => setEnlarged({ id: img.id, prompt: img.prompt || null })}
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
        prompt={enlarged?.prompt ?? null}
        onClose={() => setEnlarged(null)}
      />
    </div>
  );
}

/** In-progress scene tile: a pulsing placeholder with an explicit "Painting…" label. */
function PendingSceneTile() {
  return (
    <div className="relative aspect-[3/4] w-full overflow-hidden rounded-card border border-ink-600">
      <Skeleton className="absolute inset-0 rounded-none" />
      <span className="absolute inset-x-0 bottom-0 bg-ink-950/80 px-2 py-1 text-center text-[11px] text-paper-300">
        Painting…
      </span>
    </div>
  );
}
