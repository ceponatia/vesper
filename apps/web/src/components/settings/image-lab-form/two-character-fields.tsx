"use client";

import type { CharacterSummary, ImageRecord } from "@/lib/client/api";
import type { AsyncState } from "@/components/hooks/use-async";
import { Field } from "@/components/ui/field";
import { LabCharacterSelect, LabRenderPicker } from "../image-lab-pickers";
import { DEFAULT_MODEL_SLUG } from "./request";
import { FIXTURE_SOURCE_REASON } from "./controlled-fields";

/**
 * One half of a two-character cast: who this character is, and which of their
 * renders carries the face the output must keep.
 *
 * One component rather than two blocks of JSX because the halves differ only in
 * which character they name, and a second copy is exactly how the two slots would
 * come to behave differently about a pick whose list moved under it.
 *
 * `slot` is the letter the whole form calls this half by — the send order is A
 * then B, which is the order the runner's numbered bindings are compiled in.
 */
function LabCastSlot({
  slot,
  characters,
  characterId,
  onCharacterChange,
  portraits,
  imageId,
  onImageChange,
  excluded,
}: {
  slot: "A" | "B";
  characters: CharacterSummary[];
  characterId: string;
  onCharacterChange: (characterId: string) => void;
  portraits: AsyncState<ImageRecord[]>;
  imageId: string | null;
  onImageChange: (imageId: string | null) => void;
  excluded: { imageId: string; reason: string } | null;
}) {
  return (
    <div className="flex flex-col gap-2">
      <Field
        label={`Character ${slot}`}
        hint="The character this half of the scene is about. The other half's pick is not offered here — one person cannot be both."
      >
        {(id) => (
          <LabCharacterSelect
            id={id}
            characters={characters}
            value={characterId}
            onChange={onCharacterChange}
          />
        )}
      </Field>
      <LabRenderPicker
        label={`${slot}'s identity reference`}
        hint="The render whose face this character must keep. Required — the run sends one reference per character."
        scopeId={characterId}
        images={portraits}
        value={imageId}
        onChange={onImageChange}
        excluded={excluded}
      />
    </div>
  );
}

export function LabTwoCharacterFields({
  castAOptions,
  castBOptions,
  characterId,
  setCharacterId,
  characterBId,
  setCharacterBId,
  portraits,
  portraitsB,
  sourceImageId,
  setSourceImageId,
  sourceImageBId,
  setSourceImageBId,
  fixtureSourceId,
}: {
  castAOptions: CharacterSummary[];
  castBOptions: CharacterSummary[];
  characterId: string;
  setCharacterId: (value: string) => void;
  characterBId: string;
  setCharacterBId: (value: string) => void;
  portraits: AsyncState<ImageRecord[]>;
  portraitsB: AsyncState<ImageRecord[]>;
  sourceImageId: string | null;
  setSourceImageId: (value: string | null) => void;
  sourceImageBId: string | null;
  setSourceImageBId: (value: string | null) => void;
  fixtureSourceId: string | null;
}) {
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <LabCastSlot
          slot="A"
          characters={castAOptions}
          characterId={characterId}
          onCharacterChange={setCharacterId}
          portraits={portraits}
          imageId={sourceImageId}
          onImageChange={setSourceImageId}
          excluded={
            fixtureSourceId === null ? null : { imageId: fixtureSourceId, reason: FIXTURE_SOURCE_REASON }
          }
        />
        <LabCastSlot
          slot="B"
          characters={castBOptions}
          characterId={characterBId}
          onCharacterChange={setCharacterBId}
          portraits={portraitsB}
          imageId={sourceImageBId}
          onImageChange={setSourceImageBId}
          excluded={
            fixtureSourceId === null ? null : { imageId: fixtureSourceId, reason: FIXTURE_SOURCE_REASON }
          }
        />
      </div>
      <p className="text-xs text-paper-500">
        {"A is sent first and B second, and the runner's numbered bindings follow that order — so the "}
        {"instruction below should name both characters rather than image numbers. "}
        {`${DEFAULT_MODEL_SLUG} accepts at most 3 reference images, which the two identities and one control `}
        {"fixture fill exactly."}
      </p>
    </>
  );
}
