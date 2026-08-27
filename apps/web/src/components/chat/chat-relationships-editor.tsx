"use client";

import { useState } from "react";
import { familiarityBandForValue, familiarityBands, regardBandForValue, regardBands } from "@/contracts";
import { chatsApi, type AuthoredEdgeRecord, type ChatRelationships } from "@/lib/client/api";
import { useAsyncData } from "@/components/hooks/use-async";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";

/**
 * The per-conversation relationship matrix editor: one card per roster pair —
 * kind + history are shared-cell (written to both directed rows identically),
 * the stances show two columns
 * behind a mirrored-by-default asymmetric toggle. Storage stays fully directed.
 * The character→player edge is edited in the existing Relationship panel /
 * state tools, not here.
 */

interface DirectionDraft {
  familiarity: string;
  regard: string;
  lean: "" | "masks_warmth" | "masks_dislike";
  note: string;
  looming: boolean;
}

interface PairDraft {
  aId: string;
  bId: string;
  aName: string;
  bName: string;
  kind: string;
  history: string;
  mirrored: boolean;
  ab: DirectionDraft;
  ba: DirectionDraft;
}

/** One "them → you" card: a member's player edge. */
interface PlayerDraft {
  characterId: string;
  name: string;
  kind: string;
  history: string;
  stance: DirectionDraft;
}

function playerDrafts(data: ChatRelationships): PlayerDraft[] {
  const byId = new Map(data.playerEdges.map((e) => [e.characterId, e.record]));
  return [...data.roster]
    .sort((a, b) => a.sort - b.sort)
    .map((member) => {
      const record = byId.get(member.characterId);
      return {
        characterId: member.characterId,
        name: member.name,
        kind: record?.kind ?? "",
        history: record?.history ?? "",
        stance: directionDraft(record),
      };
    });
}

function directionDraft(record: { familiarity: number; regard: number; presented?: { lean: "masks_warmth" | "masks_dislike"; note: string }; looming: boolean } | undefined): DirectionDraft {
  return {
    familiarity: familiarityBandForValue(record?.familiarity ?? 0).id,
    regard: regardBandForValue(record?.regard ?? 0).id,
    lean: record?.presented?.lean ?? "",
    note: record?.presented?.note ?? "",
    looming: record?.looming ?? false,
  };
}

function sameDirection(a: DirectionDraft, b: DirectionDraft): boolean {
  return a.familiarity === b.familiarity && a.regard === b.regard && a.lean === b.lean && a.looming === b.looming;
}

function pairDrafts(data: ChatRelationships): PairDraft[] {
  const roster = [...data.roster].sort((a, b) => a.sort - b.sort);
  const byKey = new Map(data.edges.map((e) => [`${e.fromCharacterId}→${e.toCharacterId}`, e.record]));
  const pairs: PairDraft[] = [];
  for (let i = 0; i < roster.length; i++) {
    for (let j = i + 1; j < roster.length; j++) {
      const a = roster[i];
      const b = roster[j];
      if (!a || !b) continue;
      const abRecord = byKey.get(`${a.characterId}→${b.characterId}`);
      const baRecord = byKey.get(`${b.characterId}→${a.characterId}`);
      const ab = directionDraft(abRecord);
      const ba = directionDraft(baRecord);
      pairs.push({
        aId: a.characterId,
        bId: b.characterId,
        aName: a.name,
        bName: b.name,
        kind: abRecord?.kind ?? baRecord?.kind ?? "",
        history: abRecord?.history ?? baRecord?.history ?? "",
        mirrored: sameDirection(ab, ba),
        ab,
        ba,
      });
    }
  }
  return pairs;
}

function toAuthored(pair: PairDraft, direction: DirectionDraft): AuthoredEdgeRecord {
  return {
    familiarity: direction.familiarity,
    regard: direction.regard,
    kind: pair.kind.trim(),
    history: pair.history.trim(),
    ...(direction.lean ? { presented: { lean: direction.lean, note: direction.note.trim() } } : {}),
    looming: direction.looming,
  };
}

