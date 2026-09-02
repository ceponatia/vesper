"use client";

import { useState, type ReactNode } from "react";
import {
  type ImageLabExperiment,
  type ImageLabVerdict,
  imageLabVerdictOptions,
  isImageLabControlledKind,
  isUndisclosedProviderVersion,
  providerVersionsDisagree,
} from "@vesper/image-core";
import { imageLabApi, imageUrl } from "@/lib/client/api";
import { useAsyncData } from "@/components/hooks/use-async";
import { usePollWhile } from "@/components/hooks/use-poll-while";
import { Button } from "@/components/ui/button";
import { cx } from "@/components/ui/cx";
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
  imageLabDropReasonExplanation,
  imageLabExperimentKindLabel,
  imageLabFailureExplanation,
  imageLabModeLabel,
  imageLabRoleLabel,
  imageLabStatusChip,
  imageLabVerdictChip,
  imageLabVerdictHint,
  imageLabVerdictLabel,
} from "./image-lab-copy";
import type { ImageLabExperimentPrefill } from "./image-lab-experiment-form";

/**
 * One experiment, whole: what was sent, what came back, and — for the kinds
 * that declare a control — the ruling the whole protocol exists to produce.
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
 *
 * A controlled run additionally shows the recorded `outcome` — what the
 * reference plan decided — because the intent path TRIMS instead of refusing,
 * so the ordered inputs alone no longer say what the provider received.
 *
 * A FINISHING PASS is laid out as the pair it is: the render it refined, the
 * identity reference it was refined toward, and its own result, left to right in
 * the order they are read. It cites its source experiment as a record rather
 * than as an image, because the comparison the plan asks for is between three
 * runs and their settings, not three pictures.
 *
 * A TWO-CHARACTER SCENE shows one identity panel per character instead of one
 * "the identity reference", and shows a control panel only when it actually
 * declared a fixture — its control is optional, so an empty panel would read as a
 * missing input rather than as the arm it is. Every ordered input carrying a
 * character binding names it, because the rulings this kind offers ("identities
 * swapped", "character duplicated") are claims about which reference was supposed
 * to produce which person.
 *
 * A STAGED SCENE shows the staging it was told to render — the registry id, the
 * scene facts the row states around it, and which arm described its subject —
 * and shows NO control panel, because
 * it declares no fixture and the empty box would read as a missing input on a
 * kind that cannot have one. Its final prompt carries more weight here than
 * anywhere else on this page: the row's instruction is empty by construction, so
 * the compiled prompt is the only place the words that were actually sent exist,
 * and every staged ruling is a ruling about what those words produced.
 */

const POLL_MS = 3000;

