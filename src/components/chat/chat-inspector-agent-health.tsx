"use client";

import { useMemo, useState } from "react";
import { agentFailureExplanation, agentFailureCauseSchema, agentLegLabel } from "@/contracts/turns/agent-failure";
import { useAsyncData } from "@/components/hooks/use-async";
import { Dialog } from "@/components/ui/dialog";
import { ErrorState } from "@/components/ui/error-state";
import { Skeleton } from "@/components/ui/skeleton";
import { chatInspectorApi, type AgentFailureRow, type AgentRunRow, type AgentRunStatRow } from "@/lib/api-inspector";

/** One row of the merged activity feed — a successful run OR a failure, tagged for rendering. */
type FeedItem =
  | { kind: "run"; at: string; legId: string; run: AgentRunRow }
  | { kind: "failure"; at: string; legId: string; failure: AgentFailureRow };

const CONTROL_CLASS =
  "rounded-md border border-paper-800 bg-paper-900/60 px-2 py-1 text-xs text-paper-200 focus:border-accent-500 focus:outline-none";

/**
 * Agent health (contracts/turns/agent-failure.ts): the helper legs behind every reply are
 * best-effort by design — they degrade to a diagnostic and the reply still ships. That makes
 * a leg failing on EVERY exchange look exactly like a leg that had nothing to say. This
 * panel is the answer: what failed, how often, and the suspected cause.
 *
 * Two scopes, because a timing-out leg is usually an infrastructure story rather than a
 * per-conversation one: this chat, and every chat in the window.
 */
