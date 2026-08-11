"use client";

import { useState, type ReactNode } from "react";
import {
  IMAGE_LAB_UPLOAD_DATA_URL_MAX_CHARS,
  imageLabControlKinds,
  type ImageLabControl,
  type ImageLabControlKind,
} from "@/contracts";
import { imageLabApi, imageUrl, type ApiError } from "@/lib/client/api";
import { Button } from "@/components/ui/button";
import { cx } from "@/components/ui/cx";
import { ErrorState } from "@/components/ui/error-state";
import { Field } from "@/components/ui/field";
import { ImageLightbox } from "@/components/ui/image-lightbox";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tag } from "@/components/ui/tag";
import { useToast } from "@/components/ui/toast";
import { imageLabControlGeneratorLabel, imageLabControlKindLabel } from "./image-lab-copy";
import { LabCharacterSelect, LabRenderPicker, useLabCharacters, useLabPortraits } from "./image-lab-pickers";

/**
 * The control-fixture panel (qwen-advanced-image-subsystem.spec.md §Stage 0
 * control-probe protocol, step 1): extract a pose skeleton or depth map from an
 * existing render, upload a hand-drawn one, and — the step the protocol actually
 * names — LOOK at what came out before a paid probe is built on it.
 *
 * Fixtures are shown whole (`contain`), never cropped, and every tile states its
 * provenance and whether anyone has reviewed it, because those are the two facts
 * a disputed `ignores_control` verdict is re-examined against. The two notes ride
 * the tile as two labelled lines for the same reason they are two meta fields:
 * what a fixture was made for and what reviewing it settled are separate
 * evidence, and either one alone answers the wrong half of the question.
 *
 * The tile is also where the looking is RECORDED — marking a fixture reviewed
 * (with the required note) and throwing away one that came out wrong both happen
 * on the thing being judged, so the ruling and the pixels are never a screen
 * apart.
 */

/**
 * The real ceiling, DERIVED from the route's own cap rather than chosen here.
 *
 * The upload travels as a base64 data URL, and the route refuses a string longer
 * than {@link IMAGE_LAB_UPLOAD_DATA_URL_MAX_CHARS}; base64 carries 3 bytes per 4
 * characters, and the `data:image/…;base64,` prefix rides the same budget. A
 * number typed independently here was the bug this replaces — the picker
 * accepted 10 MB, said so, and the route rejected everything past ~2 MB, so the
 * only file that reached the failure was one the UI had already approved.
 */
const DATA_URL_HEADER_CHARS = 64;
const MAX_UPLOAD_BYTES = Math.floor((IMAGE_LAB_UPLOAD_DATA_URL_MAX_CHARS - DATA_URL_HEADER_CHARS) / 4) * 3;
/** The same number in the words the admin reads, so copy cannot drift from the check. */
const MAX_UPLOAD_LABEL = `${(MAX_UPLOAD_BYTES / (1024 * 1024)).toFixed(1)} MB`;

/** Matches `imageLabControlMetaSchema.reviewNote` — a longer note is truncated by
 * the field rather than refused by the route. */
const MAX_REVIEW_NOTE = 2000;

export interface ImageLabFixturesPanelProps {
  controls: ImageLabControl[];
  loading: boolean;
  error: ApiError | null;
  /** An extraction is queued and its fixtures have not landed yet. */
  extracting: boolean;
  onReload: () => void;
  /** How many NEW fixtures the accepted extraction promised (jobs × kinds). */
  onExtractQueued: (expectedFixtures: number) => void;
  /**
   * The stored fixture list changed under us — an upload landed, a fixture was
   * reviewed, or one was deleted. One callback for all three because the panel
   * owns none of the list: every change is settled by refetching it.
   */
  onControlsChanged: () => void;
}

function toggledKind(current: readonly ImageLabControlKind[], kind: ImageLabControlKind): ImageLabControlKind[] {
  return current.includes(kind) ? current.filter((entry) => entry !== kind) : [...current, kind];
}

