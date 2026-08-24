"use client";

import { useState, type ReactNode } from "react";
import { z } from "zod";
import {
  isUndisclosedProviderVersion,
  providerVersionsDisagree,
  type ImageRenderControls,
} from "@vesper/image-core";
import type { ImageGeneratorRun } from "@/contracts/images/image-generator";
import { imageGeneratorApi, imageUrl } from "@/lib/client/api";
import { useAsyncData } from "@/components/hooks/use-async";
import { usePollWhile } from "@/components/hooks/use-poll-while";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { ErrorState } from "@/components/ui/error-state";
import { ImageLightbox } from "@/components/ui/image-lightbox";
import { Skeleton } from "@/components/ui/skeleton";
import { Tag } from "@/components/ui/tag";
import { useToast } from "@/components/ui/toast";
import { imageGeneratorFailureExplanation, imageGeneratorRoleLabel, imageGeneratorStatusChip } from "./image-generator-copy";
import type { ImageGeneratorPrefill } from "./image-generator-form";

/**
 * One generator run, whole: exactly what was requested, what was actually sent,
 * what ran, and what came back (image-lab-general-model-trials.plan.md §10).
 *
 * The two version ids sit side by side for the lab detail's reason: a requested
 * pin and an executed version that disagree is an unannounced provider-side
 * bump made visible, and a `"hidden"` echo is NOT such a disagreement — it is
 * what Replicate answers for an official model, so it gets an informational
 * line rather than the suspect banner (`providerVersionsDisagree`).
 *
 * The final prompt is shown ONLY when it differs from the authored prompt: the
 * only permitted transformations are the shared boundary's
 * (`preparePromptForImageModel`), so identical text is the common case and a
 * second copy of it would bury the one time the boundary actually changed
 * something.
 *
 * The attempt inspector (`meta.attempt`) is the developer-facing half —
 * applied and dropped controls, the sent reference roles — kept expandable
 * because it answers "what did the planner decide", which is a different
 * question from the request facts above it.
 */

const POLL_MS = 3000;

export interface ImageGeneratorRunDetailProps {
  runId: string;
  onBack: () => void;
  onDeleted: () => void;
  /** The duplicate hand-off: values for the create form, applied by the caller. Nothing submits here. */
  onDuplicate: (prefill: ImageGeneratorPrefill) => void;
  /** Open another run — the variant lineage's citation of its original. */
  onOpenRun: (runId: string) => void;
}

/**
 * The attempt record's display shape, read leniently: the stored bag is loose
 * on the wire (a newer deploy may write more), so each branch degrades alone
 * and an unparseable record costs only the structured rows — the raw JSON
 * beneath still shows everything.
 */
const attemptViewSchema = z.object({
  seed: z.number().nullable().catch(null).default(null),
  appliedControls: z
    .record(z.string(), z.unknown())
    .catch(() => ({}))
    .default(() => ({})),
  droppedControls: z
    .array(z.object({ control: z.string().catch(""), reason: z.string().catch("") }))
    .catch(() => [])
    .default(() => []),
  sentReferenceRoles: z
    .array(z.string())
    .catch(() => [])
    .default(() => []),
});

/**
 * The sanitized effective request's display shape — the provider-facing half of
 * a run, read on the same lenient terms as the attempt record.
 */
