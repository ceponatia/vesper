"use client";

import { useState } from "react";
import { imageLabApi, meApi } from "@/lib/client/api";
import { useAsyncData } from "@/components/hooks/use-async";
import { usePollWhile } from "@/components/hooks/use-poll-while";
import { PageContainer } from "@/components/shell/app-shell";
import { Skeleton } from "@/components/ui/skeleton";
import { ImageLabExperimentDetail } from "./image-lab-experiment-detail";
import { ImageLabExperimentForm, type ImageLabExperimentPrefill } from "./image-lab-experiment-form";
import { ImageLabExperimentList } from "./image-lab-experiment-list";
import { ImageLabFixturesPanel } from "./image-lab-fixtures-panel";

/**
 * The Advanced Image Lab's admin page
 * (qwen-advanced-image-subsystem.spec.md §Code organization): control fixtures
 * above, experiments below, and one question it exists to settle — does this
 * model actually honour a pose skeleton?
 *
 * The `/api/admin/self/image-lab` family is the real gate (it 404s for everyone
 * else), so the check here is only so a non-admin gets an explanation instead of
 * a page of failed requests — the identity-trials precedent.
 *
 * Both waits are owned HERE rather than in the panels that start them, because
 * both are answered by the same two fetches this component holds. A queued
 * extraction ends when the fixture list has grown by what it promised; a queued
 * experiment ends when its row appears and settles. Neither is a timer someone
 * remembered to cancel.
 *
 * `initialExperimentId` (the `?experiment=` param, read by the server page) opens
 * that record's detail on mount.
 */

const POLL_MS = 3000;

/**
 * How long the fixtures wait tolerates silence — ~2 minutes at the cadence
 * above. An extraction whose preprocessor output failed to decode writes no
 * asset at all, so "the fixture count grew" can never arrive; without a cap that
 * wait would poll until the tab closed.
 */
const MAX_EXTRACT_POLLS = 40;

