"use client";

import { useState } from "react";
import {
  type ImageIdentityPackTrialCellWire,
  imageIdentityPackTrialRefusalCodeSchema,
} from "@vesper/image-core";
import { adminIdentityPacksApi, identityPackTrialRefusal } from "@/lib/client/api";
import {
  identityPackTrialRefusalCopy,
  trialArmStrategyLabel,
  trialCellStatusChip,
  trialCountsLine,
  trialPackVariantLabel,
  trialRunStatusChip,
} from "@/components/characters/identity-pack-copy";
import { useAsyncData } from "@/components/hooks/use-async";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { ErrorState } from "@/components/ui/error-state";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tag } from "@/components/ui/tag";
import { useToast } from "@/components/ui/toast";
import { IdentityTrialReview } from "./identity-trial-review";
import { IdentityTrialSummary } from "./identity-trial-summary";

/**
 * One trial run: progress counts, the bounded Execute control, the cell grid
 * with per-cell refusal explanations, and the review/summary tabs. Execute is
 * the only control here that spends money, and it says so — each click runs at
 * most the chosen batch and reports what remains planned.
 */

const EXECUTE_BATCH_MIN = 1;
const EXECUTE_BATCH_MAX = 20;

type DetailTab = "cells" | "review" | "summary";

const TABS: { key: DetailTab; label: string }[] = [
  { key: "cells", label: "Cells" },
  { key: "review", label: "Review" },
  { key: "summary", label: "Summary" },
];

/**
 * The English behind a settled cell's `failureCode`. The code may come from two
 * vocabularies — trial refusals (which have checked-in copy) or the render
 * failure classifier — so anything the refusal schema does not recognize falls
 * back to the recorded message, then to the raw code.
 */
function cellExplanation(cell: ImageIdentityPackTrialCellWire): string | null {
  const code = cell.result?.failureCode ?? null;
  if (code === null) return null;
  const refusal = imageIdentityPackTrialRefusalCodeSchema.safeParse(code);
  if (refusal.success) return identityPackTrialRefusalCopy(refusal.data);
  return cell.result?.failureMessage ?? code;
}

