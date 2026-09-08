"use client";

import {
  composeRelationshipLaw,
  familiarityBandMidpoint,
  familiarityBands,
  PRESENTED_NOTE_MAX,
  presentedLeans,
  regardBandMidpoint,
  regardBands,
  RELATIONSHIP_HISTORY_TEXT_MAX,
  RELATIONSHIP_KIND_MAX,
  relationshipRegionLabel,
  type AuthoredRelationshipRecord,
  type PresentedLean,
} from "@/contracts";
import { Disclosure } from "@/components/ui/disclosure";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

/** Reader-facing label per mask lean (the enum is engine vocabulary, not UI copy). */
const LEAN_LABELS: Record<PresentedLean, string> = {
  masks_warmth: "Acts colder than they feel",
  masks_dislike: "Acts warmer than they feel",
};

/**
 * The authored relationship-record editor: two band selects + kind/history
 * texture + the presented mask + the looming flag, with a **live preview of the
 * exact law block the narrator will read** — authors see the render, not an
 * abstraction. Edits the AUTHORED form (band picks); the live scalars seed at
 * band midpoints on chat creation. Shared by the character Chat tab today and
 * the conversation matrix menu later, so it takes the two display names as
 * props.
 */
export function RelationshipRecordEditor({
  value,
  onChange,
  selfName,
  targetName,
}: {
  value: AuthoredRelationshipRecord;
  onChange: (next: AuthoredRelationshipRecord) => void;
  /** The record holder (the one whose behavior the block governs). */
  selfName: string;
  /** The edge's target (who the record is toward). */
  targetName: string;
}) {
  const preview = composeRelationshipLaw({
    name: targetName,
    selfName,
    familiarity: familiarityBandMidpoint(value.familiarity),
    regard: regardBandMidpoint(value.regard),
    kind: value.kind,
    history: value.history,
    presented: value.presented,
  });
  const region = relationshipRegionLabel(
    familiarityBandMidpoint(value.familiarity),
    regardBandMidpoint(value.regard),
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Familiarity"
          hint={`How well ${selfName} and ${targetName} know each other — knowledge, not feeling.`}
        >
          {(id) => (
            <Select id={id} value={value.familiarity} onChange={(e) => onChange({ ...value, familiarity: e.target.value })}>
              {familiarityBands.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Regard" hint={`How ${selfName} feels about ${targetName} — feeling, not knowledge.`}>
          {(id) => (
            <Select id={id} value={value.regard} onChange={(e) => onChange({ ...value, regard: e.target.value })}>
              {regardBands.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>

      <Field label="Kind" hint={'The label both would use — "coworkers of 20 years", "her ex-husband". Optional.'}>
        {(id) => (
          <Input
            id={id}
            value={value.kind}
            maxLength={RELATIONSHIP_KIND_MAX}
            onChange={(e) => onChange({ ...value, kind: e.target.value })}
            placeholder="e.g. estranged childhood friends"
          />
        )}
      </Field>

      <Field label="Shared history" hint="One line of shared past the narrator can lean on. Optional.">
        {(id) => (
          <Textarea
            id={id}
            rows={2}
            value={value.history}
            maxLength={RELATIONSHIP_HISTORY_TEXT_MAX}
            onChange={(e) => onChange({ ...value, history: e.target.value })}
            placeholder="e.g. he left town without a word; she rebuilt the shop alone"
          />
        )}
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Outward mask" hint="How they PERFORM it when that differs from what they feel.">
          {(id) => (
            <Select
              id={id}
              value={value.presented?.lean ?? ""}
              onChange={(e) => {
                const lean = e.target.value as PresentedLean | "";
                onChange({
                  ...value,
                  presented: lean === "" ? undefined : { lean, note: value.presented?.note ?? "" },
                });
              }}
            >
              <option value="">Honest — no mask</option>
              {presentedLeans.map((lean) => (
                <option key={lean} value={lean}>
                  {LEAN_LABELS[lean]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {value.presented ? (
          <Field label="How the mask reads" hint="Optional flavor on the performance.">
            {(id) => (
              <Input
                id={id}
                value={value.presented?.note ?? ""}
                maxLength={PRESENTED_NOTE_MAX}
                onChange={(e) =>
                  onChange({
                    ...value,
                    presented: value.presented ? { ...value.presented, note: e.target.value } : undefined,
                  })
                }
                placeholder='e.g. "icily civil", "syrupy-sweet in public"'
              />
            )}
          </Field>
        ) : null}
      </div>

      <Disclosure title="How this shapes the story" description={region}>
        <pre className="text-xs leading-relaxed whitespace-pre-wrap text-paper-400">{preview}</pre>
      </Disclosure>
    </div>
  );
}
