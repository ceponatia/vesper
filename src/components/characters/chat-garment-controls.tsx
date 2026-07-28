"use client";

import {
  garmentDegreeBands,
  GARMENT_DEGREE_BAND_VALUES,
  garmentTuckStates,
  type GarmentDegreeBand,
  type GarmentOperation,
  type GarmentTuckState,
} from "@/contracts";
import type { GarmentPartControl, GarmentReadout } from "@/lib/client/api";

/**
 * The chat Character sheet's garment PRESENTATION controls
 * (clothing-state-graph.plan.md slice 3). A sibling of `ChatWardrobeEditor`: that
 * one decides *which* garments are worn, this one decides *how each is currently
 * arranged* — closures, rolls, tucks, strap/hem displacement, and putting a part
 * back the way it was.
 *
 * It edits nothing directly. Every click QUEUES a typed `GarmentOperation`; the
 * sheet's Save sends the list and the server's pure reducer decides what is legal
 * (a roll on a placket, a part that does not exist, a garment that is gone are all
 * dropped with a stable code). The readout below the controls is therefore
 * last-SAVED truth — effective coverage, what presentation is taking away, and any
 * operation the last save rejected — never a client-side re-derivation of the
 * coverage laws.
 *
 * Controlled, like every other section of the sheet.
 */
export interface ChatGarmentControlsProps {
  /** Worn garments as of the last save, with their bindable parts. */
  garments: readonly GarmentReadout[];
  /** Operations queued by this sheet and not yet saved. */
  operations: readonly GarmentOperation[];
  /** Garment operations the last save rejected (stable codes). */
  diagnostics: readonly { code: string; message: string }[];
  onChange: (operations: GarmentOperation[]) => void;
}

/** Dedupe key: one queued operation per addressed part (or per restore set). */
function operationKey(operation: GarmentOperation): string {
  if ("partId" in operation) return `${operation.garmentId}:${operation.partId}`;
  if (operation.kind === "restore_presentation") {
    return `${operation.garmentId}:restore:${[...operation.partIds].sort().join("|")}`;
  }
  return `${operation.garmentId}:${operation.kind}`;
}

/** The operation currently queued for one part, if any — last click wins. */
function queuedFor(
  operations: readonly GarmentOperation[],
  garmentId: string,
  partId: string,
): GarmentOperation | undefined {
  for (let index = operations.length - 1; index >= 0; index -= 1) {
    const operation = operations[index];
    if (!operation || operation.garmentId !== garmentId) continue;
    if ("partId" in operation && operation.partId === partId) return operation;
    if (operation.kind === "restore_presentation" && operation.partIds.includes(partId)) return operation;
  }
  return undefined;
}

const pillOn =
  "cursor-pointer rounded-full border border-accent-500/60 bg-accent-500/10 px-2 py-0.5 text-[11px] text-accent-300";
const pillOff =
  "cursor-pointer rounded-full border border-ink-500 px-2 py-0.5 text-[11px] text-paper-400 transition-colors hover:border-accent-500/50 hover:text-paper-200";

function Pill({ on, label, onClick }: { on: boolean; label: string; onClick: () => void }) {
  return (
    <button type="button" aria-pressed={on} onClick={onClick} className={on ? pillOn : pillOff}>
      {label}
    </button>
  );
}

/**
 * Material state, DISPLAY ONLY (clothing-state-graph slice 4). Condition changes
 * arrive through the API — from continuity (slice 5) and from the world, never
 * from a pill on this sheet — so this is a read of last-saved truth, in bands.
 * Renders nothing at all for a garment with nothing to report: a dry, clean,
 * unmarked shirt should not add a line to the sheet every turn.
 */
function conditionLine(garment: GarmentReadout) {
  const notable = garment.notableChannels.map((channel) => garment.condition[channel]).filter(Boolean);
  const parts = garment.conditionParts.flatMap((part) => {
    const bands = Object.values(part.bands).filter(Boolean);
    return bands.length > 0 ? [`${part.label} ${bands.join("/")}`] : [];
  });
  const deposits = garment.deposits.map((deposit) => {
    const where = deposit.labels.length > 0 ? ` on ${deposit.labels.join(", ")}` : "";
    return `${deposit.freshness} ${deposit.kind}${where}`;
  });
  const damage = garment.damage.map((mark) => `${mark.severity ?? "slight"} ${mark.kind} — ${mark.label}`);
  const segments = [...notable, ...parts, ...deposits, ...damage];
  if (segments.length === 0) return null;
  return (
    <p className="mt-1 text-[11px] text-paper-600">
      Condition: <span className="text-paper-400">{segments.join(" · ")}</span>
    </p>
  );
}

