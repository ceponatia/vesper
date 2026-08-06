"use client";

import { useState } from "react";
import {
  trialGradeDimensions,
  trialVerdicts,
  type IdentityReferenceStrategy,
  type TrialRenderedCombo,
  type TrialStrategyComparison,
  type TrialVerdict,
  type TrialVerdictValue,
} from "@/contracts";
import { adminIdentityPacksApi, identityPackTrialRefusal } from "@/lib/client/api";
import {
  identityPackTrialRefusalCopy,
  identityReferenceStrategyLabel,
  trialGradeDimensionLabel,
  trialVerdictLabel,
} from "@/components/characters/identity-pack-copy";
import { useAsyncData } from "@/components/hooks/use-async";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/error-state";
import { Field } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";

/**
 * The unblinded aggregates and the verdict ledger
 * (image-identity-packs.spec.trial.md §"Promotion rules"): per
 * (profile, strategy-pair) means with their sample sizes, win/tie/loss on
 * overall preference, catastrophic counts per side — and one verdict slot per
 * (profile, strategy) present in the RENDERED CELLS (the wire's
 * `renderedCombos`), each requiring a reason.
 */

/** One (profile, strategy) the rendered cells put in play — the unit a verdict rules on. */
interface VerdictSlotKey {
  profileId: string;
  strategy: IdentityReferenceStrategy;
}

/**
 * The verdict slots come from `renderedCombos`, NOT from the comparisons: a
 * strategy whose every counterpart cell failed has evidence but no pair, so it
 * appears in no comparison — yet the run cannot complete until it is ruled.
 * Deriving slots from comparisons made `complete` unreachable for such a run.
 */
function verdictSlots(combos: readonly TrialRenderedCombo[]): VerdictSlotKey[] {
  return combos.map((combo) => ({ profileId: combo.profileId, strategy: combo.identityStrategy }));
}

function hasComparison(comparisons: readonly TrialStrategyComparison[], slot: VerdictSlotKey): boolean {
  return comparisons.some(
    (comparison) =>
      comparison.profileId === slot.profileId &&
      (comparison.strategyA === slot.strategy || comparison.strategyB === slot.strategy),
  );
}

