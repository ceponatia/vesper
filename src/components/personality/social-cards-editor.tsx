"use client";

import {
  dispositionTags,
  interactionConceptIds,
  reactionKindSchema,
  severityToTier,
  type ReactionKind,
  type ReactionOverride,
  type SocialReactionCard,
} from "@/contracts";
import { newId } from "@/lib/ids";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { TagInput } from "@/components/ui/tag-input";

const CONCEPT_IDS = interactionConceptIds();
const TAG_IDS = dispositionTags.map((t) => t.id);
const REACTION_KINDS = reactionKindSchema.options;

export interface SocialCardsEditorProps {
  cards: readonly SocialReactionCard[];
  onChange: (cards: SocialReactionCard[]) => void;
  /** Short context line (world fabric vs character's personal lines). */
  hint?: string;
  emptyText?: string;
}

/**
 * Inline editor for a SocialReactionCard array (social-reaction-cards.plan.md). Shared by the
 * world editor (`style.socialCards` — the world's social fabric) and the character Disposition
 * tab (`profile.socialCards` — the character's own lines). The reaction itself is derived from
 * severity (one number → a tier → a ramped intensity); per-tag overrides author the flip.
 */
export function SocialCardsEditor({ cards, onChange, hint, emptyText }: SocialCardsEditorProps) {
  const update = (index: number, patch: Partial<SocialReactionCard>) =>
    onChange(cards.map((c, i) => (i === index ? { ...c, ...patch } : c)));
  const remove = (index: number) => onChange(cards.filter((_, i) => i !== index));
  const add = () =>
    onChange([
      ...cards,
      { id: newId(), label: "New card", description: "", kind: "social_rule", triggers: [], severity: 40, reactionOverrides: [] },
    ]);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-paper-200">Social-reaction cards</span>
        <Button size="sm" variant="ghost" onClick={add}>
          + Add card
        </Button>
      </div>
      {hint ? <p className="text-xs text-paper-500">{hint}</p> : null}

      {cards.length === 0 ? (
        <p className="rounded-card border border-dashed border-ink-600 px-4 py-6 text-center text-sm text-paper-500">
          {emptyText ?? "No cards yet. Add a taboo or social rule to shape reactions."}
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {cards.map((card, index) => (
            <li key={card.id} className="flex flex-col gap-2 rounded-card border border-ink-700 bg-ink-850 p-3">
              <div className="grid grid-cols-1 items-end gap-2 sm:grid-cols-[2fr_auto_auto_auto]">
                <Field label="Label">
                  {(id) => <Input id={id} value={card.label} onChange={(e) => update(index, { label: e.target.value })} />}
                </Field>
                <Field label="Kind">
                  {(id) => (
                    <Select
                      id={id}
                      value={card.kind}
                      onChange={(e) => update(index, { kind: e.target.value === "taboo" ? "taboo" : "social_rule" })}
                    >
                      <option value="social_rule">Social rule</option>
                      <option value="taboo">Taboo</option>
                    </Select>
                  )}
                </Field>
                <Field label={`Severity ${card.severity} · ${severityToTier(card.severity)}`}>
                  {(id) => (
                    <input
                      id={id}
                      type="range"
                      min={0}
                      max={100}
                      step={5}
                      value={card.severity}
                      onChange={(e) => update(index, { severity: Number(e.target.value) })}
                      className="touch-target h-9 w-full accent-accent-500 sm:w-32"
                    />
                  )}
                </Field>
                <Button size="sm" variant="ghost" onClick={() => remove(index)} aria-label="Remove card" className="touch-target">
                  ✕
                </Button>
              </div>
              <Field label="Description">
                {(id) => (
                  <Input
                    id={id}
                    value={card.description}
                    placeholder="What the rule forbids or expects…"
                    onChange={(e) => update(index, { description: e.target.value })}
                  />
                )}
              </Field>
              <Field label="Triggers (interaction concepts)" hint="Which classified social acts breach this card.">
                {(id) => (
                  <TagInput
                    id={id}
                    value={[...card.triggers]}
                    onChange={(triggers) => update(index, { triggers })}
                    suggestions={CONCEPT_IDS}
                    placeholder="proposition, public_display…"
                  />
                )}
              </Field>
              <OverridesEditor
                overrides={card.reactionOverrides}
                onChange={(reactionOverrides) => update(index, { reactionOverrides })}
              />
            </li>
          ))}
        </ul>
      )}
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
