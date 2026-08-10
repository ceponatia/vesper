"use client";

import { useState } from "react";
import { imageLabApi, meApi } from "@/lib/client/api";
import { useAsyncData } from "@/components/hooks/use-async";
import { usePollWhile } from "@/components/hooks/use-poll-while";
import { PageContainer } from "@/components/shell/app-shell";
import { Skeleton } from "@/components/ui/skeleton";
import { ImageLabExperimentDetail } from "./image-lab-experiment-detail";
import { ImageLabExperimentForm } from "./image-lab-experiment-form";
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
 */

const POLL_MS = 3000;

/**
 * How long the fixtures wait tolerates silence — ~2 minutes at the cadence
 * above. An extraction whose preprocessor output failed to decode writes no
 * asset at all, so "the fixture count grew" can never arrive; without a cap that
 * wait would poll until the tab closed.
 */
const MAX_EXTRACT_POLLS = 40;

export function ImageLabPage() {
  const me = useAsyncData(() => meApi.get(), []);
  const controls = useAsyncData(() => imageLabApi.controls.list(), []);
  const experiments = useAsyncData(() => imageLabApi.experiments.list(), []);

  const [selectedExperimentId, setSelectedExperimentId] = useState<string | null>(null);
  const [queuedExperimentId, setQueuedExperimentId] = useState<string | null>(null);
  // The fixture count when an extraction was accepted, and how many new fixtures
  // it promised; null when nothing is being waited on.
  const [extractWatch, setExtractWatch] = useState<{ baseline: number; expected: number } | null>(null);
  const [extractPolls, setExtractPolls] = useState(0);

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
            setSelectedExperimentId(null);
            experiments.reload({ silent: true });
          }}
          onDeleted={() => {
            setSelectedExperimentId(null);
            experiments.reload({ silent: true });
          }}
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
          controls={controlRows}
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
          onSelect={setSelectedExperimentId}
        />
      </div>
    </PageContainer>
  );
}
