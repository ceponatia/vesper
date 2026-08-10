"use client";

import { useState } from "react";
import { imageLabControlKinds, type ImageLabControl, type ImageLabControlKind } from "@/contracts";
import { imageLabApi, imageUrl, type ApiError } from "@/lib/client/api";
import { Button } from "@/components/ui/button";
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
 * a disputed `ignores_control` verdict is re-examined against.
 */

/** A hand-drawn skeleton is a small PNG; anything this size is a mistake. */
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export interface ImageLabFixturesPanelProps {
  controls: ImageLabControl[];
  loading: boolean;
  error: ApiError | null;
  /** An extraction is queued and its fixtures have not landed yet. */
  extracting: boolean;
  onReload: () => void;
  /** How many NEW fixtures the accepted extraction promised (jobs × kinds). */
  onExtractQueued: (expectedFixtures: number) => void;
  onUploaded: () => void;
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
  onUploaded,
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
      setFileError("That file is too large (max 10 MB).");
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
    onUploaded();
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
            <figure key={control.imageId} className="overflow-hidden rounded-card border border-ink-600">
              <button
                type="button"
                onClick={() => setEnlarged(control.imageId)}
                aria-label={`Enlarge ${imageLabControlKindLabel(control.meta.controlKind)}`}
                className="block w-full cursor-pointer"
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- local asset route; a fixture must be shown whole, uncropped */}
                <img
                  src={imageUrl(control.imageId)}
                  alt={imageLabControlKindLabel(control.meta.controlKind)}
                  className="aspect-square w-full bg-ink-950 object-contain"
                />
              </button>
              <figcaption className="flex flex-col gap-1 px-2 py-1.5 text-[11px] text-paper-400">
                <span className="flex flex-wrap items-center gap-1">
                  <Tag tone="accent">{imageLabControlKindLabel(control.meta.controlKind)}</Tag>
                  <Tag>{imageLabControlGeneratorLabel(control.meta.generator)}</Tag>
                </span>
                <span className="flex flex-wrap items-center gap-1">
                  {control.meta.reviewedAt ? <Tag tone="ok">reviewed</Tag> : <Tag>unreviewed</Tag>}
                  <span className="text-paper-600">{new Date(control.createdAt).toLocaleDateString()}</span>
                </span>
                {control.meta.reviewNote ? (
                  <span className="truncate text-paper-500" title={control.meta.reviewNote}>
                    {control.meta.reviewNote}
                  </span>
                ) : null}
              </figcaption>
            </figure>
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
            characterId={characterId}
            portraits={portraits}
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
          <Field label="Note" hint="Optional — what this fixture is for.">
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
          <Field label="File" hint="A skeleton, depth map, or edge map you drew. Filed as hand-drawn — the route never takes your word for provenance.">
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
          <Field label="Note" hint="Optional — how it was drawn.">
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
