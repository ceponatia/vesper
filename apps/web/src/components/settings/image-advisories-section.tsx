"use client";

import { imageAdvisoriesApi } from "@/lib/client/api/images";
import { renderAdvisoryCodeCopy } from "@/components/images/advisory-copy";
import { renderAdvisoryCodes, type RenderAdvisoryCode } from "@vesper/image-core";
import { useAsyncData } from "@/components/hooks/use-async";
import { ErrorState } from "@/components/ui/error-state";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * The comparison record issue #249 asks for: per advisory code, how many of
 * the owner's renders were annotated, how many the owner agreed or disagreed
 * with, and how many are still unreviewed, plus the most recently reviewed
 * rows. This table is the evidence an owner reads to write a verdict for each
 * signal (annotate / reject / propose a narrow promotion check) — the page
 * itself renders no verdict and no threshold; it only shows the counts.
 */
export function ImageAdvisoriesSection() {
  const summary = useAsyncData(() => imageAdvisoriesApi.summary(), []);

  if (summary.error && !summary.data) {
    return <ErrorState error={summary.error} onRetry={() => summary.reload()} />;
  }
  if (!summary.data) {
    return <Skeleton className="h-48 w-full" />;
  }

  const { codes, reviewed } = summary.data;

  return (
    <div className="flex flex-col gap-6">
      <section>
        <h2 className="mb-2 text-xs font-medium tracking-wide text-paper-400 uppercase">Signals</h2>
        <div className="flex flex-col gap-2">
          {codes.map((row) => {
            // A future/degraded row could carry a code this deployment does
            // not recognize yet; fall back to the raw string rather than an
            // unsafe cast into the exhaustive-copy switch.
            const known = (renderAdvisoryCodes as readonly string[]).includes(row.code);
            return (
              <div key={row.code} className="rounded-card border border-ink-600 bg-ink-850 p-3 text-sm">
                <p className="text-paper-200">
                  {known ? renderAdvisoryCodeCopy(row.code as RenderAdvisoryCode) : row.code}
                </p>
                <p className="mt-1 text-xs text-paper-500">
                  {row.annotated} annotated · {row.agreed} agreed · {row.disagreed} disagreed · {row.unreviewed}{" "}
                  unreviewed
                </p>
              </div>
            );
          })}
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-xs font-medium tracking-wide text-paper-400 uppercase">Recently reviewed</h2>
        {reviewed.length === 0 ? (
          <p className="text-sm text-paper-500">No reviews recorded yet.</p>
        ) : (
          <div className="flex flex-col gap-2">
            {reviewed.map((row, index) => (
              <div
                key={`${row.imageId}:${row.code}:${String(index)}`}
                className="rounded-card border border-ink-600 bg-ink-850 p-3 text-xs text-paper-400"
              >
                <p>
                  <span className="text-paper-200">{row.verdict === "agree" ? "Agreed" : "Disagreed"}</span> ·{" "}
                  {row.code} · <code className="text-paper-500">{row.imageId}</code>
                </p>
                {row.note ? <p className="mt-1 text-paper-500">{row.note}</p> : null}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
