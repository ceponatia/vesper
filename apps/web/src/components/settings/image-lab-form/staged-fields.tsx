"use client";

import { Field } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import type { ReactNode } from "react";
import { sceneStagingList, type SceneStaging } from "@/contracts/images/scene-staging";
import type { DaylightBand } from "@/lib/clock";
import type { CharacterSummary } from "@/lib/client/api";
import { Input } from "@/components/ui/input";
import { OwnedImagePicker } from "../owned-image-picker";
import {
  imageLabStagingBareSummary,
  imageLabStagingCameraSummary,
  imageLabStagingOptionLabel,
  imageLabStagingViewerPartsSummary,
} from "../image-lab-copy";

/**
 * The acts a staged scene may bench: the registry's INTIMATE entries, filtered
 * here rather than listed here.
 *
 * `intimate: true` is the same flag the render layer gates the staged sentence
 * behind — those entries are emitted only on the uncensored route — so the two
 * lists cannot disagree about which acts exist. The non-intimate entries are left
 * out because they are not what this kind is for: an embrace or a spooned pose
 * renders perfectly well on the stock model, and benching one would spend a paid
 * render measuring a LoRA on a picture that never needed it.
 */
const INTIMATE_STAGINGS: readonly SceneStaging[] = sceneStagingList.filter((staging) => staging.intimate);

/**
 * The chat lane's own time-of-day shorthand, which is what an absent lighting
 * phrase is derived from (`heuristicLighting`, server/images/scene.ts). Typed
 * against `DaylightBand` so a renamed band is a compile error here rather than a
 * silently unrecognised word that falls back to neutral light.
 *
 * A select rather than a text box: any other string is accepted by the contract
 * and simply derives nothing, so offering free text would offer four words that
 * work and every other one that quietly does not.
 */
const STAGED_TIME_OF_DAY = ["dawn", "day", "dusk", "night"] as const satisfies readonly DaylightBand[];

export function LabStagedFields({
  stagingId,
  setStagingId,
  stagingSetting,
  setStagingSetting,
  stagingLighting,
  setStagingLighting,
  stagingTimeOfDay,
  setStagingTimeOfDay,
  stagedLocationImageId,
  setStagedLocationImageId,
  characterId,
  characterRows,
  loraFields,
}: {
  stagingId: string;
  setStagingId: (value: string) => void;
  stagingSetting: string;
  setStagingSetting: (value: string) => void;
  stagingLighting: string;
  setStagingLighting: (value: string) => void;
  stagingTimeOfDay: string;
  setStagingTimeOfDay: (value: string) => void;
  stagedLocationImageId: string | null;
  setStagedLocationImageId: (value: string | null) => void;
  characterId: string;
  characterRows: CharacterSummary[];
  loraFields: ReactNode;
}) {
  const staging = INTIMATE_STAGINGS.find((entry) => entry.id === stagingId) ?? null;
  // The staged sentence as the render will state it: the registry's own template
  // with the subject's name substituted, and never a paraphrase of it — this form
  // reads the words, it does not write them. Before a character is chosen a
  // placeholder stands in, so the shape of the sentence is readable while the cast
  // is still being decided.
  const stagedSubjectName = characterRows.find((character) => character.id === characterId)?.name ?? "";
  const stagedSentence =
    staging === null
      ? ""
      : staging.template.replaceAll("{name}", stagedSubjectName === "" ? "the character" : stagedSubjectName);

  return (
    <>
      <Field
        label="Staging"
        hint="The act this render is of. Every option is an entry in the scene-staging registry, which owns its exact wording; the id shown is what the row records, what the recipe key carries, and what a written-up ruling cites."
      >
        {(id) => (
          <Select id={id} value={stagingId} onChange={(e) => setStagingId(e.target.value)}>
            <option value="">— Choose a staging —</option>
            {INTIMATE_STAGINGS.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {imageLabStagingOptionLabel(entry)}
              </option>
            ))}
          </Select>
        )}
      </Field>

      <div className="rounded-card border border-ink-700 bg-ink-950/40 px-3 py-2">
        <p className="text-[11px] tracking-wide text-paper-500 uppercase">
          Staged sentence (owned by the registry)
        </p>
        {staging === null ? (
          <p className="mt-1 text-xs text-paper-500">
            Choose a staging to read the sentence this render is compiled around.
          </p>
        ) : (
          <>
            <p className="mt-1 text-xs whitespace-pre-wrap text-paper-300">{stagedSentence}</p>
            <dl className="mt-2 grid gap-2 text-[11px] text-paper-300 sm:grid-cols-3">
              <div>
                <dt className="tracking-wide text-paper-500 uppercase">Camera</dt>
                <dd>{imageLabStagingCameraSummary(staging.camera)}</dd>
              </div>
              <div>
                <dt className="tracking-wide text-paper-500 uppercase">Subject bare</dt>
                <dd>{imageLabStagingBareSummary(staging)}</dd>
              </div>
              <div>
                <dt className="tracking-wide text-paper-500 uppercase">Viewer&apos;s own body in frame</dt>
                <dd>{imageLabStagingViewerPartsSummary(staging)}</dd>
              </div>
            </dl>
            <p className="mt-2 text-xs text-paper-500">
              {"The camera is the staging's own and overrides anything a composer would have proposed — the "}
              {"geometry is entailed by the act. The runner compiles the rest of the prompt around this "}
              {
                "sentence exactly as the chat lane does: the setting, the lighting, the shot line, and — on the "
              }
              {
                "parity arm below — the character's own description. That parity is what makes this a bench, so "
              }
              {"no words are typed on this form."}
            </p>
          </>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-[1fr_1fr_10rem]">
        <Field
          label="Setting"
          hint="Where the act happens. There is no conversation here to supply a room, so blank renders against the lane's own empty backdrop."
        >
          {(id) => (
            <Input
              id={id}
              value={stagingSetting}
              onChange={(e) => setStagingSetting(e.target.value)}
              placeholder="a dim hotel room, sheets rumpled"
              maxLength={300}
            />
          )}
        </Field>
        <Field label="Lighting" hint="Blank is derived from the time of day, by the rule the chat lane uses.">
          {(id) => (
            <Input
              id={id}
              value={stagingLighting}
              onChange={(e) => setStagingLighting(e.target.value)}
              placeholder="warm dusk light"
              maxLength={200}
            />
          )}
        </Field>
        <Field
          label="Time of day"
          hint="The lane's own shorthand — what an empty lighting box is derived from."
        >
          {(id) => (
            <Select id={id} value={stagingTimeOfDay} onChange={(e) => setStagingTimeOfDay(e.target.value)}>
              <option value="">— None —</option>
              {STAGED_TIME_OF_DAY.map((band) => (
                <option key={band} value={band}>
                  {band}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>

      <OwnedImagePicker
        label="Location reference (optional)"
        hint="A picture of the place the act happens — any of your stored images. Sent after the identity reference; the words above still say the setting, so none is a fine arm."
        value={stagedLocationImageId}
        onChange={setStagedLocationImageId}
      />

      <div className="flex flex-col gap-2">{loraFields}</div>
    </>
  );
}
