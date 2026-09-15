"use client";

import { useState } from "react";
import type { ImageGeneratorRun, ImageGeneratorRunFaceRepairPurpose } from "@/contracts/images/image-generator";
import { charactersApi, faceRepairApi, imageGeneratorApi, imageProfilesApi, imageUrl, meApi } from "@/lib/client/api";
import { useAsyncData } from "@/components/hooks/use-async";
import { usePollWhile } from "@/components/hooks/use-poll-while";
import { PageContainer } from "@/components/shell/app-shell";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/error-state";
import { Field } from "@/components/ui/field";
import { ImageLightbox } from "@/components/ui/image-lightbox";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tag } from "@/components/ui/tag";
import { useToast } from "@/components/ui/toast";
import { imageGeneratorStatusChip } from "./image-generator-copy";
import { OwnedImagePicker } from "./owned-image-picker";

/**
 * Issue #246 — the flagged owner-admin face-repair action's page content.
 *
 * A one-off admin review screen, not a tool reached every session, so it
 * lives at its own `/settings/face-repair` route linked from the Settings
 * page's Admin section — the Identity-trials precedent
 * (`components/settings/identity-trials-page.tsx`), rather than crowding the
 * Settings page itself with a character picker, an image picker, a model
 * select and a run history.
 *
 * The route it calls (`POST /api/admin/self/face-repair`) submits through the
 * ordinary Image Generator run path, so a repair run IS a Generator run: its
 * history is read from the same `imageGeneratorApi.runs.list()` the Generator
 * page uses, filtered client-side to the runs whose `purpose.kind` is
 * `"face_repair"` — a `?purpose=` query param would cost a route edit this
 * action does not otherwise need.
 *
 * The run list polls itself exactly like the Generator page's own list
 * (`image-generator-page.tsx`: same `POLL_MS`/`MAX_LIST_POLLS`,
 * `usePollWhile`), while any repair run is `pending`/`running` — otherwise a
 * run's chip, thumbnail and comparison stayed stale until a full page
 * reload (issue #246 round-2 correction).
 *
 * `FACE_REPAIR_SOURCE_KINDS` mirrors `FACE_REPAIR_ALLOWED_KINDS` in
 * `@/server/images/face-repair.ts` client-side (a "use client" component may
 * not import that server module): it narrows the source picker to kinds the
 * route will actually accept, so an admin never picks an item/location
 * `entity` render or an unrelated chat upload only to have the request
 * refused after the fact (issue #246 round-2 correction).
 */

function isFaceRepairRun(
  run: ImageGeneratorRun,
): run is ImageGeneratorRun & { purpose: ImageGeneratorRunFaceRepairPurpose } {
  return run.purpose?.kind === "face_repair";
}

/**
 * The list poll's own stop condition. Exported and unit-tested on its own
 * (`face-repair-section.test.ts`) since the component has no render harness
 * — a pure one-liner is cheap insurance against a status typo silently
 * disabling the poll (issue #246 round-2 correction).
 */
export function anyFaceRepairRunLive(runs: readonly Pick<ImageGeneratorRun, "status">[]): boolean {
  return runs.some((run) => run.status === "pending" || run.status === "running");
}

// Same interval and bound as the Generator page's own list poll
// (`image-generator-page.tsx`).
const POLL_MS = 3000;
/** ~5 minutes of silence before the list poll gives up; re-armed by any new activity. */
const MAX_LIST_POLLS = 100;

/**
 * Mirrors `FACE_REPAIR_ALLOWED_KINDS` (`@/server/images/face-repair.ts`),
 * spelled client-side because this component may not import that server
 * module — the same reason `OWNED_IMAGE_PICKER_KINDS` is spelled out in
 * `owned-image-picker.tsx` rather than imported. The server VALIDATES a
 * kinds filter rather than narrowing it, so a drifted entry here fails
 * loudly as a 400 instead of silently listing nothing.
 */
const FACE_REPAIR_SOURCE_KINDS = [
  "avatar",
  "portrait_variant",
  "chat_look",
  "reference_view",
  "scene",
  "chat_place",
] as const;

