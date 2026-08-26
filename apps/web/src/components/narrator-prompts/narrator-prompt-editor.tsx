"use client";

import {
  approximateNarratorPromptTokens,
  NARRATOR_PROMPT_BODY_MAX,
  NARRATOR_PROMPT_BODY_WARN_AT,
  NARRATOR_PROMPT_NAME_MAX,
  NARRATOR_PROMPT_NOTES_MAX,
} from "@/contracts/narrator-prompts";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Tag } from "@/components/ui/tag";
import { Textarea } from "@/components/ui/textarea";
import {
  formatCount,
  usageCountLabel,
  type NarratorPromptDraft,
} from "./narrator-prompt-shared";

/**
 * The Prompt Lab's editor pane (narrator-prompt-lab.plan.md §"Editor pane").
 *
 * Presentational on purpose: the page above owns the draft, the dirty state and
 * every confirm, because the dirty state is also what guards navigation and a
 * child holding it would have to push it back up on every keystroke.
 *
 * There is no autosave here and there will not be one. A saved body is an
 * experimental revision that reaches live conversations on their next reply, so
 * the trigger stays a button someone pressed.
 */

/** What the editor is currently editing, and what it started from. */
export interface NarratorPromptEditorSession {
  /** null while a brand-new prompt is being written — nothing is saved yet. */
  templateId: string | null;
  /** The revision the editor LOADED. Sent as `baseRevision`; a newer one is a conflict. */
  baseRevision: number;
  currentRevision: number;
  usageCount: number;
  loaded: NarratorPromptDraft;
  draft: NarratorPromptDraft;
}

export type NarratorPromptBusyAction = "save" | "duplicate" | "delete";

export interface NarratorPromptEditorProps {
  session: NarratorPromptEditorSession;
  dirty: boolean;
  busyAction: NarratorPromptBusyAction | null;
  /** Set when a save lost the optimistic-concurrency race. */
  conflict: { currentRevision: number | null } | null;
  nameError: string | null;
  bodyError: string | null;
  onChange: (patch: Partial<NarratorPromptDraft>) => void;
  onSave: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  /** Abandon an unsaved new prompt without saving anything. */
  onCancelNew: () => void;
  /** Discard local edits and load the newest revision. */
  onReloadConflict: () => void;
  /** Keep the local edits and dismiss the banner. */
  onDismissConflict: () => void;
}

