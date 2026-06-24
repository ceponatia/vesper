"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { CHAT_ACTIONS, CHAT_PREMISE_MAX_CHARS, type ChatActionId } from "@/contracts";
import {
  charactersApi,
  sendCharacterChat,
  type ChatResetScope,
  type ChatStateSnapshot,
  type ImageRecord,
} from "@/lib/client/api";
import { DEFAULT_CHARACTER_CHAT_MODEL_ID, NARRATIVE_MODELS } from "@/lib/narrative-models";
import { useAsyncData } from "@/components/hooks/use-async";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { EntityImage } from "@/components/ui/entity-image";
import { ErrorState } from "@/components/ui/error-state";
import { ImageLightbox } from "@/components/ui/image-lightbox";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tag, type TagTone } from "@/components/ui/tag";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { ChatStateToolsModal } from "./chat-state-tools";

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
  const [narratorModel, setNarratorModel] = useState(DEFAULT_CHARACTER_CHAT_MODEL_ID);
  const [sending, setSending] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [resetting, setResetting] = useState<ChatResetScope | null>(null);
  // Light chat state (character-chat-state.spec.md): the strip + premise. Held in
  // local state (not useAsyncData) so a post-send refresh can drive the
  // stage-change toast off the value it just fetched.
  const [chatState, setChatState] = useState<ChatStateSnapshot | null>(null);
  const [premise, setPremise] = useState("");
  const [savingPremise, setSavingPremise] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [actionBusy, setActionBusy] = useState<ChatActionId | null>(null);
  const stageRef = useRef<string | null>(null);
  const tempId = useRef(0);
  const mkId = () => `tmp-${tempId.current++}`;
  // Mirrors `sending` synchronously so the post-send id-reconcile can bail if a
  // new send started in the await window (state would be stale in the closure).
  const sendingRef = useRef(false);

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
      setPremise(r.data.premise);
      stageRef.current = r.data.stage.label;
    });
    return () => {
      cancelled = true;
    };
  }, [characterId]);

  // Auto-scroll to the newest line as the conversation grows / streams.
  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
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
    sendingRef.current = true;
    setSending(true);
    const outcome = await sendCharacterChat(characterId, body, (delta) => {
      setLines((prev) => prev.map((l) => (l.id === assistantId ? { ...l, content: l.content + delta } : l)));
    });
    sendingRef.current = false;
    setSending(false);
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
    const outcome = await runStream({ content, model: narratorModel }, content);
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

  const onComposerKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  /** Persist the per-chat premise (Save). Upserts the state row server-side. */
  const savePremise = async () => {
    setSavingPremise(true);
    const result = await charactersApi.saveChatPremise(characterId, premise.trim());
    setSavingPremise(false);
    if (result.ok) {
      setChatState(result.data);
      setPremise(result.data.premise);
      stageRef.current = result.data.stage.label;
      toast.push({ title: "Scenario saved" });
    } else {
      toast.push({ title: "Save failed", description: result.error.message, tone: "error" });
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
    await charactersApi.editChatState(characterId, { premise: premise.trim() });
    const outcome = await runStream({ open: true, model: narratorModel });
    if (!outcome.ok) toast.push({ title: "Couldn't open the scene", description: outcome.error?.message, tone: "error" });
  };

  /** One of the three reset actions (character-chat-state.spec.md §5). */
  const runReset = async (scope: ChatResetScope) => {
    setResetting(scope);
    const result = await charactersApi.resetChat(characterId, scope);
    setResetting(null);
    setResetOpen(false);
    if (!result.ok) {
      toast.push({ title: "Reset failed", description: result.error.message, tone: "error" });
      return;
    }
    if (scope !== "state") setLines([]);
    const fresh = await charactersApi.chatState(characterId);
    if (fresh.ok) {
      setChatState(fresh.data);
      setPremise(fresh.data.premise);
      stageRef.current = fresh.data.stage.label;
    }
    toast.push({
      title: scope === "all" ? "Chat fully reset" : scope === "chat" ? "Transcript cleared" : "State reset",
    });
  };

  const hasAnything = lines.length > 0 || (chatState !== null && (chatState.affinity !== 0 || premise.trim().length > 0));

  return (
    <div className="flex flex-col gap-5">
      <SceneStrip characterId={characterId} name={name} hasChat={lines.length > 0} />

      <div className="flex items-center justify-between gap-3">
        <h3 className="text-xs font-medium tracking-wide text-paper-400 uppercase">Conversation</h3>
        <div className="flex items-center gap-2">
          <Select
            aria-label="Narrator model"
            value={narratorModel}
            onChange={(e) => setNarratorModel(e.target.value)}
            className="h-8 w-44 text-xs"
          >
            {NARRATIVE_MODELS.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </Select>
          {chatState ? (
            <Button size="sm" variant="quiet" onClick={() => setToolsOpen(true)}>
              State tools
            </Button>
          ) : null}
          {hasAnything ? (
            <Button size="sm" variant="quiet" onClick={() => setResetOpen(true)}>
              Reset…
            </Button>
          ) : null}
        </div>
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
              <MessageBubble
                key={line.id}
                line={line}
                name={name}
                avatarImageId={avatarImageId}
                streaming={sending}
                onEdit={editLine}
                onDelete={deleteLine}
              />
            ))}
            <div ref={bottomRef} />
          </>
        )}
      </div>

      {chatState ? (
        <div className="flex flex-col gap-2">
          <StatusStrip state={chatState} />
          <ActionChips busy={actionBusy} disabled={sending} onAction={runAction} />
        </div>
      ) : null}

      <PremiseBar
        value={premise}
        who={who}
        saving={savingPremise}
        promptDisabled={sending}
        onChange={setPremise}
        onSave={savePremise}
        onPromptCharacter={promptCharacter}
      />

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
        open={resetOpen}
        onClose={() => {
          if (!resetting) setResetOpen(false);
        }}
        title="Reset this chat"
        footer={
          <Button onClick={() => setResetOpen(false)} disabled={resetting !== null}>
            Cancel
          </Button>
        }
      >
        <div className="flex flex-col gap-3 text-sm">
          <p className="text-paper-400">
            Pick what to reset. The transcript and {who}&rsquo;s disposition (affinity, mood, scenario) are separate.
          </p>
          <ResetOption
            title="Reset state"
            description={`Keep the transcript; re-seed ${who}'s disposition and scenario from the authored defaults.`}
            busy={resetting === "state"}
            disabled={resetting !== null}
            onClick={() => runReset("state")}
          />
          <ResetOption
            title="Reset chat"
            description="Clear the messages and summary but keep the current disposition and scenario, to start a fresh transcript."
            busy={resetting === "chat"}
            disabled={resetting !== null}
            onClick={() => runReset("chat")}
          />
          <ResetOption
            title="Reset all"
            description="Clear everything — messages, summary, and disposition. Generated scene images are kept (find them in the Gallery)."
            tone="danger"
            busy={resetting === "all"}
            disabled={resetting !== null}
            onClick={() => runReset("all")}
          />
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
            setPremise(next.premise);
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