export function FaceRepairSection() {
  const me = useAsyncData(() => meApi.get(), []);
  const status = useAsyncData(() => faceRepairApi.status(), []);
  const characters = useAsyncData(() => charactersApi.list({ scope: "owned" }), []);
  const profiles = useAsyncData(() => imageProfilesApi.list("variant"), []);
  const runs = useAsyncData(() => imageGeneratorApi.runs.list(), []);
  const toast = useToast();

  const [characterId, setCharacterId] = useState("");
  const [sourceImageId, setSourceImageId] = useState<string | null>(null);
  const [profileId, setProfileId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [openRunId, setOpenRunId] = useState<string | null>(null);

  // Computed ahead of the early returns below (and unconditionally on every
  // render) so the poll hook itself stays unconditional — the strict
  // react-hooks rule this file otherwise has no reason to violate.
  const faceRepairRuns = (runs.data ?? []).filter(isFaceRepairRun);
  usePollWhile(anyFaceRepairRunLive(faceRepairRuns), () => runs.reload({ silent: true }), POLL_MS, {
    maxPolls: MAX_LIST_POLLS,
  });

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
        <h1 className="prose-display text-2xl">Face repair</h1>
        <p className="mt-2 text-sm text-paper-400">This page is only available to administrators.</p>
      </PageContainer>
    );
  }

  if (status.loading && !status.data) {
    return (
      <PageContainer>
        <Skeleton className="h-8 w-56" />
      </PageContainer>
    );
  }

  if (status.data?.enabled !== true) {
    return (
      <PageContainer>
        <h1 className="prose-display text-2xl">Face repair</h1>
        <p className="mt-2 text-sm text-paper-400">
          Face repair is not enabled on this deployment.
        </p>
      </PageContainer>
    );
  }

  const openRun = openRunId ? (runs.data ?? []).find((run) => run.id === openRunId) : undefined;

  async function submit() {
    if (!sourceImageId) return;
    setSubmitting(true);
    try {
      const result = await faceRepairApi.create({
        characterId,
        sourceImageId,
        ...(profileId ? { modelId: profileId } : {}),
      });
      if (result.ok) {
        toast.push({ tone: "success", title: "Repair started" });
        setSourceImageId(null);
        runs.reload({ silent: true });
      } else {
        toast.push({ tone: "error", title: "Repair refused", description: result.error.message });
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <PageContainer>
      <header className="mb-6">
        <h1 className="prose-display text-2xl">Face repair</h1>
        <p className="mt-1 text-sm text-paper-400">
          Explicitly repair one character&rsquo;s face in one selected source image. The source
          image is never changed — the repair is a new image beside it, so the two can be
          compared. Repair is never an automatic fallback after another render; a multi-person
          source is refused before anything is spent.
        </p>
      </header>

      <section className="rounded-card border border-ink-600 bg-ink-850 p-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Character">
            {characters.loading && !characters.data ? (
              <Skeleton className="h-9 w-full" />
            ) : (
              <Select
                value={characterId}
                onChange={(event) => {
                  setCharacterId(event.target.value);
                  setSourceImageId(null);
                }}
              >
                <option value="">— Select a character —</option>
                {(characters.data ?? []).map((character) => (
                  <option key={character.id} value={character.id}>
                    {character.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>

          <Field label="Repair model" hint="Omit to use the task's default profile.">
            {profiles.loading && !profiles.data ? (
              <Skeleton className="h-9 w-full" />
            ) : (
              <Select value={profileId} onChange={(event) => setProfileId(event.target.value)}>
                <option value="">— Default —</option>
                {(profiles.data ?? []).map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label} ({option.modelLabel})
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>

        {characters.error ? <ErrorState error={characters.error} onRetry={() => characters.reload()} /> : null}
        {profiles.error ? <ErrorState error={profiles.error} onRetry={() => profiles.reload()} /> : null}

        <div className="mt-4">
          <p className="mb-2 text-xs font-medium tracking-wide text-paper-400 uppercase">Source image</p>
          {characterId ? (
            <OwnedImagePicker
              label="Source image"
              hint="The picture to repair. It stays unchanged; the repair is stored beside it."
              kinds={FACE_REPAIR_SOURCE_KINDS}
              value={sourceImageId}
              onChange={(imageId) => setSourceImageId(imageId)}
              allowAdminFiles={false}
            />
          ) : (
            <p className="text-sm text-paper-500">Select a character first.</p>
          )}
        </div>

        <div className="mt-4 flex justify-end">
          <Button
            variant="primary"
            busy={submitting}
            disabled={!characterId || !sourceImageId}
            onClick={() => void submit()}
          >
            Repair
          </Button>
        </div>
      </section>

      <section className="mt-6">
        <h2 className="text-xs font-medium tracking-wide text-paper-400 uppercase">Repair runs</h2>
        {runs.error ? <ErrorState error={runs.error} onRetry={() => runs.reload()} /> : null}
        {runs.loading && !runs.data ? <Skeleton className="mt-2 h-24 w-full" /> : null}
        <div className="mt-2 flex flex-col gap-3">
          {faceRepairRuns.map((run) => {
            const chip = imageGeneratorStatusChip(run.status);
            return (
              <button
                key={run.id}
                type="button"
                onClick={() => setOpenRunId(run.id)}
                className="flex items-center gap-3 rounded-card border border-ink-600 bg-ink-850 p-3 text-left transition-colors hover:border-ink-500"
              >
                {run.resultImageId ? (
                  // eslint-disable-next-line @next/next/no-img-element -- local asset route; next/image adds nothing here
                  <img
                    src={imageUrl(run.resultImageId)}
                    alt=""
                    className="h-12 w-12 shrink-0 rounded-md object-cover"
                  />
                ) : (
                  <div className="h-12 w-12 shrink-0 rounded-md bg-ink-700" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Tag tone={chip.tone}>{chip.label}</Tag>
                    <span className="text-[11px] text-paper-500">
                      {new Date(run.createdAt).toLocaleString()}
                    </span>
                  </div>
                  <p className="mt-1 truncate text-xs text-paper-500">Method: {run.purpose.method}</p>
                </div>
              </button>
            );
          })}
          {!runs.loading && faceRepairRuns.length === 0 ? (
            <p className="text-sm text-paper-500">No repair runs yet.</p>
          ) : null}
        </div>
      </section>

      {openRun && isFaceRepairRun(openRun) ? (
        <ImageLightbox
          imageId={openRun.resultImageId}
          comparisonImageId={openRun.purpose.sourceImageId}
          open
          alt="Face repair result"
          onClose={() => setOpenRunId(null)}
          emptyMessage="This run has no stored result."
        />
      ) : null}
    </PageContainer>
  );
}
