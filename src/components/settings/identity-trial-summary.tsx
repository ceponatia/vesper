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
  trialArmStrategyLabel,
  trialGradeDimensionLabel,
  trialPackVariantLabel,
  trialVerdictLabel,
} from "@/components/characters/identity-pack-copy";
import { useAsyncData } from "@/components/hooks/use-async";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/error-state";
import { Field } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tag } from "@/components/ui/tag";
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

/** One (profile, strategy) the rendered cells put in play — the unit a verdict
 * rules on, carrying the pairwise evidence behind it. */
interface VerdictSlotKey {
  profileId: string;
  strategy: IdentityReferenceStrategy;
  totalPairs: number;
  gradedPairs: number;
}

/**
 * The verdict slots come from `renderedCombos`, NOT from the comparisons: a
 * strategy whose every counterpart cell failed has evidence but no pair, so it
 * appears in no comparison — yet the run cannot complete until it is ruled.
 * Deriving slots from comparisons made `complete` unreachable for such a run.
 *
 * The pair counts ride along from the same wire field, so the slot can say how
 * much evidence stands behind the ruling it is asking for instead of the
 * reviewer having to notice an absence in the list above.
 */
function verdictSlots(combos: readonly TrialRenderedCombo[]): VerdictSlotKey[] {
  return combos.map((combo) => ({
    profileId: combo.profileId,
    strategy: combo.identityStrategy,
    totalPairs: combo.totalPairs,
    gradedPairs: combo.gradedPairs,
  }));
}

/**
 * Whether ANY reviewable pair in this run is still ungraded — the condition the
 * server's `review_incomplete` gate refuses on.
 *
 * It is deliberately run-wide rather than per-slot: the gate is run-wide, so a
 * slot whose own pairs are all graded is still refused while another slot's are
 * not, and an override checkbox that appeared only on the incomplete slot would
 * leave the reviewer unable to record the ruling the server actually blocked.
 * Both wire lists are read because either can carry a pair the other does not —
 * a combo with no comparison still reports its own pair counts.
 */
function reviewIsIncomplete(
  comparisons: readonly TrialStrategyComparison[],
  combos: readonly TrialRenderedCombo[],
): boolean {
  return (
    comparisons.some((comparison) => comparison.gradedPairs < comparison.totalPairs) ||
    combos.some((combo) => combo.gradedPairs < combo.totalPairs)
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
  const reviewIncomplete = reviewIsIncomplete(comparisons, renderedCombos);
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
              key={[
                comparison.profileId,
                comparison.strategyA,
                comparison.variantKeyA,
                comparison.strategyB,
                comparison.variantKeyB,
              ].join("|")}
              comparison={comparison}
            />
          ))}
        </div>
      )}

      <section>
        <h2 className="mb-2 text-xs font-medium tracking-wide text-paper-400 uppercase">Verdicts</h2>
        <p className="mb-3 text-[11px] text-paper-500">
          One ruling per profile and strategy, with a required reason. The run completes when every combination in the
          rendered cells is ruled AND every reviewable pair is graded.
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
                reviewIncomplete={reviewIncomplete}
                recorded={recorded}
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
  const labelA = trialArmStrategyLabel(comparison.strategyA);
  const labelB = trialArmStrategyLabel(comparison.strategyB);
  // The variant labels keep the character and revision a `rev:…` key names
  // verbatim ({@link trialPackVariantLabel}) — two arms of the same run differ
  // only in those, so anything that abbreviated them would make two arms read as
  // one. A shared variant is printed once: repeating it either side of a "vs"
  // would suggest the comparison varies on an axis it holds constant.
  const variantA = trialPackVariantLabel(comparison.variantKeyA);
  const variantB = trialPackVariantLabel(comparison.variantKeyB);
  const variants = variantA === variantB ? variantA : `${variantA} vs ${variantB}`;
  return (
    <div className="rounded-card border border-ink-600 bg-ink-850 p-4">
      <div className="flex flex-wrap items-baseline gap-2">
        <h3 className="text-sm font-medium text-paper-200">
          {labelA} vs {labelB}
        </h3>
        <code className="text-[11px] text-paper-500">{comparison.profileId}</code>
        <span className="text-[11px] text-paper-500">{variants}</span>
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
  reviewIncomplete,
  recorded,
  onRecorded,
}: {
  runId: string;
  slot: VerdictSlotKey;
  /** Reviewable pairs are still ungraded somewhere in the run — the server will
   * refuse `review_incomplete` unless the ruling carries an explicit override. */
  reviewIncomplete: boolean;
  recorded: TrialVerdict | null;
  onRecorded: () => void;
}) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [verdict, setVerdict] = useState<TrialVerdictValue>(recorded?.verdict ?? "retained_current");
  const [reason, setReason] = useState("");
  const [override, setOverride] = useState(false);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    const result = await adminIdentityPacksApi.trial.verdict(runId, {
      profileId: slot.profileId,
      identityStrategy: slot.strategy,
      verdict,
      reason: reason.trim(),
      // Sent only when the reviewer ticked it. The absence of the flag is what
      // tells the server "I expect complete evidence", so a default-false that
      // always travelled would be the same request wearing a louder name.
      overrideIncompleteReview: override ? true : undefined,
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
    setOverride(false);
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

      <p className="mt-1 text-[11px] text-paper-500">
        {slot.totalPairs === 0
          ? "No pairwise comparison rendered for this combination — this ruling has no pairwise evidence."
          : `${slot.gradedPairs} of ${slot.totalPairs} pair(s) graded for this combination.`}
      </p>

      {recorded !== null && !editing ? (
        <p className="mt-2 flex flex-wrap items-baseline gap-x-1 text-xs text-paper-400">
          <span className="text-paper-200">{trialVerdictLabel(recorded.verdict)}</span> — {recorded.reason}
          <span className="text-paper-600">({new Date(recorded.decidedAt).toLocaleString()})</span>
          {/* The stored flag, not a live re-derivation: whether the evidence was
              complete AT DECISION TIME is unrecoverable once more grades land. */}
          {recorded.overrideIncompleteReview ? (
            <Tag tone="accent" title="Recorded before every reviewable pair was graded.">
              incomplete review
            </Tag>
          ) : null}
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
          {reviewIncomplete ? (
            <label className="flex items-start gap-2 text-xs text-paper-300">
              <input
                type="checkbox"
                checked={override}
                onChange={() => setOverride((on) => !on)}
                className="mt-0.5 accent-accent-500"
              />
              <span>
                Record without complete review
                <span className="mt-0.5 block text-[11px] text-paper-500">
                  Pairs in this run are still ungraded. The ruling is stored marked as decided on incomplete evidence,
                  permanently.
                </span>
              </span>
            </label>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
