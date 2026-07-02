"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { ChatActionId } from "@/contracts";
import { charactersApi, sendCharacterChat, type ChatStateSnapshot } from "@/lib/client/api";
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