const effectiveRequestViewSchema = z.object({
  providerControls: z
    .record(z.string(), z.unknown())
    .catch(() => ({}))
    .default(() => ({})),
  shape: z
    .object({
      mode: z.string().catch("provider_default"),
      requestedAspect: z.string().nullable().catch(null).default(null),
      field: z.string().nullable().catch(null).default(null),
      value: z.string().nullable().catch(null).default(null),
    })
    .catch(() => ({ mode: "provider_default", requestedAspect: null, field: null, value: null }))
    .default(() => ({ mode: "provider_default", requestedAspect: null, field: null, value: null })),
  primaryInputs: z
    .array(
      z.object({
        imageId: z.string().catch(""),
        requestedPosition: z.number().catch(0),
        providerPosition: z.number().nullable().catch(null).default(null),
        providerField: z.string().catch(""),
      }),
    )
    .catch(() => [])
    .default(() => []),
  dedicatedInputs: z
    .array(
      z.object({
        imageId: z.string().catch(""),
        role: z.string().catch(""),
        providerField: z.string().nullable().catch(null).default(null),
      }),
    )
    .catch(() => [])
    .default(() => []),
  postprocess: z
    .object({ cropTarget: z.number().nullable().catch(null).default(null) })
    .catch(() => ({ cropTarget: null }))
    .default(() => ({ cropTarget: null })),
});

/** What actually came back, on the same terms. */
const runResultViewSchema = z.object({
  spent: z.boolean().catch(true).default(true),
  outputDimensions: z
    .object({ width: z.number().catch(0), height: z.number().catch(0) })
    .nullable()
    .catch(null)
    .default(null),
  postprocess: z
    .object({ cropTarget: z.number().nullable().catch(null).default(null) })
    .catch(() => ({ cropTarget: null }))
    .default(() => ({ cropTarget: null })),
});

/** One labelled fact in the recorded-request grid. */
function Fact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <dt className="text-[11px] tracking-wide text-paper-500 uppercase">{label}</dt>
      <dd className="mt-0.5 text-xs break-words text-paper-300">{value}</dd>
    </div>
  );
}

function instantText(instant: string | null): string {
  if (instant === null) return "—";
  return new Date(instant).toLocaleString();
}

/**
 * Every explicit control the run recorded, in words. Exhaustive over the
 * stored shape so a control set through the API still reads back here.
 */
function controlEntries(controls: ImageRenderControls): string[] {
  const entries: string[] = [];
  if (controls.seed !== undefined) entries.push(`seed ${String(controls.seed)}`);
  if (controls.negativePrompt !== undefined) entries.push(`negative prompt “${controls.negativePrompt}”`);
  if (controls.guidance !== undefined) entries.push(`guidance ${String(controls.guidance)}`);
  if (controls.steps !== undefined) entries.push(`steps ${String(controls.steps)}`);
  if (controls.editStrength !== undefined) entries.push(`edit strength ${String(controls.editStrength)}`);
  if (controls.outputCount !== undefined) entries.push(`output count ${String(controls.outputCount)}`);
  if (controls.coherentSet !== undefined) entries.push(`coherent set ${String(controls.coherentSet)}`);
  if (controls.thinkingMode !== undefined) entries.push(`thinking mode ${String(controls.thinkingMode)}`);
  if (controls.resolution !== undefined) entries.push(`resolution ${controls.resolution}`);
  if (controls.width !== undefined) entries.push(`width ${String(controls.width)}`);
  if (controls.height !== undefined) entries.push(`height ${String(controls.height)}`);
  if (controls.lora !== undefined) {
    entries.push(
      `LoRA ${controls.lora.id}${controls.lora.scale !== undefined ? ` @ ${String(controls.lora.scale)}` : ""}`,
    );
  }
  return entries;
}

/** The dashed placeholder every absent image renders as. */
const MISSING_IMAGE_TILE =
  "flex aspect-[3/4] w-full items-center justify-center rounded-card border border-dashed border-ink-600 px-2 text-center text-[11px] text-paper-600";

/**
 * One recorded image, shown whole and enlargeable. A run outlives the assets
 * it cites — deleting an input image leaves the record intact — so a tile
 * whose asset is gone says so beside the id instead of rendering broken.
 */
