"use client";

import { useMemo, useState } from "react";
import {
  compositionFallbackCodeLabel,
  compositionFallbackSiteLabel,
} from "@/contracts/turns/composition-fallback";
import { useAsyncData } from "@/components/hooks/use-async";
import { ErrorState } from "@/components/ui/error-state";
import { Skeleton } from "@/components/ui/skeleton";
import { chatInspectorApi, type CompositionFallbackRow } from "@/lib/api-inspector";

/**
 * Composed-turn health (contracts/turns/composition-fallback.ts — C15): the choreography
 * behind travel / walk-with-me / skips degrades silently by design (a plain solo render, a
 * "traveled alone"). This panel makes that visible — what fell back, where, and how often —
 * so a systemic degradation isn't mistaken for ordinary play. Admin-only (ruling 2).
 *
 * Two scopes, because a degrading leg is usually systemic: this chat, and every chat in the
 * window. The per-row `detail` is the private cause — shown here because this surface is
 * admin-only; it never rides player-visible message meta.
 */
export function ChatInspectorCompositionHealth({ chatId }: { chatId: string }) {
  const health = useAsyncData(() => chatInspectorApi.compositionFallbacks(chatId), [chatId]);
  const data = health.data;

  const [query, setQuery] = useState("");
  const filtered = useMemo<CompositionFallbackRow[]>(() => {
    if (!data) return [];
    const q = query.trim().toLowerCase();
    if (!q) return data.chat.recent;
    return data.chat.recent.filter((row) =>
      `${compositionFallbackSiteLabel(row.site)} ${compositionFallbackCodeLabel(row.code)} ${row.detail}`
        .toLowerCase()
        .includes(q),
    );
  }, [data, query]);

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-medium tracking-wide text-paper-400 uppercase">Composed-turn health</h2>
        <span className="text-[11px] text-paper-600">travel · walk-with-me · skips · last {data?.days ?? 7} days</span>
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
                <span className="text-ok-400">No composed degradations in this conversation.</span> Every travel,
                walk-with-me, and skip composed cleanly.
              </>
            ) : (
              <>
                <span className="text-danger-300">
                  {data.chat.total} degradation{data.chat.total === 1 ? "" : "s"}
                </span>{" "}
                in this conversation. A degradation doesn&apos;t break the turn — it silently ships a lesser one (a
                solo render, a &ldquo;traveled alone&rdquo;, a short skip).
              </>
            )}
            {data.global.total > data.chat.total ? (
              <>
                {" "}
                <span className="text-paper-500">({data.global.total} across all conversations — totals below.)</span>
              </>
            ) : null}
          </p>

          {data.global.total > 0 ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <TallyList title="By kind (all conversations)" rows={data.global.byCode} label={compositionFallbackCodeLabel} />
              <TallyList title="By flow (all conversations)" rows={data.global.bySite} label={compositionFallbackSiteLabel} />
            </div>
          ) : null}

          {data.chat.recent.length > 0 ? (
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="text-xs font-medium tracking-wide text-paper-500 uppercase">In this conversation</h3>
                <span className="text-[11px] tabular-nums text-paper-600">
                  {filtered.length === data.chat.recent.length
                    ? data.chat.recent.length
                    : `${filtered.length} of ${data.chat.recent.length}`}
                </span>
              </div>
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search flow, kind, detail…"
                aria-label="Search composed-turn degradations"
                className="rounded-md border border-paper-800 bg-paper-900/60 px-2 py-1 text-xs text-paper-200 focus:border-accent-500 focus:outline-none"
              />
              {filtered.length > 0 ? (
                <div className="max-h-72 overflow-y-auto rounded-card border border-paper-800/60 bg-paper-950/40 p-1">
                  <ul className="flex flex-col gap-2">
                    {filtered.map((row, i) => (
                      <FallbackRow key={`${row.at}-${row.code}-${i}`} row={row} />
                    ))}
                  </ul>
                </div>
              ) : (
                <p className="text-xs text-paper-500">No degradations match this filter.</p>
              )}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function FallbackRow({ row }: { row: CompositionFallbackRow }) {
  const when = row.at ? row.at.slice(0, 16).replace("T", " ") : "unknown time";
  return (
    <li className="rounded-card border border-paper-800 bg-paper-900/40 px-3 py-2">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="text-sm text-paper-200">{compositionFallbackSiteLabel(row.site)}</span>
        <span className="text-xs text-danger-300">{compositionFallbackCodeLabel(row.code)}</span>
        <span className="ml-auto text-[11px] text-paper-600">{when}</span>
      </div>
      {row.detail ? (
        <p className="mt-1 truncate text-[11px] text-paper-600" title={row.detail}>
          {row.detail}
        </p>
      ) : null}
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