export function ChatInspectorAgentHealth({ chatId }: { chatId: string }) {
  const health = useAsyncData(() => chatInspectorApi.agentFailures(chatId), [chatId]);
  const data = health.data;

  const [legFilter, setLegFilter] = useState("all");
  const [query, setQuery] = useState("");
  // The row the user clicked to open the detail lightbox (null = closed).
  const [selected, setSelected] = useState<FeedItem | null>(null);

  // One chronological feed of this conversation's agent items — successful runs AND failures,
  // newest first — so a single filter / search / scroll governs the whole (potentially large)
  // list instead of two unbounded stacks eating the page.
  const feed = useMemo<FeedItem[]>(() => {
    if (!data) return [];
    const runs: FeedItem[] = data.runs.recent.map((run) => ({ kind: "run", at: run.at, legId: run.legId, run }));
    const failures: FeedItem[] = data.chat.recent.map((failure) => ({
      kind: "failure",
      at: failure.at,
      legId: failure.legId,
      failure,
    }));
    return [...runs, ...failures].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  }, [data]);

  // The agent-type options are whatever legs actually appear (labelled), plus "All".
  const legOptions = useMemo(() => [...new Set(feed.map((item) => item.legId))].sort(), [feed]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return feed.filter((item) => {
      if (legFilter !== "all" && item.legId !== legFilter) return false;
      if (!q) return true;
      const hay =
        item.kind === "run"
          ? `${agentLegLabel(item.legId)} ${item.run.summary} ${item.run.modelId} ${item.run.provider ?? ""}`
          : `${agentLegLabel(item.legId)} ${item.failure.detail} ${item.failure.cause} ${item.failure.modelId} ${item.failure.provider ?? ""}`;
      return hay.toLowerCase().includes(q);
    });
  }, [feed, legFilter, query]);

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-medium tracking-wide text-paper-400 uppercase">Agent health</h2>
        <span className="text-[11px] text-paper-600">helper legs · last {data?.days ?? 7} days</span>
      </div>

      {health.loading ? (
        <Skeleton className="h-24 w-full rounded-card" aria-hidden="true" />
      ) : health.error ? (
        <ErrorState error={health.error} onRetry={() => health.reload()} />
      ) : data ? (
        <div className="flex flex-col gap-4 rounded-card border border-paper-800 bg-paper-950/40 p-4">
          <p className="text-sm text-paper-300">
            {data.chat.total === 0 ? (
              <>
                <span className="text-ok-400">No failures in this conversation.</span> Every helper leg behind these
                replies completed — nothing was silently lost.
              </>
            ) : (
              <>
                <span className="text-danger-300">
                  {data.chat.total} failed leg{data.chat.total === 1 ? "" : "s"}
                </span>{" "}
                in this conversation. A failed leg doesn&apos;t break a reply — it silently drops whatever it was
                supposed to track (a fact, an outfit change, a mood shift).
              </>
            )}
            {data.global.total > data.chat.total ? (
              <>
                {" "}
                <span className="text-paper-500">
                  ({data.global.total} across all conversations — see the totals below.)
                </span>
              </>
            ) : null}
          </p>

          {data.global.total > 0 ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <TallyList title="By leg (all conversations)" rows={data.global.byLeg} label={agentLegLabel} />
              <TallyList title="By suspected cause" rows={data.global.byCause} label={causeLabel} />
            </div>
          ) : null}

          {/* The latency half (chat-plans-promises follow-up): how long the legs that DO complete
              actually take — the diagnostic that tells a slow endpoint from a dead one. */}
          {data.runsGlobal.byLeg.length > 0 ? (
            <RunLatencyList title="Completed runs — latency by leg (all conversations)" rows={data.runsGlobal.byLeg} />
          ) : null}

          {/* The per-item activity feed (runs + failures) — filterable by agent type, keyword-
              searchable, and height-capped so hundreds of items scroll inside a fixed box. */}
          {feed.length > 0 ? (
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="text-xs font-medium tracking-wide text-paper-500 uppercase">
                  Activity in this conversation
                </h3>
                <span className="text-[11px] tabular-nums text-paper-600">
                  {filtered.length === feed.length ? feed.length : `${filtered.length} of ${feed.length}`}
                </span>
              </div>
              <div className="flex flex-wrap gap-2">
                <select
                  value={legFilter}
                  onChange={(e) => setLegFilter(e.target.value)}
                  aria-label="Filter by agent type"
                  className={CONTROL_CLASS}
                >
                  <option value="all">All agents</option>
                  {legOptions.map((leg) => (
                    <option key={leg} value={leg}>
                      {agentLegLabel(leg)}
                    </option>
                  ))}
                </select>
                <input
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search summaries, models, causes…"
                  aria-label="Search agent activity"
                  className={`${CONTROL_CLASS} min-w-0 flex-1`}
                />
              </div>
              {filtered.length > 0 ? (
                <div className="max-h-96 overflow-y-auto rounded-card border border-paper-800/60 bg-paper-950/40 p-1">
                  <ul className="flex flex-col gap-2">
                    {filtered.map((item, i) =>
                      item.kind === "run" ? (
                        <RunRow key={`r-${item.run.at}-${item.legId}-${i}`} run={item.run} onSelect={() => setSelected(item)} />
                      ) : (
                        <FailureRow
                          key={`f-${item.failure.at}-${item.legId}-${i}`}
                          failure={item.failure}
                          onSelect={() => setSelected(item)}
                        />
                      ),
                    )}
                  </ul>
                </div>
              ) : (
                <p className="text-xs text-paper-500">No items match this filter.</p>
              )}
            </div>
          ) : null}
        </div>
      ) : null}

      {selected ? <AgentItemDialog item={selected} onClose={() => setSelected(null)} /> : null}
    </section>
  );
}

