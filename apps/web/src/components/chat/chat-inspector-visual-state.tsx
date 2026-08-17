"use client";

import { useAsyncData } from "@/components/hooks/use-async";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/error-state";
import { Skeleton } from "@/components/ui/skeleton";
import {
  chatInspectorApi,
  type VisualStateCandidateRow,
  type VisualStatePreview,
  type VisualStateSetComparisonRow,
  type VisualStateSuppressionRow,
} from "@/lib/api-inspector";

/**
 * The READ-ONLY visual-state inspector (visual-state.plan.md slice 6): the
 * complete source-to-selection staircase — projected features, composition,
 * suppression reasons, attention scores under ideal debug conditions, both
 * consumer selections, and the slice's measurements (missing owners, duplicate
 * facts, disagreement with the current summaries).
 *
 * It never spends notice or mention state: the route recomputes on demand,
 * loads observer memory read-only, and reports the shadow flag rather than
 * obeying it. Suppression reasons are first-class here, exactly like the
 * affordance panel above it — the common result of this projection today IS
 * conservative silence, and this panel exists to say why, per feature.
 */
export function ChatInspectorVisualState({ chatId }: { chatId: string }) {
  const preview = useAsyncData(() => chatInspectorApi.visualState(chatId), [chatId]);
  const data = preview.data;

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-medium tracking-wide text-paper-400 uppercase">
          Visual state — the projected snapshot
        </h2>
        <Button size="sm" onClick={() => preview.reload()} disabled={preview.loading}>
          Refresh
        </Button>
      </div>

      {preview.loading ? (
        <Skeleton className="h-32 w-full rounded-card" aria-hidden="true" />
      ) : preview.error ? (
        <ErrorState error={preview.error} onRetry={() => preview.reload()} />
      ) : data ? (
        <PreviewBody data={data} />
      ) : null}
    </section>
  );
}