export function ImageLabFixturesPanel({
  controls,
  loading,
  error,
  extracting,
  onReload,
  onExtractQueued,
  onControlsChanged,
}: ImageLabFixturesPanelProps) {
  const toast = useToast();
  const characters = useLabCharacters();

  const [characterId, setCharacterId] = useState("");
  const [sourceImageId, setSourceImageId] = useState<string | null>(null);
  const portraits = useLabPortraits(characterId);

  const [kinds, setKinds] = useState<ImageLabControlKind[]>(["pose"]);
  const [note, setNote] = useState("");
  const [submittingExtract, setSubmittingExtract] = useState(false);

  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [fileName, setFileName] = useState("");
  const [fileError, setFileError] = useState<string | null>(null);
  const [uploadKind, setUploadKind] = useState<ImageLabControlKind>("pose");
  const [uploadNote, setUploadNote] = useState("");
  const [linkSource, setLinkSource] = useState(true);
  const [uploading, setUploading] = useState(false);

  const [enlarged, setEnlarged] = useState<string | null>(null);

  // A character change invalidates the picked render (render-adjust, so no
  // effect ever writes state synchronously).
  const [prevCharacterId, setPrevCharacterId] = useState(characterId);
  if (characterId !== prevCharacterId) {
    setPrevCharacterId(characterId);
    setSourceImageId(null);
  }

  const readFile = (file: File | undefined) => {
    setFileError(null);
    if (!file) {
      setDataUrl(null);
      setFileName("");
      return;
    }
    if (!file.type.startsWith("image/")) {
      setFileError("Choose an image file.");
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setFileError(`That file is too large (max ${MAX_UPLOAD_LABEL}).`);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result === "string") {
        setDataUrl(result);
        setFileName(file.name);
      } else {
        setFileError("Could not read that file.");
      }
    };
    reader.onerror = () => setFileError("Could not read that file.");
    reader.readAsDataURL(file);
  };

  const extract = async () => {
    if (sourceImageId === null || kinds.length === 0) return;
    setSubmittingExtract(true);
    const result = await imageLabApi.controls.extract({
      sourceImageIds: [sourceImageId],
      controlKinds: kinds,
      note: note.trim() === "" ? undefined : note.trim(),
    });
    setSubmittingExtract(false);
    if (!result.ok) {
      toast.push({ title: "Extraction refused", description: result.error.message, tone: "error" });
      return;
    }
    if (result.data.queued === 0) {
      toast.push({
        title: "Nothing was queued",
        description: "The extractor took no work for that render. Try another source.",
        tone: "error",
      });
      return;
    }
    toast.push({
      title: `Extracting ${kinds.length} fixture(s)`,
      description: "Pose and depth are paid preprocessor runs; edge is computed here.",
    });
    setNote("");
    // One submit names exactly one source render, so what it promises the panel
    // is one fixture per requested kind — a count that reads the same whether
    // `queued` counts jobs or fixtures.
    onExtractQueued(kinds.length);
  };

  const upload = async () => {
    if (dataUrl === null) return;
    setUploading(true);
    const result = await imageLabApi.controls.upload({
      controlKind: uploadKind,
      sourceImageId: linkSource && sourceImageId !== null ? sourceImageId : undefined,
      note: uploadNote.trim() === "" ? undefined : uploadNote.trim(),
      dataUrl,
    });
    setUploading(false);
    if (!result.ok) {
      toast.push({ title: "Upload failed", description: result.error.message, tone: "error" });
      return;
    }
    toast.push({ title: "Fixture uploaded", description: "Filed as hand-drawn.", tone: "success" });
    setDataUrl(null);
    setFileName("");
    setUploadNote("");
    onControlsChanged();
  };

  return (
    <section className="rounded-card border border-ink-600 bg-ink-850 p-5">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="prose-display text-lg">Control fixtures</h2>
          <p className="mt-1 text-sm text-paper-400">
            Pose skeletons, depth maps, and edge maps an experiment can send as a numbered image. Review one before you
            spend a probe on it — a bad fixture and an unresponsive model look identical in the output.
          </p>
        </div>
        <Button size="sm" onClick={onReload}>
          Refresh
        </Button>
      </div>

      {error ? <ErrorState error={error} onRetry={onReload} /> : null}

      {loading && controls.length === 0 ? (
        <Skeleton className="h-24 w-full" />
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
          {extracting ? (
            <figure className="relative overflow-hidden rounded-card border border-ink-600">
              <Skeleton className="aspect-square rounded-none" />
              <figcaption className="absolute inset-x-0 bottom-0 bg-ink-950/80 px-2 py-1.5 text-[11px] text-paper-300">
                <Tag>extracting…</Tag>
              </figcaption>
            </figure>
          ) : null}
          {controls.map((control) => (
            <FixtureCard
              key={control.imageId}
              control={control}
              onEnlarge={setEnlarged}
              onChanged={onControlsChanged}
            />
          ))}
          {controls.length === 0 && !extracting ? (
            <p className="col-span-full text-sm text-paper-500">
              No fixtures yet. Extract one from a render below, or upload a skeleton you drew.
            </p>
          ) : null}
        </div>
      )}

      <div className="mt-6 flex flex-col gap-4 border-t border-ink-700 pt-5">
        <h3 className="text-xs font-medium tracking-wide text-paper-400 uppercase">Source render</h3>
        <div className="grid gap-4 sm:grid-cols-[16rem_1fr]">
          <Field label="Character" hint="Whose renders to work from.">
            {(id) => (
              <LabCharacterSelect
                id={id}
                characters={characters.data ?? []}
                value={characterId}
                onChange={setCharacterId}
              />
            )}
          </Field>
          <LabRenderPicker
            label="Render"
            hint="The image a control map is extracted from — pick a pose clearly unlike the target."
            scopeId={characterId}
            images={portraits}
            value={sourceImageId}
            onChange={setSourceImageId}
          />
        </div>
      </div>

      <div className="mt-6 grid gap-6 border-t border-ink-700 pt-5 lg:grid-cols-2">
        <div className="flex flex-col gap-3">
          <h3 className="text-xs font-medium tracking-wide text-paper-400 uppercase">Extract from the render</h3>
          <Field label="Control kinds" hint="One fixture per kind. Pose and depth each cost a preprocessor run.">
            <div className="flex flex-wrap gap-4">
              {imageLabControlKinds.map((kind) => (
                <label key={kind} className="flex items-center gap-2 text-sm text-paper-300">
                  <input
                    type="checkbox"
                    checked={kinds.includes(kind)}
                    onChange={() => setKinds((current) => toggledKind(current, kind))}
                    className="accent-accent-500"
                  />
                  {imageLabControlKindLabel(kind)}
                </label>
              ))}
            </div>
          </Field>
          <Field label="Note" hint="Optional — what this fixture is for. Kept apart from the review note.">
            {(id) => (
              <Input id={id} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
            )}
          </Field>
          <div>
            <Button
              variant="primary"
              busy={submittingExtract}
              disabled={sourceImageId === null || kinds.length === 0}
              title={sourceImageId === null ? "Pick a source render first" : undefined}
              onClick={() => void extract()}
            >
              Extract from image
            </Button>
          </div>
        </div>

        <div className="flex flex-col gap-3">
          <h3 className="text-xs font-medium tracking-wide text-paper-400 uppercase">Upload a skeleton</h3>
          <Field
            label="File"
            hint={`A skeleton, depth map, or edge map you drew, up to ${MAX_UPLOAD_LABEL}. Filed as hand-drawn — the route never takes your word for provenance.`}
          >
            {(id) => (
              <input
                id={id}
                type="file"
                accept="image/*"
                onChange={(e) => readFile(e.target.files?.[0])}
                className="text-xs text-paper-400 file:mr-3 file:cursor-pointer file:rounded-md file:border file:border-ink-600 file:bg-ink-800 file:px-2.5 file:py-1 file:text-xs file:text-paper-200"
              />
            )}
          </Field>
          {fileError ? <p className="text-xs text-danger-300">{fileError}</p> : null}
          {dataUrl !== null ? (
            <div className="flex items-center gap-3">
              {/* eslint-disable-next-line @next/next/no-img-element -- in-memory data URL preview; next/image cannot serve one */}
              <img src={dataUrl} alt={fileName} className="h-20 w-20 rounded-card border border-ink-600 bg-ink-950 object-contain" />
              <span className="truncate text-xs text-paper-500">{fileName}</span>
            </div>
          ) : null}
          <Field label="Kind" hint="What this image IS — it decides which recipe may use it.">
            {(id) => (
              <Select
                id={id}
                value={uploadKind}
                onChange={(e) => setUploadKind(e.target.value as ImageLabControlKind)}
                className="w-48"
              >
                {imageLabControlKinds.map((kind) => (
                  <option key={kind} value={kind}>
                    {imageLabControlKindLabel(kind)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <label className="flex items-center gap-2 text-sm text-paper-300">
            <input
              type="checkbox"
              checked={linkSource && sourceImageId !== null}
              disabled={sourceImageId === null}
              onChange={() => setLinkSource((on) => !on)}
              className="accent-accent-500"
            />
            {sourceImageId === null ? "Drawn over nothing (no render picked)" : "Drawn over the render picked above"}
          </label>
          <Field label="Note" hint="Optional — how it was drawn. Kept apart from the review note.">
            {(id) => (
              <Input id={id} value={uploadNote} onChange={(e) => setUploadNote(e.target.value)} maxLength={500} />
            )}
          </Field>
          <div>
            <Button variant="primary" busy={uploading} disabled={dataUrl === null} onClick={() => void upload()}>
              Upload skeleton
            </Button>
          </div>
        </div>
      </div>

      <ImageLightbox imageId={enlarged} alt="Control fixture" onClose={() => setEnlarged(null)} />
    </section>
  );
}

const tileActionTones = {
  quiet: "text-paper-400 hover:text-paper-100",
  accent: "text-accent-300 hover:text-accent-200",
  danger: "text-danger-300 hover:text-danger-200",
} as const;

/**
 * A tile-footer action — the dense text button the chat inspector's rows use,
 * deliberately not `Button size="sm"`: three 28px controls do not fit a fixture
 * tile at the six-column breakpoint, and a wrapped row of them would push the
 * provenance chips off the card that exists to show them.
 */
function TileAction({
  tone = "quiet",
  disabled,
  onClick,
  className,
  children,
}: {
  tone?: keyof typeof tileActionTones;
  disabled?: boolean;
  onClick: () => void;
  /** Layout only — a colour or size here would lose to the base classes, whose
   * position in the generated stylesheet decides the winner, not attribute order. */
  className?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cx(
        "cursor-pointer rounded px-1.5 py-0.5 text-[11px] hover:bg-ink-800 disabled:cursor-not-allowed disabled:text-paper-600 disabled:hover:bg-transparent",
        tileActionTones[tone],
        className,
      )}
    >
      {children}
    </button>
  );
}

/**
 * One fixture: the pixels shown whole, what it is, where it came from, and the
 * two rulings an admin makes on it.
 *
 * Both rulings are two-step and neither is a modal. Marking reviewed opens the
 * note field the record requires — `reviewed` with nothing written beside it is
 * indistinguishable from a misclick six months later, which is the same reason
 * the probe verdict's note is required. Deleting asks "really?" in the tile
 * (the chat-inspector idiom) rather than in a dialog, because the thing being
 * confirmed is the image right above the button and a modal would cover it.
 *
 * The draft note lives HERE rather than in the panel because the page silently
 * refetches this list every three seconds while an extraction is pending: tiles
 * are keyed by image id, so a card outlives its list being replaced and a
 * half-written note survives the poll.
 */
function FixtureCard({
  control,
  onEnlarge,
  onChanged,
}: {
  control: ImageLabControl;
  onEnlarge: (imageId: string) => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [reviewing, setReviewing] = useState(false);
  const [reviewNote, setReviewNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const kindLabel = imageLabControlKindLabel(control.meta.controlKind);
  const reviewed = Boolean(control.meta.reviewedAt);
  const busy = saving || deleting;

  const review = async () => {
    const note = reviewNote.trim();
    if (note === "" || busy) return;
    setSaving(true);
    const result = await imageLabApi.controls.review(control.imageId, note);
    setSaving(false);
    if (!result.ok) {
      toast.push({ title: "Couldn't record that review", description: result.error.message, tone: "error" });
      return;
    }
    setReviewing(false);
    setReviewNote("");
    toast.push({ title: "Fixture reviewed", description: kindLabel, tone: "success" });
    onChanged();
  };

  const remove = async () => {
    if (busy) return;
    setDeleting(true);
    const result = await imageLabApi.controls.remove(control.imageId);
    setDeleting(false);
    setConfirmingDelete(false);
    if (!result.ok) {
      toast.push({ title: "Delete failed", description: result.error.message, tone: "error" });
      return;
    }
    toast.push({ title: "Fixture deleted", description: kindLabel, tone: "success" });
    onChanged();
  };

  return (
    <figure className="flex flex-col overflow-hidden rounded-card border border-ink-600">
      <button
        type="button"
        onClick={() => onEnlarge(control.imageId)}
        aria-label={`Enlarge ${kindLabel}`}
        className="block w-full cursor-pointer"
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- local asset route; a fixture must be shown whole, uncropped */}
        <img
          src={imageUrl(control.imageId)}
          alt={kindLabel}
          className="aspect-square w-full bg-ink-950 object-contain"
        />
      </button>
      <figcaption className="flex flex-1 flex-col gap-1 px-2 py-1.5 text-[11px] text-paper-400">
        <span className="flex flex-wrap items-center gap-1">
          <Tag tone="accent">{kindLabel}</Tag>
          <Tag>{imageLabControlGeneratorLabel(control.meta.generator)}</Tag>
        </span>
        <span className="flex flex-wrap items-center gap-1">
          {reviewed ? <Tag tone="ok">reviewed</Tag> : <Tag>unreviewed</Tag>}
          <span className="text-paper-600">{new Date(control.createdAt).toLocaleDateString()}</span>
        </span>
        {/* Both notes, labelled, on their own lines. They answer different
            questions — what this fixture was made for, and what looking at it
            settled — and they are separate meta fields precisely so the second
            cannot overwrite the first. A tile showing one unlabelled note would
            put that distinction back where the bug was: in the reader's head.

            The review line rides `reviewedAt` rather than the note's presence.
            A row written before the two notes split carries its creation note in
            `reviewNote` with no review date and nothing migrates it, so keying
            off the string alone would label a fixture's own reason for existing
            as somebody's ruling — under an `unreviewed` tag, in the one panel
            built to keep those apart. Unreviewed and silent is the true reading. */}
        {control.meta.originNote ? (
          <span className="truncate text-paper-500" title={`Made for: ${control.meta.originNote}`}>
            <span className="text-paper-600">Made for: </span>
            {control.meta.originNote}
          </span>
        ) : null}
        {reviewed && control.meta.reviewNote ? (
          <span className="truncate text-paper-500" title={`Review: ${control.meta.reviewNote}`}>
            <span className="text-paper-600">Review: </span>
            {control.meta.reviewNote}
          </span>
        ) : null}

        {confirmingDelete ? (
          <span className="mt-auto flex flex-wrap items-center gap-0.5 pt-1">
            <TileAction tone="danger" disabled={busy} onClick={() => void remove()}>
              {deleting ? "Deleting…" : "Really delete?"}
            </TileAction>
            <TileAction disabled={busy} onClick={() => setConfirmingDelete(false)}>
              Keep
            </TileAction>
          </span>
        ) : reviewing ? (
          <span className="mt-auto flex flex-col gap-1 pt-1">
            <Input
              value={reviewNote}
              onChange={(e) => setReviewNote(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void review();
                if (e.key === "Escape") setReviewing(false);
              }}
              maxLength={MAX_REVIEW_NOTE}
              placeholder="What you saw"
              aria-label={`Review note for this ${kindLabel}`}
              autoFocus
            />
            <span className="flex flex-wrap items-center gap-0.5">
              <TileAction tone="accent" disabled={busy || reviewNote.trim() === ""} onClick={() => void review()}>
                {saving ? "Saving…" : "Save review"}
              </TileAction>
              <TileAction disabled={busy} onClick={() => setReviewing(false)}>
                Cancel
              </TileAction>
            </span>
          </span>
        ) : (
          <span className="mt-auto flex flex-wrap items-center gap-0.5 pt-1">
            {reviewed ? null : (
              <TileAction tone="accent" onClick={() => setReviewing(true)}>
                Mark reviewed
              </TileAction>
            )}
            <TileAction tone="danger" className="ml-auto" onClick={() => setConfirmingDelete(true)}>
              Delete
            </TileAction>
          </span>
        )}
      </figcaption>
    </figure>
  );
}