/** ms → "12.3s" / "840ms" / "—". */
function formatMs(ms: number): string {
  if (ms <= 0) return "—";
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

/** Per-leg latency bars (median scaled to the slowest max) — the "how slow, really?" view. */
function RunLatencyList({ title, rows }: { title: string; rows: AgentRunStatRow[] }) {
  if (rows.length === 0) return null;
  const max = Math.max(...rows.map((r) => r.maxMs), 1);
  return (
    <div className="flex flex-col gap-1.5">
      <h3 className="text-xs font-medium tracking-wide text-paper-500 uppercase">{title}</h3>
      <ul className="flex flex-col gap-1">
        {rows.map((row) => (
          <li key={row.key} className="flex items-center gap-2 text-xs">
            <span className="min-w-0 flex-1 truncate text-paper-300">{agentLegLabel(row.key)}</span>
            <span
              aria-hidden="true"
              className="h-1.5 rounded-full bg-accent-500/50"
              style={{ width: `${Math.round((row.medianMs / max) * 64)}px` }}
            />
            <span className="text-right tabular-nums text-paper-400">
              {formatMs(row.medianMs)} med · {formatMs(row.maxMs)} max · {row.count}×
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** One successful run: leg · latency · what it did · model. Click opens the detail lightbox. */
function RunRow({ run, onSelect }: { run: AgentRunRow; onSelect: () => void }) {
  const when = run.at ? run.at.slice(0, 16).replace("T", " ") : "unknown time";
  const facts = [run.provider ? `via ${run.provider}` : "", run.modelId].filter(Boolean);
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        className="w-full cursor-pointer rounded-card border border-paper-800 bg-paper-900/40 px-3 py-2 text-left transition-colors hover:border-accent-500/50"
      >
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="text-sm text-paper-200">{agentLegLabel(run.legId)}</span>
          <span className="text-xs tabular-nums text-accent-300">{formatMs(run.latencyMs)}</span>
          {run.summary ? <span className="text-xs text-paper-400">— {run.summary}</span> : null}
          <span className="ml-auto text-[11px] text-paper-600">{when}</span>
        </div>
        {facts.length > 0 ? <p className="mt-1 text-[11px] text-paper-600">{facts.join(" · ")}</p> : null}
      </button>
    </li>
  );
}

function TallyList({
  title,
  rows,
  label,
}: {
  title: string;
  rows: { key: string; count: number }[];
  label: (key: string) => string;
}) {
  if (rows.length === 0) return null;
  const max = Math.max(...rows.map((r) => r.count), 1);
  return (
    <div className="flex flex-col gap-1.5">
      <h3 className="text-xs font-medium tracking-wide text-paper-500 uppercase">{title}</h3>
      <ul className="flex flex-col gap-1">
        {rows.map((row) => (
          <li key={row.key} className="flex items-center gap-2 text-xs">
            <span className="min-w-0 flex-1 truncate text-paper-300">{label(row.key)}</span>
            <span
              aria-hidden="true"
              className="h-1.5 rounded-full bg-danger-400/50"
              style={{ width: `${Math.round((row.count / max) * 64)}px` }}
            />
            <span className="w-8 text-right tabular-nums text-paper-400">{row.count}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The suspected cause, as a short human label (the long explanation rides each row). */
function causeLabel(cause: string): string {
  const LABELS: Record<string, string> = {
    prompt_too_large: "Prompt too large",
    model_slow: "Model / endpoint slow",
    output_cap_too_low: "Output cut off (cap too low)",
    malformed_output: "Malformed output",
    rate_limited: "Rate limited (429)",
    no_credits: "Out of credits (402)",
    auth_failed: "Auth rejected",
    moderation_blocked: "Moderation refusal",
    context_too_long: "Context too long",
    provider_error: "Provider error",
    network: "Network",
    unknown: "Unknown",
  };
  return LABELS[cause] ?? cause;
}

const KIND_LABELS: Record<AgentFailureRow["kind"], string> = {
  timeout: "timed out",
  api_error: "provider error",
  parse_failed: "bad output",
};

/** One failed leg: leg · kind · suspected cause. Click opens the detail lightbox. */
function FailureRow({ failure, onSelect }: { failure: AgentFailureRow; onSelect: () => void }) {
  const cause = agentFailureCauseSchema.parse(failure.cause);
  const when = failure.at ? failure.at.slice(0, 16).replace("T", " ") : "unknown time";
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        className="w-full cursor-pointer rounded-card border border-paper-800 bg-paper-900/40 px-3 py-2 text-left transition-colors hover:border-accent-500/50"
      >
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="text-sm text-paper-200">{agentLegLabel(failure.legId)}</span>
          <span className="text-xs text-danger-300">{KIND_LABELS[failure.kind]}</span>
          <span className="text-xs text-paper-500">— probably: {causeLabel(cause)}</span>
          <span className="ml-auto text-[11px] text-paper-600">{when}</span>
        </div>
        <p className="mt-1 text-xs text-paper-400">{agentFailureExplanation(cause)}</p>
        {failure.detail ? (
          <p className="mt-1 truncate text-[11px] text-paper-600" title={failure.detail}>
            {failure.detail}
          </p>
        ) : null}
      </button>
    </li>
  );
}

/** Numbered signals shown in the failure lightbox — the facts that make the cause checkable. */
function failureFacts(failure: AgentFailureRow): string[] {
  return [
    failure.kind === "timeout" && failure.timeoutMs ? `budget ${failure.timeoutMs}ms` : "",
    failure.latencyMs ? `took ${failure.latencyMs}ms` : "",
    failure.promptChars ? `prompt ${Math.round(failure.promptChars / 100) / 10}k chars` : "",
    failure.maxOutputTokens ? `cap ${failure.maxOutputTokens} tok` : "",
    failure.provider ? `via ${failure.provider}` : "",
    failure.modelId,
  ].filter(Boolean);
}

/**
 * The click-to-open detail lightbox (the "db viewer"): for a RUN, its metadata + the detail
 * sections behind the summary (the actual facts / loops / queries the leg produced); for a
 * FAILURE, the suspected cause + the raw provider/parser message + the checkable signals.
 */
function AgentItemDialog({ item, onClose }: { item: FeedItem; onClose: () => void }) {
  const when = item.at ? item.at.slice(0, 16).replace("T", " ") : "unknown time";
  const title = `${agentLegLabel(item.legId)} — ${item.kind === "run" ? "completed" : "failed"}`;

  const meta: [string, string][] =
    item.kind === "run"
      ? [
          ["Latency", formatMs(item.run.latencyMs)],
          ["Model", item.run.modelId || "—"],
          ["Provider", item.run.provider || "—"],
          ["Prompt", item.run.promptChars ? `${Math.round(item.run.promptChars / 100) / 10}k chars` : "—"],
          ["Output cap", item.run.maxOutputTokens ? `${item.run.maxOutputTokens} tok` : "—"],
          ["When", when],
          ["Exchange", item.run.messageId || "—"],
        ]
      : [
          ["Kind", KIND_LABELS[item.failure.kind]],
          ["Cause", causeLabel(agentFailureCauseSchema.parse(item.failure.cause))],
          ["Model", item.failure.modelId || "—"],
          ["When", when],
          ["Exchange", item.failure.messageId || "—"],
        ];

  return (
    <Dialog open onClose={onClose} title={title}>
      <div className="flex flex-col gap-4">
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          {meta.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-paper-500">{k}</dt>
              <dd className="break-words text-paper-300 tabular-nums">{v}</dd>
            </div>
          ))}
        </dl>

        {item.kind === "run" ? (
          item.run.details.length > 0 ? (
            <div className="flex flex-col gap-3">
              {item.run.details.map((section, i) => (
                <div key={`${section.label}-${i}`} className="flex flex-col gap-1">
                  <h4 className="text-xs font-medium tracking-wide text-paper-500 uppercase">{section.label}</h4>
                  <ul className="flex flex-col gap-1">
                    {section.items.map((line, j) => (
                      <li
                        key={j}
                        className="rounded-md border border-paper-800/60 bg-paper-900/40 px-2 py-1 text-xs break-words text-paper-300"
                      >
                        {line}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-paper-500">This run completed but changed nothing (no facts, state, or queries).</p>
          )
        ) : (
          <div className="flex flex-col gap-2">
            <p className="text-xs text-paper-400">
              {agentFailureExplanation(agentFailureCauseSchema.parse(item.failure.cause))}
            </p>
            {failureFacts(item.failure).length > 0 ? (
              <p className="text-[11px] text-paper-600">{failureFacts(item.failure).join(" · ")}</p>
            ) : null}
            {item.failure.detail ? (
              <div className="flex flex-col gap-1">
                <h4 className="text-xs font-medium tracking-wide text-paper-500 uppercase">What the provider / parser said</h4>
                <p className="rounded-md border border-paper-800/60 bg-paper-900/40 px-2 py-1 text-xs break-words text-paper-300">
                  {item.failure.detail}
                </p>
              </div>
            ) : null}
          </div>
        )}
      </div>
    </Dialog>
  );
}