export function ChatGarmentControls({ garments, operations, diagnostics, onChange }: ChatGarmentControlsProps) {
  if (garments.length === 0) return null;

  /** Queue one operation, replacing whatever was queued for the same part. */
  const queue = (operation: GarmentOperation) => {
    const key = operationKey(operation);
    onChange([...operations.filter((existing) => operationKey(existing) !== key), operation]);
  };

  /** Restore a whole garment: its other pending edits are moot, so they go too. */
  const restoreGarment = (garment: GarmentReadout) => {
    const partIds = garment.controls.map((control) => control.partId);
    if (partIds.length === 0) return;
    onChange([
      ...operations.filter((existing) => existing.garmentId !== garment.garmentId),
      { kind: "restore_presentation", garmentId: garment.garmentId, partIds },
    ]);
  };

  const renderControl = (garmentId: string, control: GarmentPartControl) => {
    const queued = queuedFor(operations, garmentId, control.partId);
    const restored = queued?.kind === "restore_presentation";
    const band: GarmentDegreeBand | null = restored
      ? null
      : queued?.kind === "set_roll" || queued?.kind === "set_displacement"
        ? queued.degree
        : queued?.kind === "set_closure"
          ? null
          : control.band;
    const openFasteners: number[] =
      queued?.kind === "set_closure" && queued.state.kind === "fastener_series"
        ? [...queued.state.openFastenerIndexes]
        : restored
          ? []
          : control.openFasteners;
    const tuck: GarmentTuckState | null =
      queued?.kind === "set_tuck" ? queued.state : restored ? "out" : control.tuck;

    const bandPills = (make: (degree: GarmentDegreeBand) => GarmentOperation) =>
      garmentDegreeBands.map((degree) => (
        <Pill key={degree} on={band === degree} label={degree} onClick={() => queue(make(degree))} />
      ));

    return (
      <li key={control.partId} className="flex flex-wrap items-center gap-1.5">
        <span className="w-28 shrink-0 text-[11px] text-paper-400">{control.label}</span>
        {control.channel === "closure" && control.fastenerCount !== null ? (
          // A bounded fastener series: individual buttons open without becoming
          // graph nodes, so the control is one toggle per fastener, top→bottom.
          Array.from({ length: control.fastenerCount }, (_, index) => index).map((index) => (
            <Pill
              key={index}
              on={openFasteners.includes(index)}
              label={String(index + 1)}
              onClick={() =>
                queue({
                  kind: "set_closure",
                  garmentId,
                  partId: control.partId,
                  state: {
                    kind: "fastener_series",
                    openFastenerIndexes: openFasteners.includes(index)
                      ? openFasteners.filter((open) => open !== index)
                      : [...openFasteners, index],
                  },
                })
              }
            />
          ))
        ) : control.channel === "closure" ? (
          bandPills((degree) => ({
            kind: "set_closure",
            garmentId,
            partId: control.partId,
            state: { kind: "continuous", openness: GARMENT_DEGREE_BAND_VALUES[degree] },
          }))
        ) : control.channel === "roll" ? (
          bandPills((degree) => ({ kind: "set_roll", garmentId, partId: control.partId, degree }))
        ) : control.channel === "displacement" && control.displacementKind !== null ? (
          bandPills((degree) => ({
            kind: "set_displacement",
            garmentId,
            partId: control.partId,
            displacement: control.displacementKind ?? "lifted",
            degree,
          }))
        ) : control.channel === "tuck" ? (
          garmentTuckStates.map((state) => (
            <Pill
              key={state}
              on={tuck === state}
              label={state}
              onClick={() => queue({ kind: "set_tuck", garmentId, partId: control.partId, state })}
            />
          ))
        ) : null}
        <button
          type="button"
          title="Put this part back the way it was"
          onClick={() => queue({ kind: "restore_presentation", garmentId, partIds: [control.partId] })}
          className="cursor-pointer text-[11px] text-paper-600 hover:text-paper-300"
        >
          reset
        </button>
        {control.dropped.length > 0 && !queued ? (
          <span className="text-[11px] text-paper-600">— uncovers {control.dropped.join(", ")}</span>
        ) : null}
      </li>
    );
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <span className="text-xs font-medium tracking-wide text-paper-400 uppercase">Garment presentation</span>
        {operations.length > 0 ? (
          <span className="text-[11px] text-accent-300">
            {operations.length} pending — Save to apply
          </span>
        ) : null}
      </div>

      {garments.map((garment) => (
        <div key={garment.garmentId} className="rounded-card border border-ink-600 bg-ink-950/40 p-3">
          <div className="flex items-center gap-3">
            <h4 className="text-[11px] font-medium tracking-wide text-paper-400 uppercase">{garment.name}</h4>
            {garment.controls.length > 0 ? (
              <button
                type="button"
                onClick={() => restoreGarment(garment)}
                className="cursor-pointer rounded-md border border-ink-600 px-2 py-0.5 text-[11px] text-paper-400 transition-colors hover:border-accent-500/60 hover:text-accent-300"
              >
                Restore all
              </button>
            ) : null}
          </div>
          {garment.controls.length > 0 ? (
            <ul className="mt-2 flex flex-col gap-1.5">
              {garment.controls.map((control) => renderControl(garment.garmentId, control))}
            </ul>
          ) : (
            <p className="mt-1 text-[11px] text-paper-600">No adjustable parts on this garment.</p>
          )}
          <p className="mt-2 text-[11px] text-paper-600">
            Covers: <span className="text-paper-400">{garment.covers.length ? garment.covers.join(", ") : "—"}</span>
            {garment.dropped.length > 0 ? (
              <>
                {" · no longer: "}
                <span className="text-paper-400">{garment.dropped.join(", ")}</span>
              </>
            ) : null}
          </p>
          {conditionLine(garment)}
        </div>
      ))}

      {diagnostics.length > 0 ? (
        <div className="rounded-card border border-danger-500/40 bg-ink-950/40 p-3 text-[11px] text-paper-400">
          <span className="block font-medium tracking-wide text-paper-400 uppercase">Rejected last save</span>
          <ul className="mt-1 space-y-0.5">
            {diagnostics.map((diagnostic, index) => (
              <li key={`${diagnostic.code}-${index}`}>
                <span className="text-danger-300">{diagnostic.code}</span> — {diagnostic.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
