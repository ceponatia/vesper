"use client";

import { useState } from "react";
import { cardFromLibraryParts, type SocialReactionCard } from "@/contracts";
import { newId } from "@/lib/ids";
import { socialCardsApi, type SocialCardSummary } from "@/lib/client/api";
import { EntityPickerDialog } from "@/components/library/entity-picker";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { SocialCardFields } from "./social-card-fields";

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
 * tab (`profile.socialCards` — the character's own lines). The card's row-level label/description
 * live here; the mechanical fields (kind/severity/triggers/overrides + the live preview) come from
 * the shared {@link SocialCardFields}, so this and the standalone card builder stay in lockstep.
 *
 * Library reuse (copy-at-every-layer): **Import** snapshots a `social_cards` library row into this
 * array (a fresh-id copy via `cardFromLibraryParts`); **Save to library** promotes an inline card
 * to a reusable library row. Neither keeps a live link — editing/deleting the library card never
 * reaches a world or character already using it.
 */
export function SocialCardsEditor({ cards, onChange, hint, emptyText }: SocialCardsEditorProps) {
  const toast = useToast();
  const [importing, setImporting] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);

  const update = (index: number, patch: Partial<SocialReactionCard>) =>
    onChange(cards.map((c, i) => (i === index ? { ...c, ...patch } : c)));
  const remove = (index: number) => onChange(cards.filter((_, i) => i !== index));
  const add = () =>
    onChange([
      ...cards,
      { id: newId(), label: "New card", description: "", kind: "social_rule", triggers: [], severity: 40, reactionOverrides: [] },
    ]);

  const searchLibrary = (q: string) =>
    socialCardsApi.list({ q }).then((result) =>
      result.ok
        ? {
            ok: true as const,
            data: result.data.map((c) => ({ id: c.id, name: c.name, detail: c.definition.kind, data: c })),
          }
        : result,
    );

  const importCard = (data: unknown) => {
    const summary = data as SocialCardSummary;
    onChange([...cards, cardFromLibraryParts(newId(), summary.name, summary.description, summary.definition)]);
  };

  const saveToLibrary = async (card: SocialReactionCard) => {
    setSavingId(card.id);
    const result = await socialCardsApi.create({
      name: card.label,
      description: card.description,
      definition: { kind: card.kind, triggers: card.triggers, severity: card.severity, defaultReaction: card.defaultReaction, reactionOverrides: card.reactionOverrides },
    });
    setSavingId(null);
    if (result.ok) toast.push({ title: `“${card.label}” saved to library`, tone: "success" });
    else toast.push({ title: "Couldn't save to library", description: result.error.message, tone: "error" });
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-paper-200">Social-reaction cards</span>
        <div className="flex gap-1">
          <Button size="sm" variant="ghost" onClick={() => setImporting(true)}>
            Import from library
          </Button>
          <Button size="sm" variant="ghost" onClick={add}>
            + Add card
          </Button>
        </div>
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
              <div className="grid grid-cols-1 items-end gap-2 sm:grid-cols-[1fr_auto_auto]">
                <Field label="Label">
                  {(id) => <Input id={id} value={card.label} onChange={(e) => update(index, { label: e.target.value })} />}
                </Field>
                <Button
                  size="sm"
                  variant="quiet"
                  busy={savingId === card.id}
                  onClick={() => saveToLibrary(card)}
                  title="Save this card to your reusable library"
                  className="touch-target"
                >
                  Save to library
                </Button>
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
              <SocialCardFields value={card} onChange={(patch) => update(index, patch)} />
            </li>
          ))}
        </ul>
      )}

      <EntityPickerDialog
        open={importing}
        onClose={() => setImporting(false)}
        title="Import a social card"
        search={searchLibrary}
        onPick={(entry) => importCard(entry.data)}
        emptyText="No saved cards yet. Build one in the Social cards library, or save a card here first."
      />
    </div>
  );
}