export function ImageLabPage({ initialExperimentId }: { initialExperimentId?: string }) {
  const me = useAsyncData(() => meApi.get(), []);
  const controls = useAsyncData(() => imageLabApi.controls.list(), []);
  const experiments = useAsyncData(() => imageLabApi.experiments.list(), []);

  const [selectedExperimentId, setSelectedExperimentId] = useState<string | null>(initialExperimentId ?? null);
  const [queuedExperimentId, setQueuedExperimentId] = useState<string | null>(null);
  // A paired-baseline pre-fill, versioned so each request mounts a FRESH form
  // seeded from it (the detail's own key idiom): the form owns its state after
  // mount, so a reused instance would ignore a second pre-fill.
  const [prefill, setPrefill] = useState<{ id: number; values: ImageLabExperimentPrefill } | null>(null);
  // The fixture count when an extraction was accepted, and how many new fixtures
  // it promised; null when nothing is being waited on.
  const [extractWatch, setExtractWatch] = useState<{ baseline: number; expected: number } | null>(null);
  const [extractPolls, setExtractPolls] = useState(0);

  // The single door for changing which experiment is open: state and URL move
  // together, so a refresh or a pasted link lands back on the same record — the
  // point of a bench whose rulings are cited by id. `replaceState`, never
  // `pushState` (the chat-conversation precedent): nothing here listens for
  // popstate, so a pushed entry would let Back rewind the address bar while the
  // view stayed where it was. Other params are left alone.
  const selectExperiment = (experimentId: string | null) => {
    setSelectedExperimentId(experimentId);
    const url = new URL(window.location.href);
    if (experimentId === null) url.searchParams.delete("experiment");
    else url.searchParams.set("experiment", experimentId);
    window.history.replaceState(null, "", url);
  };

  const controlRows = controls.data ?? [];
  const experimentRows = experiments.data ?? [];

  // Render-adjust (never a setState inside an effect): the wait ends the moment
  // the refetched list carries everything the extraction promised.
  const controlCount = controlRows.length;
  const [prevControlCount, setPrevControlCount] = useState(controlCount);
  if (controlCount !== prevControlCount) {
    setPrevControlCount(controlCount);
    if (extractWatch !== null && controlCount - extractWatch.baseline >= extractWatch.expected) {
      setExtractWatch(null);
    }
  }

  const extractPending = extractWatch !== null && extractPolls < MAX_EXTRACT_POLLS;
  usePollWhile(
    extractPending,
    () => {
      setExtractPolls((polls) => polls + 1);
      controls.reload({ silent: true });
    },
    POLL_MS,
    { maxPolls: MAX_EXTRACT_POLLS },
  );

  // A create is accepted before its row can be listed, so the tile is armed by
  // the returned id and disarmed by that id appearing — no flag to clear, and no
  // window where the page claims nothing is happening (PR #70's pattern).
  const experimentQueued =
    queuedExperimentId !== null && !experimentRows.some((experiment) => experiment.id === queuedExperimentId);
  const experimentRunning = experimentRows.some(
    (experiment) => experiment.status === "pending" || experiment.status === "running",
  );
  usePollWhile(experimentQueued || experimentRunning, () => experiments.reload({ silent: true }), POLL_MS);

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
        <h1 className="prose-display text-2xl">Image lab</h1>
        <p className="mt-2 text-sm text-paper-400">This page is only available to administrators.</p>
      </PageContainer>
    );
  }

  if (selectedExperimentId !== null) {
    return (
      <PageContainer>
        {/* Keyed by the experiment so a different row mounts a fresh detail —
            the verdict control seeds from the record once, and a reused instance
            would carry the previous ruling's note into it. */}
        <ImageLabExperimentDetail
          key={selectedExperimentId}
          experimentId={selectedExperimentId}
          onBack={() => {
            selectExperiment(null);
            experiments.reload({ silent: true });
          }}
          onDeleted={() => {
            selectExperiment(null);
            experiments.reload({ silent: true });
          }}
          onRunBaseline={(values) => {
            setPrefill((previous) => ({ id: (previous?.id ?? 0) + 1, values }));
            selectExperiment(null);
            experiments.reload({ silent: true });
          }}
          // A finishing pass cites the run it refines, and that citation is only
          // useful if it opens. Through the same one door as every other
          // selection, so the address bar keeps up.
          onOpenExperiment={selectExperiment}
        />
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      <header className="mb-6">
        <h1 className="prose-display text-2xl">Image lab</h1>
        <p className="mt-1 text-sm text-paper-400">
          An admin bench for questions no provider schema can answer — starting with whether this model obeys a pose
          skeleton sent as a numbered image. Nothing here touches the portrait, variant, or scene lanes; every run is
          charged against the daily render budget.
        </p>
      </header>

      <div className="flex flex-col gap-6">
        <ImageLabFixturesPanel
          controls={controlRows}
          loading={controls.loading}
          error={controls.error}
          extracting={extractPending}
          onReload={() => controls.reload()}
          onExtractQueued={(expected) => {
            setExtractWatch({ baseline: controlRows.length, expected });
            setExtractPolls(0);
            controls.reload({ silent: true });
          }}
          onControlsChanged={() => controls.reload({ silent: true })}
        />

        <ImageLabExperimentForm
          key={prefill?.id ?? 0}
          controls={controlRows}
          experiments={experimentRows}
          prefill={prefill?.values ?? null}
          onCreated={(experimentId) => {
            setQueuedExperimentId(experimentId);
            experiments.reload({ silent: true });
          }}
        />

        <ImageLabExperimentList
          experiments={experimentRows}
          loading={experiments.loading}
          error={experiments.error}
          queued={experimentQueued}
          onReload={() => experiments.reload()}
          onSelect={selectExperiment}
        />
      </div>
    </PageContainer>
  );
}
