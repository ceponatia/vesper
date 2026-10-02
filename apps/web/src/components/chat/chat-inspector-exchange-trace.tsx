"use client";

import { useMemo, useState } from "react";
import { agentFailureExplanation, agentLegLabel } from "@/contracts/turns/agent-failure";
import { compositionFallbackCodeLabel, compositionFallbackSiteLabel } from "@/contracts/turns/composition-fallback";
import type {
  AssembledTrace,
  ExchangeCoverageEntry,
  ExchangeDiagnosticEntry,
  ExchangeStageEvent,
} from "@/contracts/turns/chat-exchange-trace";
import { useAsyncData } from "@/components/hooks/use-async";
import { Button } from "@/components/ui/button";
import { cx } from "@/components/ui/cx";
import { Disclosure } from "@/components/ui/disclosure";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tag } from "@/components/ui/tag";
import { useToast } from "@/components/ui/toast";
import { chatInspectorApi } from "@/lib/api-inspector";
import {
  exchangeCoverageStatusBadge,
  exchangeOperationLabel,
  exchangeOutcomeBadge,
  exchangePhaseLabel,
  exchangeStageStatusBadge,
  groupCoverageByStatus,
  highlightedStageSeqs,
  shortId,
} from "./chat-inspector-exchange-trace-format";

/**
 * The exchange-trace panel (#637): one exchange's full stage timeline, its
 * narrator-context coverage, correlated agent/fallback telemetry, and the ids
 * that tie it to the chat's own message and sim rows — exactly the data the
 * CLI's `--json` output shows (contracts/turns/chat-exchange-trace.ts). Mounted
 * right after the two existing health panels: those answer "is something
 * failing, in general?"; this answers "what exactly happened on THIS
 * exchange?" once a panel above already pointed at one.
 */
const TRACE_LIMIT = 10;

export function ChatInspectorExchangeTrace({ chatId }: { chatId: string }) {
  const result = useAsyncData(() => chatInspectorApi.traces(chatId, { limit: TRACE_LIMIT }), [chatId]);
  const toast = useToast();
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null);

  const data = result.data;
  const traces = data?.traces ?? [];
  // `traces` is already newest-first (the read model's own order); deriving the
  // selection from the current list rather than syncing state in an effect
  // means a reload that drops the previously-selected trace falls back to the
  // newest one for free.
  const selected = traces.find((trace) => trace.traceId === selectedTraceId) ?? traces[0] ?? null;

  const copyJson = (label: string, value: unknown) => {
    void navigator.clipboard
      .writeText(JSON.stringify(value, null, 2))
      .then(() => toast.push({ title: `${label} copied`, tone: "success" }))
      .catch(() =>
        toast.push({
          title: `Couldn't copy ${label.toLowerCase()}`,
          description: "The browser refused clipboard access.",
          tone: "error",
        }),
      );
  };

  const copyText = (label: string, value: string) => {
    void navigator.clipboard
      .writeText(value)
      .then(() => toast.push({ title: `${label} copied`, tone: "success" }))
      .catch(() => toast.push({ title: `Couldn't copy ${label.toLowerCase()}`, tone: "error" }));
  };

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-medium tracking-wide text-paper-400 uppercase">Exchange trace</h2>
        <span className="text-[11px] text-paper-600">per-turn execution timeline · last {TRACE_LIMIT}</span>
      </div>

      {result.loading ? (
        <Skeleton className="h-24 w-full rounded-card" aria-hidden="true" />
      ) : result.error ? (
        <ErrorState error={result.error} onRetry={() => result.reload()} />
      ) : traces.length === 0 ? (
        <EmptyState
          title="No traces recorded yet"
          description="Either tracing wasn't enabled when this conversation started, or nothing has been sent since."
        />
      ) : selected ? (
        <div className="flex flex-col gap-4 rounded-card border border-paper-800 bg-paper-950/40 p-4">
          <TracePicker traces={traces} selectedTraceId={selected.traceId} onSelect={setSelectedTraceId} />
          <TraceSummary trace={selected} />

          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => copyJson("Trace JSON", selected)}>
              Copy trace JSON
            </Button>
            <Button
              size="sm"
              variant="quiet"
              onClick={() => downloadJson(`exchange-trace-${selected.traceId}.json`, selected)}
            >
              Download trace JSON
            </Button>
            <Button size="sm" variant="quiet" onClick={() => copyJson("Response JSON", data)}>
              Copy all JSON
            </Button>
            <Button size="sm" variant="quiet" onClick={() => downloadJson(`exchange-traces-${chatId}.json`, data)}>
              Download all JSON
            </Button>
          </div>

          <LinkedIds trace={selected} onCopy={copyText} />
          <Timeline trace={selected} />
          <CoverageSummary coverage={selected.coverage} />
          <NarratorFingerprint trace={selected} />
          <CorrelatedTelemetry trace={selected} />
        </div>
      ) : null}
    </section>
  );
}

