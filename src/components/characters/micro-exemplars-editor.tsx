"use client";

import { MICRO_EXEMPLARS_MAX, type MicroExemplar } from "@/contracts";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

export interface MicroExemplarsEditorProps {
  exemplars: readonly MicroExemplar[];
  onChange: (exemplars: MicroExemplar[]) => void;
}

/**
 * Voice micro-exemplars (character-fidelity slice 6): a few worked examples of how the
 * character answers a charged moment, forge-drafted and hand-editable. Rendered as
 * few-shots in the chat prefix so voice + disposition + age land near generation. Lives
 * on the Profile tab beside Voice notes; the profile Re-draft scope re-derives them.
 */
export function MicroExemplarsEditor({ exemplars, onChange }: MicroExemplarsEditorProps) {
  const update = (index: number, patch: Partial<MicroExemplar>) =>
    onChange(exemplars.map((e, i) => (i === index ? { ...e, ...patch } : e)));
  const remove = (index: number) => onChange(exemplars.filter((_, i) => i !== index));
  const add = () => onChange([...exemplars, { situation: "", line: "" }]);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-paper-200">Voice examples</span>
        <Button size="sm" variant="ghost" onClick={add} disabled={exemplars.length >= MICRO_EXEMPLARS_MAX}>
          + Add example
        </Button>
      </div>
      <p className="text-xs text-paper-500">
        A few worked lines showing how this character actually talks — a deflection, a boundary, a tease. The narrator
        few-shots from these, so voice and disposition land in the prose, not just the sliders.
      </p>

      {exemplars.length === 0 ? (
        <p className="rounded-card border border-dashed border-ink-600 px-4 py-6 text-center text-sm text-paper-500">
          No voice examples yet. Add one — or use Re-draft on this tab to draft them from the sheet.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {exemplars.map((exemplar, index) => (
            <li key={index} className="grid grid-cols-1 gap-2 rounded-card border border-ink-700 bg-ink-850 p-3">
              <Field label="Situation">
                {(id) => (
                  <Input
                    id={id}
                    value={exemplar.situation}
                    placeholder="pushed to talk about her past…"
                    onChange={(e) => update(index, { situation: e.target.value })}
                  />
                )}
              </Field>
              <div className="flex items-end gap-2">
                <Field label="Line" className="flex-1">
                  {(id) => (
                    <Textarea
                      id={id}
                      rows={2}
                      value={exemplar.line}
                      placeholder={'A dry look. "That\'s a long story, and you haven\'t earned it."'}
                      onChange={(e) => update(index, { line: e.target.value })}
                    />
                  )}
                </Field>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => remove(index)}
                  aria-label="Remove voice example"
                  className="touch-target"
                >
                  ✕
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
