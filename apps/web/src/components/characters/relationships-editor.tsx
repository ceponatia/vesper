"use client";

import { useRef, useState } from "react";
import { familiarityBands, regardBands } from "@/contracts";
import { charactersApi, type AuthoredEdgeRecord } from "@/lib/client/api";
import { useAsyncData } from "@/components/hooks/use-async";
import { EntityPickerDialog } from "@/components/library/entity-picker";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/error-state";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useSession } from "@/components/auth/auth-client";
import { useAutosave } from "@/components/hooks/use-autosave";
import { useCharacterDraftStorage } from "./use-character-draft-storage";
import { rebaseRelationshipRecovery, relationshipRecoverySchema, relationshipSnapshot as snapshotOf,
  type EdgeDraft, type RelationshipRecovery } from "./relationships-draft";

/**
 * The character editor's Relationships tab (owner ruling 2026-07-07): the
 * character's DEFAULT edges toward other library
 * characters, stored in `character_relationships` (FK cascade — deleting a
 * character never leaves dangling edges). Creating a conversation seeds its
 * matrix from these for every roster pair; the in-chat matrix overrides on top.
 * The player edge lives above this editor in the character draft.
 */

const blankRecord = (): AuthoredEdgeRecord => ({
  familiarity: "strangers",
  regard: "neutral",
  kind: "",
  history: "",
  looming: false,
});

const emptyRecovery = (): RelationshipRecovery => null;

/** Keep this component mounted while the section is hidden so debounce and writes survive tab changes. */
export function RelationshipsEditor({ characterId, name }: { characterId: string; name: string }) {
  const { data: session } = useSession();
  const stored = useAsyncData(() => charactersApi.relationships(characterId), [characterId]);
  if (stored.loading || !session?.user.id) return <Skeleton className="h-24 w-full" />;
  if (stored.error) return <ErrorState error={stored.error} onRetry={() => stored.reload()} />;
  if (!stored.data) return null;
  const storageKey = `vesper:character-relationships:${session.user.id}:${characterId}`;
  return <RelationshipDraftEditor key={storageKey} storageKey={storageKey} characterId={characterId}
    name={name} initialEdges={stored.data.edges} />;
}

