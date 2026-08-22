"use client";

import Link from "next/link";
import { useState } from "react";
import { useAsyncData } from "@/components/hooks/use-async";
import { useIsAdmin } from "@/components/hooks/use-is-admin";
import { PageContainer } from "@/components/shell/app-shell";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/error-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Tag } from "@/components/ui/tag";
import {
  shadowApi,
  shadowVerdictLabels,
  shadowVerdicts,
  type ShadowReport,
  type ShadowRow,
  type ShadowVerdict,
} from "@/lib/api-shadow";

/**
 * The admin Engine Comparison screen (R4, engine.rollout.plan.md): the browser
 * face of the legacy-vs-successor comparison substrate, so reviewing and ruling
 * never needs a raw API call. The route and storage names retain `shadow` for
 * compatibility; that is now an internal implementation term, not the feature name.
 * `/admin/shadow` lists every chat with recorded rows; `/admin/shadow/[chatId]`
 * shows the computed report, prose pairs side by side, and per-row review controls.
 */
export function EngineComparisonIndexPage() {
  const isAdmin = useIsAdmin();
  if (!isAdmin) {
    return (
      <PageContainer>
        <p className="text-sm text-paper-500">Not found.</p>
      </PageContainer>
    );
  }
  return <IndexBody />;
}

function IndexBody() {
  const list = useAsyncData(() => shadowApi.chats(), []);
  return (
    <PageContainer>
      <div className="mb-6">
        <h1 className="prose-display text-2xl">Engine Comparison</h1>
        <p className="mt-1 text-sm text-paper-400">
          Legacy chat and the successor engine run against the same player turns. Review recorded rows to decide
          whether a difference needs work or is acceptable.
        </p>
      </div>
      {list.loading ? (
        <div className="flex flex-col gap-3" aria-hidden="true">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-16 w-full rounded-card" />
          ))}
        </div>
      ) : list.error ? (
        <ErrorState error={list.error} onRetry={() => list.reload()} />
      ) : (list.data?.chats.length ?? 0) === 0 ? (
        <p className="text-sm text-paper-500">
          No engine comparisons recorded yet. Put a mapped chat in comparison mode (<code>successor_shadow</code>)
          and play a few plain-send exchanges.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {list.data?.chats.map((chat) => (
            <li key={chat.chatId}>
              <Link
                href={`/admin/shadow/${chat.chatId}`}
                className="flex items-center justify-between gap-3 rounded-card border border-ink-600 bg-ink-850 px-4 py-3 transition-colors hover:border-accent-500/50"
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm text-paper-200">{chat.title || chat.chatId}</span>
                  <span className="block text-xs text-paper-500">
                    {chat.characterName}
                    {chat.lastAt ? ` · last ${new Date(chat.lastAt).toLocaleString()}` : ""}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-1.5">
                  <Tag tone={chat.open > 0 ? "danger" : "ok"}>{chat.open} unreviewed</Tag>
                  <Tag>{chat.total} rows</Tag>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </PageContainer>
  );
}

export function EngineComparisonChatPage({ chatId }: { chatId: string }) {
  const isAdmin = useIsAdmin();
  if (!isAdmin) {
    return (
      <PageContainer>
        <p className="text-sm text-paper-500">Not found.</p>
      </PageContainer>
    );
  }
  return <ChatBody chatId={chatId} />;
}

function ChatBody({ chatId }: { chatId: string }) {
  const report = useAsyncData(() => shadowApi.report(chatId), [chatId]);
  const rows = useAsyncData(() => shadowApi.rows(chatId), [chatId]);
  const reload = () => {
    report.reload({ silent: true });
    rows.reload({ silent: true });
  };
  return (
    <PageContainer>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="prose-display text-2xl">Engine Comparison</h1>
          <p className="mt-1 text-sm text-paper-400">
            Legacy chat and the successor engine, side by side — same player lines, two world models.
          </p>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <Link href={`/chat/${chatId}`} className="text-accent-300 hover:text-accent-200">
            Conversation
          </Link>
          <Link href="/admin/shadow" className="text-accent-300 hover:text-accent-200">
            ← All comparisons
          </Link>
        </div>
      </div>
      {report.loading || rows.loading ? (
        <div className="flex flex-col gap-3" aria-hidden="true">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-24 w-full rounded-card" />
          ))}
        </div>
      ) : report.error ? (
        <ErrorState error={report.error} onRetry={() => report.reload()} />
      ) : rows.error ? (
        <ErrorState error={rows.error} onRetry={() => rows.reload()} />
      ) : report.data && rows.data ? (
        <div className="flex flex-col gap-6 pb-10">
          <ReportSummary report={report.data.report} />
          <ReviewGuide />
          <ExchangeList chatId={chatId} rows={rows.data.rows} onRuled={reload} />
        </div>
      ) : null}
    </PageContainer>
  );
}

