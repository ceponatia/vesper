"use client";

import {
  dispositionTags,
  interactionConceptIds,
  reactionKindSchema,
  reactionKindToValence,
  severityToTier,
  tierDefaultKind,
  tierIntensity,
  type ReactionKind,
  type ReactionOverride,
  type SocialReactionCardExtras,
} from "@/contracts";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import { TagInput } from "@/components/ui/tag-input";

const CONCEPT_IDS = interactionConceptIds();
const TAG_IDS = dispositionTags.map((t) => t.id);
const REACTION_KINDS = reactionKindSchema.options;

export interface SocialCardFieldsProps {
  value: SocialReactionCardExtras;
  onChange: (patch: Partial<SocialReactionCardExtras>) => void;
}

/**
 * The mechanical authoring controls for one card — kind · severity (→ tier) · trigger concepts ·
 * tag overrides · a live reaction preview. Shared by the inline array editor
 * (`SocialCardsEditor`, on a world/character) and the standalone card builder
 * (`/social-cards/[id]`), so both author the same `definition` shape (social-reaction-cards.plan.md).
 */
export function SocialCardFields({ value, onChange }: SocialCardFieldsProps) {
  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-1 items-end gap-2 sm:grid-cols-[auto_1fr]">
        <Field label="Kind">
          {(id) => (
            <Select
              id={id}
              value={value.kind}
              onChange={(e) => onChange({ kind: e.target.value === "taboo" ? "taboo" : "social_rule" })}
            >
              <option value="social_rule">Social rule</option>
              <option value="taboo">Taboo</option>
            </Select>
          )}
        </Field>
        <Field label={`Severity ${value.severity} · ${severityToTier(value.severity)}`}>
          {(id) => (
            <input
              id={id}
              type="range"
              min={0}
              max={100}
              step={5}
              value={value.severity}
              onChange={(e) => onChange({ severity: Number(e.target.value) })}
              className="touch-target h-9 w-full accent-accent-500"
            />
          )}
        </Field>
      </div>
      <Field label="Triggers (interaction concepts)" hint="Which classified social acts breach this card.">
        {(id) => (
          <TagInput
            id={id}
            value={[...value.triggers]}
            onChange={(triggers) => onChange({ triggers })}
            suggestions={CONCEPT_IDS}
            placeholder="proposition, public_display…"
          />
        )}
      </Field>
      <OverridesEditor
        overrides={value.reactionOverrides}
        onChange={(reactionOverrides) => onChange({ reactionOverrides })}
      />
      <CardReactionPreview value={value} />
    </div>
  );
}

/**
 * Live read-out of how the card resolves before the §6 curve scales it: the severity → tier →
 * base intensity + default kind/valence, plus each per-tag flip. Pure derivation — no authoring,
 * just so the author sees the foot-fetish enjoy land.
 */
function CardReactionPreview({ value }: { value: SocialReactionCardExtras }) {
  const tier = severityToTier(value.severity);
  const defaultKind = value.defaultReaction?.kind ?? tierDefaultKind(tier);
  const defaultValence = reactionKindToValence(defaultKind);
  const baseIntensity = value.defaultReaction?.intensity ?? tierIntensity(tier);
  return (
    <div className="rounded-card border border-ink-700 bg-ink-900 px-3 py-2 text-xs text-paper-400">
      <p>
        <span className="text-paper-300">Resolves as</span> tier{" "}
        <span className="font-medium text-paper-200">{tier}</span> · base intensity{" "}
        <span className="font-medium text-paper-200">{baseIntensity}</span> · default{" "}
        <span className="font-medium text-paper-200">{defaultKind.replace(/_/g, " ")}</span> (
        {defaultValence ?? "no reaction"})
      </p>
      {value.reactionOverrides.length > 0 ? (
        <ul className="mt-1 flex flex-col gap-0.5">
          {value.reactionOverrides.map((o, i) => {
            const v = reactionKindToValence(o.toReaction.kind);
            return (
              <li key={i}>
                tagged <span className="text-paper-200">{o.tag}</span> → {o.toReaction.kind.replace(/_/g, " ")} (
                {v ?? "no reaction"})
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

/** Per-tag flips: a character carrying `tag` reacts with a different kind (the foot-fetish enjoy). */
function OverridesEditor({
  overrides,
  onChange,
}: {
  overrides: readonly ReactionOverride[];
  onChange: (overrides: ReactionOverride[]) => void;
}) {
  const setTag = (i: number, tag: string) => onChange(overrides.map((o, idx) => (idx === i ? { ...o, tag } : o)));
  const setKind = (i: number, kind: ReactionKind) =>
    onChange(overrides.map((o, idx) => (idx === i ? { ...o, toReaction: { ...o.toReaction, kind } } : o)));
  const remove = (i: number) => onChange(overrides.filter((_, idx) => idx !== i));
  const add = () => onChange([...overrides, { tag: TAG_IDS[0] ?? "", toReaction: { kind: "enjoy", hint: "" } }]);

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium uppercase tracking-wide text-paper-400">Tag overrides</span>
        <Button size="sm" variant="quiet" onClick={add}>
          + Override
        </Button>
      </div>
      {overrides.length === 0 ? (
        <p className="text-xs text-paper-500">None — a character carrying a tag here reacts differently (e.g. foot-fetish-positive → enjoy).</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {overrides.map((o, i) => (
            <li key={i} className="flex flex-wrap items-center gap-2">
              <Select aria-label="Tag" value={o.tag} onChange={(e) => setTag(i, e.target.value)} className="w-48">
                {TAG_IDS.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </Select>
              <span className="text-xs text-paper-500">reacts with</span>
              <Select
                aria-label="Reaction"
                value={o.toReaction.kind}
                onChange={(e) => setKind(i, e.target.value as ReactionKind)}
                className="w-40"
              >
                {REACTION_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {k.replace(/_/g, " ")}
                  </option>
                ))}
              </Select>
              <Button size="sm" variant="quiet" onClick={() => remove(i)} aria-label="Remove override">
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
