"use client";

import { Field } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import type { Dispatch, ReactNode, SetStateAction } from "react";
import type { ImageLabExperiment, ImageLora } from "@vesper/image-core";
import { Input } from "@/components/ui/input";
import { imageLabExperimentKindLabel } from "../image-lab-copy";

/**
 * One eligible source in the picker: what it was, when it ran, and its id.
 *
 * The id is included rather than hidden behind a prettier label because a lab
 * record is cited by id everywhere else — the detail header, the written-up
 * ruling — and an admin holding an id from a note has to be able to find the
 * same row here without opening each one.
 */
function sourceOptionLabel(experiment: ImageLabExperiment): string {
  const when = new Date(experiment.createdAt).toLocaleDateString();
  return `${imageLabExperimentKindLabel(experiment.kind)} · ${when} · ${experiment.id}`;
}

export function LabFinishingFields({
  sourceExperimentId,
  setSourceExperimentId,
  finishableSources,
  loraOnlyArm,
  loraFields,
}: {
  sourceExperimentId: string;
  setSourceExperimentId: (value: string) => void;
  finishableSources: ImageLabExperiment[];
  loraOnlyArm: boolean;
  loraFields: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <Field
        label="Source experiment"
        hint="The succeeded run whose result this pass re-edits. Its character or conversation is inherited, so both arms of the comparison file against the same subject."
      >
        {(id) => (
          <Select id={id} value={sourceExperimentId} onChange={(e) => setSourceExperimentId(e.target.value)}>
            <option value="">— Choose an experiment to refine —</option>
            {finishableSources.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {sourceOptionLabel(entry)}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <p className="text-xs text-paper-500">
        {finishableSources.length === 0
          ? "No finished baseline or controlled run to refine yet — a probe cannot be finished, and neither can another finishing pass."
          : loraOnlyArm
            ? "The runner sends that run's result as the base image and stops there — the LoRA-only arm asks the identity pack for nothing."
            : "The runner sends that run's result as the base image and the character's identity-pack reference beside it. Nothing else is picked here: the pack decides which image its identity is."}
      </p>

      {loraFields}
    </div>
  );
}

export function LabLoraFields({
  offerableLoras,
  isStaged,
  isFinishing,
  loraId,
  setLoraId,
  selectedLora,
  loraScale,
  setLoraScale,
  loraModelMismatch,
  effectiveModelSlug,
  loraOnly,
  setLoraOnly,
}: {
  offerableLoras: ImageLora[];
  isStaged: boolean;
  isFinishing: boolean;
  loraId: string;
  setLoraId: (value: string) => void;
  selectedLora: ImageLora | null;
  loraScale: string;
  setLoraScale: (value: string) => void;
  loraModelMismatch: boolean;
  effectiveModelSlug: string;
  loraOnly: boolean;
  setLoraOnly: Dispatch<SetStateAction<boolean>>;
}) {
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-[1fr_9rem]">
        <Field
          label="LoRA"
          hint={
            offerableLoras.length === 0
              ? isStaged
                ? "No enabled library row allows scene renders, so there are no weights to offer. Curate one under Settings → Image models → LoRA library — without them the act is drawn by the stock model, which is the thing this bench measures the absence of."
                : "None in the library yet. Curate one under Settings → Image models → LoRA library; only enabled rows are offered here."
              : isStaged
                ? "The weights the act is rendered with. The production intimate-scene LoRA is chosen for you because it is what the chat lane sends on every intimate staged render — clear it to none to see the same act without them."
                : "Optional. Blends a curated weights file into this pass — the library row decides which models, versions, and strengths it may run at."
          }
        >
          {(id) => (
            <Select id={id} value={loraId} onChange={(e) => setLoraId(e.target.value)}>
              <option value="">— None —</option>
              {offerableLoras.map((lora) => (
                <option key={lora.id} value={lora.id}>
                  {lora.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {selectedLora !== null ? (
          <Field label="Scale">
            {(id) => (
              <Input
                id={id}
                type="number"
                step={0.05}
                min={selectedLora.minimumScale}
                max={selectedLora.maximumScale}
                value={loraScale}
                onChange={(e) => setLoraScale(e.target.value)}
              />
            )}
          </Field>
        ) : null}
      </div>
      {selectedLora !== null ? (
        <>
          {/* String-expression children throughout: this prose straddles
                  expressions, and a wrapped boundary is where the space goes missing. */}
          <p className="text-xs text-paper-500">
            {`Curated range ${String(selectedLora.minimumScale)}–${String(selectedLora.maximumScale)}, default ${String(selectedLora.defaultScale)}. `}
            {
              "A scale outside it is refused before any spend rather than clamped. The row's trigger words and "
            }
            {"prompt additions are woven into the compiled prompt automatically."}
            {isStaged
              ? " Moving this number is what a scale sweep is: too low reads as withheld anatomy, too high as wrong geometry, and the ruling on each run says which way to go next."
              : " Nothing to type below."}
          </p>
          {loraModelMismatch ? (
            <p className="text-xs text-danger-300">
              {`These weights are not curated for ${effectiveModelSlug}. `}
              {selectedLora.compatibleModelSlugs.length === 0
                ? "The library row lists no compatible model at all, "
                : `The row lists ${selectedLora.compatibleModelSlugs.join(", ")}, `}
              {
                "so as it stands the run is refused before any spend and nothing is rendered. Name a listed model in "
              }
              {"the Model box above, or widen the row in the LoRA library."}
            </p>
          ) : null}
          {isFinishing ? (
            <>
              <label className="flex items-center gap-2 text-sm text-paper-300">
                <input
                  type="checkbox"
                  checked={loraOnly}
                  onChange={() => setLoraOnly((on) => !on)}
                  className="accent-accent-500"
                />
                LoRA-only arm — send no identity reference
              </label>
              <p className="text-xs text-paper-500">
                {loraOnly
                  ? "This pass sends the base render alone, so what the weights do to the face is not shared with the identity pack. The compiled prompt below changes to match — it names no reference image."
                  : "Leave it off and the pack's reference goes too. Tick it to measure the LoRA on its own: the pass sends the base render and nothing else, which is the only arm that can attribute an improved face to the weights."}
              </p>
            </>
          ) : null}
        </>
      ) : null}
    </>
  );
}