export interface ImageLabExperimentDetailProps {
  experimentId: string;
  onBack: () => void;
  onDeleted: () => void;
  /**
   * The paired-baseline hand-off: values for the create form, applied by the
   * caller (which owns both views). Pre-fill only — nothing is submitted here.
   */
  onRunBaseline: (prefill: ImageLabExperimentPrefill) => void;
  /** Open another experiment — the finishing pass's citation of the run it refines. */
  onOpenExperiment: (experimentId: string) => void;
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

/**
 * The one way an image is shown on this page: whole (never cropped — a control
 * map judged on a cropped thumbnail is a wrong ruling), and enlargeable into the
 * shared lightbox. Both the big panels and the ordered-input strip render
 * through this, so an input can never be less viewable than a panel.
 */
function EnlargeableImage({
  imageId,
  label,
  onEnlarge,
}: {
  imageId: string;
  label: string;
  onEnlarge: (imageId: string) => void;
}) {
  // An experiment outlives the assets it cites: deleting a control fixture drops
  // its image row and deliberately leaves the ordered inputs intact, so the
  // asset route can 404 under a perfectly valid record. A broken tile would read
  // as "the bench lost your reference"; say the asset is gone, and keep the id
  // beside it (rendered by the caller) so the record still cites what ran.
  const [missing, setMissing] = useState<string | null>(null);
  // Render-adjust: a different id is a different question, so re-ask it.
  if (missing !== null && missing !== imageId) setMissing(null);

  if (missing === imageId) {
    return (
      <div className="flex aspect-[3/4] w-full items-center justify-center rounded-card border border-dashed border-ink-600 px-2 text-center text-[11px] text-paper-600">
        this image no longer exists
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => onEnlarge(imageId)}
      aria-label={`Enlarge ${label}`}
      className="block w-full cursor-pointer overflow-hidden rounded-card border border-ink-600"
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- local asset route; a control map must be shown whole */}
      <img
        src={imageUrl(imageId)}
        alt={label}
        onError={() => setMissing(imageId)}
        className="aspect-[3/4] w-full bg-ink-950 object-contain"
      />
    </button>
  );
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
        <EnlargeableImage imageId={imageId} label={label} onEnlarge={onEnlarge} />
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

export function ImageLabExperimentDetail({
  experimentId,
  onBack,
  onDeleted,
  onRunBaseline,
  onOpenExperiment,
}: ImageLabExperimentDetailProps) {
  const toast = useToast();
  const detail = useAsyncData(() => imageLabApi.experiments.detail(experimentId), [experimentId]);

  // Unset until someone picks. On a bench whose whole output is trustworthy
  // rulings, the most favourable ruling must never be the one a distracted click
  // records by default — an unchosen verdict has to be indistinguishable from
  // no verdict, which a pre-selected option cannot be.
  const [verdict, setVerdict] = useState<ImageLabVerdict | "">("");
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
  // The rulings THIS kind may record — the contract's gate, never a local guess.
  const verdictOptions = imageLabVerdictOptions(experiment.kind);
  const isFinishing = experiment.kind === "finishing_pass";
  const isTwoCharacter = experiment.kind === "two_character_scene";
  const isStaged = experiment.kind === "staged_scene";
  // What this run staged, as the ROW holds it. Deliberately not resolved back
  // against the staging registry for the reason the LoRA selection below is not
  // resolved against the library: the registry is code that moves between
  // deploys, and a display that went and looked would describe the entry as it is
  // TODAY rather than the act this render was asked for. The id is the citation,
  // and the compiled final prompt further down is the words as sent.
  const staging = experiment.staging;
  // A finishing pass is read as a before/after pair, so the panel that holds a
  // control fixture on every other kind holds the render being refined here.
  const beforeInput = experiment.inputs.find((input) => input.role === "before") ?? null;
  const versionsDisagree = providerVersionsDisagree(experiment.requestedVersionId, experiment.executedVersionId);
  const versionUndisclosed =
    experiment.requestedVersionId !== null && isUndisclosedProviderVersion(experiment.executedVersionId);
  const hasOverlay =
    Object.keys(experiment.settings.controls).length > 0 || Object.keys(experiment.settings.controlInput).length > 0;
  // The LoRA this run asked for, as the RECORD holds it: a library id and the
  // scale it was sent at. Deliberately not resolved back into a label or a
  // locator here — the library is editable and a row can be deleted, so a
  // display that went and looked would describe the library as it is now rather
  // than the weights this run was configured with.
  const loraSelection = experiment.settings.controls.lora ?? null;
  // Which ARM a finishing pass ran. Null means the pass declared none, which the
  // runner reads as the identity arm — so only the isolating arm is worth a line,
  // and the absence of that line means what every pass before Stage 5 meant.
  const loraOnlyArm = experiment.finishingVariant === "lora_only";

  // A two-character scene sent one identity reference PER character, and the
  // panels are what a swapped or duplicated cast is read from — a single
  // "identity reference" panel would name one of the two people as THE identity
  // and hide the other. The fallback is every other kind's one panel, which also
  // catches a two-character row whose inputs no longer parse.
  const identityInputs = experiment.inputs.filter((input) => input.role === "identity");
  const identityPanels =
    isTwoCharacter && identityInputs.length > 0
      ? identityInputs.map((input, index) => ({
          key: `identity-${String(input.position)}`,
          label: `Identity ${String(index + 1)} (Image ${String(input.position)})`,
          imageId: input.imageId,
        }))
      : [{ key: "identity", label: "Identity reference", imageId: identityInput?.imageId ?? null }];
  // The two-character fixture is OPTIONAL, so an uncontrolled run shows no
  // control panel rather than an empty one — a dashed box captioned "no control
  // fixture was sent" reads as a missing input on the one kind where sending none
  // is a deliberate arm.
  // A staged scene declares no fixture at all — its recipe has no slot to send one
  // under — so it is excluded for the same reason, one step further: not "sent
  // none this time" but "never sends one".
  const showsControlPanel =
    !isFinishing && !isStaged && !(isTwoCharacter && experiment.controlImageId === null);
  const panelCount = (isFinishing ? 1 : 0) + identityPanels.length + (showsControlPanel ? 1 : 0) + 1;

  // What this kind's ruling is ABOUT, and what it decides. Both are read before
  // the vocabulary is offered, because a ruling picked against the wrong question
  // is a misfiled ruling.
  const verdictLead = isFinishing
    ? "Read the after against the before, in that order: did the face get closer to the identity reference, and did anything else move? A pass is only promotable when the first is yes and the second is no."
    : isTwoCharacter
      ? "Count the people first, then match each face to its own reference: both characters present exactly once, each rendered from the reference bound to them."
      : isStaged
        ? "Read the picture against the act the staging named, narrowing in that order: is it that act at all, is the anatomy the act needs actually drawn, are the bodies arranged the way the words say, and is it this character. The first question that answers no is the ruling."
        : "Judge the output against the fixture: limb for limb, and identity preserved.";
  const verdictStake =
    experiment.kind === "control_probe"
      ? "This ruling decides whether the plan runs on this model or on a second connector."
      : isFinishing
        ? "This ruling decides whether a finishing pass earns its render at all."
        : isTwoCharacter
          ? "This ruling says whether two identities can share one render without swapping, duplicating, or losing one."
          : isStaged
            ? "This ruling decides where the next run goes: withheld anatomy says try a higher scale, wrong geometry a lower one, and a substituted act says the wording is the problem and the weights are not."
            : "This ruling says whether the control still held in a production-shaped run.";

  // The paired direct-edit arm: pre-fill only, submitted by the admin. The
  // instruction travels VERBATIM because the shared text is what makes the two
  // runs a comparison (the baseline runner's own rule); the subject id rides
  // along so the evidence files against the same character or conversation.
  // Only reachable from the succeeded-controlled section below, so the kind
  // mapping never sees a probe or baseline.
  const runBaseline = () => {
    toast.push({
      title: "Baseline form pre-filled",
      description: "Review the pre-filled experiment form and run it yourself — nothing was submitted.",
      tone: "success",
    });
    onRunBaseline({
      kind: experiment.kind === "controlled_portrait" ? "baseline_portrait" : "baseline_scene",
      characterId: experiment.characterId ?? undefined,
      chatId: experiment.chatId ?? undefined,
      instruction: experiment.instruction,
      fromExperimentId: experiment.id,
    });
  };

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
          {/* The act, beside the kind, in the place the control kind sits on the
              kinds that declare one: on a staged row it is the single fact that
              says what this render was for, and "staged scene" alone does not. */}
          {staging !== null ? <Tag tone="accent">{staging.id}</Tag> : null}
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

      {/* Four panels — two identities, a fixture, and the result — get a row of
          their own on a wide screen; three still read best as thirds. */}
      <div className={cx("mb-6 grid gap-3 sm:grid-cols-3", panelCount > 3 ? "lg:grid-cols-4" : null)}>
        {isFinishing ? (
          <LabImage
            label="Before (the source's result)"
            imageId={beforeInput?.imageId ?? null}
            pending={live}
            emptyHint="the base render is resolved when the pass runs"
            onEnlarge={setEnlarged}
          />
        ) : null}
        {identityPanels.map((panel) => (
          <LabImage
            key={panel.key}
            label={panel.label}
            imageId={panel.imageId}
            // The LoRA-only arm never resolves one, so it is not pending — it is
            // absent by design, and a spinner there would promise an image that is
            // never coming.
            pending={isFinishing && !loraOnlyArm && live}
            emptyHint={
              loraOnlyArm
                ? "this arm sends none — the likeness comes from the LoRA"
                : isFinishing
                  ? "the pack's reference is resolved when the pass runs"
                  : "no identity reference was sent"
            }
            onEnlarge={setEnlarged}
          />
        ))}
        {showsControlPanel ? (
          <LabImage
            label="Control fixture"
            imageId={experiment.controlImageId}
            pending={false}
            emptyHint="no control fixture was sent"
            onEnlarge={setEnlarged}
          />
        ) : null}
        <LabImage
          label={isFinishing ? "After (this pass)" : "Result"}
          imageId={experiment.resultImageId}
          pending={live}
          emptyHint={experiment.status === "failed" ? "the run failed before an image existed" : "no result yet"}
          onEnlarge={setEnlarged}
        />
      </div>

      {experiment.sourceExperimentId !== null ? (
        <section className="mb-6 rounded-card border border-ink-600 bg-ink-850 p-4">
          <h2 className="text-xs font-medium tracking-wide text-paper-400 uppercase">Source experiment</h2>
          <p className="mt-1 text-sm text-paper-400">
            This pass re-edits that run&apos;s result. The plan&apos;s comparison is read across three images — the
            direct-edit baseline, the controlled result, and this — so the run behind the &ldquo;before&rdquo; panel is
            part of the evidence, not just its provenance.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <code className="text-[11px] break-all text-paper-500">{experiment.sourceExperimentId}</code>
            <Button
              size="sm"
              onClick={() => {
                if (experiment.sourceExperimentId !== null) onOpenExperiment(experiment.sourceExperimentId);
              }}
            >
              Open source experiment
            </Button>
          </div>
        </section>
      ) : null}

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
            <code className="break-all">
              {experiment.profileId ?? "— (probes resolve none; a controlled run cites its recipe below)"}
            </code>
          </Fact>
          <Fact label="Prediction">
            <code className="break-all">{experiment.predictionId ?? "—"}</code>
          </Fact>
          <Fact label="Mode">
            {experiment.mode === null ? "— (none declared; probes and baselines never do)" : imageLabModeLabel(experiment.mode)}
          </Fact>
          <Fact label="Character">
            <code className="break-all">{experiment.characterId ?? "—"}</code>
          </Fact>
          <Fact label="Chat">
            <code className="break-all">{experiment.chatId ?? "—"}</code>
          </Fact>
          <Fact label="Control fixture">
            <code className="break-all">{experiment.controlImageId ?? "—"}</code>
          </Fact>
          {/* The staged row's own four facts. The three scene fields are shown
              even when absent, saying what the lane defaulted them to instead of
              hiding the question: an admin comparing two staged runs has to be
              able to see that one stated a room and the other did not. */}
          {staging !== null ? (
            <>
              <Fact label="Staging">
                <code className="break-all">{staging.id}</code>
              </Fact>
              <Fact label="Setting">{staging.setting ?? "— (the lane's own empty backdrop)"}</Fact>
              <Fact label="Lighting">{staging.lighting ?? "— (derived from the time of day)"}</Fact>
              <Fact label="Time of day">{staging.timeOfDay ?? "— (none stated)"}</Fact>
            </>
          ) : null}
          {loraSelection !== null ? (
            <Fact label="LoRA">
              <code className="break-all">
                {loraSelection.scale === undefined
                  ? loraSelection.id
                  : `${loraSelection.id} @ ${String(loraSelection.scale)}`}
              </code>
            </Fact>
          ) : null}
          {loraOnlyArm ? (
            <Fact label="Finishing variant">
              {"LoRA only, no identity reference — the face was corrected from the weights alone, so an improvement " +
                "here is attributable to them and not to the identity pack."}
            </Fact>
          ) : null}
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
          <p className="mt-1 text-xs text-paper-500">
            Every reference the run ordered, shown — a slot judged from its id alone is a slot nobody judged.
          </p>
          {experiment.inputs.length === 0 ? (
            <p className="mt-1 text-xs text-paper-500">None recorded — a baseline orders its own references.</p>
          ) : (
            <ol className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {experiment.inputs.map((input) => {
                const slot = `Image ${String(input.position)}`;
                // A slot BOUND to a character says which face was supposed to
                // land on whom, and that is the fact a swapped-identities ruling
                // is written against: two tiles both captioned "identity
                // reference" cannot tell one cast member from the other. The id is
                // shown whole, like every id on this page — a ruling cites what the
                // record stores, and the character list is not fetched here.
                const label =
                  input.characterId === undefined
                    ? `${slot} — ${imageLabRoleLabel(input.role)}`
                    : `${slot} — ${imageLabRoleLabel(input.role)} for character ${input.characterId}`;
                return (
                  <li key={input.position} className="flex flex-col gap-1">
                    <EnlargeableImage imageId={input.imageId} label={label} onEnlarge={setEnlarged} />
                    <p className="text-[11px] text-paper-300">
                      <span className="text-paper-500">{slot}</span>
                      {" — "}
                      {imageLabRoleLabel(input.role)}
                    </p>
                    <code className="text-[10px] break-all text-paper-500">{input.imageId}</code>
                    {input.characterId !== undefined ? (
                      <p className="text-[10px] text-paper-500">
                        {"bound to character "}
                        <code className="break-all">{input.characterId}</code>
                      </p>
                    ) : null}
                    {input.note !== undefined && input.note !== "" ? (
                      <p className="text-[11px] text-paper-500">{input.note}</p>
                    ) : null}
                  </li>
                );
              })}
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

      {experiment.outcome !== null ? (
        <section className="mb-6 rounded-card border border-ink-600 bg-ink-850 p-4">
          <h2 className="text-xs font-medium tracking-wide text-paper-400 uppercase">Reference plan</h2>
          <p className="mt-1 text-sm text-paper-400">
            What the plan actually decided on the intent path — recorded by the runner so a verdict judges what the
            provider received, not what the form ordered.
          </p>
          <dl className="mt-3">
            <Fact label="Recipe">
              {experiment.outcome.recipeKey !== undefined ? (
                <code className="break-all">{experiment.outcome.recipeKey}</code>
              ) : (
                "— (the lane's own resolved profile, not a recipe)"
              )}
            </Fact>
          </dl>
          <div className="mt-3">
            <h3 className="text-[11px] tracking-wide text-paper-500 uppercase">
              Sent roles ({experiment.outcome.sentRoles.length})
            </h3>
            {experiment.outcome.sentRoles.length === 0 ? (
              <p className="mt-1 text-xs text-paper-500">None recorded.</p>
            ) : (
              <ol className="mt-1 flex flex-col gap-0.5 text-xs text-paper-300">
                {experiment.outcome.sentRoles.map((role, index) => (
                  <li key={`${String(index)}-${role}`}>
                    <span className="text-paper-500">Image {index + 1} —</span> {imageLabRoleLabel(role)}
                  </li>
                ))}
              </ol>
            )}
          </div>
          {experiment.outcome.dropped.length > 0 ? (
            <div className="mt-3">
              <h3 className="text-[11px] tracking-wide text-paper-500 uppercase">
                Dropped references ({experiment.outcome.dropped.length})
              </h3>
              <ul className="mt-1 flex flex-col gap-1 text-xs text-paper-300">
                {experiment.outcome.dropped.map((drop, index) => (
                  <li key={`${String(index)}-${drop.role}`}>
                    {imageLabRoleLabel(drop.role)} — {imageLabDropReasonExplanation(drop.reason)}
                    {drop.sourceImageId !== undefined ? (
                      <>
                        {" "}
                        · <code className="break-all text-paper-500">{drop.sourceImageId}</code>
                      </>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {experiment.outcome.renumbered ? (
            <p className="mt-3 text-xs text-danger-300">
              A drop or reorder moved later references up: the provider&apos;s numbered slots no longer match the
              ordered inputs above. The compiled prompt numbers what was SENT, so judge slots by the sent roles here,
              not the input list.
            </p>
          ) : null}
        </section>
      ) : null}

      <section className="mb-6 flex flex-col gap-3">
        <div>
          <h2 className="text-xs font-medium tracking-wide text-paper-400 uppercase">Instruction (as approved)</h2>
          <p className="mt-1 rounded-card border border-ink-600 bg-ink-950/40 px-3 py-2 text-sm whitespace-pre-wrap text-paper-300">
            {experiment.instruction.trim() !== ""
              ? experiment.instruction
              : isStaged
                ? "— none, and none was possible: a staged scene writes no instruction, because the registry owns the act's wording and the runner compiles it."
                : "—"}
          </p>
        </div>
        <div>
          <h2 className="text-xs font-medium tracking-wide text-paper-400 uppercase">Final prompt (as sent)</h2>
          <p className="mt-1 rounded-card border border-ink-600 bg-ink-950/40 px-3 py-2 text-sm whitespace-pre-wrap text-paper-300">
            {experiment.finalPrompt ?? "— not recorded yet"}
          </p>
          {/* On every other kind this is a record of what the admin's text became.
              Here it is the only place the words exist at all — the row's
              instruction is empty by construction — and on the parity arm it is
              what the chat lane would have sent for the same staging, which is
              the claim the whole bench rests on. */}
          {isStaged ? (
            <p className="mt-1 text-[11px] text-paper-500">
              {"The whole of what was sent, compiled from the staging registry the way the chat lane compiles it: "}
              {"the staged sentence, the setting and lighting above, the shot line the staging's own camera fixes, "}
              {"and the character's own description on the parity arm (the ablation states nothing but their name). "}
              {"No model wrote any of it, so a ruling above is a ruling on this text and the weights it ran with."}
            </p>
          ) : null}
        </div>
      </section>

      {verdictOptions !== null && experiment.status === "succeeded" ? (
        <section className="mb-6 rounded-card border border-ink-600 bg-ink-850 p-4">
          <h2 className="text-xs font-medium tracking-wide text-paper-400 uppercase">
            {isFinishing
              ? "Finishing verdict"
              : isTwoCharacter
                ? "Two-character verdict"
                : isStaged
                  ? "Staged-act verdict"
                  : "Control verdict"}
          </h2>
          <p className="mt-1 mb-3 text-sm text-paper-400">{`${verdictLead} ${verdictStake}`}</p>
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
                <Select id={id} value={verdict} onChange={(e) => setVerdict(e.target.value as ImageLabVerdict | "")}>
                  <option value="">— Choose a ruling —</option>
                  {verdictOptions.map((entry) => (
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

      {isImageLabControlledKind(experiment.kind) && experiment.status === "succeeded" ? (
        <section className="mb-6 rounded-card border border-ink-600 bg-ink-850 p-4">
          <h2 className="text-xs font-medium tracking-wide text-paper-400 uppercase">Paired baseline</h2>
          <p className="mt-1 mb-3 text-sm text-paper-400">
            A controlled render is read beside a direct-edit arm that shares its instruction — the lane&apos;s own
            configuration, no recipe, no control. This pre-fills the create form with the matching baseline kind and
            this experiment&apos;s instruction, verbatim; nothing runs until you review and submit it there.
          </p>
          <Button onClick={runBaseline}>Run direct-edit baseline</Button>
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