function ReportSummary({ report }: { report: ShadowReport }) {
  const unreviewed = report.totals.byVerdict.open ?? 0;
  return (
    <section className="rounded-card border border-ink-600 bg-ink-850 p-4">
      {report.findings.length === 0 ? (
        <p className="text-sm text-ok-400">
          No automatically detected unresolved findings. Rendered prose still requires human review.
        </p>
      ) : (
        <div>
          <p className="mb-1.5 text-sm text-danger-300">
            {report.findings.length} unresolved finding{report.findings.length === 1 ? "" : "s"}:
          </p>
          <ul className="list-disc pl-5 text-sm text-paper-300">
            {report.findings.map((finding) => (
              <li key={finding}>{finding}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="mt-3 flex flex-wrap gap-1.5 text-xs">
        <Tag>{report.totals.rows} rows</Tag>
        <Tag tone={unreviewed > 0 ? "danger" : "ok"}>{unreviewed} unreviewed</Tag>
        <Tag>{report.totals.byVerdict.intentional ?? 0} accepted</Tag>
        <Tag>{report.totals.byVerdict.fixed ?? 0} fixed &amp; verified</Tag>
        <Tag>
          clock: {report.clock.steps} steps, {report.clock.driftingSteps.length} drifting
          {report.clock.latestSuccessorClock ? ` · now ${report.clock.latestSuccessorClock}` : ""}
        </Tag>
        <Tag>
          meters: {report.meters.sharedKeys.length} shared, {report.meters.beyondTolerance.length} beyond tolerance
        </Tag>
        <Tag>presence: {report.presence.mismatches.length} mismatches</Tag>
        <Tag>
          prose: {report.prose.rendered}/{report.prose.pairs} rendered
        </Tag>
      </div>
    </section>
  );
}

function ReviewGuide() {
  return (
    <section className="rounded-card border border-ink-700 bg-ink-850/70 p-4 text-sm text-paper-300">
      <h2 className="mb-2 font-medium text-paper-100">How to record a ruling</h2>
      <p className="mb-2 text-paper-400">
        A row being unreviewed does not mean it is a bug. Review the two lanes first, then choose the status that
        describes the result.
      </p>
      <div className="grid gap-2 md:grid-cols-3">
        <div>
          <strong className="text-paper-200">Unreviewed</strong>
          <p className="text-paper-500">Leave it here while the result is undecided or a needed fix is still outstanding.</p>
        </div>
        <div>
          <strong className="text-paper-200">Accepted / no fix needed</strong>
          <p className="text-paper-500">Use when the row is clean or the difference is understood and intentionally acceptable.</p>
        </div>
        <div>
          <strong className="text-paper-200">Fixed &amp; verified</strong>
          <p className="text-paper-500">Use only after a real defect has been corrected and a follow-up comparison confirms it.</p>
        </div>
      </div>
    </section>
  );
}

/** Rows grouped per exchange (the four domains share a messageId), newest first. */
function ExchangeList({ chatId, rows, onRuled }: { chatId: string; rows: ShadowRow[]; onRuled: () => void }) {
  const groups = new Map<string, ShadowRow[]>();
  for (const row of rows) {
    const group = groups.get(row.messageId) ?? [];
    group.push(row);
    groups.set(row.messageId, group);
  }
  const domainOrder = ["prose", "presence", "meters", "clock"];
  return (
    <div className="flex flex-col gap-4">
      {[...groups.entries()].map(([messageId, group], index) => (
        <section key={messageId} className="rounded-card border border-ink-600 bg-ink-850 p-4">
          <p className="mb-3 text-xs tracking-wide text-paper-500 uppercase">
            Exchange {groups.size - index} · {group[0]?.createdAt ? new Date(group[0].createdAt).toLocaleString() : ""}
          </p>
          <div className="flex flex-col gap-3">
            {group
              .slice()
              .sort((a, b) => domainOrder.indexOf(a.domain) - domainOrder.indexOf(b.domain))
              .map((row) => (
                <ComparisonRow key={row.id} chatId={chatId} row={row} onRuled={onRuled} />
              ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function ComparisonRow({ chatId, row, onRuled }: { chatId: string; row: ShadowRow; onRuled: () => void }) {
  const [busy, setBusy] = useState<ShadowVerdict | null>(null);
  const rule = async (verdict: ShadowVerdict) => {
    if (busy) return;
    setBusy(verdict);
    try {
      await shadowApi.verdict(chatId, row.id, verdict);
      onRuled();
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="rounded-md border border-ink-700 bg-ink-900/60 p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-1.5">
          <Tag tone={row.verdict === "open" && row.detail ? "danger" : "default"}>{row.domain}</Tag>
          {row.detail ? <span className="text-xs text-paper-400">{row.detail}</span> : null}
        </span>
        <span className="flex items-center gap-1" role="group" aria-label="Review status">
          {shadowVerdicts.map((verdict) => (
            <Button
              key={verdict}
              size="sm"
              variant={row.verdict === verdict ? "primary" : "quiet"}
              busy={busy === verdict}
              disabled={busy !== null || row.verdict === verdict}
              onClick={() => void rule(verdict)}
            >
              {shadowVerdictLabels[verdict]}
            </Button>
          ))}
        </span>
      </div>
      <RowPayload row={row} />
    </div>
  );
}

function RowPayload({ row }: { row: ShadowRow }) {
  if (row.domain === "prose") {
    const legacy = pick(row.legacy, "prose");
    const successorProse = pick(row.successor, "prose");
    const status = pick(row.successor, "status");
    return (
      <div className="grid gap-3 md:grid-cols-2">
        <ProseColumn label="Legacy reply" text={legacy} />
        <ProseColumn
          label={`Successor render${status && status !== "rendered" ? ` (${status})` : ""}`}
          text={successorProse}
        />
      </div>
    );
  }
  // The structured domains stay honest raw JSON — small payloads, and the
  // report card above already carries the derived comparison.
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <JsonColumn label="Legacy" value={row.legacy} />
      <JsonColumn label="Successor" value={row.successor} />
    </div>
  );
}

function ProseColumn({ label, text }: { label: string; text: string }) {
  return (
    <div>
      <p className="mb-1 text-xs tracking-wide text-paper-500 uppercase">{label}</p>
      <p className="text-sm whitespace-pre-wrap text-paper-200">{text || "—"}</p>
    </div>
  );
}

function JsonColumn({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="min-w-0">
      <p className="mb-1 text-xs tracking-wide text-paper-500 uppercase">{label}</p>
      <pre className="overflow-x-auto rounded-md bg-ink-900 p-2 text-xs text-paper-300">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

/** Read one string field off an unknown payload without trusting its shape. */
function pick(value: unknown, key: string): string {
  if (typeof value !== "object" || value === null) return "";
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : "";
}
