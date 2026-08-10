"use client";

import { charactersApi, imageUrl, type ApiResult, type CharacterSummary, type ImageRecord } from "@/lib/client/api";
import { useAsyncData, type AsyncState } from "@/components/hooks/use-async";
import { Field } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { cx } from "@/components/ui/cx";

/**
 * The pickers both halves of the Advanced Image Lab need: whose renders to work
 * from, which render, and which stored image a slot points at.
 *
 * They live in one file because the fixtures panel and the experiment form ask
 * the same two questions — "which character?" then "which of their portraits?" —
 * and a second copy of either would be a copy that drifts (the fixtures panel
 * extracting from ready renders while the form offered pending ones would be
 * invisible until a run failed with `input_missing`).
 */

/** The admin's own characters, by name. */
export function useLabCharacters(): AsyncState<CharacterSummary[]> {
  return useAsyncData(() => charactersApi.list({ sort: "name" }), []);
}

const NO_PORTRAITS: ApiResult<ImageRecord[]> = { ok: true, data: [] };

/**
 * One character's usable source renders — READY rows only.
 *
 * A pending row has no bytes to extract from and a failed row has none at all,
 * so offering either would buy a refusal several minutes later instead of a
 * shorter list now. An empty `characterId` resolves to an empty list without a
 * request, so the panel can render its picker before anything is chosen.
 */
export function useLabPortraits(characterId: string): AsyncState<ImageRecord[]> {
  return useAsyncData<ImageRecord[]>(async () => {
    if (characterId === "") return NO_PORTRAITS;
    const result = await charactersApi.portraits(characterId);
    if (!result.ok) return result;
    return { ok: true, data: result.data.portraits.filter((image) => image.status === "ready") };
  }, [characterId]);
}

export function LabCharacterSelect({
  id,
  characters,
  value,
  onChange,
}: {
  id?: string;
  characters: CharacterSummary[];
  value: string;
  onChange: (characterId: string) => void;
}) {
  return (
    <Select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">— Choose a character —</option>
      {characters.map((character) => (
        <option key={character.id} value={character.id}>
          {character.name}
        </option>
      ))}
    </Select>
  );
}

/** One selectable image tile. */
export interface ImageChoice {
  imageId: string;
  /** The tile's caption — what this image is. */
  label: string;
  /** A second, quieter line (provenance, prompt, timestamp). */
  detail?: string | null;
}

const FIT_CLASS = { cover: "object-cover", contain: "object-contain" } as const;
export type ImageChoiceFit = keyof typeof FIT_CLASS;

/**
 * A grid of image tiles, one of which is chosen.
 *
 * `fit` is not styling trivia: a portrait is cropped to its tile (`cover`)
 * because its subject is centred, while a control fixture must be shown WHOLE
 * (`contain`) — a skeleton with its arms cropped off is exactly the fixture an
 * admin must be able to reject before spending a render on it.
 */
export function ImageChoiceGrid({
  choices,
  value,
  onChange,
  fit = "cover",
  emptyHint,
}: {
  choices: ImageChoice[];
  value: string | null;
  onChange: (imageId: string) => void;
  fit?: ImageChoiceFit;
  emptyHint: string;
}) {
  if (choices.length === 0) {
    return <p className="text-sm text-paper-500">{emptyHint}</p>;
  }
  return (
    <div className="grid grid-cols-3 gap-2 sm:grid-cols-5 lg:grid-cols-6">
      {choices.map((choice) => {
        const selected = choice.imageId === value;
        return (
          <button
            key={choice.imageId}
            type="button"
            onClick={() => onChange(choice.imageId)}
            aria-pressed={selected}
            title={choice.detail ?? choice.label}
            className={cx(
              "group overflow-hidden rounded-card border text-left transition-colors",
              selected ? "border-accent-500" : "border-ink-600 hover:border-ink-500",
            )}
          >
            {/* eslint-disable-next-line @next/next/no-img-element -- local asset route at natural size; next/image adds nothing here */}
            <img
              src={imageUrl(choice.imageId)}
              alt={choice.label}
              className={cx("aspect-[3/4] w-full bg-ink-950", FIT_CLASS[fit])}
            />
            <span className="block truncate px-1.5 py-1 text-[11px] text-paper-400">{choice.label}</span>
            {choice.detail ? (
              <span className="block truncate px-1.5 pb-1 text-[10px] text-paper-600">{choice.detail}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

/** How one render is captioned wherever the lab names it: variant kind, else asset kind. */
export function labRenderLabel(image: ImageRecord): string {
  return image.meta?.variantKind?.trim() || image.kind.replaceAll("_", " ");
}

/**
 * "Which of this character's renders?" — the fixtures panel's extraction source
 * and the experiment form's identity reference are the same question, asked in
 * two places, and they must offer the same answers.
 *
 * Clicking the chosen tile again clears it, because both callers have a
 * legitimate "none" (a skeleton drawn over nothing; a probe testing structure
 * with no identity to preserve) and a picker with no way back to empty would
 * hide it.
 */
export function LabRenderPicker({
  label,
  hint,
  characterId,
  portraits,
  value,
  onChange,
}: {
  label: string;
  hint: string;
  characterId: string;
  portraits: AsyncState<ImageRecord[]>;
  value: string | null;
  onChange: (imageId: string | null) => void;
}) {
  return (
    <Field label={label} hint={hint}>
      {portraits.loading && characterId !== "" ? (
        <Skeleton className="h-20 w-full" />
      ) : (
        <ImageChoiceGrid
          choices={(portraits.data ?? []).map((image) => ({
            imageId: image.id,
            label: labRenderLabel(image),
            detail: image.prompt || null,
          }))}
          value={value}
          onChange={(imageId) => onChange(imageId === value ? null : imageId)}
          emptyHint={characterId === "" ? "Choose a character first." : "This character has no finished renders yet."}
        />
      )}
    </Field>
  );
}
