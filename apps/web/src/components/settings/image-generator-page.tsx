"use client";

import { useState } from "react";
import { imageGeneratorApi, meApi } from "@/lib/client/api";
import { useAsyncData } from "@/components/hooks/use-async";
import { usePollWhile } from "@/components/hooks/use-poll-while";
import { PageContainer } from "@/components/shell/app-shell";
import { Skeleton } from "@/components/ui/skeleton";
import { ImageGeneratorForm, type ImageGeneratorPrefill } from "./image-generator-form";
import { ImageGeneratorRunDetail } from "./image-generator-run-detail";
import { ImageGeneratorRunList } from "./image-generator-run-list";

/**
 * The Image Generator's admin page
 * (image-lab-general-model-trials.spec.md §Code organization): the raw
 * prompt/model bench beside the Advanced Image Lab — form above, run history
 * below, one run's detail when selected.
 *
 * The `/api/admin/self/image-generator` family is the real gate (it 404s for
 * everyone else), so the check here is only so a non-admin gets an explanation
 * instead of a page of failed requests — the lab page's precedent.
 *
 * An accepted create OPENS the new run rather than arming a queued tile: a
 * generator run is a single request the admin just authored, and its detail —
 * which polls itself while pending — is where the answer lands. The form
 * remounts blank behind it (the key idiom), so a submitted request is never
 * one stray click from being paid for twice.
 *
 * The list poll runs only while some run is pending or running, bounded so a
 * run stranded by a dead job cannot poll until the tab closes; opening any
 * live run's detail re-arms its own poll regardless.
 *
 * `initialRunId` (the `?run=` param, read by the server page) opens that run's
 * detail on mount.
 */

const POLL_MS = 3000;
/** ~5 minutes of silence before the list poll gives up; re-armed by any new activity. */
const MAX_LIST_POLLS = 100;

export function ImageGeneratorPage({ initialRunId }: { initialRunId?: string }) {
  const me = useAsyncData(() => meApi.get(), []);
  const runs = useAsyncData(() => imageGeneratorApi.runs.list(), []);

  const [selectedRunId, setSelectedRunId] = useState<string | null>(initialRunId ?? null);
  // Bumped by every accepted create so the form remounts blank.
  const [formGeneration, setFormGeneration] = useState(0);
  // A duplicate pre-fill, versioned so each request mounts a FRESH form seeded
  // from it (the lab's idiom): the form owns its state after mount, so a
  // reused instance would ignore a second pre-fill.
  const [prefill, setPrefill] = useState<{ id: number; values: ImageGeneratorPrefill } | null>(null);

  // The single door for changing which run is open: state and URL move
  // together, so a refresh or a pasted link lands back on the same record.
  // `replaceState`, never `pushState` (the lab page's reasoning): nothing here
  // listens for popstate, so a pushed entry would let Back rewind the address
  // bar while the view stayed where it was.
  const selectRun = (runId: string | null) => {
    setSelectedRunId(runId);
    const url = new URL(window.location.href);
    if (runId === null) url.searchParams.delete("run");
    else url.searchParams.set("run", runId);
    window.history.replaceState(null, "", url);
  };

  const runRows = runs.data ?? [];
  const anyLive = runRows.some((run) => run.status === "pending" || run.status === "running");
  usePollWhile(anyLive, () => runs.reload({ silent: true }), POLL_MS, { maxPolls: MAX_LIST_POLLS });

  const isAdmin = me.data?.role === "admin";

  if (me.loading && !me.data) {
    return (
      <PageContainer>
        <Skeleton className="h-8 w-56" />
      </PageContainer>
    );
  }

  if (!isAdmin) {
    return (
      <PageContainer>
        <h1 className="prose-display text-2xl">Image generator</h1>
        <p className="mt-2 text-sm text-paper-400">This page is only available to administrators.</p>
      </PageContainer>
    );
  }

  if (selectedRunId !== null) {
    return (
      <PageContainer>
        {/* Keyed by the run so a different record mounts a fresh detail — its
            polling and lightbox state belong to one run at a time. */}
        <ImageGeneratorRunDetail
          key={selectedRunId}
          runId={selectedRunId}
          onBack={() => {
            selectRun(null);
            runs.reload({ silent: true });
          }}
          onDeleted={() => {
            selectRun(null);
            runs.reload({ silent: true });
          }}
          onDuplicate={(values) => {
            setPrefill((previous) => ({ id: (previous?.id ?? 0) + 1, values }));
            selectRun(null);
            runs.reload({ silent: true });
          }}
          // Variant lineage: the original opens through the same one door as
          // every other selection, so the address bar keeps up.
          onOpenRun={selectRun}
        />
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      <header className="mb-6">
        <h1 className="prose-display text-2xl">Image generator</h1>
        <p className="mt-1 text-sm text-paper-400">
          The raw prompt/model bench: run any registered image model with exactly the prompt, references, and
          controls you choose, and keep the full request on record. Nothing here is an Image Lab experiment, and
          every run is charged against the daily render budget.
        </p>
      </header>

      <div className="flex flex-col gap-6">
        <ImageGeneratorForm
          key={`${String(prefill?.id ?? 0)}-${String(formGeneration)}`}
          prefill={prefill?.values ?? null}
          onCreated={(runId) => {
            // Everything the form was holding is spent the moment the request
            // is accepted — the pre-fill included. The new run's detail is
            // where the render lands, so open it; its own poll takes over.
            setPrefill(null);
            setFormGeneration((generation) => generation + 1);
            runs.reload({ silent: true });
            selectRun(runId);
          }}
        />

        <ImageGeneratorRunList
          runs={runRows}
          loading={runs.loading}
          error={runs.error}
          onReload={() => runs.reload()}
          onSelect={selectRun}
        />
      </div>
    </PageContainer>
  );
}