export function IdentityTrialSummary({ runId, onChanged }: { runId: string; onChanged?: () => void }) {
  const summary = useAsyncData(() => adminIdentityPacksApi.trial.summary(runId), [runId]);

  if (summary.error && !summary.data) {
    return <ErrorState error={summary.error} onRetry={() => summary.reload()} />;
  }
  if (!summary.data) {
    return <Skeleton className="h-48 w-full" />;
  }

  const { comparisons, renderedCombos, verdicts } = summary.data;
  if (renderedCombos.length === 0) {
    return (
      <p className="text-sm text-paper-500">
        Nothing to review yet — verdict slots appear once a cell renders, and pairwise aggregates once two strategies
        have rendered the same character, profile, and fixture.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {comparisons.length === 0 ? (
        <p className="text-sm text-paper-500">
          No pairwise aggregates yet — pairs exist once two strategies have rendered the same character, profile, and
          fixture. The rendered combinations below still need verdicts.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {comparisons.map((comparison) => (
            <ComparisonCard
              key={`${comparison.profileId}:${comparison.strategyA}:${comparison.strategyB}`}
              comparison={comparison}
            />
          ))}
        </div>
      )}

      <section>
        <h2 className="mb-2 text-xs font-medium tracking-wide text-paper-400 uppercase">Verdicts</h2>
        <p className="mb-3 text-[11px] text-paper-500">
          One ruling per profile and strategy, with a required reason. The run completes when every combination in the
          rendered cells is ruled.
        </p>
        <div className="flex flex-col gap-3">
          {verdictSlots(renderedCombos).map((slot) => {
            const recorded =
              verdicts.find(
                (verdict) => verdict.profileId === slot.profileId && verdict.identityStrategy === slot.strategy,
              ) ?? null;
            return (
              <VerdictSlot
                // The recorded verdict participates in the key so a slot whose
                // verdict changed on a refresh remounts with the fresh value —
                // its form state seeds from props once, deliberately.
                key={`${slot.profileId}:${slot.strategy}:${recorded?.decidedAt ?? "new"}`}
                runId={runId}
                slot={slot}
                recorded={recorded}
                comparisonRendered={hasComparison(comparisons, slot)}
                onRecorded={() => {
                  summary.reload({ silent: true });
                  onChanged?.();
                }}
              />
            );
          })}
        </div>
      </section>
    </div>
  );
}

function ComparisonCard({ comparison }: { comparison: TrialStrategyComparison }) {
  const labelA = identityReferenceStrategyLabel(comparison.strategyA);
  const labelB = identityReferenceStrategyLabel(comparison.strategyB);
  return (
    <div className="rounded-card border border-ink-600 bg-ink-850 p-4">
      <div className="flex flex-wrap items-baseline gap-2">
        <h3 className="text-sm font-medium text-paper-200">
          {labelA} vs {labelB}
        </h3>
        <code className="text-[11px] text-paper-500">{comparison.profileId}</code>
      </div>
      <p className="mt-1 text-[11px] text-paper-500">
        {comparison.gradedPairs} of {comparison.totalPairs} pair(s) graded · overall {comparison.overall.winsA}–
        {comparison.overall.ties}–{comparison.overall.winsB} (A–tie–B) · catastrophic {comparison.catastrophic.a} (A) /{" "}
        {comparison.catastrophic.b} (B)
      </p>
      <dl className="mt-3 grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
        {trialGradeDimensions.map((dimension) => {
          const aggregate = comparison.dimensions[dimension];
          return (
            <div key={dimension} className="flex justify-between gap-3">
              <dt className="text-paper-500">{trialGradeDimensionLabel(dimension)}</dt>
              <dd className="text-paper-300">
                {aggregate.mean === null ? "—" : aggregate.mean.toFixed(2)}
                <span className="ml-1 text-paper-600">({aggregate.count})</span>
              </dd>
            </div>
          );
        })}
      </dl>
      <p className="mt-2 text-[11px] text-paper-600">
        Negative means favor {labelA}; positive favor {labelB}. Null is ungraded, never a tie.
      </p>
    </div>
  );
}

function VerdictSlot({
  runId,
  slot,
  recorded,
  comparisonRendered,
  onRecorded,
}: {
  runId: string;
  slot: VerdictSlotKey;
  recorded: TrialVerdict | null;
  /** False when this combo rendered cells but no counterpart pair exists to compare against. */
  comparisonRendered: boolean;
  onRecorded: () => void;
}) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [verdict, setVerdict] = useState<TrialVerdictValue>(recorded?.verdict ?? "retained_current");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    const result = await adminIdentityPacksApi.trial.verdict(runId, {
      profileId: slot.profileId,
      identityStrategy: slot.strategy,
      verdict,
      reason: reason.trim(),
    });
    setSaving(false);
    if (!result.ok) {
      const refusal = identityPackTrialRefusal(result.error);
      toast.push({
        title: "Couldn't record the verdict",
        description: refusal ? identityPackTrialRefusalCopy(refusal.code) : result.error.message,
        tone: "error",
      });
      return;
    }
    toast.push({ title: "Verdict recorded", tone: "success" });
    setEditing(false);
    setReason("");
    onRecorded();
  };

  const showForm = editing || recorded === null;

  return (
    <div className="rounded-card border border-ink-600 bg-ink-850 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-baseline gap-2">
          <h3 className="text-sm font-medium text-paper-200">{identityReferenceStrategyLabel(slot.strategy)}</h3>
          <code className="text-[11px] text-paper-500">{slot.profileId}</code>
        </div>
        {recorded !== null && !editing ? (
          <Button size="sm" variant="quiet" onClick={() => setEditing(true)}>
            Revise
          </Button>
        ) : null}
      </div>

      {!comparisonRendered ? (
        <p className="mt-1 text-[11px] text-paper-500">No pairwise comparison rendered for this combination.</p>
      ) : null}

      {recorded !== null && !editing ? (
        <p className="mt-2 text-xs text-paper-400">
          <span className="text-paper-200">{trialVerdictLabel(recorded.verdict)}</span> — {recorded.reason}
          <span className="ml-1 text-paper-600">({new Date(recorded.decidedAt).toLocaleString()})</span>
        </p>
      ) : null}

      {showForm ? (
        <div className="mt-3 flex flex-col gap-3">
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Verdict">
              {(id) => (
                <Select
                  id={id}
                  value={verdict}
                  onChange={(e) => setVerdict(e.target.value as TrialVerdictValue)}
                  className="h-8 w-56 text-xs"
                >
                  {trialVerdicts.map((value) => (
                    <option key={value} value={value}>
                      {trialVerdictLabel(value)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Button variant="primary" busy={saving} disabled={reason.trim().length === 0} onClick={() => void save()}>
              Record
            </Button>
          </div>
          <Field label="Reason" hint="Required — a ruling with no stated reason is indistinguishable from a mistake later.">
            {(id) => <Textarea id={id} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} />}
          </Field>
        </div>
      ) : null}
    </div>
  );
}
