"use client";

import { useEffect, useMemo, useState } from "react";
import { z } from "zod";
import { apiGet, apiPatch } from "@/lib/client/api";
import {
  DEFAULT_SCENE_COMPOSER_MODEL_ID,
  SCENE_COMPOSER_MODELS,
  type SceneComposerModelOption,
} from "@/lib/composer-models";
import { ModelSelect } from "@/components/ui/model-select";
import { useToast } from "@/components/ui/toast";

/**
 * Admin-only per-conversation **scene composer model** picker — the text model that plans
 * the shot before anything is painted (`lib/composer-models.ts`). It exists so a candidate
 * from the A/B (`scripts/eval/scene-images/composer-model-ab.ts`) can be tried on a real
 * conversation without a deploy; the route re-checks role + ownership.
 *
 * Sibling of `AgentReasoningSelect`, and deliberately NOT of the scene-model picker in the
 * scenario modal: that one is story-adjacent setup a player owns, while this is operational
 * configuration for comparing models. It never rides the rollback snapshot.
 */

/** "" is the stored value for "no override" — the option the dropdown shows by default. */
const FOLLOW_DEFAULT = "";

const responseSchema = z.object({
  stored: z.string().catch(FOLLOW_DEFAULT),
  model: z.string().catch(DEFAULT_SCENE_COMPOSER_MODEL_ID),
});
const pathFor = (chatId: string) => `/api/admin/self/scene-composer/${chatId}`;

type Loaded = { chatId: string; stored: string; model: string };

/**
 * The curated list with the follow-the-default entry in front. Built once at module scope:
 * the contents are static, and rebuilding it per render would churn `ModelSelect`'s options
 * on every keystroke elsewhere in the menu.
 */
const OPTIONS: readonly { id: string; label: string }[] = [
  { id: FOLLOW_DEFAULT, label: "Default (follows the app)" },
  ...SCENE_COMPOSER_MODELS.map((option) => ({ id: option.id, label: option.label })),
];

const describe = (id: string): string =>
  SCENE_COMPOSER_MODELS.find((option: SceneComposerModelOption) => option.id === id)?.description ?? "";

export function SceneComposerSelect({ chatId }: { chatId: string }) {
  const toast = useToast();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [saving, setSaving] = useState(false);
  const loading = loaded?.chatId !== chatId;
  const stored = loading ? FOLLOW_DEFAULT : loaded.stored;
  const effective = loading ? DEFAULT_SCENE_COMPOSER_MODEL_ID : loaded.model;

  useEffect(() => {
    let active = true;
    void apiGet(responseSchema, pathFor(chatId)).then((result) => {
      if (!active) return;
      setLoaded({
        chatId,
        stored: result.ok ? result.data.stored : FOLLOW_DEFAULT,
        model: result.ok ? result.data.model : DEFAULT_SCENE_COMPOSER_MODEL_ID,
      });
    });
    return () => {
      active = false;
    };
  }, [chatId]);

  // Always describes what will actually RUN, never the raw pick: on "Default" the operator
  // needs to know which model that currently is, and that is the one thing the label can't say.
  const description = useMemo(() => describe(effective), [effective]);

  const save = async (next: string) => {
    const previous = loaded;
    // Optimistic, and it resolves the same way the server will — so the description line
    // updates to the newly-effective model immediately instead of lagging a round trip.
    const optimistic = next || DEFAULT_SCENE_COMPOSER_MODEL_ID;
    setLoaded({ chatId, stored: next, model: optimistic });
    setSaving(true);
    const result = await apiPatch(responseSchema, pathFor(chatId), { model: next });
    setSaving(false);
    if (!result.ok) {
      setLoaded(previous);
      toast.push({ title: "Couldn't save the composer model", description: result.error.message, tone: "error" });
      return;
    }
    setLoaded({ chatId, stored: result.data.stored, model: result.data.model });
    toast.push({ title: "Scene composer updated", description: "The model applies to the next scene render." });
  };

  return (
    <label className="flex flex-col gap-1 px-2 pt-1 pb-2">
      <span className="text-xs font-medium tracking-wide text-paper-400 uppercase">Scene composer (admin)</span>
      <ModelSelect
        ariaLabel="Scene composer model"
        models={OPTIONS}
        value={stored}
        onChange={(value) => void save(value)}
        disabled={loading || saving}
        className="h-8 text-xs"
      />
      <span className="text-[11px] leading-snug text-paper-600">
        {loading ? "Loading composer model…" : description}
      </span>
    </label>
  );
}
