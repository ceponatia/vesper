"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { z } from "zod";
import type {
  NarratorPromptTemplateSummary,
  SelectNarratorPromptRequest,
} from "@/contracts/narrator-prompts/template";
import { apiGet, apiPatch } from "@/lib/client/api";
import { ModelSelect } from "@/components/ui/model-select";
import { useToast } from "@/components/ui/toast";

/**
 * Admin-only per-conversation **narrator instructions** picker: which
 * handwritten test prompt replaces Vesper's narrator behavior/craft
 * instructions for THIS chat.
 *
 * Sibling of `AgentReasoningSelect` / `SceneComposerSelect`, and the same kind of
 * thing: operational configuration for an experiment, never story state. It is
 * not part of `ChatScenario`, is never copied into a scenario preset, and is
 * never rolled back by state reset / regenerate / rerun. The route re-checks role
 * + ownership; hiding the control is convenience only.
 *
 * The selection is exposed as a hook rather than fetched inside the control,
 * because the persistent header badge must show the SAME selection the menu
 * shows — two independent fetchers would drift the moment the picker changed.
 */

/** The stored value for "no override" — Vesper's production narrator instructions. */
const PRODUCTION_VALUE = "";

/** Where the owner writes and edits these prompts (the Prompt Lab). */
export const NARRATOR_PROMPT_LAB_PATH = "/settings/narrator-prompts";

/**
 * One read serves both surfaces. The route answers with the stored selection, the
 * selected template as the badge renders it, AND the owner's selectable prompts,
 * so the menu never needs a second request to the Prompt Lab's collection route
 * (and a non-admin issues none at all).
 */
const selectionPath = (chatId: string) => `/api/admin/self/narrator-prompt/${chatId}`;

/**
 * Forgiving parse at the trust boundary (docs/resilience.md): a summary whose
 * shape drifted degrades to a usable row rather than blanking the dropdown.
 */
const templateSummarySchema = z.object({
  id: z.string(),
  name: z.string().catch(""),
  notes: z.string().catch(""),
  currentRevision: z.number().int().catch(1),
  currentRevisionId: z.string().catch(""),
  usageCount: z.number().int().catch(0),
  createdAt: z.string().catch(""),
  updatedAt: z.string().catch(""),
  duplicatedFromId: z.string().nullable().catch(null),
});

/** Bad rows are dropped, not fatal — one malformed template still leaves a usable library. */
const templateListField = z
  .array(z.unknown())
  .catch([])
  .transform((rows) =>
    rows.flatMap((row) => {
      const parsed = templateSummarySchema.safeParse(row);
      return parsed.success ? [parsed.data] : [];
    }),
  );

const selectionSchema = z.object({
  selection: z.object({
    promptId: z.string().nullable().catch(null),
    /**
     * `null` on production — and also when a stored selection no longer resolves,
     * which is exactly what the next exchange falls back from. Either way the badge
     * correctly shows nothing.
     */
    selected: templateSummarySchema.nullable().catch(null),
    available: templateListField,
  }),
});

/** What the menu control and the header badge both read. */
export interface NarratorPromptSelection {
  /** True until THIS chat's selection has settled (and always for non-admins). */
  loading: boolean;
  /** `null` ⇒ Vesper's production narrator instructions. */
  promptId: string | null;
  /** The selected template, when one is selected — what the badge names. */
  active: NarratorPromptTemplateSummary | null;
  /** The owner's saved prompts; `null` while the library is still loading. */
  templates: NarratorPromptTemplateSummary[] | null;
  saving: boolean;
  /** Save immediately; applies to the next exchange. Optimistic, rolled back on failure. */
  save: (promptId: string | null) => Promise<void>;
}

/**
 * Stamped with the chat it belongs to, so a chat switch reads as "loading",
 * never as the previous chat's pick. `available` rides the same stamp because it
 * arrives in the same response.
 */
type Loaded = {
  chatId: string;
  promptId: string | null;
  selected: NarratorPromptTemplateSummary | null;
  available: NarratorPromptTemplateSummary[];
};

/**
 * The conversation's narrator-prompt selection, fetched once per chat.
 *
 * Lives here rather than in `PER_CHAT_DEFAULTS` because the value is stamped
 * with its own chat id: `loading` stays true until the loaded stamp matches the
 * mounted `chatId`, which gives the same anti-leak guarantee the per-chat reset
 * gives, without a second copy of the switch bookkeeping.
 *
 * @param enabled admin-gated — a non-admin never issues the request.
 */
