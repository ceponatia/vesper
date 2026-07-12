"use client";

import { interactionConcepts, interactionFamilies, type Preference } from "@/contracts";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";

export interface PreferencesEditorProps {
  preferences: readonly Preference[];
  onChange: (preferences: Preference[]) => void;
}

/**
 * Bespoke likes/dislikes (personality-and-state.spec.md §6) resolved against the
 * interaction-concept vocabulary — authored game data, not just prose. Lives on the
 * character editor's Personality tab (moved off Disposition 2026-07-11 for room).
 */
export function PreferencesEditor({ preferences, onChange }: PreferencesEditorProps) {
  const update = (index: number, patch: Partial<Preference>) =>
    onChange(preferences.map((p, i) => (i === index ? { ...p, ...patch } : p)));
  const remove = (index: number) => onChange(preferences.filter((_, i) => i !== index));
  const add = () =>
    onChange([...preferences, { target: interactionConcepts[0]?.id ?? "compliment", valence: "dislike", intensity: 5 }]);

  return (
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
                    className="touch-target h-9 w-full accent-accent-500 sm:w-24"
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
              <Button
                size="sm"
                variant="ghost"
                onClick={() => remove(index)}
                aria-label="Remove preference"
                className="touch-target w-full sm:w-auto"
              >
                ✕
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
