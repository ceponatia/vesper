"use client";

import { useState, type ReactNode } from "react";
import {
  imageLabProbeVerdicts,
  isUndisclosedProviderVersion,
  providerVersionsDisagree,
  type ImageLabExperiment,
  type ImageLabProbeVerdict,
} from "@/contracts";
import { imageLabApi, imageUrl } from "@/lib/client/api";
import { useAsyncData } from "@/components/hooks/use-async";
import { usePollWhile } from "@/components/hooks/use-poll-while";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { ErrorState } from "@/components/ui/error-state";
import { Field } from "@/components/ui/field";
import { ImageLightbox } from "@/components/ui/image-lightbox";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tag } from "@/components/ui/tag";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import {
  imageLabControlKindLabel,
  imageLabExperimentKindLabel,
  imageLabFailureExplanation,
  imageLabRoleLabel,
  imageLabStatusChip,
  imageLabVerdictChip,
  imageLabVerdictHint,
  imageLabVerdictLabel,
} from "./image-lab-copy";

/**
 * One experiment, whole: what was sent, what came back, and — for a control
 * probe — the ruling the whole Stage 0 protocol exists to produce.
 *
 * Everything recorded is shown, including the two version ids side by side. A
 * requested version and an executed version that disagree is how an unannounced
 * provider-side bump becomes visible instead of silently invalidating every
 * comparison made against it, and that is only useful if someone can see both.
 *
 * An executed version of `"hidden"` is NOT such a disagreement — it is what
 * Replicate answers for an official model, which publishes no versions at all.
 * That case gets a plain informational line rather than the suspect banner: the
 * run's evidence identity is the requested pin, which Replicate validated when
 * it accepted the prediction (`providerVersionsDisagree`, contracts).
 */

const POLL_MS = 3000;

export interface ImageLabExperimentDetailProps {
  experimentId: string;
  onBack: () => void;
  onDeleted: () => void;
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-[11px] tracking-wide text-paper-500 uppercase">{label}</dt>
      <dd className="text-xs break-words text-paper-300">{children}</dd>
    </div>
  );
}

function instantText(instant: string | null): string {
  return instant === null ? "—" : new Date(instant).toLocaleString();
}

function LabImage({
  label,
  imageId,
  pending,
  emptyHint,
  onEnlarge,
}: {
  label: string;
  imageId: string | null;
  pending: boolean;
  emptyHint: string;
  onEnlarge: (imageId: string) => void;
}) {
  return (
    <figure className="flex flex-col gap-1">
      <figcaption className="text-[11px] tracking-wide text-paper-500 uppercase">{label}</figcaption>
      {imageId !== null ? (
        <button
          type="button"
          onClick={() => onEnlarge(imageId)}
          aria-label={`Enlarge ${label}`}
          className="block w-full cursor-pointer overflow-hidden rounded-card border border-ink-600"
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- local asset route; a control map must be shown whole */}
          <img src={imageUrl(imageId)} alt={label} className="aspect-[3/4] w-full bg-ink-950 object-contain" />
        </button>
      ) : pending ? (
        <Skeleton className="aspect-[3/4] w-full rounded-card" />
      ) : (
        <div className="flex aspect-[3/4] w-full items-center justify-center rounded-card border border-dashed border-ink-600 px-2 text-center text-[11px] text-paper-600">
          {emptyHint}
        </div>
      )}
    </figure>
  );
}

