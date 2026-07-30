"use client";

import { useAsyncData } from "@/components/hooks/use-async";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/error-state";
import { Skeleton } from "@/components/ui/skeleton";
import {
  chatInspectorApi,
  type PhysicalGuidanceCandidate,
  type PhysicalGuidancePreview,
} from "@/lib/api-inspector";

/**
 * The READ-ONLY narrator physical-guidance preview
 * (narrator-physical-guidance.plan.md slice 2).
 *
 * It shows the staircase a developer reads in code, in order —
 *
 * ```text
 * input authority → committed state → relevance → candidates
 *   → disclosure + selection → rendered instruction
 * ```
 *
 * — for the stored cut and the newest player line. Like the affordance panel above it,
 * it answers ONE question well: why did this turn say nothing? Silence has six
 * different causes here and they are indistinguishable from the prompt — the flag is
 * off, the message was never eligible, the committed owner could not answer, the claim
 * was ambiguous, the fence was true but irrelevant to this turn, or a candidate lost a
 * budget — so every stage shows its own input.
 *
 * Computes on demand and stores nothing. Admin-gated like every other section on this
 * page; the route proves ownership independently.
 */
export function ChatInspectorPhysicalGuidance({ chatId }: { chatId: string }) {
  const preview = useAsyncData(() => chatInspectorApi.physicalGuidance(chatId), [chatId]);
  const data = preview.data;

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-medium tracking-wide text-paper-400 uppercase">
          Physical consistency — constraints and premise checks
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

function PreviewBody({ data }: { data: PhysicalGuidancePreview }) {
  return (
    <>
      <p className="text-xs text-paper-500">
        Guidance block{" "}
        <span className={data.flagEnabled ? "text-ok-400" : "text-paper-400"}>
          {data.flagEnabled ? "reaching the narrator" : "off (CHAT_PHYSICAL_CONSTRAINTS)"}
        </span>{" "}
        · computed on demand, nothing stored
      </p>

      <Panel label={`Rendered instruction (${data.rendered.length})`} defaultOpen>
        {data.rendered.length === 0 ? (
          <p className="text-xs text-paper-500">
            Nothing to say this turn — silence is the common result. The stages below say which one
            produced it.
          </p>
        ) : (
          <ul className="flex flex-col gap-1 text-xs text-paper-200">
            {data.rendered.map((line, index) => (
              <li key={`${index}-${line.slice(0, 24)}`} className="break-words">
                {line}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel label="1 · input authority — who may assert a premise">
        {data.inputAuthority.narratorInput ? (
          <p className="text-xs text-paper-500">
            Storyteller narration: excluded from premise checking entirely, before any span is read.
            Constraints still apply.
          </p>
        ) : null}
        <p className="mt-2 font-mono text-[11px] break-words text-paper-400">
          {data.inputAuthority.message || "— no player line in this conversation yet"}
        </p>
        <p className="mt-2 text-[11px] text-paper-500">
          {data.inputAuthority.eligibleSpans} of {data.inputAuthority.spans.length} spans eligible
        </p>
        {data.inputAuthority.spans.length > 0 ? (
          <ul className="mt-1 flex flex-col gap-1 font-mono text-[11px]">
            {data.inputAuthority.spans.map((span, index) => (
              <li key={`${span.kind}-${index}`} className="break-words">
                <span className={span.eligible ? "text-ok-400" : "text-paper-500"}>{span.kind}</span>{" "}
                <span className="text-paper-300">{span.text}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </Panel>

      <Panel label="2 · committed state — what every verdict is measured against">
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-[11px]">
          <Row term="wetness band" value={data.committed.wetnessBand} />
          <Row term="wetness cause" value={data.committed.wetnessCause} />
          <Row term="arrangement" value={data.committed.arrangement} />
          <Row term="covered fraction" value={data.committed.coveredFraction} />
          {data.committed.available.map((row) => (
            <Row
              key={row.owner}
              term={`${row.owner} owner`}
              value={row.available ? "available" : "unavailable"}
              muted={!row.available}
            />
          ))}
        </dl>
        <p className="mt-2 text-[11px] text-paper-500">
          An unavailable owner licenses an unsupported-claim fence and never a substituted value. A
          value of &ldquo;—&rdquo; with the owner available is narrower: it answered, and the answer maps to
          no claim.
        </p>
      </Panel>

      <Panel
        label={`3 · relevance — ${data.relevance.relevant ? data.relevance.signals.join(", ") : "nothing makes a fence relevant this turn"}`}
      >
        <p className="text-[11px] text-paper-500">
          A braid is true all day. Constraints are compiled only when the turn is about them —
          the message reaches for this body part, a premise was corrected, a live force is acting
          on it, or the beat is aimed at it. No signal means no candidates and no prompt bytes.
        </p>
        {data.relevance.constraints.length > 0 ? (
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-[11px]">
            {data.relevance.constraints.map((row, index) => (
              <Row
                key={`${row.code}-${index}`}
                term={row.code}
                value={row.admitted ? `admitted · ${row.reason}` : row.reason}
                muted={!row.admitted}
              />
            ))}
          </dl>
        ) : (
          <p className="mt-2 text-[11px] text-paper-500">This cut resolved no constraints at all.</p>
        )}
      </Panel>

      <Panel
        label={`4 · candidates — ${data.candidates.corrections.length} correction(s), ${data.candidates.constraints.length} constraint(s)`}
      >
        <Stage label="premise corrections">
          <CandidateList rows={data.candidates.corrections} empty="No premise claim survived the guards." />
        </Stage>
        <Stage label="consistency constraints">
          <CandidateList rows={data.candidates.constraints} empty="Nothing is holding this hair still." />
        </Stage>
        {data.candidates.diagnostics.length > 0 ? (
          <Stage label="diagnostics">
            <ul className="flex flex-col gap-1 font-mono text-[11px] text-paper-400">
              {data.candidates.diagnostics.map((entry, index) => (
                <li key={`${entry.code}-${index}`} className="break-words">
                  [{entry.level}] {entry.code} — {entry.message}
                </li>
              ))}
            </ul>
          </Stage>
        ) : null}
      </Panel>

      <Panel label="5 · disclosure + selection — what survived the gate and the budget">
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-[11px]">
          <Row term="corrections kept" value={data.selection.corrections.join(", ") || "—"} />
          <Row term="constraints kept" value={data.selection.constraints.join(", ") || "—"} />
          <Row term="dropped" value={data.selection.dropped.join(", ") || "none"} muted={data.selection.dropped.length > 0} />
        </dl>
        <p className="mt-2 text-[11px] text-paper-500">
          The gate runs before the ranking, so salience can never unlock a resolver-only fact.
        </p>
      </Panel>
    </>
  );
}

function CandidateList({ rows, empty }: { rows: readonly PhysicalGuidanceCandidate[]; empty: string }) {
  if (rows.length === 0) return <p className="text-xs text-paper-500">{empty}</p>;
  return (
    <ul className="flex flex-col gap-2 font-mono text-[11px]">
      {rows.map((row) => (
        <li key={row.fingerprint} className="break-words">
          <span className="text-paper-300">{row.id}</span>{" "}
          <span className="text-paper-400">· {row.grade}</span>{" "}
          <span className="text-paper-500">· {row.disclosure}</span>
          <br />
          <span className="text-paper-500">forbids</span>{" "}
          <span className="text-danger-300">{row.prohibitedClaimCodes.join(", ") || "—"}</span>
          <br />
          <span className="text-paper-500">may state</span>{" "}
          <span className="text-ok-400">{row.allowedClaimCodes.join(", ") || "— (nothing; the cause stays out)"}</span>
          {row.locusIds.length > 0 ? <span className="text-paper-600"> @ {row.locusIds.join(", ")}</span> : null}
          {row.evidence.length > 0 ? (
            <>
              <br />
              <span className="text-paper-600">{row.evidence.join(" · ")}</span>
            </>
          ) : null}
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

function Stage({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mt-3 first:mt-0">
      <p className="mb-1 text-[11px] tracking-wide text-paper-500 uppercase">{label}</p>
      {children}
    </div>
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