export function ChatRelationshipsEditor({ chatId, archived }: { chatId: string; archived: boolean }) {
  const toast = useToast();
  const data = useAsyncData(() => chatsApi.relationships(chatId), [chatId]);
  const [drafts, setDrafts] = useState<PairDraft[] | null>(null);
  const [playerRows, setPlayerRows] = useState<PlayerDraft[] | null>(null);
  const [savingKey, setSavingKey] = useState<string | null>(null);

  if (data.loading) return <Skeleton className="h-24 w-full" />;
  if (data.error || !data.data) return null;
  if (data.data.roster.length < 2) return null;

  const pairs = drafts ?? pairDrafts(data.data);
  const players = playerRows ?? playerDrafts(data.data);
  const update = (index: number, patch: Partial<PairDraft>) => {
    setDrafts(pairs.map((p, i) => (i === index ? { ...p, ...patch } : p)));
  };
  const updateDirection = (index: number, key: "ab" | "ba", patch: Partial<DirectionDraft>) => {
    const pair = pairs[index];
    if (!pair) return;
    const next = { ...pair[key], ...patch };
    // Mirrored pairs keep both stances identical (asymmetry is one toggle away).
    update(index, pair.mirrored ? { ab: next, ba: next } : { [key]: next });
  };

  const save = async (index: number) => {
    const pair = pairs[index];
    if (!pair) return;
    const key = `${pair.aId}·${pair.bId}`;
    setSavingKey(key);
    const result = await chatsApi.saveRelationships(chatId, {
      edges: [
        { fromCharacterId: pair.aId, toCharacterId: pair.bId, record: toAuthored(pair, pair.ab) },
        { fromCharacterId: pair.bId, toCharacterId: pair.aId, record: toAuthored(pair, pair.ba) },
      ],
    });
    setSavingKey(null);
    if (!result.ok) {
      toast.push({ title: "Couldn't save", description: result.error.message, tone: "error" });
      return;
    }
    toast.push({ title: `${pair.aName} & ${pair.bName} updated`, tone: "success" });
  };

  const updatePlayer = (index: number, patch: Partial<PlayerDraft>) => {
    setPlayerRows(players.map((p, i) => (i === index ? { ...p, ...patch } : p)));
  };

  const savePlayer = async (index: number) => {
    const row = players[index];
    if (!row) return;
    const key = `player·${row.characterId}`;
    setSavingKey(key);
    const result = await chatsApi.saveRelationships(chatId, {
      playerEdges: [
        {
          characterId: row.characterId,
          record: {
            familiarity: row.stance.familiarity,
            regard: row.stance.regard,
            kind: row.kind.trim(),
            history: row.history.trim(),
            ...(row.stance.lean ? { presented: { lean: row.stance.lean, note: row.stance.note.trim() } } : {}),
            looming: row.stance.looming,
          },
        },
      ],
    });
    setSavingKey(null);
    if (!result.ok) {
      toast.push({ title: "Couldn't save", description: result.error.message, tone: "error" });
      return;
    }
    toast.push({ title: `${row.name}'s side updated`, tone: "success" });
  };

  const stanceRow = (fromName: string, toName: string, direction: DirectionDraft, onChange: (patch: Partial<DirectionDraft>) => void) => (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="w-28 shrink-0 truncate text-[11px] text-paper-500">
        {fromName} → {toName}
      </span>
      <Select
        aria-label={`${fromName} familiarity toward ${toName}`}
        value={direction.familiarity}
        onChange={(e) => onChange({ familiarity: e.target.value })}
        className="h-7 text-xs"
      >
        {familiarityBands.map((band) => (
          <option key={band.id} value={band.id}>
            {band.label}
          </option>
        ))}
      </Select>
      <Select
        aria-label={`${fromName} regard toward ${toName}`}
        value={direction.regard}
        onChange={(e) => onChange({ regard: e.target.value })}
        className="h-7 text-xs"
      >
        {regardBands.map((band) => (
          <option key={band.id} value={band.id}>
            {band.label}
          </option>
        ))}
      </Select>
      <Select
        aria-label={`${fromName} mask toward ${toName}`}
        value={direction.lean}
        onChange={(e) =>
          onChange({
            lean: e.target.value === "masks_warmth" || e.target.value === "masks_dislike" ? e.target.value : "",
          })
        }
        className="h-7 text-xs"
      >
        <option value="">Honest</option>
        <option value="masks_warmth">Masks warmth</option>
        <option value="masks_dislike">Masks dislike</option>
      </Select>
      <label className="flex items-center gap-1 text-[11px] text-paper-400">
        <input type="checkbox" checked={direction.looming} onChange={(e) => onChange({ looming: e.target.checked })} />
        Looms
      </label>
    </div>
  );

  return (
    <div className="flex flex-col gap-3">
      <span className="text-xs font-medium tracking-wide text-paper-400 uppercase">How they stand with each other</span>
      {pairs.map((pair, index) => {
        const key = `${pair.aId}·${pair.bId}`;
        return (
          <div key={key} className="flex flex-col gap-2 rounded-md border border-ink-600 bg-ink-850 p-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm text-paper-200">
                {pair.aName} &amp; {pair.bName}
              </span>
              <label className="flex items-center gap-1 text-[11px] text-paper-400">
                <input
                  type="checkbox"
                  checked={!pair.mirrored}
                  onChange={(e) =>
                    update(index, e.target.checked ? { mirrored: false } : { mirrored: true, ba: { ...pair.ab } })
                  }
                />
                Asymmetric
              </label>
            </div>
            <Input
              value={pair.kind}
              onChange={(e) => update(index, { kind: e.target.value })}
              placeholder="What they are to each other — “coworkers of 20 years”, “her ex”"
              aria-label="Relationship kind"
              className="h-8 text-xs"
            />
            <Input
              value={pair.history}
              onChange={(e) => update(index, { history: e.target.value })}
              placeholder="One line of shared past"
              aria-label="Relationship history"
              className="h-8 text-xs"
            />
            {stanceRow(pair.aName, pair.bName, pair.ab, (patch) => updateDirection(index, "ab", patch))}
            {pair.mirrored ? null : stanceRow(pair.bName, pair.aName, pair.ba, (patch) => updateDirection(index, "ba", patch))}
            {!archived ? (
              <Button size="sm" className="self-end" busy={savingKey === key} onClick={() => void save(index)}>
                Save
              </Button>
            ) : null}
          </div>
        );
      })}
      <span className="mt-1 text-xs font-medium tracking-wide text-paper-400 uppercase">Toward you</span>
      {players.map((row, index) => (
        <div key={row.characterId} className="flex flex-col gap-2 rounded-md border border-ink-600 bg-ink-850 p-2.5">
          <span className="text-sm text-paper-200">{row.name} → you</span>
          <Input
            value={row.kind}
            onChange={(e) => updatePlayer(index, { kind: e.target.value })}
            placeholder="What you are to each other — “her boss”, “an old flame”"
            aria-label={`Relationship kind toward you (${row.name})`}
            className="h-8 text-xs"
          />
          <Input
            value={row.history}
            onChange={(e) => updatePlayer(index, { history: e.target.value })}
            placeholder="One line of shared past"
            aria-label={`Relationship history toward you (${row.name})`}
            className="h-8 text-xs"
          />
          {stanceRow(row.name, "you", row.stance, (patch) => updatePlayer(index, { stance: { ...row.stance, ...patch } }))}
          {!archived ? (
            <Button
              size="sm"
              className="self-end"
              busy={savingKey === `player·${row.characterId}`}
              onClick={() => void savePlayer(index)}
            >
              Save
            </Button>
          ) : null}
        </div>
      ))}
    </div>
  );
}