function RecordedImage({
  imageId,
  label,
  onEnlarge,
}: {
  imageId: string;
  label: string;
  onEnlarge: (imageId: string) => void;
}) {
  const [missingId, setMissingId] = useState<string | null>(null);
  // Render-adjust: a different id is a different question, so re-ask it.
  if (missingId !== null && missingId !== imageId) setMissingId(null);
  const gone = missingId === imageId;
  if (gone) {
    return <div className={MISSING_IMAGE_TILE}>this image no longer exists</div>;
  }
  return (
    <button
      type="button"
      aria-label={`Enlarge ${label}`}
      className="block w-full cursor-pointer overflow-hidden rounded-card border border-ink-600"
      onClick={() => onEnlarge(imageId)}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- local asset route; an input must be judged whole */}
      <img
        alt={label}
        src={imageUrl(imageId)}
        className="aspect-[3/4] w-full bg-ink-950 object-contain"
        onError={() => setMissingId(imageId)}
      />
    </button>
  );
}

export function ImageGeneratorRunDetail({ runId, onBack, onDeleted, onDuplicate, onOpenRun }: ImageGeneratorRunDetailProps) {
  const toast = useToast();
  const detail = useAsyncData(() => imageGeneratorApi.runs.detail(runId), [runId]);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [enlarged, setEnlarged] = useState<string | null>(null);

  const run: ImageGeneratorRun | null = detail.data?.run ?? null;
  const live = run !== null && (run.status === "pending" || run.status === "running");
  usePollWhile(live, () => detail.reload({ silent: true }), POLL_MS);

  const remove = async () => {
    setDeleting(true);
    const result = await imageGeneratorApi.runs.remove(runId);
    setDeleting(false);
    setConfirmDelete(false);
    if (!result.ok) {
      toast.push({ title: "Delete failed", description: result.error.message, tone: "error" });
      return;
    }
    toast.push({ title: "Run deleted", tone: "success" });
    onDeleted();
  };

  if (detail.error && run === null) {
    return (
      <div>
        <BackButton onBack={onBack} />
        <ErrorState error={detail.error} onRetry={() => detail.reload()} />
      </div>
    );
  }
  if (run === null) {
    return (
      <div>
        <BackButton onBack={onBack} />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  const chip = imageGeneratorStatusChip(run.status);
  const settled = run.status === "succeeded" || run.status === "failed";
  const versionsDisagree = providerVersionsDisagree(run.requestedVersionId, run.executedVersionId);
  const versionUndisclosed = run.requestedVersionId !== null && isUndisclosedProviderVersion(run.executedVersionId);
  const controls = controlEntries(run.controls);
  const advanced = Object.entries(run.providerInputs);
  const attemptView = run.attempt === null ? null : attemptViewSchema.safeParse(run.attempt);
  const effectiveView =
    run.effectiveRequest === null ? null : effectiveRequestViewSchema.safeParse(run.effectiveRequest);
  const resultView = run.result === null ? null : runResultViewSchema.safeParse(run.result);
  const promptTransformed = run.finalPrompt !== null && run.finalPrompt !== run.prompt;

  const duplicate = () => {
    toast.push({
      title: "Form pre-filled",
      description: "Review the duplicated request and run it yourself — nothing was submitted.",
      tone: "success",
    });
    onDuplicate({
      modelSlug: run.modelSlug,
      requestedVersionId: run.requestedVersionId,
      prompt: run.prompt,
      inputs: run.inputs,
      controls: run.controls,
      providerInputs: run.providerInputs,
      sourceRunId: run.id,
    });
  };

  // The id leaves the page exactly as stored — bare, nothing to hand-trim out
  // of a paste (the lab detail's rule).
  const copyId = () => {
    void navigator.clipboard
      .writeText(run.id)
      .then(() => toast.push({ title: "Run id copied", tone: "success" }))
      .catch(() =>
        toast.push({
          title: "Couldn’t copy that id",
          description: "The browser refused clipboard access — select it in the header instead.",
          tone: "error",
        }),
      );
  };

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <BackButton onBack={onBack} />
        <div className="flex items-center gap-2">
          {settled ? <Button size="sm" onClick={duplicate}>Duplicate</Button> : null}
          <Button size="sm" variant="quiet" onClick={() => setConfirmDelete(true)}>
            Delete run
          </Button>
        </div>
      </div>

      <header className="mb-5">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="prose-display text-xl">
            <code>{run.modelSlug}</code>
          </h1>
          <Tag tone={chip.tone}>{chip.label}</Tag>
          {run.sourceRunId !== null ? <Tag>variant</Tag> : null}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-paper-500">
          <span>id</span>
          <code className="break-all">{run.id}</code>
          <Button size="sm" variant="quiet" onClick={copyId} aria-label="Copy run id">
            Copy
          </Button>
        </div>
        <p className="mt-1 text-[11px] text-paper-500">
          created {instantText(run.createdAt)} · started {instantText(run.startedAt)} · finished{" "}
          {instantText(run.finishedAt)}
        </p>
      </header>

      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        <figure className="flex flex-col gap-1 sm:col-span-1">
          <figcaption className="text-[11px] tracking-wide text-paper-500 uppercase">Result</figcaption>
          {run.resultImageId !== null ? (
            <RecordedImage imageId={run.resultImageId} label="Run result" onEnlarge={setEnlarged} />
          ) : live ? (
            <Skeleton className="aspect-[3/4] w-full rounded-card" />
          ) : (
            <div className={MISSING_IMAGE_TILE}>
              {run.status === "failed" ? "the run failed before an image existed" : "no result yet"}
            </div>
          )}
        </figure>
      </div>

      {run.sourceRunId !== null ? (
        <section className="mb-6 rounded-card border border-ink-600 bg-ink-850 p-4">
          <h2 className="text-xs font-medium tracking-wide text-paper-400 uppercase">Variant of</h2>
          <p className="mt-1 text-sm text-paper-400">
            This run was duplicated from another and changed something — read the two side by side.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <code className="text-[11px] break-all text-paper-500">{run.sourceRunId}</code>
            <Button
              size="sm"
              onClick={() => {
                if (run.sourceRunId !== null) onOpenRun(run.sourceRunId);
              }}
            >
              Open original run
            </Button>
          </div>
        </section>
      ) : null}

      {run.failureCode !== null ? (
        <section className="mb-6 rounded-card border border-danger-500/40 bg-ink-850 p-4">
          <h2 className="text-xs font-medium tracking-wide text-danger-300 uppercase">Failure</h2>
          <p className="mt-1 text-sm text-paper-300">{imageGeneratorFailureExplanation(run.failureCode)}</p>
          <p className="mt-1 text-[11px] text-paper-600">
            code <code className="break-all">{run.failureCode}</code>
            {run.error !== null ? (
              <>
                {" · detail "}
                <code className="break-all">{run.error}</code>
              </>
            ) : null}
          </p>
        </section>
      ) : null}

      <section className="mb-6 rounded-card border border-ink-600 bg-ink-850 p-4">
        <h2 className="text-xs font-medium tracking-wide text-paper-400 uppercase">Recorded request</h2>
        <dl className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Fact label="Model" value={<code className="break-all">{run.modelSlug}</code>} />
          <Fact
            label="Requested version"
            value={
              <>
                <code className="break-all">{run.requestedVersionId ?? "—"}</code>
                {run.versionPolicy === "captured" ? " — replayed from the source run" : ""}
              </>
            }
          />
          <Fact label="Executed version" value={<code className="break-all">{run.executedVersionId ?? "—"}</code>} />
          <Fact label="Prediction" value={<code className="break-all">{run.predictionId ?? "—"}</code>} />
          <Fact
            label="Explicit controls"
            value={controls.length > 0 ? controls.join(" · ") : "— none; the model’s own defaults ruled"}
          />
          <Fact
            label="Advanced model inputs"
            value={
              advanced.length > 0
                ? advanced.map(([field, value]) => `${field} = ${String(value)}`).join(" · ")
                : "— none sent"
            }
          />
        </dl>
        {versionsDisagree ? (
          <p className="mt-3 text-xs text-danger-300">
            The provider ran a different version than this run pinned. Treat anything concluded from it as suspect
            until the pin is re-resolved.
          </p>
        ) : versionUndisclosed ? (
          <p className="mt-3 text-xs text-paper-500">
            The provider does not disclose which version ran; the requested pin was validated when the prediction was
            created.
          </p>
        ) : null}

        <div className="mt-4">
          <h3 className="text-[11px] tracking-wide text-paper-500 uppercase">
            Ordered inputs ({run.inputs.primary.length + run.inputs.dedicated.length})
          </h3>
          {run.inputs.primary.length === 0 && run.inputs.dedicated.length === 0 ? (
            <p className="mt-1 text-xs text-paper-500">None — a prompt-only run.</p>
          ) : (
            <ol className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {run.inputs.primary.map((input, index) => {
                const slot = `Image ${String(index + 1)}`;
                return (
                  <li key={`primary-${String(index)}`} className="flex flex-col gap-1">
                    <RecordedImage imageId={input.imageId} label={slot} onEnlarge={setEnlarged} />
                    <p className="text-[11px] text-paper-300">
                      <span className="text-paper-500">{slot}</span>
                      {" — plain reference"}
                      {input.purpose !== undefined
                        ? ` · recorded purpose: ${imageGeneratorRoleLabel(input.purpose)}`
                        : ""}
                    </p>
                    <code className="text-[10px] break-all text-paper-500">{input.imageId}</code>
                  </li>
                );
              })}
              {run.inputs.dedicated.map((input) => {
                const label = `${imageGeneratorRoleLabel(input.role)} (dedicated input)`;
                return (
                  <li key={`dedicated-${input.role}`} className="flex flex-col gap-1">
                    <RecordedImage imageId={input.imageId} label={label} onEnlarge={setEnlarged} />
                    <p className="text-[11px] text-paper-300">
                      <span className="text-paper-500">{imageGeneratorRoleLabel(input.role)}</span>
                      {" — dedicated structural input"}
                    </p>
                    <code className="text-[10px] break-all text-paper-500">{input.imageId}</code>
                  </li>
                );
              })}
            </ol>
          )}
          {run.inputs.primary.length > 0 ? (
            <p className="mt-2 text-xs text-paper-500">
              {"Primary references are sent under the neutral reference role in this order; a recorded purpose is "}
              {"provenance only and never changed the request."}
            </p>
          ) : null}
        </div>
      </section>

      <section className="mb-6 flex flex-col gap-3">
        <div>
          <h2 className="text-xs font-medium tracking-wide text-paper-400 uppercase">Prompt (as written)</h2>
          <p className="mt-1 rounded-card border border-ink-600 bg-ink-950/40 px-3 py-2 text-sm whitespace-pre-wrap text-paper-300">
            {run.prompt}
          </p>
        </div>
        {promptTransformed ? (
          <div>
            <h2 className="text-xs font-medium tracking-wide text-paper-400 uppercase">Final prompt (as sent)</h2>
            <p className="mt-1 rounded-card border border-ink-600 bg-ink-950/40 px-3 py-2 text-sm whitespace-pre-wrap text-paper-300">
              {run.finalPrompt}
            </p>
            <p className="mt-1 text-[11px] text-paper-500">
              The shared model boundary transformed the authored text — the only layer allowed to — and this is what
              the provider actually received.
            </p>
          </div>
        ) : run.finalPrompt !== null ? (
          <p className="text-[11px] text-paper-500">Sent verbatim — the shared boundary changed nothing.</p>
        ) : null}
      </section>

      {effectiveView !== null && effectiveView.success ? (
        <details className="mb-6 rounded-card border border-ink-600 bg-ink-850 p-4">
          <summary className="cursor-pointer text-xs font-medium tracking-wide text-paper-400 uppercase">
            Effective request (as sent)
          </summary>
          <p className="mt-2 text-xs text-paper-500">
            {"The provider-facing request, written down before the spend: the real field names and values, the shape "}
            {"that was asked for, and which image occupied which provider slot. Recorded here so this run still "}
            {"describes itself after the model is re-probed. No bytes, addresses, or credentials are kept."}
          </p>
          <div className="mt-3 flex flex-col gap-3">
            <div>
              <h3 className="text-[11px] tracking-wide text-paper-500 uppercase">Shape</h3>
              <p className="mt-1 text-xs text-paper-300">
                {effectiveView.data.shape.field === null || effectiveView.data.shape.value === null
                  ? "No shape field was sent — the model answered at its own default."
                  : `${effectiveView.data.shape.field} = ${effectiveView.data.shape.value}`}
                {effectiveView.data.postprocess.cropTarget === null
                  ? " No crop was planned."
                  : ` A crop to ${String(effectiveView.data.postprocess.cropTarget)} was planned; the result below says what happened.`}
              </p>
            </div>
            <div>
              <h3 className="text-[11px] tracking-wide text-paper-500 uppercase">
                Provider fields ({Object.keys(effectiveView.data.providerControls).length})
              </h3>
              {Object.keys(effectiveView.data.providerControls).length === 0 ? (
                <p className="mt-1 text-xs text-paper-500">
                  None — every control was left at the model’s own default.
                </p>
              ) : (
                <ul className="mt-1 flex flex-col gap-0.5 text-xs text-paper-300">
                  {Object.entries(effectiveView.data.providerControls).map(([field, value]) => (
                    <li key={field}>
                      <span className="text-paper-500">{field}</span> — <code>{JSON.stringify(value)}</code>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {effectiveView.data.primaryInputs.length > 0 ? (
              <div>
                <h3 className="text-[11px] tracking-wide text-paper-500 uppercase">Primary images</h3>
                <ol className="mt-1 flex flex-col gap-0.5 text-xs text-paper-300">
                  {effectiveView.data.primaryInputs.map((input) => (
                    <li key={`${input.imageId}-${String(input.requestedPosition)}`}>
                      <span className="text-paper-500">{`#${String(input.requestedPosition)} →`}</span>{" "}
                      {input.providerPosition === null
                        ? "not sent"
                        : `${input.providerField}[${String(input.providerPosition)}]`}{" "}
                      <code className="break-all">{input.imageId}</code>
                    </li>
                  ))}
                </ol>
              </div>
            ) : null}
            {effectiveView.data.dedicatedInputs.length > 0 ? (
              <div>
                <h3 className="text-[11px] tracking-wide text-paper-500 uppercase">Structural images</h3>
                <ul className="mt-1 flex flex-col gap-0.5 text-xs text-paper-300">
                  {effectiveView.data.dedicatedInputs.map((input) => (
                    <li key={`${input.role}-${input.imageId}`}>
                      <span className="text-paper-500">{input.role} →</span> {input.providerField ?? "unbound"}{" "}
                      <code className="break-all">{input.imageId}</code>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {resultView !== null && resultView.success ? (
              <div>
                <h3 className="text-[11px] tracking-wide text-paper-500 uppercase">Result</h3>
                <p className="mt-1 text-xs text-paper-300">
                  {!resultView.data.spent
                    ? "Refused before the provider was called — nothing was spent."
                    : resultView.data.outputDimensions === null
                      ? "The returned image’s size could not be read."
                      : `Returned ${String(resultView.data.outputDimensions.width)}×${String(resultView.data.outputDimensions.height)}.`}
                  {resultView.data.spent
                    ? resultView.data.postprocess.cropTarget === null
                      ? " Vesper did not crop it."
                      : ` Vesper cropped it to ${String(resultView.data.postprocess.cropTarget)}.`
                    : ""}
                </p>
              </div>
            ) : null}
          </div>
          <pre className="mt-3 overflow-x-auto rounded-card border border-ink-700 bg-ink-950/60 p-2 text-[11px] text-paper-300">
            {JSON.stringify({ effectiveRequest: run.effectiveRequest, result: run.result }, null, 2)}
          </pre>
        </details>
      ) : null}

      {run.attempt !== null ? (
        <details className="mb-6 rounded-card border border-ink-600 bg-ink-850 p-4">
          <summary className="cursor-pointer text-xs font-medium tracking-wide text-paper-400 uppercase">
            Attempt inspector
          </summary>
          <p className="mt-2 text-xs text-paper-500">
            What the planner decided at run time — which controls actually reached the payload, which were dropped
            and why, and which reference roles were sent.
          </p>
          {attemptView !== null && attemptView.success ? (
            <div className="mt-3 flex flex-col gap-3">
              <div>
                <h3 className="text-[11px] tracking-wide text-paper-500 uppercase">
                  Applied controls ({Object.keys(attemptView.data.appliedControls).length})
                </h3>
                {Object.keys(attemptView.data.appliedControls).length === 0 ? (
                  <p className="mt-1 text-xs text-paper-500">None reached the payload.</p>
                ) : (
                  <ul className="mt-1 flex flex-col gap-0.5 text-xs text-paper-300">
                    {Object.entries(attemptView.data.appliedControls).map(([control, value]) => (
                      <li key={control}>
                        <span className="text-paper-500">{control}</span> — <code>{JSON.stringify(value)}</code>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              {attemptView.data.droppedControls.length > 0 ? (
                <div>
                  <h3 className="text-[11px] tracking-wide text-paper-500 uppercase">
                    Dropped controls ({attemptView.data.droppedControls.length})
                  </h3>
                  <ul className="mt-1 flex flex-col gap-0.5 text-xs text-paper-300">
                    {attemptView.data.droppedControls.map((drop, index) => (
                      <li key={`${String(index)}-${drop.control}`}>
                        <span className="text-paper-500">{drop.control}</span> — {drop.reason}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              <div>
                <h3 className="text-[11px] tracking-wide text-paper-500 uppercase">
                  Sent reference roles ({attemptView.data.sentReferenceRoles.length})
                </h3>
                {attemptView.data.sentReferenceRoles.length === 0 ? (
                  <p className="mt-1 text-xs text-paper-500">None — a prompt-only payload.</p>
                ) : (
                  <ol className="mt-1 flex flex-col gap-0.5 text-xs text-paper-300">
                    {attemptView.data.sentReferenceRoles.map((role, index) => (
                      <li key={`${String(index)}-${role}`}>
                        <span className="text-paper-500">Image {index + 1} —</span> {role}
                      </li>
                    ))}
                  </ol>
                )}
              </div>
              {attemptView.data.seed !== null ? (
                <p className="text-xs text-paper-500">{`Resolved seed ${String(attemptView.data.seed)}.`}</p>
              ) : null}
            </div>
          ) : null}
          <pre className="mt-3 overflow-x-auto rounded-card border border-ink-700 bg-ink-950/60 p-2 text-[11px] text-paper-300">
            {JSON.stringify(run.attempt, null, 2)}
          </pre>
        </details>
      ) : null}

      <Dialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title="Delete this run?"
        footer={
          <>
            <Button onClick={() => setConfirmDelete(false)}>Cancel</Button>
            <Button variant="danger" busy={deleting} onClick={() => void remove()}>
              Delete
            </Button>
          </>
        }
      >
        The record and the hidden image it rendered are removed. Input images are not touched.
      </Dialog>

      <ImageLightbox
        imageId={enlarged}
        alt="Generator run image"
        prompt={enlarged !== null && enlarged === run.resultImageId ? (run.finalPrompt ?? run.prompt) : null}
        onClose={() => setEnlarged(null)}
      />
    </div>
  );
}

function BackButton({ onBack }: { onBack: () => void }) {
  return (
    <Button size="sm" variant="quiet" onClick={onBack}>
      ← All runs
    </Button>
  );
}