function RelationshipDraftEditor({ characterId, name, storageKey, initialEdges }: {
  characterId: string;
  name: string;
  storageKey: string;
  initialEdges: EdgeDraft[];
}) {
  const storage = useCharacterDraftStorage(storageKey, relationshipRecoverySchema, emptyRecovery);
  const [savedEdges, setSavedEdges] = useState(initialEdges);
  const [savedSnapshot, setSavedSnapshot] = useState(() => snapshotOf(initialEdges));
  const acknowledged = useRef(savedSnapshot);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);
  const serverConflict = storage.data !== null && storage.data.base !== savedSnapshot;
  const edges = storage.data?.edges ?? savedEdges;
  const dirty = storage.data !== null && snapshotOf(edges) !== savedSnapshot;
  const blocked = storage.conflict || serverConflict;
  const setDrafts = (next: EdgeDraft[]) => {
    setSaveError(null);
    storage.update({ base: acknowledged.current, edges: next });
  };
  const update = (index: number, patch: Partial<AuthoredEdgeRecord>) => {
    setDrafts(edges.map((edge, i) => i === index ? { ...edge, record: { ...edge.record, ...patch } } : edge));
  };

  const save = (): Promise<void> => {
    if (inFlight.current) return inFlight.current;
    const current = storage.current.current;
    if (!storage.ready || blocked || !current || snapshotOf(current.edges) === acknowledged.current) return Promise.resolve();
    const previousBase = acknowledged.current;
    const snapshot = snapshotOf(current.edges);
    setSaving(true);
    const request = (async () => {
      try {
        const writeSnapshot = async () => {
          await storage.flush();
          if (storage.isBlocked() || storage.current.current?.base !== previousBase) return;
          const result = await charactersApi.saveRelationships(characterId,
            current.edges.map(({ toCharacterId, record }) => ({ toCharacterId, record })));
          if (!result.ok) { setSaveError(result.error.message); return; }
          // Rebase pending continuation on the acknowledged server version without replacing edits.
          const continuation = rebaseRelationshipRecovery(storage.current.current, previousBase, snapshot, storage.isBlocked());
          if (continuation !== storage.current.current) storage.update(continuation);
          acknowledged.current = snapshot;
          setSavedSnapshot(snapshot);
          setSavedEdges(current.edges);
          setSaveError(null);
          if (storage.current.current && snapshotOf(storage.current.current.edges) === snapshot) {
            await storage.clear(storage.revision.current);
          }
        };
        // Serialize replacements across remounted editors and cooperating browser tabs too.
        if (navigator.locks) await navigator.locks.request(`${storageKey}:save`, writeSnapshot);
        else await writeSnapshot();
      } catch {
        setSaveError("Couldn't save library relationships. Your edits are kept for retry.");
      } finally {
        setSaving(false);
        inFlight.current = null;
      }
    })();
    inFlight.current = request;
    return request;
  };
  const autosave = useAutosave({
    enabled: storage.ready && !blocked && !saveError,
    dirty, saving, save, signal: storage.data,
  });

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
    <div className="flex flex-col gap-3" onBlur={autosave.onBlur}>
      <h3 className="text-base font-medium text-paper-100">Library relationships</h3>
      <p className="text-sm text-paper-400">
        How {name || "this character"} stands toward other library characters. Edits autosave and stay available when
        you switch sections. New conversations use these defaults; existing stories keep their own relationships.
        Section generation changes only the player relationship above.
      </p>
      <p role="status" className="text-sm text-paper-400">
        {saving ? "Saving library relationships…" : saveError ? "Library relationships could not be saved." : dirty ? "Library relationship changes waiting to save" : "Library relationships saved"}
      </p>
      {saveError ? <p role="alert" className="text-sm text-danger-300">{saveError}</p> : null}
      {storage.notice ? <p role="status" className="text-sm text-paper-400">{storage.notice}</p> : null}
      {serverConflict ? (
        <div className="flex flex-wrap items-center gap-2">
          <p className="w-full text-sm text-paper-400">Saved relationships changed since this browser draft. Choose which version to keep.</p>
          <Button size="sm" disabled={saving} onClick={() => setDrafts(edges)}>Use recovered edits</Button>
          <Button size="sm" disabled={saving} onClick={() => storage.reset()}>Use saved relationships</Button>
        </div>
      ) : null}
      {storage.conflict ? (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={saving} onClick={() => storage.resume()}>Use shared browser draft</Button>
          <Button size="sm" disabled={saving} onClick={() => storage.reset()}>Use saved relationships</Button>
        </div>
      ) : null}
      {storage.recoveries.map((copy) => (
        <Button key={copy.key} size="sm" disabled={saving} onClick={() => storage.resume(copy.key)}>Recover edits from {copy.label}</Button>
      ))}
      <fieldset disabled={!storage.ready || blocked} className="flex min-w-0 flex-col gap-3">
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
        {dirty || saveError ? (
          <Button size="sm" variant="primary" busy={saving} disabled={saving} onClick={() => void save()}>
            Save library relationships
          </Button>
        ) : null}
      </div>
      </fieldset>
      <EntityPickerDialog
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        title="Relate to which character?"
        search={searchCharacters}
        onPick={(entry) => {
          setPickerOpen(false);
          if (blocked || !storage.ready) return;
          if (edges.some((e) => e.toCharacterId === entry.id)) return;
          setDrafts([...edges, { toCharacterId: entry.id, toName: entry.name, record: blankRecord() }]);
        }}
        disabledIds={new Set([characterId, ...edges.map((e) => e.toCharacterId)])}
        emptyText="No characters match."
      />
    </div>
  );
}