/** Compact, off-baseline meter pips for the status strip (only what's worth saying). */
function meterPips(meters: Record<string, number>): { id: string; label: string; tone: TagTone }[] {
  const pips: { id: string; label: string; tone: TagTone }[] = [];
  const energy = meters.energy ?? 0.9;
  if (energy <= 0.45) pips.push({ id: "energy", label: energy <= 0.2 ? "exhausted" : "tired", tone: "default" });
  const hygiene = meters.hygiene ?? 0.9;
  if (hygiene <= 0.55) pips.push({ id: "hygiene", label: hygiene <= 0.3 ? "unwashed" : "lived-in", tone: "default" });
  const stress = meters.stress ?? 0.15;
  if (stress >= 0.6) pips.push({ id: "stress", label: stress >= 0.85 ? "near breaking" : "on edge", tone: "danger" });
  const arousal = meters.arousal ?? 0;
  if (arousal >= 0.55) pips.push({ id: "arousal", label: "flushed", tone: "accent" });
  const intoxication = meters.intoxication ?? 0;
  if (intoxication >= 0.35)
    pips.push({ id: "intoxication", label: intoxication >= 0.7 ? "drunk" : "tipsy", tone: "accent" });
  const mood = meters.mood ?? 0.5;
  if (mood >= 0.65) pips.push({ id: "mood", label: "bright", tone: "ok" });
  else if (mood <= 0.35) pips.push({ id: "mood", label: "low", tone: "default" });
  return pips;
}

/**
 * The status strip above the composer: an affinity stage chip (heart) + meter
 * pips, shown only when off-baseline so casual chats stay clean
 * (character-chat-state.spec.md §7). Fed by GET …/chat/state, refetched per send.
 */
