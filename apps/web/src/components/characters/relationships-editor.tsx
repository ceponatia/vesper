"use client";

import { useState } from "react";
import { familiarityBands, regardBands } from "@/contracts";
import { charactersApi, type AuthoredEdgeRecord } from "@/lib/client/api";
import { useAsyncData } from "@/components/hooks/use-async";
import { EntityPickerDialog } from "@/components/library/entity-picker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";

/**
 * The character editor's Relationships tab (relationship-model.plan.md, owner
 * ruling 2026-07-07): the character's DEFAULT edges toward other library
 * characters, stored in `character_relationships` (FK cascade — deleting a
 * character never leaves dangling edges). Creating a conversation seeds its
 * matrix from these for every roster pair; the in-chat matrix overrides on top.
 * The player edge stays the Chat tab's Starting Relationship control.
 */

interface EdgeDraft {
  toCharacterId: string;
  toName: string;
  record: AuthoredEdgeRecord;
}

const blankRecord = (): AuthoredEdgeRecord => ({
  familiarity: "strangers",
  regard: "neutral",
  kind: "",
  history: "",
  looming: false,
});

export function RelationshipsEditor({ characterId, name }: { characterId: string; name: string }) {
  const toast = useToast();
  const stored = useAsyncData(() => charactersApi.relationships(characterId), [characterId]);
  const [drafts, setDrafts] = useState<EdgeDraft[] | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  if (stored.loading) return <Skeleton className="h-24 w-full" />;
  if (stored.error || !stored.data) return null;

  const edges = drafts ?? stored.data.edges.map((e) => ({ toCharacterId: e.toCharacterId, toName: e.toName, record: e.record }));
  const update = (index: number, patch: Partial<AuthoredEdgeRecord>) => {
    setDrafts(edges.map((e, i) => (i === index ? { ...e, record: { ...e.record, ...patch } } : e)));
  };

  const save = async () => {
    setSaving(true);
    const result = await charactersApi.saveRelationships(
      characterId,
      edges.map((e) => ({ toCharacterId: e.toCharacterId, record: e.record })),
    );
    setSaving(false);
    if (!result.ok) {
      toast.push({ title: "Couldn't save relationships", description: result.error.message, tone: "error" });
      return;
    }
    toast.push({ title: "Default relationships saved", tone: "success" });
    stored.reload({ silent: true });
  };

  const searchCharacters = async (q: string) => {
    const result = await charactersApi.list({ q, scope: "owned" });
    return result.ok
      ? {
          ok: true as const,
          data: result.data
            .filter((c) => c.id !== characterId)
            .map((c) => ({ id: c.id, name: c.name, imageId: c.avatarImageId })),
        }
      : result;
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-paper-400">
        How {name || "this character"} stands toward other library characters by default — new conversations seed their
        relationship matrix from these, then override per story. The player edge lives on the Chat tab.
      </p>
      {edges.map((edge, index) => (
        <div key={edge.toCharacterId} className="flex flex-col gap-2 rounded-md border border-ink-600 bg-ink-850 p-2.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm text-paper-200">Toward {edge.toName}</span>
            <button
              type="button"
              onClick={() => setDrafts(edges.filter((_, i) => i !== index))}
              aria-label={`Remove the edge toward ${edge.toName}`}
              className="cursor-pointer rounded px-1 text-xs text-paper-500 hover:text-danger-300"
            >
              ✕
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Select
              aria-label={`Familiarity toward ${edge.toName}`}
              value={edge.record.familiarity}
              onChange={(e) => update(index, { familiarity: e.target.value })}
              className="h-7 text-xs"
            >
              {familiarityBands.map((band) => (
                <option key={band.id} value={band.id}>
                  {band.label}
                </option>
              ))}
            </Select>
            <Select
              aria-label={`Regard toward ${edge.toName}`}
              value={edge.record.regard}
              onChange={(e) => update(index, { regard: e.target.value })}
              className="h-7 text-xs"
            >
              {regardBands.map((band) => (
                <option key={band.id} value={band.id}>
                  {band.label}
                </option>
              ))}
            </Select>
            <Select
              aria-label={`Mask toward ${edge.toName}`}
              value={edge.record.presented?.lean ?? ""}
              onChange={(e) =>
                update(index, {
                  presented:
                    e.target.value === "masks_warmth" || e.target.value === "masks_dislike"
                      ? { lean: e.target.value, note: edge.record.presented?.note ?? "" }
                      : undefined,
                })
              }
              className="h-7 text-xs"
            >
              <option value="">Honest</option>
              <option value="masks_warmth">Masks warmth</option>
              <option value="masks_dislike">Masks dislike</option>
            </Select>
            <label className="flex items-center gap-1 text-[11px] text-paper-400">
              <input
                type="checkbox"
                checked={edge.record.looming}
                onChange={(e) => update(index, { looming: e.target.checked })}
              />
              Looms when apart
            </label>
          </div>
          <Input
            value={edge.record.kind}
            onChange={(e) => update(index, { kind: e.target.value })}
            placeholder="What they are to each other — “her brother”, “old rivals”"
            aria-label="Relationship kind"
            className="h-8 text-xs"
          />
          <Input
            value={edge.record.history}
            onChange={(e) => update(index, { history: e.target.value })}
            placeholder="One line of shared past"
            aria-label="Relationship history"
            className="h-8 text-xs"
          />
        </div>
      ))}
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={() => setPickerOpen(true)}>
          + Add relationship
        </Button>
        {drafts ? (
          <Button size="sm" variant="primary" busy={saving} onClick={() => void save()}>
            Save relationships
          </Button>
        ) : null}
      </div>
      <EntityPickerDialog
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        title="Relate to which character?"
        search={searchCharacters}
        onPick={(entry) => {
          setPickerOpen(false);
          if (edges.some((e) => e.toCharacterId === entry.id)) return;
          setDrafts([...edges, { toCharacterId: entry.id, toName: entry.name, record: blankRecord() }]);
        }}
        disabledIds={new Set([characterId, ...edges.map((e) => e.toCharacterId)])}
        emptyText="No characters match."
      />
    </div>
  );
}
