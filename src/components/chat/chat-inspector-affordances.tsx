"use client";

import { useAsyncData } from "@/components/hooks/use-async";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/error-state";
import { Skeleton } from "@/components/ui/skeleton";
import {
  chatInspectorApi,
  type AffordancePreview,
  type AffordancePreviewDomain,
  type AffordancePreviewResolution,
} from "@/lib/api-inspector";

/**
 * The READ-ONLY affordance preview (body-attribute-affordances.spec.architecture.md
 * §Resolved, "Developer preview"), built after the garment domain proved the
 * architecture twice.
 *
 * It shows the staircase a developer reads in code, in order —
 *
 * ```text
 * source inputs → structural profile → mechanics
 *   → observations or suppression reason → perception filtering → selected cue
 * ```
 *
 * — for every domain this lane can feed. It answers ONE question well: why did
 * this cut say nothing? So the suppression reasons are first-class here rather
 * than hidden behind a toggle, and each is shown with the stage that produced it.
 *
 * Computes on demand and stores nothing. Admin-gated like every other section on
 * this page; the route proves ownership independently.
 */
export function ChatInspectorAffordances({ chatId }: { chatId: string }) {
  const preview = useAsyncData(() => chatInspectorApi.affordances(chatId), [chatId]);
  const data = preview.data;

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-medium tracking-wide text-paper-400 uppercase">
          Affordances — the staged read
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

function PreviewBody({ data }: { data: AffordancePreview }) {
  return (
    <>
      <p className="text-xs text-paper-500">
        Story minute {data.storyTime} · cue block{" "}
        <span className={data.cueFlagEnabled ? "text-ok-400" : "text-paper-400"}>
          {data.cueFlagEnabled ? "reaching the narrator" : "off (CHAT_AFFORDANCE_CUES)"}
        </span>{" "}
        · computed on demand, nothing stored
      </p>

      <Panel label={`Selected cues (${data.cues.length})`} defaultOpen>
        {data.cues.length === 0 ? (
          <p className="text-xs text-paper-500">
            No cue this cut — silence is the common result. The suppression reasons below say why.
          </p>
        ) : (
          <ul className="flex flex-col gap-1 text-xs text-paper-200">
            {data.cues.map((cue, index) => (
              <li key={`${cue.phenomenonId}-${index}`}>
                <span className="text-paper-500">
                  {cue.phenomenonId} · {cue.band}
                </span>
                <br />
                {cue.line}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {data.domains.map((domain) => (
        <DomainPanel key={domain.domainId} domain={domain} />
      ))}

      <Panel label="Perception filter">
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-[11px]">
          {data.perception.exposure.map((row) => (
            <Row key={row.locationId} term={row.locationId} value={row.exposure} />
          ))}
          {data.perception.channels.map((row) => (
            <Row key={row.channel} term={row.channel} value={row.available ? "available" : "unavailable"} />
          ))}
        </dl>
        {data.perception.exposure.length === 0 ? (
          <p className="mt-2 text-xs text-paper-500">No location produced a read to filter.</p>
        ) : null}
      </Panel>

      <Panel label={`Perception-safe observations (${data.observations.length}) · suppressed (${data.suppressed.length})`}>
        <ResolutionList rows={data.observations} empty="Nothing survived to the narrator." />
        <div className="mt-3 border-t border-ink-600 pt-3">
          <ResolutionList rows={data.suppressed} empty="Nothing was suppressed." />
        </div>
      </Panel>

      <Panel label="Captured effective coverage">
        {data.coverage === null ? (
          <p className="text-xs text-paper-500">
            No capture — this actor&apos;s wardrobe is unmodelled, which is unknown coverage, not bare skin.
          </p>
        ) : (
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-[11px]">
            {data.coverage.entries.map((entry) => (
              <Row
                key={entry.locationId}
                term={entry.locationId}
                value={`${entry.band} — ${entry.evidence.map((row) => `${row.garmentId}@${row.effectiveOpacity}`).join(", ")}`}
              />
            ))}
          </dl>
        )}
      </Panel>
    </>
  );
}

function DomainPanel({ domain }: { domain: AffordancePreviewDomain }) {
  return (
    <Panel label={`${domain.domainId} — inputs → profile → mechanics → phenomena`}>
      <Stage label="1 · source inputs">
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-[11px]">
          {domain.inputs.map((row) => (
            <Row key={row.key} term={row.key} value={row.status} muted={row.status !== "supported"} />
          ))}
        </dl>
        {domain.inputs.length === 0 ? (
          <p className="text-xs text-paper-500">The whole payload was unavailable or invalid.</p>
        ) : null}
      </Stage>

      <Stage label="2 · structural profile">
        {domain.profile === null ? (
          <p className="text-xs text-paper-500">
            No profile compiled — the domain is suppressed. An unauthored subject has no read yet.
          </p>
        ) : (
          <ValueList rows={domain.profile} />
        )}
      </Stage>

      <Stage label="3 · effective mechanics">
        <ValueList rows={domain.mechanics} />
      </Stage>

      <Stage label="4 · phenomena">
        <ResolutionList rows={domain.resolutions} empty="No phenomenon ran." />
      </Stage>

      {domain.diagnostics.length > 0 ? (
        <Stage label="diagnostics">
          <ul className="flex flex-col gap-1 font-mono text-[11px] text-danger-300">
            {domain.diagnostics.map((entry, index) => (
              <li key={`${entry.code}-${index}`}>
                [{entry.level}] {entry.code} — {entry.message}
              </li>
            ))}
          </ul>
        </Stage>
      ) : null}

      {domain.evidence.length > 0 ? (
        <Stage label="evidence">
          <p className="font-mono text-[11px] break-words text-paper-500">{domain.evidence.join(" · ")}</p>
        </Stage>
      ) : null}
    </Panel>
  );
}

function ValueList({ rows }: { rows: readonly { path: string; value: string }[] }) {
  if (rows.length === 0) return <p className="text-xs text-paper-500">—</p>;
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-[11px]">
      {rows.map((row) => (
        <Row key={row.path} term={row.path} value={row.value} />
      ))}
    </dl>
  );
}

function ResolutionList({ rows, empty }: { rows: readonly AffordancePreviewResolution[]; empty: string }) {
  if (rows.length === 0) return <p className="text-xs text-paper-500">{empty}</p>;
  return (
    <ul className="flex flex-col gap-1 font-mono text-[11px]">
      {rows.map((row, index) => (
        <li key={`${row.phenomenonId}-${row.code}-${index}`} className="break-words">
          <span className={row.kind === "observation" ? "text-ok-400" : "text-paper-500"}>{row.kind}</span>{" "}
          <span className="text-paper-300">{row.phenomenonId}</span>
          {row.band ? <span className="text-paper-400"> · {row.band}</span> : null}
          {row.locationId ? <span className="text-paper-400"> @ {row.locationId}</span> : null}
          {row.code ? <span className="text-paper-400"> · {row.code}</span> : null}
          {row.detail ? <span className="text-paper-600"> ({row.detail})</span> : null}
          {row.tags.length > 0 ? <span className="text-paper-600"> — {row.tags.join(", ")}</span> : null}
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