/** ms → "12.3s" / "840ms" / "—" (null = unknown/instantaneous, not zero latency). */
function formatMs(ms: number | null): string {
  if (ms === null || ms <= 0) return "—";
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

/**
 * Browser-only side effect (not extracted to the pure format module): saves
 * JSON as a file. The revoke is deferred rather than run right after
 * `click()` — some browsers treat an immediately-revoked object URL as a
 * cancelled download, since the actual save can still be in flight.
 */
function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function TracePicker({
  traces,
  selectedTraceId,
  onSelect,
}: {
  traces: AssembledTrace[];
  selectedTraceId: string;
  onSelect: (traceId: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-2">
      <label className="shrink-0 text-xs text-paper-500" htmlFor="exchange-trace-picker">
        Exchange
      </label>
      <Select
        id="exchange-trace-picker"
        value={selectedTraceId}
        onChange={(e) => onSelect(e.target.value)}
        className="w-full sm:w-auto sm:max-w-md"
      >
        {traces.map((trace) => {
          const when = trace.header.startedAt ? trace.header.startedAt.slice(0, 16).replace("T", " ") : "unknown time";
          return (
            <option key={trace.traceId} value={trace.traceId}>
              {exchangeOperationLabel(trace.header.operation)} · {exchangeOutcomeBadge(trace.outcome).label} · {when} ·{" "}
              {shortId(trace.traceId)}
            </option>
          );
        })}
      </Select>
    </div>
  );
}

function TraceSummary({ trace }: { trace: AssembledTrace }) {
  const badge = exchangeOutcomeBadge(trace.outcome);
  const when = trace.header.startedAt ? trace.header.startedAt.slice(0, 16).replace("T", " ") : "unknown time";
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-paper-400">
      <Tag tone={badge.tone}>{badge.label}</Tag>
      {trace.failureCode ? <Tag tone="danger">{trace.failureCode}</Tag> : null}
      <span>{exchangeOperationLabel(trace.header.operation)}</span>
      <span className="text-paper-600">·</span>
      <span>{trace.header.lane}</span>
      <span className="text-paper-600">·</span>
      <span>{trace.header.authority}</span>
      <span className="text-paper-600">·</span>
      <span>{when}</span>
      {trace.unreadableParts > 0 ? (
        <Tag tone="danger" title="Some flushed parts for this trace failed to parse and were dropped.">
          {trace.unreadableParts} unreadable part{trace.unreadableParts === 1 ? "" : "s"}
        </Tag>
      ) : null}
    </div>
  );
}

function LinkedIds({
  trace,
  onCopy,
}: {
  trace: AssembledTrace;
  onCopy: (label: string, value: string) => void;
}) {
  const sim = trace.header.sim;
  const branchVersion = sim?.branchVersion;
  const rows: { label: string; value: string | null | undefined }[] = [
    { label: "Prompt message", value: trace.header.promptMessageId },
    { label: "Reply message", value: trace.header.replyMessageId },
    { label: "Guard message", value: trace.header.guardMessageId },
    { label: "Sim branch", value: sim?.branchId },
    { label: "Sim cut", value: sim?.cutId },
    { label: "Sim branch version", value: branchVersion !== undefined ? String(branchVersion) : undefined },
  ];
  return (
    <div className="flex flex-col gap-1.5">
      <h3 className="text-xs font-medium tracking-wide text-paper-500 uppercase">Linked ids</h3>
      <div className="grid gap-1.5 sm:grid-cols-2">
        {rows.map((row) => (
          <div key={row.label} className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
            <span className="shrink-0 text-paper-500">{row.label}</span>
            {row.value ? (
              <>
                <code className="min-w-0 break-all text-paper-300" title={row.value}>
                  {shortId(row.value)}
                </code>
                <Button
                  size="sm"
                  variant="quiet"
                  onClick={() => onCopy(row.label, row.value as string)}
                  aria-label={`Copy ${row.label}`}
                >
                  Copy
                </Button>
              </>
            ) : (
              <span className="text-paper-600">—</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function Timeline({ trace }: { trace: AssembledTrace }) {
  const highlighted = useMemo(() => highlightedStageSeqs(trace.highlights), [trace]);
  const diagnosticsBySeq = useMemo(() => {
    const map = new Map<number, ExchangeDiagnosticEntry[]>();
    for (const diagnostic of trace.diagnostics) {
      if (diagnostic.seq === undefined) continue;
      const list = map.get(diagnostic.seq) ?? [];
      list.push(diagnostic);
      map.set(diagnostic.seq, list);
    }
    return map;
  }, [trace]);
  const unassignedDiagnostics = trace.diagnostics.filter((diagnostic) => diagnostic.seq === undefined);

  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-xs font-medium tracking-wide text-paper-500 uppercase">Timeline</h3>
      {trace.stages.length === 0 ? (
        <p className="text-xs text-paper-500">No stages recorded for this exchange.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {trace.stages.map((stage) => (
            <StageRow
              key={stage.seq}
              stage={stage}
              highlighted={highlighted.has(stage.seq)}
              diagnostics={diagnosticsBySeq.get(stage.seq) ?? []}
            />
          ))}
        </ul>
      )}
      {unassignedDiagnostics.length > 0 ? (
        <Disclosure title={`General diagnostics (${unassignedDiagnostics.length})`}>
          <DiagnosticList diagnostics={unassignedDiagnostics} />
        </Disclosure>
      ) : null}
    </div>
  );
}

function StageRow({
  stage,
  highlighted,
  diagnostics,
}: {
  stage: ExchangeStageEvent;
  highlighted: boolean;
  diagnostics: ExchangeDiagnosticEntry[];
}) {
  const badge = exchangeStageStatusBadge(stage.status);
  const facts = [
    stage.reason ? `reason: ${stage.reason}` : "",
    stage.attempt !== undefined ? `attempt ${stage.attempt}` : "",
    stage.model ? `${stage.model.modelId}${stage.model.provider ? ` via ${stage.model.provider}` : ""}` : "",
    stage.inputChars !== undefined ? `in ${stage.inputChars}c` : "",
    stage.outputChars !== undefined ? `out ${stage.outputChars}c` : "",
    stage.count !== undefined ? `${stage.count}×` : "",
  ].filter(Boolean);
  const refs = stage.refs;
  const refRowIds = refs?.rowIds ?? [];
  const refLine = [
    refs?.jobId ? `job ${shortId(refs.jobId)}` : "",
    refRowIds.length > 0 ? `rows ${refRowIds.map(shortId).join(", ")}` : "",
  ].filter(Boolean);
  const hasDetail = Boolean(stage.detail) || diagnostics.length > 0 || refLine.length > 0;

  return (
    <li
      className={cx(
        "rounded-card border px-3 py-2",
        highlighted ? "border-accent-500/70 bg-accent-500/10" : "border-paper-800 bg-paper-900/40",
      )}
    >
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="font-mono text-sm break-all text-paper-200">{stage.stage}</span>
        <span className="text-[11px] text-paper-500">{exchangePhaseLabel(stage.phase)}</span>
        <Tag tone={badge.tone}>{badge.label}</Tag>
        {highlighted ? <Tag tone="accent">flagged</Tag> : null}
        <span className="ml-auto text-[11px] tabular-nums text-paper-600">{formatMs(stage.durationMs)}</span>
      </div>
      {facts.length > 0 ? <p className="mt-1 text-[11px] text-paper-500">{facts.join(" · ")}</p> : null}
      {hasDetail ? (
        <Disclosure title="Detail" className="mt-2">
          <div className="flex flex-col gap-2">
            {stage.detail ? (
              <p className="rounded-md border border-paper-800/60 bg-paper-950/40 px-2 py-1 text-xs break-words text-paper-300">
                {stage.detail}
              </p>
            ) : (
              <p className="text-xs text-paper-500">No detail recorded (production row, or nothing to say).</p>
            )}
            {refLine.length > 0 ? <p className="text-[11px] break-all text-paper-600">{refLine.join(" · ")}</p> : null}
            {diagnostics.length > 0 ? <DiagnosticList diagnostics={diagnostics} /> : null}
          </div>
        </Disclosure>
      ) : null}
    </li>
  );
}

function DiagnosticList({ diagnostics }: { diagnostics: ExchangeDiagnosticEntry[] }) {
  return (
    <ul className="flex flex-col gap-1">
      {diagnostics.map((diagnostic, i) => (
        <li key={`${diagnostic.code}-${i}`} className="text-[11px] text-paper-400">
          <Tag tone={diagnostic.severity === "error" ? "danger" : diagnostic.severity === "warn" ? "accent" : "default"}>
            {diagnostic.severity}
          </Tag>{" "}
          <span className="text-paper-300">{diagnostic.code}</span>
          {diagnostic.path ? <span className="text-paper-600"> — {diagnostic.path}</span> : null}
          {diagnostic.message ? <span className="block text-paper-500">{diagnostic.message}</span> : null}
        </li>
      ))}
    </ul>
  );
}

function CoverageSummary({ coverage }: { coverage: ExchangeCoverageEntry[] }) {
  const groups = useMemo(() => groupCoverageByStatus(coverage), [coverage]);
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-xs font-medium tracking-wide text-paper-500 uppercase">Narrator-context coverage</h3>
      {groups.length === 0 ? (
        <p className="text-xs text-paper-500">No coverage checks recorded for this exchange.</p>
      ) : (
        <div className="flex flex-col gap-3">
          {groups.map((group) => {
            const badge = exchangeCoverageStatusBadge(group.status);
            return (
              <div key={group.status} className="flex flex-col gap-1.5">
                <div className="flex items-center gap-2">
                  <Tag tone={badge.tone}>{badge.label}</Tag>
                  <span className="text-[11px] text-paper-600">{group.entries.length}</span>
                </div>
                <ul className="flex flex-col gap-1">
                  {group.entries.map((entry, i) => (
                    <li
                      key={`${entry.family}-${i}`}
                      className="rounded-md border border-paper-800/60 bg-paper-900/40 px-2 py-1 text-xs"
                    >
                      <div className="flex flex-wrap items-baseline gap-2">
                        <span className="text-paper-200">{entry.family}</span>
                        {entry.reason ? <span className="text-paper-500">{entry.reason}</span> : null}
                        <span className="ml-auto text-[11px] text-paper-600">
                          {entry.count !== undefined ? `${entry.count} items` : ""}
                          {entry.chars !== undefined ? ` · ${entry.chars}c` : ""}
                        </span>
                      </div>
                      {entry.summary ? <p className="mt-1 text-[11px] text-paper-500">{entry.summary}</p> : null}
                      {entry.sourceIds && entry.sourceIds.length > 0 ? (
                        <p className="mt-1 text-[11px] break-all text-paper-600">
                          sources: {entry.sourceIds.map(shortId).join(", ")}
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function NarratorFingerprint({ trace }: { trace: AssembledTrace }) {
  const narrator = trace.header.narrator;
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-xs font-medium tracking-wide text-paper-500 uppercase">Narrator fingerprint</h3>
      {!narrator ? (
        <p className="text-xs text-paper-500">No narrator header recorded for this exchange.</p>
      ) : (
        <>
          <NarratorFacts narrator={narrator} />
          {narrator.promptUnits && narrator.promptUnits.length > 0 ? (
            <Disclosure title={`Prompt units (${narrator.promptUnits.length})`}>
              <ul className="flex flex-col gap-1">
                {narrator.promptUnits.map((unit, i) => (
                  <li key={`${unit.id}-${i}`} className="flex flex-wrap items-center gap-2 text-[11px] text-paper-400">
                    <code className="break-all text-paper-300">{unit.id || "(unnamed unit)"}</code>
                    <span className="text-paper-600">{unit.chars}c</span>
                    {unit.hash ? <span className="break-all text-paper-600">hash {shortId(unit.hash)}</span> : null}
                  </li>
                ))}
              </ul>
            </Disclosure>
          ) : null}
        </>
      )}
    </div>
  );
}

function NarratorFacts({ narrator }: { narrator: NonNullable<AssembledTrace["header"]["narrator"]> }) {
  const facts = [
    narrator.modelId ? `model: ${narrator.modelId}` : "",
    narrator.provider ? `via ${narrator.provider}` : "",
    narrator.attempts !== undefined ? `${narrator.attempts} attempt${narrator.attempts === 1 ? "" : "s"}` : "",
    narrator.finishReason ? `finish: ${narrator.finishReason}` : "",
    narrator.inputTokens !== undefined ? `${narrator.inputTokens} in tok` : "",
    narrator.outputTokens !== undefined ? `${narrator.outputTokens} out tok` : "",
  ].filter(Boolean);
  return facts.length > 0 ? (
    <p className="text-xs text-paper-400">{facts.join(" · ")}</p>
  ) : (
    <p className="text-xs text-paper-500">Nothing recorded.</p>
  );
}

function CorrelatedTelemetry({ trace }: { trace: AssembledTrace }) {
  const hasAny = trace.agentRuns.length + trace.agentFailures.length + trace.compositionFallbacks.length > 0;
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-xs font-medium tracking-wide text-paper-500 uppercase">Agent telemetry</h3>
      {!hasAny ? (
        <p className="text-xs text-paper-500">
          No correlated agent runs, failures, or composition fallbacks for this exchange.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {trace.agentRuns.map((run, i) => (
            <div
              key={`run-${run.at}-${i}`}
              className="rounded-md border border-paper-800/60 bg-paper-900/40 px-2 py-1 text-xs"
            >
              <span className="text-paper-200">{agentLegLabel(run.legId)}</span>{" "}
              <span className="text-ok-400">completed</span>
              {run.summary ? <span className="text-paper-500"> — {run.summary}</span> : null}
            </div>
          ))}
          {trace.agentFailures.map((failure, i) => (
            <div
              key={`fail-${failure.at}-${i}`}
              className="rounded-md border border-paper-800/60 bg-paper-900/40 px-2 py-1 text-xs"
            >
              <span className="text-paper-200">{agentLegLabel(failure.legId)}</span>{" "}
              <span className="text-danger-300">failed</span>{" "}
              <span className="text-paper-500">— probably: {agentFailureExplanation(failure.cause)}</span>
            </div>
          ))}
          {trace.compositionFallbacks.map((fallback, i) => (
            <div
              key={`fallback-${i}-${fallback.code}`}
              className="rounded-md border border-paper-800/60 bg-paper-900/40 px-2 py-1 text-xs"
            >
              <span className="text-paper-200">{compositionFallbackSiteLabel(fallback.site)}</span>{" "}
              <span className="text-danger-300">{compositionFallbackCodeLabel(fallback.code)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

