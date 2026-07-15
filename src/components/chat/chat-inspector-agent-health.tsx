"use client";

import { agentFailureExplanation, agentFailureCauseSchema, agentLegLabel } from "@/contracts/turns/agent-failure";
import { useAsyncData } from "@/components/hooks/use-async";
import { ErrorState } from "@/components/ui/error-state";
import { Skeleton } from "@/components/ui/skeleton";
import { chatInspectorApi, type AgentFailureRow, type AgentRunRow, type AgentRunStatRow } from "@/lib/api-inspector";

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

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-medium tracking-wide text-paper-400 uppercase">Agent health</h2>
        <span className="text-[11px] text-paper-600">
          failed helper legs · last {data?.days ?? 7} days
        </span>
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

          {data.chat.recent.length > 0 ? (
            <div className="flex flex-col gap-2">
              <h3 className="text-xs font-medium tracking-wide text-paper-500 uppercase">
                Recent failures in this conversation
              </h3>
              <ul className="flex flex-col gap-2">
                {data.chat.recent.map((failure, i) => (
                  <FailureRow key={`${failure.at}-${failure.legId}-${i}`} failure={failure} />
                ))}
              </ul>
            </div>
          ) : null}

          {/* The activity + latency half (chat-plans-promises follow-up): how long the legs that
              DO complete actually take — the diagnostic that tells a slow endpoint from a dead one. */}
          {data.runsGlobal.byLeg.length > 0 ? (
            <RunLatencyList title="Completed runs — latency by leg (all conversations)" rows={data.runsGlobal.byLeg} />
          ) : null}

          {data.runs.recent.length > 0 ? (
            <div className="flex flex-col gap-2">
              <h3 className="text-xs font-medium tracking-wide text-paper-500 uppercase">
                Recent activity in this conversation
              </h3>
              <ul className="flex flex-col gap-2">
                {data.runs.recent.map((run, i) => (
                  <RunRow key={`${run.at}-${run.legId}-${i}`} run={run} />
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
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

/** One successful run: leg · latency · what it did · model. */
function RunRow({ run }: { run: AgentRunRow }) {
  const when = run.at ? run.at.slice(0, 16).replace("T", " ") : "unknown time";
  const facts = [run.provider ? `via ${run.provider}` : "", run.modelId].filter(Boolean);
  return (
    <li className="rounded-card border border-paper-800 bg-paper-900/40 px-3 py-2">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="text-sm text-paper-200">{agentLegLabel(run.legId)}</span>
        <span className="text-xs text-accent-300 tabular-nums">{formatMs(run.latencyMs)}</span>
        {run.summary ? <span className="text-xs text-paper-400">— {run.summary}</span> : null}
        <span className="ml-auto text-[11px] text-paper-600">{when}</span>
      </div>
      {facts.length > 0 ? <p className="mt-1 text-[11px] text-paper-600">{facts.join(" · ")}</p> : null}
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

function FailureRow({ failure }: { failure: AgentFailureRow }) {
  const cause = agentFailureCauseSchema.parse(failure.cause);
  const when = failure.at ? failure.at.slice(0, 16).replace("T", " ") : "unknown time";
  // The numbers that make the suspected cause checkable rather than a bare assertion.
  const facts = [
    failure.kind === "timeout" && failure.timeoutMs ? `budget ${failure.timeoutMs}ms` : "",
    failure.latencyMs ? `took ${failure.latencyMs}ms` : "",
    failure.promptChars ? `prompt ${Math.round(failure.promptChars / 100) / 10}k chars` : "",
    failure.maxOutputTokens ? `cap ${failure.maxOutputTokens} tok` : "",
    failure.provider ? `via ${failure.provider}` : "",
    failure.modelId,
  ].filter(Boolean);

  return (
    <li className="rounded-card border border-paper-800 bg-paper-900/40 px-3 py-2">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="text-sm text-paper-200">{agentLegLabel(failure.legId)}</span>
        <span className="text-xs text-danger-300">{KIND_LABELS[failure.kind]}</span>
        <span className="text-xs text-paper-500">— probably: {causeLabel(cause)}</span>
        <span className="ml-auto text-[11px] text-paper-600">{when}</span>
      </div>
      <p className="mt-1 text-xs text-paper-400">{agentFailureExplanation(cause)}</p>
      {facts.length > 0 ? <p className="mt-1 text-[11px] text-paper-600">{facts.join(" · ")}</p> : null}
      {failure.detail ? (
        <p className="mt-1 truncate text-[11px] text-paper-600" title={failure.detail}>
          {failure.detail}
        </p>
      ) : null}
    </li>
  );
}
