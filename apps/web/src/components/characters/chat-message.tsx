"use client";

import { useState } from "react";
import type { WorldBeatKind } from "@/lib/simulation/world-beat";
import type { ReplyTakes } from "@/lib/client/api";
import {
  narratorProvenanceLabel,
  narratorRunProvenanceSchema,
  type NarratorRunProvenance,
} from "@/contracts/narrator-prompts/provenance";
import { parseOrNull } from "@/lib/parse";
import { MessageContent } from "@/components/characters/message-content";
import { chatReplySegments } from "@/components/characters/chat-segments";
import { useIsAdmin } from "@/components/hooks/use-is-admin";
import { Button } from "@/components/ui/button";
import { EntityImage } from "@/components/ui/entity-image";
import { Textarea } from "@/components/ui/textarea";

export interface ChatLine {
  id: string;
  role: "user" | "assistant";
  content: string;
  /** Recorded alternate generations on an assistant reply (spec §4.1); absent on user/optimistic lines. */
  takes?: ReplyTakes;
  /** True when the player cut this reply short with Stop (spec §4.2). */
  stopped?: boolean;
  /** Attached-photo asset ids on a user line (chat-image-input.plan.md) — rendered as thumbs. */
  attachmentIds?: string[];
  /** User line written in NARRATOR mode (chat-supporting-cast.plan.md): story narration, not the player's POV. */
  narrator?: boolean;
  /**
   * World beat (world-ui.plan.md slice 2): a durable travel / time-skip / scene-ended
   * trace on a successor-chat transcript. Set ⇒ the line renders as a muted, compact
   * system line (no portrait, no bubble, no actions) — `content` is the phrased text.
   */
  worldBeat?: WorldBeatKind;
}

/**
 * The narrator-run provenance recorded on one take, when it has any
 * (narrator-prompt-lab.plan.md §Provenance / §"Alternate takes").
 *
 * Read structurally rather than off the take type: the field is optional
 * everywhere, and every take generated before the Prompt Lab existed simply has
 * none. A missing OR malformed record degrades to `null` — no label, no
 * placeholder, no thrown render — which is exactly how a historical take should
 * look. `parseOrNull` with no sink, because a take without provenance is the
 * normal case here, not a boundary failure worth a diagnostic.
 */