function PreviewBody({ data }: { data: VisualStatePreview }) {
  const m = data.measurements;
  return (
    <>
      <p className="text-xs text-paper-500">
        {data.lane === "successor" ? "Successor lane" : "Character chat"} · scope {data.scopeKey || "—"} · story minute{" "}
        {data.atMinutes} · shadow{" "}
        <span className={data.shadowFlagEnabled ? "text-ok-400" : "text-paper-400"}>
          {data.shadowFlagEnabled ? "measuring live turns" : "off (CHAT_VISUAL_STATE_SHADOW)"}
        </span>{" "}
        · computed on demand, nothing stored, no notice or mention spent
      </p>

      <Panel label="Measurements" defaultOpen>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-[11px]">
          <Row term="features" value={String(m.featureCount)} />
          <Row term="by layer" value={countList(m.featuresByLayer)} />
          <Row term="suppressions" value={countList(m.suppressionsByCode) || "0"} />
          <Row term="missing owners" value={String(m.missingOwnerCount)} />
          <Row term="duplicate keys" value={String(m.duplicateKeyCount)} muted={m.duplicateKeyCount > 0} />
          <Row
            term="narrator"
            value={`${m.narrator.candidateCount} candidates → ${m.narrator.selectedCount} cues · ${m.narrator.constraintCount} constraints · ${m.narrator.noticeCount} notices`}
          />
          <Row
            term="image"
            value={`${m.image.mandatoryCount} mandatory · ${m.image.selectedCount} optional (${m.image.suppressedOptionalCount} past budget)`}
          />
        </dl>
        <ComparisonBlock label="Attributes vs legacy narrator block" comparison={m.attributes} />
        <ComparisonBlock label="Garments vs resolved wardrobe" comparison={m.garments} />
      </Panel>

      <Panel label={`Projected features (${data.features.length})`}>
        {data.features.length === 0 ? (
          <p className="text-xs text-paper-500">Nothing projected — the suppressions below say why.</p>
        ) : (
          <ul className="flex flex-col gap-2 font-mono text-[11px]">
            {data.features.map((feature) => (
              <li key={feature.key} className="break-words">
                <span className="text-paper-200">{feature.key}</span>{" "}
                <span className="text-paper-500">
                  · {feature.kindId} · {feature.layer} · {feature.stability}
                </span>
                <br />
                <span className="text-paper-400">value: {JSON.stringify(feature.value)}</span>{" "}
                <span className="text-paper-600">src {feature.source}</span>
                {feature.changedAtMinutes !== null ? (
                  <span className="text-paper-600"> · changed @{feature.changedAtMinutes}</span>
                ) : null}
                {feature.relationships.length > 0 ? (
                  <>
                    <br />
                    <span className="text-paper-500">{feature.relationships.join(" · ")}</span>
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel label={`Composition (${data.composition.length})`}>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-[11px]">
          {data.composition.map((entry) => (
            <Row
              key={entry.key}
              term={entry.key}
              value={[
                `visible ${entry.effectiveVisibility}`,
                entry.coverage > 0 ? `covered ${entry.coverage}` : "",
                entry.occlusion > 0 ? `occluded ${entry.occlusion}` : "",
                entry.replacedBy ? `replaced by ${entry.replacedBy}` : "",
                entry.modifiedBy.length > 0 ? `modified by ${entry.modifiedBy.join(", ")}` : "",
                entry.attachedTo.length > 0 ? `attached to ${entry.attachedTo.join(", ")}` : "",
                entry.derivedFrom.length > 0 ? `derived from ${entry.derivedFrom.join(", ")}` : "",
              ]
                .filter(Boolean)
                .join(" · ")}
            />
          ))}
        </dl>
        {data.composition.length === 0 ? <p className="text-xs text-paper-500">No features to compose.</p> : null}
      </Panel>

      <Panel label={`Snapshot suppressions (${data.suppressions.length})`}>
        <SuppressionList rows={data.suppressions} empty="Nothing was dropped." />
      </Panel>

      <Panel label={`Attention staircase — debug viewpoint, ideal conditions (${data.staircase.length})`}>
        <CandidateList rows={data.staircase} empty="No feature survived visibility even under ideal conditions." />
      </Panel>

      <Panel label="Viewing conditions — what the production reads ran under">
        <p className="font-mono text-[11px] text-paper-400">
          light {data.viewing.lighting} · distance {data.viewing.distance} · angle {data.viewing.angle} · motion{" "}
          {data.viewing.motion}
        </p>
        <p className="mt-1 font-mono text-[11px] text-paper-600">
          {data.viewing.declared.length === 0
            ? "every component came from an owner"
            : `declared release default: ${data.viewing.declared.join(", ")} — no owner asserts these, and the value is stated policy, not an observation`}
        </p>
      </Panel>

      <Panel label="Narrator selection — production conditions">
        {data.narrator.digests.map((digest) => (
          <div key={digest.subjectId} className="mt-2 first:mt-0">
            <p className="text-[11px] tracking-wide text-paper-500 uppercase">{digest.subjectId}</p>
            <p className="font-mono text-[11px] text-paper-400">
              {digest.selected.length === 0
                ? "no cue offered"
                : digest.selected.map((cue) => `${cue.key} (${cue.reason})`).join(" · ")}
              {" · "}
              {digest.constraintKeys.length} visible constraints · {digest.suppressedCount} unsaid
            </p>
          </div>
        ))}
        <p className="mt-2 font-mono text-[11px] text-paper-600">
          notices {data.narrator.noticeCount} · changes {data.narrator.changeCount} · mention commits{" "}
          {data.narrator.mentionCommitCount} — all discarded; the inspector spends nothing
        </p>
        <p className="mt-1 font-mono text-[11px] text-paper-600">
          cue state: cut {data.narrator.cueState.sequenceAfter} · {data.narrator.cueState.recordCount} families tracked ·{" "}
          {data.narrator.cueState.observedCount} in view now · {data.narrator.cueState.mentionCommitCount} would cool down
        </p>
        <div className="mt-3 border-t border-ink-600 pt-3">
          <SuppressionList rows={data.narrator.suppressions} empty="Nothing suppressed." />
        </div>
      </Panel>

      <Panel label="Image selection — camera, production conditions">
        <p className="font-mono text-[11px] text-paper-400">
          mandatory:{" "}
          {data.image.mandatoryKeys.length === 0 ? "none" : data.image.mandatoryKeys.join(" · ")}
        </p>
        <div className="mt-2">
          <CandidateList rows={data.image.optional} empty="No optional detail survived the camera's visibility read." />
        </div>
        <div className="mt-3 border-t border-ink-600 pt-3">
          <SuppressionList rows={data.image.suppressions} empty="Nothing suppressed." />
        </div>
      </Panel>

      {data.diagnostics.length > 0 ? (
        <Panel label={`Diagnostics (${data.diagnostics.length})`}>
          <ul className="flex flex-col gap-1 font-mono text-[11px]">
            {data.diagnostics.map((entry, index) => (
              <li
                key={`${entry.code}-${index}`}
                className={entry.severity === "info" ? "text-paper-500" : "text-danger-300"}
              >
                [{entry.severity}] {entry.code} — {entry.message}
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}
    </>
  );
}

function countList(record: Record<string, number>): string {
  const entries = Object.entries(record);
  if (entries.length === 0) return "";
  return entries.map(([key, count]) => `${key} ${count}`).join(" · ");
}

function ComparisonBlock({
  label,
  comparison,
}: {
  label: string;
  comparison: VisualStateSetComparisonRow;
}) {
  return (
    <div className="mt-3">
      <p className="mb-1 text-[11px] tracking-wide text-paper-500 uppercase">{label}</p>
      {comparison === null ? (
        <p className="text-xs text-paper-500">No summary to compare against in this lane.</p>
      ) : (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-[11px]">
          <Row
            term="counts"
            value={`legacy ${comparison.legacyCount} · projected ${comparison.projectedCount} · shared ${comparison.sharedCount}`}
          />
          <Row
            term="legacy only"
            value={comparison.legacyOnly.length > 0 ? comparison.legacyOnly.join(", ") : "—"}
            muted={comparison.legacyOnly.length > 0}
          />
          <Row
            term="projected only"
            value={comparison.projectedOnly.length > 0 ? comparison.projectedOnly.join(", ") : "—"}
          />
        </dl>
      )}
    </div>
  );
}

function SuppressionList({ rows, empty }: { rows: readonly VisualStateSuppressionRow[]; empty: string }) {
  if (rows.length === 0) return <p className="text-xs text-paper-500">{empty}</p>;
  return (
    <ul className="flex flex-col gap-1 font-mono text-[11px]">
      {rows.map((row, index) => (
        <li key={`${row.key}-${row.code}-${index}`} className="break-words text-paper-500">
          <span className="text-paper-300">{row.key}</span> · {row.code}
          {row.detail ? <span className="text-paper-600"> ({row.detail})</span> : null}
        </li>
      ))}
    </ul>
  );
}

function CandidateList({ rows, empty }: { rows: readonly VisualStateCandidateRow[]; empty: string }) {
  if (rows.length === 0) return <p className="text-xs text-paper-500">{empty}</p>;
  return (
    <ul className="flex flex-col gap-1 font-mono text-[11px]">
      {rows.map((row) => (
        <li key={row.key} className="break-words">
          <span className="text-paper-200">{row.key}</span>{" "}
          <span className="text-paper-500">
            priority {row.priority} · vis {row.visibility} · uniq {row.uniqueness} · imp {row.importance} · tier{" "}
            {row.detailTier}
          </span>
          {row.changeSignificance > 0 ? <span className="text-ok-400"> · changed {row.changeSignificance}</span> : null}
          {row.cueStatus === null ? null : (
            <span className="text-ok-400">
              {" "}
              · cue {row.cueStatus} · cooldown {row.repetitionCooldown}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

function Row({ term, value, muted }: { term: string; value: string; muted?: boolean }) {
  return (
    <>
      <dt className="text-paper-500">{term}</dt>
      <dd className={muted ? "break-words text-danger-300" : "break-words text-paper-300"}>{value}</dd>
    </>
  );
}

function Panel({
  label,
  children,
  defaultOpen,
}: {
  label: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  return (
    <details className="rounded-card border border-ink-600 bg-ink-950/40" open={defaultOpen}>
      <summary className="cursor-pointer px-3 py-2 text-xs text-paper-300 select-none">{label}</summary>
      <div className="border-t border-ink-600 p-3">{children}</div>
    </details>
  );
}