export function NarratorPromptEditor({
  session,
  dirty,
  busyAction,
  conflict,
  nameError,
  bodyError,
  onChange,
  onSave,
  onDuplicate,
  onDelete,
  onCancelNew,
  onReloadConflict,
  onDismissConflict,
}: NarratorPromptEditorProps) {
  const isNew = session.templateId === null;
  const body = session.draft.body;
  const tokens = approximateNarratorPromptTokens(body);
  const overWarn = body.length > NARRATOR_PROMPT_BODY_WARN_AT;
  const busy = busyAction !== null;

  const countLine = `${formatCount(body.length)} / ${formatCount(NARRATOR_PROMPT_BODY_MAX)} characters · about ${formatCount(tokens)} tokens`;

  const conflictHeadline =
    conflict === null
      ? ""
      : conflict.currentRevision === null
        ? "Another tab saved a newer revision of this prompt."
        : `Another tab saved revision ${String(conflict.currentRevision)} of this prompt.`;
  const conflictDetail = `Your editor started from revision ${String(session.baseRevision)}, so saving now would overwrite work you cannot see here. Nothing has been overwritten, and your text is still in the box below.`;

  return (
    <section className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="prose-display text-lg">
          {isNew ? "New prompt" : session.loaded.name === "" ? "Untitled prompt" : session.loaded.name}
        </h2>
        <Tag>{isNew ? "not saved yet" : `revision ${String(session.currentRevision)}`}</Tag>
        {isNew ? null : <Tag>{usageCountLabel(session.usageCount)}</Tag>}
        {dirty ? <Tag tone="accent">unsaved changes</Tag> : <Tag tone="ok">saved</Tag>}
      </div>

      {/* The authority boundary, in the owner's words. It is the one thing that
          makes a production-vs-test comparison readable later: the facts stay
          the same, only the narrator's instructions change. */}
      <div className="rounded-card border border-ink-600 bg-ink-850 px-4 py-3 text-xs text-paper-400">
        <p>
          This text replaces the narrator’s <span className="text-paper-200">behavior and craft instructions only</span>
          {" "}— its role, how it embodies NPCs, player agency, camera and voice, pacing, prose texture. Vesper still
          supplies the character sheet, the world, relationship and memory state, the constraints that apply to this
          turn, and the response format it has to parse back.
        </p>
        <p className="mt-2">
          The body is sent literally. Braces and every other sigil have no special meaning in v1, so{" "}
          <code className="text-paper-300">{"{like this}"}</code> reaches the model exactly as typed.
        </p>
      </div>

      {conflict === null ? null : (
        <div role="alert" className="rounded-card border border-danger-500/40 bg-danger-500/5 px-4 py-3">
          <p className="text-sm text-danger-300">{conflictHeadline}</p>
          <p className="mt-1 text-xs text-paper-300">{conflictDetail}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" variant="danger" onClick={onReloadConflict} disabled={busy}>
              Reload the newest revision
            </Button>
            <Button size="sm" onClick={onDismissConflict} disabled={busy}>
              Keep editing
            </Button>
          </div>
          <p className="mt-2 text-[11px] text-paper-500">
            Reloading discards what is in this editor. Keeping your edits leaves them untouched — but saving will keep
            failing until you reload, so copy anything you want to keep before you do.
          </p>
        </div>
      )}

      <Field label="Name" error={nameError}>
        {(id) => (
          <Input
            id={id}
            value={session.draft.name}
            maxLength={NARRATOR_PROMPT_NAME_MAX}
            placeholder="Player Agency Minimal"
            spellCheck={false}
            onChange={(e) => onChange({ name: e.target.value })}
          />
        )}
      </Field>

      <Field
        label="Hypothesis"
        hint="What you expect this prompt to change, so a result read weeks later still has a question attached to it. Optional."
      >
        {(id) => (
          <Textarea
            id={id}
            rows={3}
            value={session.draft.notes}
            maxLength={NARRATOR_PROMPT_NOTES_MAX}
            placeholder="Cutting the pacing rules should make scenes linger instead of jumping ahead."
            onChange={(e) => onChange({ notes: e.target.value })}
          />
        )}
      </Field>

      <Field label="Prompt body" error={bodyError}>
        {(id) => (
          <Textarea
            id={id}
            rows={18}
            value={body}
            maxLength={NARRATOR_PROMPT_BODY_MAX}
            spellCheck={false}
            className="min-h-96 font-mono text-[13px] leading-relaxed"
            onChange={(e) => onChange({ body: e.target.value })}
          />
        )}
      </Field>

      <p className="text-[11px] text-paper-500">{countLine}</p>

      {overWarn ? (
        <div className="rounded-card border border-accent-500/40 bg-accent-500/5 px-4 py-3">
          <p className="text-xs font-medium text-accent-300">This body is getting long.</p>
          <p className="mt-1 text-xs text-paper-300">
            It still has to share the narrator’s context window with the character sheet, the world, relationship and
            memory state, and the per-turn constraints Vesper adds on top. If the whole prompt does not fit the
            narrator model, the reply fails or degrades — Vesper will not quietly drop world state to make room for a
            custom prompt.
          </p>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 border-t border-ink-600 pt-4">
        <Button
          variant="primary"
          onClick={onSave}
          busy={busyAction === "save"}
          disabled={busy || !dirty}
        >
          {isNew ? "Create prompt" : `Save revision ${String(session.currentRevision + 1)}`}
        </Button>
        {isNew ? (
          <Button variant="quiet" onClick={onCancelNew} disabled={busy}>
            Cancel
          </Button>
        ) : (
          <>
            <Button onClick={onDuplicate} busy={busyAction === "duplicate"} disabled={busy}>
              Duplicate
            </Button>
            <Button variant="danger" onClick={onDelete} busy={busyAction === "delete"} disabled={busy}>
              Delete
            </Button>
          </>
        )}
        <span className="ml-auto text-[11px] text-paper-500">
          {dirty ? "Nothing saves until you press it." : "No unsaved changes."}
        </span>
      </div>
    </section>
  );
}
