"use client";

import { useEffect } from "react";
import type { CharacterMediaResult, CharacterMediaRetryTarget } from "@/contracts";
import { useAsyncData } from "@/components/hooks/use-async";
import { Button } from "@/components/ui/button";
import { Tag } from "@/components/ui/tag";
import { characterMediaJobsApi } from "@/lib/client/api";
import { characterMediaStatusView } from "./character-media-status-view";

export interface CharacterMediaStatusProps {
  characterId: string;
  /** Navigate to the owning controls. It must not start paid work by itself. */
  onRetry?: (target: CharacterMediaRetryTarget) => void;
}

/** One persistent status surface for portrait, variant, identity and reference work. */
export function CharacterMediaStatus({ characterId, onRetry }: CharacterMediaStatusProps) {
  const state = useAsyncData(() => characterMediaJobsApi.list(characterId), [characterId]);
  const jobs = state.data?.jobs ?? [];
  const active = jobs.some((job) => job.lifecycle === "queued" || job.lifecycle === "running");

  useEffect(() => {
    // The quiet interval discovers work started by a nested tab without coupling
    // that tab to this status owner. Active work tightens the interval.
    const timer = window.setInterval(() => state.reload({ silent: true }), active ? 2_500 : 15_000);
    return () => window.clearInterval(timer);
  }, [active, state.reload]);

  if (state.loading && jobs.length === 0) return null;
  if (jobs.length === 0 && !state.error) return null;

  return (
    <section
      aria-label="Character media status"
      className="mb-4 flex flex-col gap-2 rounded-card border border-ink-600 bg-ink-850 p-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-xs font-medium tracking-wide text-paper-400 uppercase">Media activity</h2>
        {active ? <Tag tone="accent">Working</Tag> : null}
        {state.error ? (
          <div className="ml-auto flex items-center gap-2 text-xs text-warning">
            <span>{jobs.length > 0 ? "Showing the last update." : "Media status could not refresh."}</span>
            <Button size="sm" variant="quiet" onClick={() => state.reload()}>
              Retry status
            </Button>
          </div>
        ) : null}
      </div>
      <div className="flex flex-col gap-2" aria-live="polite">
        {jobs.map((job) => {
          const view = characterMediaStatusView(job);
          return (
            <article
              key={job.id}
              className="flex flex-wrap items-start gap-3 border-t border-ink-700 pt-2 first:border-0 first:pt-0"
            >
              <div className="min-w-0 flex-1">
                <p
                  className={
                    view.tone === "danger"
                      ? "text-sm text-danger-300"
                      : view.tone === "ok"
                        ? "text-sm text-ok-400"
                        : "text-sm text-paper-200"
                  }
                >
                  {view.title}
                </p>
                <p className="text-xs text-paper-500">{view.detail}</p>
                {job.targets.length > 0 ? (
                  <p className="mt-0.5 text-[11px] text-paper-500">Targets: {job.targets.join(", ")}</p>
                ) : null}
                {job.results.length > 0 ? (
                  <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
                    {job.results.map((result) => (
                      <ResultLink key={`${result.kind}:${result.id}`} result={result} />
                    ))}
                  </div>
                ) : null}
              </div>
              {view.retryLabel && onRetry ? (
                <Button size="sm" onClick={() => onRetry(job.retry)}>
                  {view.retryLabel}
                </Button>
              ) : view.retryLabel ? (
                <span className="text-xs text-paper-500">{view.retryLabel}</span>
              ) : null}
            </article>
          );
        })}
      </div>
    </section>
  );
}

function ResultLink({ result }: { result: CharacterMediaResult }) {
  const label = result.kind === "image"
    ? "Open image"
    : result.kind === "identity_pack"
      ? `Identity ${result.id}`
      : `Attempt ${result.id}`;
  const imageId = result.imageId ?? (result.kind === "image" ? result.id : null);
  return imageId
    ? (
      <a
        className="text-accent-300 hover:text-accent-200"
        href={`/api/images/${imageId}/file`}
        target="_blank"
        rel="noreferrer"
      >
        {label}
      </a>
    )
    : <span className="text-paper-500">{label}</span>;
}