function StatusStrip({ state }: { state: ChatStateSnapshot }) {
  const pips = meterPips(state.meters);
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Tag tone="accent" title={`Affinity ${state.affinity}`}>
        <span aria-hidden>♥</span> {state.stage.label}
      </Tag>
      {pips.map((p) => (
        <Tag key={p.id} tone={p.tone}>
          {p.label}
        </Tag>
      ))}
    </div>
  );
}

/**
 * The premise (Scenario) bar above the composer (character-chat-state.spec.md §7):
 * a collapsible free-text scenario for this chat, pre-filled from the authored
 * default and editable any time. Collapsed by default when empty so casual chats
 * aren't cluttered; it's the headline control for the "easily test scenarios" use.
 */
function PremiseBar({
  value,
  who,
  saving,
  promptDisabled,
  onChange,
  onSave,
  onPromptCharacter,
}: {
  value: string;
  who: string;
  saving: boolean;
  promptDisabled: boolean;
  onChange: (next: string) => void;
  onSave: () => void;
  onPromptCharacter: () => void;
}) {
  const [open, setOpen] = useState(value.trim().length > 0);
  return (
    <div className="rounded-card border border-ink-600 bg-ink-950/40">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between px-3 py-2 text-xs"
      >
        <span className="font-medium tracking-wide text-paper-400 uppercase">Scenario</span>
        <span className="text-paper-500">{open ? "Hide" : value.trim() ? "Edit" : "Set the scene"}</span>
      </button>
      {open ? (
        <div className="flex flex-col gap-2 px-3 pb-3">
          <Textarea
            rows={2}
            value={value}
            maxLength={CHAT_PREMISE_MAX_CHARS}
            onChange={(e) => onChange(e.target.value)}
            placeholder={`Set the scene for this chat with ${who} — e.g. "it's the night before you move away…"`}
          />
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] text-paper-600">
              Chat-only — it never touches {who}&rsquo;s saved bio or personality.
            </span>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="quiet"
                disabled={promptDisabled}
                onClick={onPromptCharacter}
                title={`Let ${who} open the scene from this scenario`}
              >
                Prompt {who}
              </Button>
              <Button size="sm" variant="primary" busy={saving} onClick={onSave}>
                Save
              </Button>
            </div>
          </div>
        </div>
      ) : value.trim() ? (
        <p className="line-clamp-2 px-3 pb-2 text-xs text-paper-500">{value}</p>
      ) : null}
    </div>
  );
}

/** One labeled choice in the reset dialog. */
function ResetOption({
  title,
  description,
  tone = "default",
  busy,
  disabled,
  onClick,
}: {
  title: string;
  description: string;
  tone?: "default" | "danger";
  busy: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded-card border px-3 py-2 text-left transition-colors disabled:opacity-60 ${
        tone === "danger"
          ? "border-danger-500/40 hover:border-danger-500/70"
          : "border-ink-600 hover:border-accent-500/60"
      }`}
    >
      <span className={`text-sm font-medium ${tone === "danger" ? "text-danger-300" : "text-paper-200"}`}>
        {title}
        {busy ? " …" : ""}
      </span>
      <span className="mt-0.5 block text-xs text-paper-500">{description}</span>
    </button>
  );
}

/**
 * One chat line: the user on the right, the character (with avatar) on the left.
 * Hovering a persisted line reveals Edit / Delete — the recovery levers for a
 * refusal (edit rewrites the line in place; delete snips it out of the window).
 * Optimistic, still-streaming, and temp-id lines expose no actions: there is no
 * server row to target until the send settles and ids reconcile.
 */
function MessageBubble({
  line,
  name,
  avatarImageId,
  streaming,
  onEdit,
  onDelete,
}: {
  line: ChatLine;
  name: string;
  avatarImageId: string | null;
  streaming: boolean;
  onEdit: (id: string, content: string) => Promise<boolean>;
  onDelete: (id: string) => Promise<void>;
}) {
  const isUser = line.role === "user";
  const pending = !isUser && line.content === "" && streaming;
  const actionable = !pending && !streaming && !line.id.startsWith("tmp-");
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
            {actionable ? (
              // `.hover-reveal` (globals.css): hover-gated on pointer devices,
              // always shown on touch — the only way these reach a phone. Padded
              // so each is a comfortable finger target, not an 11px glyph.
              <div className="hover-reveal -mx-1 flex gap-1">
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
