"use client";

import {
  axisRange,
  bandForValue,
  dispositionTags,
  INTIMATE_TRAIT_CATEGORY,
  interactionConcepts,
  interactionFamilies,
  traitRegistry,
  type Preference,
  type TraitCategory,
  type TraitValue,
} from "@/contracts";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { TagInput } from "@/components/ui/tag-input";

const CANONICAL_TAG_IDS = dispositionTags.map((t) => t.id);
const TRAIT_CATEGORY_ORDER: TraitCategory[] = ["temperament", "social", "intimate"];

export interface DispositionEditorProps {
  traits: readonly TraitValue[];
  onChangeTraits: (traits: TraitValue[]) => void;
  tags: readonly string[];
  onChangeTags: (tags: string[]) => void;
  preferences: readonly Preference[];
  onChangePreferences: (preferences: Preference[]) => void;
}

/**
 * The "Disposition" tab (docs/developer-notes/personality-and-state.spec.md §6):
 * reusable **tags** (social-reaction cards key overrides on these — autocompleted
 * from the dev registry, free-form allowed) and **bespoke** likes/dislikes resolved
 * against the interaction-concept vocabulary. Authored game data, not just prose.
 */
export function DispositionEditor({ traits, onChangeTraits, tags, onChangeTags, preferences, onChangePreferences }: DispositionEditorProps) {
  const update = (index: number, patch: Partial<Preference>) =>
    onChangePreferences(preferences.map((p, i) => (i === index ? { ...p, ...patch } : p)));
  const remove = (index: number) => onChangePreferences(preferences.filter((_, i) => i !== index));
  const add = () =>
    onChangePreferences([...preferences, { target: interactionConcepts[0]?.id ?? "compliment", valence: "dislike", intensity: 5 }]);

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
        hint="Reusable trait labels the world's social-reaction cards key on. Canonical tags autocomplete; free-form is allowed."
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

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-paper-200">Likes &amp; dislikes</span>
          <Button size="sm" variant="ghost" onClick={add}>
            + Add preference
          </Button>
        </div>
        <p className="text-xs text-paper-500">
          How this character takes specific social moves. Resolved deterministically over an affinity-aware curve — the
          narrator is told the verdict, not asked to guess it.
        </p>

        {preferences.length === 0 ? (
          <p className="rounded-card border border-dashed border-ink-600 px-4 py-6 text-center text-sm text-paper-500">
            No preferences yet. Add one to give this character authored likes and dislikes.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {preferences.map((pref, index) => (
              <li
                key={index}
                className="grid grid-cols-1 items-end gap-2 rounded-card border border-ink-700 bg-ink-850 p-3 sm:grid-cols-[1fr_auto_auto_2fr_auto]"
              >
                <Field label="Concept / family">
                  {(id) => (
                    <Select id={id} value={pref.target} onChange={(e) => update(index, { target: e.target.value })}>
                      <optgroup label="Concepts">
                        {interactionConcepts.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.label}
                            {c.intimate ? " (intimate)" : ""}
                          </option>
                        ))}
                      </optgroup>
                      <optgroup label="Families">
                        {interactionFamilies().map((f) => (
                          <option key={f} value={f}>
                            {f.replace(/_/g, " ")}
                          </option>
                        ))}
                      </optgroup>
                    </Select>
                  )}
                </Field>
                <Field label="Feeling">
                  {(id) => (
                    <Select
                      id={id}
                      value={pref.valence}
                      onChange={(e) => update(index, { valence: e.target.value === "like" ? "like" : "dislike" })}
                    >
                      <option value="like">Likes</option>
                      <option value="dislike">Dislikes</option>
                    </Select>
                  )}
                </Field>
                <Field label={`Intensity ${pref.intensity}`}>
                  {(id) => (
                    <input
                      id={id}
                      type="range"
                      min={1}
                      max={10}
                      value={pref.intensity}
                      onChange={(e) => update(index, { intensity: Number(e.target.value) })}
                      className="h-9 w-24 accent-accent-500"
                    />
                  )}
                </Field>
                <Field label="Reaction hint (optional)">
                  {(id) => (
                    <Input
                      id={id}
                      value={pref.hint ?? ""}
                      placeholder="finds flattery cloying…"
                      onChange={(e) => update(index, { hint: e.target.value || undefined })}
                    />
                  )}
                </Field>
                <Button size="sm" variant="ghost" onClick={() => remove(index)} aria-label="Remove preference">
                  ✕
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