export function ImageLabExperimentDetail({ experimentId, onBack, onDeleted }: ImageLabExperimentDetailProps) {
  const toast = useToast();
  const detail = useAsyncData(() => imageLabApi.experiments.detail(experimentId), [experimentId]);

  // Unset until someone picks. On a bench whose whole output is trustworthy
  // rulings, the most favourable ruling must never be the one a distracted click
  // records by default — an unchosen verdict has to be indistinguishable from
  // no verdict, which a pre-selected option cannot be.
  const [verdict, setVerdict] = useState<ImageLabProbeVerdict | "">("");
  const [note, setNote] = useState("");
  const [recording, setRecording] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [enlarged, setEnlarged] = useState<string | null>(null);

  const experiment: ImageLabExperiment | null = detail.data?.experiment ?? null;
  const live = experiment !== null && (experiment.status === "pending" || experiment.status === "running");
  usePollWhile(live, () => detail.reload({ silent: true }), POLL_MS);

  // Seed the verdict control from what is already recorded, once (render-adjust,
  // the settings-page idiom) — a silent poll must never reset a half-written note.
  const [seeded, setSeeded] = useState(false);
  if (!seeded && experiment !== null) {
    setSeeded(true);
    if (experiment.verdict !== null) setVerdict(experiment.verdict);
    if (experiment.verdictNote !== null) setNote(experiment.verdictNote);
  }

  const record = async () => {
    if (verdict === "" || note.trim() === "") return;
    setRecording(true);
    const result = await imageLabApi.experiments.recordVerdict(experimentId, { verdict, note: note.trim() });
    setRecording(false);
    if (!result.ok) {
      toast.push({ title: "Couldn't record that verdict", description: result.error.message, tone: "error" });
      return;
    }
    toast.push({ title: "Verdict recorded", description: imageLabVerdictLabel(verdict), tone: "success" });
    detail.reload({ silent: true });
  };

  const remove = async () => {
    setDeleting(true);
    const result = await imageLabApi.experiments.remove(experimentId);
    setDeleting(false);
    setConfirmDelete(false);
    if (!result.ok) {
      toast.push({ title: "Delete failed", description: result.error.message, tone: "error" });
      return;
    }
    toast.push({ title: "Experiment deleted", tone: "success" });
    onDeleted();
  };

  if (detail.error && experiment === null) {
    return (
      <div>
        <BackButton onBack={onBack} />
        <ErrorState error={detail.error} onRetry={() => detail.reload()} />
      </div>
    );
  }
  if (experiment === null) {
    return (
      <div>
        <BackButton onBack={onBack} />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  const chip = imageLabStatusChip(experiment.status);
  const verdictChip = experiment.verdict === null ? null : imageLabVerdictChip(experiment.verdict);
  const identityInput = experiment.inputs.find((input) => input.role === "identity") ?? null;
  const versionsDisagree = providerVersionsDisagree(experiment.requestedVersionId, experiment.executedVersionId);
  const versionUndisclosed =
    experiment.requestedVersionId !== null && isUndisclosedProviderVersion(experiment.executedVersionId);
  const hasOverlay =
    Object.keys(experiment.settings.controls).length > 0 || Object.keys(experiment.settings.controlInput).length > 0;

  // The id is what a written-up ruling cites, so it has to leave the page exactly
  // as stored — bare, with no surrounding label to hand-trim out of the paste.
  const copyId = () => {
    void navigator.clipboard
      .writeText(experiment.id)
      .then(() => toast.push({ title: "Experiment id copied", tone: "success" }))
      .catch(() =>
        toast.push({
          title: "Couldn't copy that id",
          description: "The browser refused clipboard access — select it in the header instead.",
          tone: "error",
        }),
      );
  };

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <BackButton onBack={onBack} />
        <Button size="sm" variant="quiet" onClick={() => setConfirmDelete(true)}>
          Delete experiment
        </Button>
      </div>

      <header className="mb-5">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="prose-display text-xl">{imageLabExperimentKindLabel(experiment.kind)}</h1>
          <Tag tone={chip.tone}>{chip.label}</Tag>
          {experiment.controlKind !== null ? (
            <Tag tone="accent">{imageLabControlKindLabel(experiment.controlKind)}</Tag>
          ) : null}
          {verdictChip ? <Tag tone={verdictChip.tone}>{verdictChip.label}</Tag> : null}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-paper-500">
          <span>id</span>
          <code className="break-all">{experiment.id}</code>
          <Button size="sm" variant="quiet" onClick={copyId} aria-label="Copy experiment id">
            Copy
          </Button>
        </div>
        <p className="mt-1 text-[11px] text-paper-500">
          created {instantText(experiment.createdAt)} · started {instantText(experiment.startedAt)} · finished{" "}
          {instantText(experiment.finishedAt)}
        </p>
      </header>

      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        <LabImage
          label="Identity reference"
          imageId={identityInput?.imageId ?? null}
          pending={false}
          emptyHint="no identity reference was sent"
          onEnlarge={setEnlarged}
        />
        <LabImage
          label="Control fixture"
          imageId={experiment.controlImageId}
          pending={false}
          emptyHint="no control fixture was sent"
          onEnlarge={setEnlarged}
        />
        <LabImage
          label="Result"
          imageId={experiment.resultImageId}
          pending={live}
          emptyHint={experiment.status === "failed" ? "the run failed before an image existed" : "no result yet"}
          onEnlarge={setEnlarged}
        />
      </div>

      {experiment.failureCode !== null ? (
        <section className="mb-6 rounded-card border border-danger-500/40 bg-ink-850 p-4">
          <h2 className="text-xs font-medium tracking-wide text-danger-300 uppercase">Failure</h2>
          <p className="mt-1 text-sm text-paper-300">{imageLabFailureExplanation(experiment.failureCode)}</p>
          <p className="mt-1 text-[11px] text-paper-600">
            code <code className="break-all">{experiment.failureCode}</code>
          </p>
        </section>
      ) : null}

      <section className="mb-6 rounded-card border border-ink-600 bg-ink-850 p-4">
        <h2 className="text-xs font-medium tracking-wide text-paper-400 uppercase">Recorded settings</h2>
        <dl className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Fact label="Model">
            <code className="break-all">{experiment.modelSlug}</code>
          </Fact>
          <Fact label="Requested version">
            <code className="break-all">{experiment.requestedVersionId ?? "—"}</code>
          </Fact>
          <Fact label="Executed version">
            <code className="break-all">{experiment.executedVersionId ?? "—"}</code>
          </Fact>
          <Fact label="Profile">
            <code className="break-all">{experiment.profileId ?? "— (a probe resolves none)"}</code>
          </Fact>
          <Fact label="Prediction">
            <code className="break-all">{experiment.predictionId ?? "—"}</code>
          </Fact>
          <Fact label="Mode">{experiment.mode ?? "— (Stage 0 declares none)"}</Fact>
          <Fact label="Character">
            <code className="break-all">{experiment.characterId ?? "—"}</code>
          </Fact>
          <Fact label="Chat">
            <code className="break-all">{experiment.chatId ?? "—"}</code>
          </Fact>
          <Fact label="Control fixture">
            <code className="break-all">{experiment.controlImageId ?? "—"}</code>
          </Fact>
        </dl>
        {versionsDisagree ? (
          <p className="mt-3 text-xs text-danger-300">
            The provider ran a different version than this run pinned. Treat anything concluded from it as suspect until
            the pin is re-resolved.
          </p>
        ) : versionUndisclosed ? (
          <p className="mt-3 text-xs text-paper-500">
            The provider does not disclose which version ran; the requested pin was validated when the prediction was
            created.
          </p>
        ) : null}
        <div className="mt-4">
          <h3 className="text-[11px] tracking-wide text-paper-500 uppercase">
            Ordered inputs ({experiment.inputs.length})
          </h3>
          {experiment.inputs.length === 0 ? (
            <p className="mt-1 text-xs text-paper-500">None recorded — a baseline orders its own references.</p>
          ) : (
            <ol className="mt-1 flex flex-col gap-1 text-xs text-paper-300">
              {experiment.inputs.map((input) => (
                <li key={input.position}>
                  <span className="text-paper-500">Image {input.position} —</span> {imageLabRoleLabel(input.role)}{" "}
                  <code className="break-all text-paper-500">{input.imageId}</code>
                  {input.note ? <span className="text-paper-500"> · {input.note}</span> : null}
                </li>
              ))}
            </ol>
          )}
        </div>
        <div className="mt-4">
          <h3 className="text-[11px] tracking-wide text-paper-500 uppercase">Per-experiment overlay</h3>
          {hasOverlay ? (
            <pre className="mt-1 overflow-x-auto rounded-card border border-ink-700 bg-ink-950/60 p-2 text-[11px] text-paper-300">
              {JSON.stringify(experiment.settings, null, 2)}
            </pre>
          ) : (
            <p className="mt-1 text-xs text-paper-500">None — the run sent no normalized control and no raw key.</p>
          )}
        </div>
      </section>

      <section className="mb-6 flex flex-col gap-3">
        <div>
          <h2 className="text-xs font-medium tracking-wide text-paper-400 uppercase">Instruction (as approved)</h2>
          <p className="mt-1 rounded-card border border-ink-600 bg-ink-950/40 px-3 py-2 text-sm whitespace-pre-wrap text-paper-300">
            {experiment.instruction.trim() === "" ? "—" : experiment.instruction}
          </p>
        </div>
        <div>
          <h2 className="text-xs font-medium tracking-wide text-paper-400 uppercase">Final prompt (as sent)</h2>
          <p className="mt-1 rounded-card border border-ink-600 bg-ink-950/40 px-3 py-2 text-sm whitespace-pre-wrap text-paper-300">
            {experiment.finalPrompt ?? "— not recorded yet"}
          </p>
        </div>
      </section>

      {experiment.kind === "control_probe" && experiment.status === "succeeded" ? (
        <section className="mb-6 rounded-card border border-ink-600 bg-ink-850 p-4">
          <h2 className="text-xs font-medium tracking-wide text-paper-400 uppercase">Probe verdict</h2>
          <p className="mt-1 mb-3 text-sm text-paper-400">
            Judge the output against the fixture: limb for limb, and identity preserved. This ruling decides whether the
            plan runs on this model or on a second connector.
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Ruling"
              hint={
                verdict === ""
                  ? "Nothing is pre-judged — pick the ruling the output actually earned."
                  : imageLabVerdictHint(verdict)
              }
            >
              {(id) => (
                <Select
                  id={id}
                  value={verdict}
                  onChange={(e) => setVerdict(e.target.value as ImageLabProbeVerdict | "")}
                >
                  <option value="">— Choose a ruling —</option>
                  {imageLabProbeVerdicts.map((entry) => (
                    <option key={entry} value={entry}>
                      {imageLabVerdictLabel(entry)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Note" hint="Required — what you saw. A ruling with nothing beside it is unreadable in six months.">
              {(id) => (
                <Textarea id={id} rows={3} value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} />
              )}
            </Field>
          </div>
          <div className="mt-3 flex items-center gap-3">
            <Button
              variant="primary"
              busy={recording}
              disabled={verdict === "" || note.trim() === ""}
              onClick={() => void record()}
            >
              {experiment.verdict === null ? "Record verdict" : "Update verdict"}
            </Button>
            {experiment.verdict !== null ? (
              <p className="text-[11px] text-paper-500">
                Recorded as {imageLabVerdictLabel(experiment.verdict)}
                {experiment.verdictNote ? ` — ${experiment.verdictNote}` : ""}
              </p>
            ) : null}
          </div>
        </section>
      ) : null}

      <Dialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title="Delete this experiment?"
        footer={
          <>
            <Button onClick={() => setConfirmDelete(false)}>Cancel</Button>
            <Button variant="danger" busy={deleting} onClick={() => void remove()}>
              Delete
            </Button>
          </>
        }
      >
        The record, its verdict, and the image it rendered are removed. Fixtures it used are not touched.
      </Dialog>

      <ImageLightbox
        imageId={enlarged}
        alt={imageLabExperimentKindLabel(experiment.kind)}
        prompt={enlarged !== null && enlarged === experiment.resultImageId ? experiment.finalPrompt : null}
        onClose={() => setEnlarged(null)}
      />
    </div>
  );
}

function BackButton({ onBack }: { onBack: () => void }) {
  return (
    <Button size="sm" variant="quiet" onClick={onBack}>
      ← All experiments
    </Button>
  );
}