function takeProvenance(take: { id: string; provenance?: unknown } | undefined): NarratorRunProvenance | null {
  return take ? parseOrNull(narratorRunProvenanceSchema, take.provenance) : null;
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
 * A narrator/character reply, rendered as in-bubble per-speaker segments
 * (dialogue-attribution). Speaker segments get a small accent label (mirroring the
 * session feed's speaker label) with the `[Name]` tag hidden; narrator-prose segments
 * render bare. Content flows through `MessageContent` so the sigil grammar keeps working.
 * Re-parsing the growing reply on each streaming render is fine — the parser is pure and
 * cheap, and its line-oriented rules keep the unterminated tail stable.
 */
function ReplyBody({ content, knownNames }: { content: string; knownNames: readonly string[] }) {
  const segments = chatReplySegments(content, knownNames);
  const context = { knownNames: knownNames.length ? [...knownNames] : undefined };
  return (
    <>
      {segments.map((seg, i) => (
        <div key={i} className={i > 0 ? "mt-1.5" : undefined}>
          {seg.showLabel && seg.speaker ? (
            <p className="mb-0.5 text-xs font-medium text-accent-300">{seg.speaker}</p>
          ) : null}
          <MessageContent content={seg.content} context={context} />
        </div>
      ))}
    </>
  );
}

/**
 * One chat line: the user on the right, the character (with avatar) on the left.
 * Hovering a persisted line reveals Edit / Delete — the recovery levers for a
 * refusal (edit rewrites the line in place; delete snips it out of the window) —
 * and, on the user's own lines, Rerun: re-send this prompt for a fresh reply, dropping
 * only the lines after it. Rerun stays available while a reply streams, precisely so it
 * can interrupt one — the atomic rerun stops the in-flight reply and snips its successors
 * server-side under the chat lock (data-loss-rerun fix), deleting nothing until the
 * exchange is accepted; Edit/Delete don't (mutating mid-stream is ambiguous). Optimistic
 * / still-streaming temp-id lines expose no actions: there is no server row to target
 * until ids reconcile.
 *
 * Beyond parity (spec §4.1–4.2): the newest reply (`takeTarget`) also offers
 * "Another take" — regenerate in place, keeping earlier takes browsable via the
 * always-visible `‹ 2/3 ›` pager in the footer — and a reply the player cut short
 * with Stop carries a subtle "stopped" chip inside the bubble.
 */
export function MessageBubble({
  line,
  name,
  knownNames,
  avatarImageId,
  streaming,
  takeTarget,
  canEditHistory,
  canDeleteHistory,
  canRerunFromMessage,
  canRetakeLatest,
  onEdit,
  onDelete,
  onRerun,
  onAnotherTake,
  onSwitchTake,
  onRemember,
  onMarkMoment,
  onEnlargeAvatar,
  privacyMode,
}: {
  line: ChatLine;
  name: string;
  /** The full roster's display names (primary first) — the dialogue-tag vocabulary. In a
   *  1-on-1 this is just `[name]`; in a group every member, so non-primary `[Name]` tags
   *  attribute instead of leaking as literal text. `name` stays the primary, for the avatar
   *  and action labels. */
  knownNames: readonly string[];
  avatarImageId: string | null;
  streaming: boolean;
  /** True on the last assistant reply when regeneration is available (parent gates archived). */
  takeTarget: boolean;
  /** Transcript-policy capabilities. The server enforces the same boundary. */
  canEditHistory: boolean;
  canDeleteHistory: boolean;
  canRerunFromMessage: boolean;
  canRetakeLatest: boolean;
  onEdit: (id: string, content: string) => Promise<boolean>;
  onDelete: (id: string) => Promise<void>;
  onRerun: (id: string) => void;
  onAnotherTake: (id: string) => void;
  onSwitchTake: (id: string, takeId: string) => Promise<void>;
  /** "Remember this" (spec §6.4): opens the pinned-note dialog prefilled with this line. Absent ⇒ no action. */
  onRemember?: (content: string) => void;
  /** "Mark this moment" (spec §7.2): pin a player milestone on this message. Absent ⇒ no action. */
  onMarkMoment?: (id: string) => void;
  /** Tap/click the circular avatar to enlarge the portrait (the mobile path to a full-size view). Absent ⇒ plain image. */
  onEnlargeAvatar?: () => void;
  /** Privacy mode (mobile-ux.plan.md ruling 4): render a first-initial monogram
   *  instead of the avatar image, and make the avatar inert — no lightbox tap. */
  privacyMode?: boolean;
}) {
  const isUser = line.role === "user";
  const pending = !isUser && line.content === "" && streaming;
  const persisted = !pending && !line.id.startsWith("tmp-");
  // History mutation is both message-state and transcript-policy dependent. The
  // latter keeps successor chats from exposing legacy operations whose semantics
  // would desynchronize the projected world.
  const canUseSettledLine = persisted && !streaming;
  const canEdit = canUseSettledLine && canEditHistory;
  const canDelete = canUseSettledLine && canDeleteHistory;
  const canRerun = canRerunFromMessage && isUser && persisted;
  const canTake = canRetakeLatest && takeTarget && persisted && !streaming;
  const canRemember = Boolean(onRemember) && canUseSettledLine;
  const canMarkMoment = Boolean(onMarkMoment) && canUseSettledLine;
  // The pager shows on any settled reply carrying multiple takes (not just the last).
  const pagerTakes = !isUser && persisted && line.takes && line.takes.takes.length > 1 ? line.takes : undefined;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(line.content);
  const [saving, setSaving] = useState(false);
  const [switching, setSwitching] = useState(false);

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

  const switchTo = async (takeId: string) => {
    if (switching) return;
    setSwitching(true);
    await onSwitchTake(line.id, takeId);
    setSwitching(false);
  };

  if (line.worldBeat) {
    // A durable world beat (travel / time-skip / scene-ended, world-ui.plan.md
    // slice 2): a muted, compact, non-bubble system line in the successor
    // transcript — no portrait, no speaker label, no hover actions. The phrased
    // text (with its story-time stamp) is server-rendered onto `content`.
    return (
      <div className="flex justify-center px-4 py-1">
        <p className="text-center text-xs text-paper-500 italic">{line.content}</p>
      </div>
    );
  }

  return (
    <div className={`group flex gap-2.5 ${isUser ? "flex-row-reverse" : "flex-row"}`}>
      {!isUser ? (
        privacyMode ? (
          // Inert — no button, no lightbox tap (mobile-ux.plan.md ruling 4): the
          // monogram itself carries the "hidden on purpose" signal.
          <EntityImage
            imageId={avatarImageId}
            name={name}
            privacy
            className="mt-0.5 size-8 shrink-0 rounded-full text-xs"
          />
        ) : onEnlargeAvatar ? (
          <button
            type="button"
            onClick={onEnlargeAvatar}
            aria-label={`View ${name || "the character"}'s portrait`}
            title="View portrait"
            className="mt-0.5 shrink-0 cursor-pointer self-start rounded-full transition-opacity hover:opacity-80"
          >
            <EntityImage imageId={avatarImageId} name={name} className="size-8 rounded-full text-xs" />
          </button>
        ) : (
          <EntityImage imageId={avatarImageId} name={name} className="mt-0.5 size-8 shrink-0 rounded-full text-xs" />
        )
      ) : null}
      <div className={`flex min-w-0 max-w-[80%] flex-col gap-1 ${isUser ? "items-end" : "items-start"}`}>
        {editing ? (
          <div className="flex w-full min-w-64 flex-col gap-1.5">
            <Textarea
              rows={2}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              className="w-full text-sm"
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
              className={`rounded-card px-3 py-2 text-sm break-words whitespace-pre-wrap ${
                isUser
                  ? line.narrator
                    ? "border border-ink-500 bg-ink-750 text-paper-200"
                    : "bg-accent-500/15 text-paper-100"
                  : "bg-ink-800 text-paper-200"
              }`}
            >
              {isUser && line.narrator ? (
                // Narrator-mode marker (chat-supporting-cast.plan.md): this line is story
                // narration the player authored as storyteller, not their own POV.
                <p className="mb-0.5 text-[10px] font-medium tracking-wide text-paper-400 uppercase">Narration</p>
              ) : null}
              {line.attachmentIds?.length ? (
                // Attached photos (chat-image-input.plan.md): thumbs above the text.
                <div className={`flex flex-wrap gap-1.5 ${line.content.trim() ? "mb-1.5" : ""}`}>
                  {line.attachmentIds.map((imageId) => (
                    <EntityImage
                      key={imageId}
                      imageId={imageId}
                      name="photo"
                      alt="Attached photo"
                      className="h-28 max-w-40 rounded-md object-cover"
                    />
                  ))}
                </div>
              ) : null}
              {pending ? (
                // Animated typing indicator (ux-improvements slice 9): the pending
                // bubble breathes during the reveal-hold, so "thinking" reads alive.
                <span aria-label="typing" className="inline-flex items-center gap-1 text-paper-500">
                  {[0, 1, 2].map((i) => (
                    <span
                      key={i}
                      aria-hidden
                      className="inline-block size-1.5 animate-pulse rounded-full bg-current"
                      style={{ animationDelay: `${i * 220}ms` }}
                    />
                  ))}
                </span>
              ) : isUser ? (
                // Span renderer (player-input-perception slice 5): italicize thoughts /
                // `_italic_`, read `*Name:*` as a text, mark `((OOC))` — sigils hidden.
                // (the roster seeds comms-recipient resolution — the player may text any member.)
                <MessageContent
                  content={line.content}
                  context={{ knownNames: knownNames.length ? [...knownNames] : undefined }}
                />
              ) : (
                // Narrator/character replies render per-speaker segments (dialogue-attribution):
                // the `[Name]` tag is hidden behind a small speaker label, standalone whole-line
                // quotes attribute to the character, and segment content still flows through the
                // span renderer above. In-bubble segments — the chat lane stays "a story being told".
                <ReplyBody content={line.content} knownNames={knownNames} />
              )}
              {line.stopped ? (
                <span className="ml-1.5 inline-block rounded-sm border border-ink-600 px-1 text-[10px] tracking-wide text-paper-500 uppercase">
                  stopped
                </span>
              ) : null}
            </div>
            {pagerTakes !== undefined || canEdit || canDelete || canRerun || canTake || canRemember || canMarkMoment ? (
              <div className="-mx-1 flex items-center gap-1">
                {pagerTakes ? (
                  <TakesPager
                    takes={pagerTakes}
                    disabled={streaming || switching}
                    onSwitch={(takeId) => void switchTo(takeId)}
                  />
                ) : null}
                {canEdit || canDelete || canRerun || canTake || canRemember || canMarkMoment ? (
                  // `.hover-reveal` (globals.css): hover-gated on pointer devices,
                  // always shown on touch — the only way these reach a phone.
                  // `.touch-target` gives each button a ≥44px coarse-pointer tap
                  // height (was ~22px) and the gap widens on coarse too, so a
                  // slightly-off tap on these primary recovery levers still lands
                  // (mobile-ux W3 task 2).
                  <div className="hover-reveal flex items-center gap-1 pointer-coarse:gap-2">
                    {canEdit ? (
                      <button
                        type="button"
                        onClick={startEdit}
                        className="touch-target inline-flex items-center justify-center rounded px-2 py-1 text-[11px] text-paper-500 hover:text-paper-200"
                      >
                        Edit
                      </button>
                    ) : null}
                    {canDelete ? (
                      <button
                        type="button"
                        onClick={() => void onDelete(line.id)}
                        className="touch-target inline-flex items-center justify-center rounded px-2 py-1 text-[11px] text-paper-500 hover:text-danger-400"
                      >
                        Delete
                      </button>
                    ) : null}
                    {canTake ? (
                      <button
                        type="button"
                        onClick={() => onAnotherTake(line.id)}
                        title="Regenerate this reply — earlier takes stay browsable"
                        className="touch-target inline-flex items-center justify-center rounded px-2 py-1 text-[11px] text-paper-500 hover:text-accent-300"
                      >
                        Another take
                      </button>
                    ) : null}
                    {canRemember ? (
                      <button
                        type="button"
                        onClick={() => onRemember?.(line.content)}
                        title={`Pin this as something ${name || "the character"} always remembers`}
                        className="touch-target inline-flex items-center justify-center rounded px-2 py-1 text-[11px] text-paper-500 hover:text-accent-300"
                      >
                        Remember
                      </button>
                    ) : null}
                    {canMarkMoment ? (
                      <button
                        type="button"
                        onClick={() => onMarkMoment?.(line.id)}
                        title="Mark this as a milestone in the relationship"
                        className="touch-target inline-flex items-center justify-center rounded px-2 py-1 text-[11px] text-paper-500 hover:text-accent-300"
                      >
                        Mark moment
                      </button>
                    ) : null}
                    {canRerun ? (
                      <button
                        type="button"
                        onClick={() => onRerun(line.id)}
                        aria-label="Rerun from here"
                        title="Re-send this message — replaces everything after it with a fresh reply"
                        className="touch-target inline-flex items-center justify-center rounded px-2 py-1 text-paper-500 hover:text-accent-300"
                      >
                        <RerunIcon className="size-3.5" />
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * The `‹ 2/3 ›` take browser (spec §4.1) — always visible (not hover-gated) so
 * recorded takes stay discoverable. Switching is display-only: the conversation's
 * state and memory follow the newest generated take, so the arrows just swap which
 * take the bubble shows.
 *
 * For admins only, the pager also names what wrote the take on screen —
 * `aion-2.0 · Player Agency Minimal v4` (narrator-prompt-lab.plan.md slice 6).
 * That is the whole point of the manual A/B: generate on the production prompt,
 * switch the conversation to a test prompt, take again, then step through the
 * takes and watch the attribution change with them. Without it a pager reading
 * "2/3" is unfalsifiable days later. A take carrying no provenance — every take
 * predating the Prompt Lab — renders no label whatsoever, and a non-admin's
 * pager is unchanged down to its class list.
 */
function TakesPager({
  takes,
  disabled,
  onSwitch,
}: {
  takes: ReplyTakes;
  disabled: boolean;
  onSwitch: (takeId: string) => void;
}) {
  const isAdmin = useIsAdmin();
  const found = takes.takes.findIndex((t) => t.id === takes.activeId);
  const active = found < 0 ? takes.takes.length - 1 : found; // unknown activeId ⇒ the newest take
  const prev = takes.takes[active - 1];
  const next = takes.takes[active + 1];
  // The displayed take's attribution, so browsing takes moves the label with them.
  const provenance = isAdmin ? takeProvenance(takes.takes[active]) : null;
  const label = provenance ? narratorProvenanceLabel(provenance) : null;
  const arrow =
    "rounded px-1.5 py-1 hover:text-paper-200 disabled:pointer-events-none disabled:text-paper-600";
  return (
    <div className={`flex items-center text-[11px] text-paper-500${label ? " min-w-0" : ""}`}>
      <button
        type="button"
        onClick={() => (prev ? onSwitch(prev.id) : undefined)}
        disabled={disabled || !prev}
        aria-label="Show the previous take"
        className={arrow}
      >
        ‹
      </button>
      <span className="tabular-nums">
        {active + 1}/{takes.takes.length}
      </span>
      <button
        type="button"
        onClick={() => (next ? onSwitch(next.id) : undefined)}
        disabled={disabled || !next}
        aria-label="Show the next take"
        className={arrow}
      >
        ›
      </button>
      {label ? (
        // Capped and truncating: a 120-character prompt name must not push the
        // Edit / Delete / Another take levers out of the row. `min-w-0` above lets
        // the pager itself shrink, so the ellipsis absorbs the pressure and the
        // title attribute hands the full label back on hover.
        <span
          title={`The narrator model and prompt that wrote the take on screen (admin only): ${label}`}
          className="ml-1 max-w-24 truncate text-paper-600 sm:max-w-56"
        >
          {label}
        </span>
      ) : null}
    </div>
  );
}