export function useNarratorPromptSelection(chatId: string, enabled: boolean): NarratorPromptSelection {
  const toast = useToast();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [saving, setSaving] = useState(false);
  // Only a stamp matching the MOUNTED chat counts as settled; anything else —
  // no fetch yet, a non-admin, the previous conversation's value mid-switch —
  // reads as loading.
  const settled = enabled && loaded !== null && loaded.chatId === chatId ? loaded : null;

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    void apiGet(selectionSchema, selectionPath(chatId)).then((result) => {
      if (!active) return;
      setLoaded(
        result.ok
          ? { chatId, ...result.data.selection }
          : { chatId, promptId: null, selected: null, available: [] },
      );
    });
    return () => {
      active = false;
    };
  }, [chatId, enabled]);

  const save = async (promptId: string | null) => {
    const previous = loaded;
    const available = settled?.available ?? [];
    // Optimistic: name the target from the list we already hold, so the header
    // badge flips the instant the dropdown does rather than after the round trip.
    setLoaded({
      chatId,
      promptId,
      selected: promptId === null ? null : (available.find((row) => row.id === promptId) ?? null),
      available,
    });
    setSaving(true);
    // The route accepts exactly this and nothing else — a chat send never carries
    // prompt text or a one-call override.
    const body: SelectNarratorPromptRequest = { promptId };
    const result = await apiPatch(selectionSchema, selectionPath(chatId), body);
    setSaving(false);
    if (!result.ok) {
      setLoaded(previous);
      toast.push({
        title: "Couldn't save the narrator instructions",
        description: result.error.message,
        tone: "error",
      });
      return;
    }
    setLoaded({ chatId, ...result.data.selection });
    toast.push({
      title: result.data.selection.promptId === null ? "Back on Vesper's narrator prompt" : "Narrator instructions updated",
      description: "The choice applies to this conversation's next exchange.",
    });
  };

  return {
    loading: settled === null,
    promptId: settled?.promptId ?? null,
    active: settled?.selected ?? null,
    templates: settled?.available ?? null,
    saving,
    save,
  };
}

/** Prompt Lab link — a new tab, so opening it never unmounts a streaming reply. */
function PromptLabLink({ children }: { children: string }) {
  return (
    <Link
      href={NARRATOR_PROMPT_LAB_PATH}
      target="_blank"
      rel="noopener noreferrer"
      prefetch={false}
      className="text-accent-300 hover:underline"
    >
      {children}
    </Link>
  );
}

/**
 * The conversation menu's narrator-instruction picker. Takes the shared selection
 * so the header badge and this control can never disagree.
 */
export function NarratorPromptSelect({ selection }: { selection: NarratorPromptSelection }) {
  const { active, loading, promptId, saving, templates } = selection;

  const options = useMemo(() => {
    const rows: { id: string; label: string }[] = [{ id: PRODUCTION_VALUE, label: "Vesper production prompt" }];
    for (const template of templates ?? []) rows.push({ id: template.id, label: template.name || "Untitled prompt" });
    // A selected template the library list doesn't carry (still loading, or hidden
    // from the list) still shows by NAME rather than as a raw id.
    if (active && !rows.some((row) => row.id === active.id)) {
      rows.push({ id: active.id, label: active.name || "Untitled prompt" });
    }
    return rows;
  }, [active, templates]);

  const heading = (
    <span className="text-xs font-medium tracking-wide text-paper-400 uppercase">Narrator instructions (admin)</span>
  );

  // Nothing saved yet: point at the Prompt Lab instead of offering a dropdown
  // whose only entry is the production default.
  if (!loading && templates !== null && templates.length === 0 && active === null) {
    return (
      <div className="flex flex-col gap-1 px-2 pt-1 pb-2">
        {heading}
        <span className="text-[11px] leading-snug text-paper-600">
          {"No saved prompts yet — this conversation uses Vesper's production narrator instructions. "}
          <PromptLabLink>Write one in the Prompt Lab</PromptLabLink>
          {"."}
        </span>
      </div>
    );
  }

  return (
    <label className="flex flex-col gap-1 px-2 pt-1 pb-2">
      {heading}
      <ModelSelect
        ariaLabel="Narrator instructions"
        models={options}
        value={promptId ?? PRODUCTION_VALUE}
        onChange={(value) => void selection.save(value === PRODUCTION_VALUE ? null : value)}
        disabled={loading || saving || templates === null}
        className="h-8 text-xs"
      />
      <span className="text-[11px] leading-snug text-paper-600">
        {loading
          ? "Loading narrator instructions…"
          : "Replaces the narrator's behavior instructions only — Vesper still supplies the character sheet, world, relationship and memory state, this turn's constraints and the required response format. Saves immediately; applies to the next exchange."}
      </span>
    </label>
  );
}