export function IdentityTrialRunDetail({ runId, onBack }: { runId: string; onBack: () => void }) {
  const toast = useToast();
  const detail = useAsyncData(() => adminIdentityPacksApi.trial.detail(runId), [runId]);

  const [tab, setTab] = useState<DetailTab>("cells");
  const [batchSize, setBatchSize] = useState(5);
  const [executing, setExecuting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const execute = async () => {
    const maxRenders = Math.min(EXECUTE_BATCH_MAX, Math.max(EXECUTE_BATCH_MIN, batchSize));
    setExecuting(true);
    const result = await adminIdentityPacksApi.trial.execute(runId, maxRenders);
    setExecuting(false);
    if (!result.ok) {
      const refusal = identityPackTrialRefusal(result.error);
      toast.push({
        title: "Execution refused",
        description: refusal ? identityPackTrialRefusalCopy(refusal.code) : result.error.message,
        tone: "error",
      });
      detail.reload({ silent: true });
      return;
    }
    const rendered = result.data.executed.filter((cell) => cell.status === "rendered").length;
    toast.push({
      title: `Rendered ${rendered} of ${result.data.executed.length} cell(s)`,
      description: `${result.data.remainingPlanned} still planned`,
      tone: rendered === result.data.executed.length ? "success" : "info",
    });
    detail.reload({ silent: true });
  };

  const remove = async () => {
    setDeleting(true);
    const result = await adminIdentityPacksApi.trial.remove(runId);
    setDeleting(false);
    setConfirmDelete(false);
    if (!result.ok) {
      toast.push({ title: "Delete failed", description: result.error.message, tone: "error" });
      return;
    }
    toast.push({ title: "Run deleted", tone: "success" });
    onBack();
  };

  if (detail.error && !detail.data) {
    return (
      <div>
        <BackButton onBack={onBack} />
        <ErrorState error={detail.error} onRetry={() => detail.reload()} />
      </div>
    );
  }
  if (!detail.data) {
    return (
      <div>
        <BackButton onBack={onBack} />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  const { run, cells } = detail.data;
  const chip = trialRunStatusChip(run.status);

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <BackButton onBack={onBack} />
        <Button size="sm" variant="quiet" onClick={() => setConfirmDelete(true)}>
          Delete run
        </Button>
      </div>

      <header className="mb-5">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="prose-display text-xl">{run.label}</h1>
          <Tag tone={chip.tone}>{chip.label}</Tag>
        </div>
        <p className="mt-1 text-[11px] text-paper-500">
          {trialCountsLine(run.counts)} · created {new Date(run.createdAt).toLocaleString()}
        </p>
      </header>

      {/*
        Claimed cells keep the control on screen, not just planned ones. A pass
        that died mid-batch leaves its cells `running` with nothing planned
        behind them, and returning those abandoned claims to the grid is
        something only an execution pass does — hiding Execute here would wedge
        such a run permanently, unreviewable and unrulable. A pass that finds
        nothing to claim costs nothing, so the affordance is safe to offer.
      */}
      {run.counts.planned + run.counts.running > 0 ? (
        <section className="mb-6 rounded-card border border-ink-600 bg-ink-850 p-4">
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex items-center gap-2 text-sm text-paper-300">
              Renders this pass
              <Input
                type="number"
                min={EXECUTE_BATCH_MIN}
                max={EXECUTE_BATCH_MAX}
                value={batchSize}
                onChange={(e) => {
                  const next = Number(e.target.value);
                  if (Number.isInteger(next)) setBatchSize(next);
                }}
                className="h-8 w-20 text-sm"
              />
            </label>
            <Button variant="primary" busy={executing} onClick={() => void execute()}>
              Execute
            </Button>
            <p className="text-[11px] text-paper-500">
              {run.counts.planned} cell(s) still planned. Each pass is charged against the daily render budget before it
              runs.
            </p>
          </div>
          {run.counts.running > 0 ? (
            <p className="mt-2 text-[11px] text-accent-300">
              {run.counts.running} cell(s) are claimed by an execution pass — those renders may already have been paid
              for, so nothing resets them on sight. If no pass is live, execute again once the claim ages out and it
              returns them to the grid.
            </p>
          ) : null}
        </section>
      ) : null}

      <div className="mb-4 flex gap-2">
        {TABS.map((entry) => (
          <Button
            key={entry.key}
            size="sm"
            variant={tab === entry.key ? "primary" : "quiet"}
            onClick={() => setTab(entry.key)}
          >
            {entry.label}
          </Button>
        ))}
      </div>

      {tab === "cells" ? <CellList cells={cells} /> : null}
      {tab === "review" ? <IdentityTrialReview runId={runId} /> : null}
      {tab === "summary" ? <IdentityTrialSummary runId={runId} onChanged={() => detail.reload({ silent: true })} /> : null}

      <Dialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={`Delete ${run.label}?`}
        footer={
          <>
            <Button onClick={() => setConfirmDelete(false)}>Cancel</Button>
            <Button variant="danger" busy={deleting} onClick={() => void remove()}>
              Delete
            </Button>
          </>
        }
      >
        The run, its grades, and every output image it rendered are removed. The grades cannot be recovered.
      </Dialog>
    </div>
  );
}

function BackButton({ onBack }: { onBack: () => void }) {
  return (
    <Button size="sm" variant="quiet" onClick={onBack}>
      ← All runs
    </Button>
  );
}

function CellList({ cells }: { cells: ImageIdentityPackTrialCellWire[] }) {
  if (cells.length === 0) {
    return <p className="text-sm text-paper-500">This run has no cells — every part of its configuration was refused.</p>;
  }
  return (
    <div className="flex flex-col gap-2">
      {cells.map((cell) => {
        const chip = trialCellStatusChip(cell.status);
        const explanation = cellExplanation(cell);
        return (
          <div key={cell.id} className="rounded-card border border-ink-600 bg-ink-850 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <code className="text-[11px] break-all text-paper-400">{cell.cellKey}</code>
              <Tag tone={chip.tone}>{chip.label}</Tag>
              {cell.spec ? <Tag>{trialArmStrategyLabel(cell.spec.identityStrategy)}</Tag> : null}
              {/* Only the non-default variants are named: every run has a
                  `current` arm, so labelling it on every cell would be noise. */}
              {cell.spec !== null && cell.spec.packVariantKey !== "current" ? (
                <span className="text-[11px] text-paper-500">{trialPackVariantLabel(cell.spec.packVariantKey)}</span>
              ) : null}
            </div>
            {explanation ? <p className="mt-1 text-[11px] text-paper-500">{explanation}</p> : null}
            {/* The provider's own handle on this render — the one identifier that
                lets a cell be traced in the provider dashboard after the fact. */}
            {cell.result?.providerPredictionId ? (
              <p className="mt-1 text-[11px] text-paper-600">
                prediction <code className="break-all">{cell.result.providerPredictionId}</code>
              </p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
