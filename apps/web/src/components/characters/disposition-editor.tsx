"use client";

import {
  axisRange,
  bandForValue,
  dispositionTags,
  INTIMATE_TRAIT_CATEGORY,
  traitRegistry,
  type TraitCategory,
  type TraitValue,
} from "@/contracts";
import { Field } from "@/components/ui/field";
import { Slider } from "@/components/ui/slider";
import { TagInput } from "@/components/ui/tag-input";

const CANONICAL_TAG_IDS = dispositionTags.map((t) => t.id);
const TRAIT_CATEGORY_ORDER: TraitCategory[] = ["temperament", "social", "intimate"];

export interface DispositionEditorProps {
  traits: readonly TraitValue[];
  onChangeTraits: (traits: TraitValue[]) => void;
  tags: readonly string[];
  onChangeTags: (tags: string[]) => void;
}

/**
 * The "Disposition" tab: atomic trait scalars and the reusable **tags**
 * social-reaction cards key overrides on (autocompleted from the dev registry,
 * free-form allowed). Likes/dislikes and the character's social cards live on the
 * Personality tab (moved 2026-07-11 for room); the `disposition` re-draft scope
 * still owns preferences alongside tags + traits.
 */
export function DispositionEditor({ traits, onChangeTraits, tags, onChangeTags }: DispositionEditorProps) {
  // A slider edit is a `manual` overlay; keep one entry per trait id (it wins resolution).
  const valueOf = (id: string, fallback: number) => traits.find((t) => t.id === id)?.value ?? fallback;
  const setTrait = (id: string, value: number) =>
    onChangeTraits([...traits.filter((t) => t.id !== id), { id, value, source: "manual" }]);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-4">
        <div>
          <span className="text-sm font-medium text-paper-200">Traits</span>
          <p className="text-xs text-paper-500">
            Stable temperament scalars. Bands surface to the narrator as behavioural guidance; some also scale how the
            character takes social moves. Intimate traits surface only in intimate scenes.
          </p>
        </div>
        {TRAIT_CATEGORY_ORDER.map((category) => {
          const defs = traitRegistry.forCategory(category);
          if (defs.length === 0) return null;
          return (
            <div key={category} className="flex flex-col gap-2">
              <span className="text-xs font-medium uppercase tracking-wide text-paper-400">
                {category}
                {category === INTIMATE_TRAIT_CATEGORY ? " (intimate)" : ""}
              </span>
              {defs.map((def) => {
                const { min, max } = axisRange(def.axis);
                const value = valueOf(def.id, def.default);
                const band = bandForValue(def, value);
                return (
                  <Field key={def.id} label={`${def.label} — ${band?.label ?? ""}`} hint={def.description}>
                    {(id) => (
                      <Slider id={id} value={value} min={min} max={max} step={5} onChange={(v) => setTrait(def.id, v)} />
                    )}
                  </Field>
                );
              })}
            </div>
          );
        })}
      </div>

      <Field
        label="Disposition tags"
        hint="Reusable trait labels for social-reaction cards to key on. Note: no cards read them yet, so tags don't affect play today — set the Traits above and Likes & dislikes (Personality tab) to actually shape behavior."
      >
        {(id) => (
          <TagInput
            id={id}
            value={tags}
            onChange={onChangeTags}
            suggestions={CANONICAL_TAG_IDS}
            placeholder="bratty, prudish…"
          />
        )}
      </Field>
    </div>
  );
}
