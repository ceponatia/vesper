"use client";

import { useState } from "react";
import {
  IMAGE_LAB_MAX_INPUTS,
  type ImageLabControl,
  type ImageLabCreateExperimentRequest,
  type ImageLabExperimentKind,
  type ImageLabInput,
} from "@/contracts";
import { chatsApi, imageLabApi } from "@/lib/client/api";
import { imageLabControlRole, imageLabProbeInstruction } from "@/lib/images/image-lab-instruction";
import { useAsyncData } from "@/components/hooks/use-async";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { imageLabControlKindLabel, imageLabExperimentKindLabel, imageLabRoleLabel } from "./image-lab-copy";
import {
  ImageChoiceGrid,
  LabCharacterSelect,
  LabRenderPicker,
  labRenderLabel,
  useLabCharacters,
  useLabPortraits,
} from "./image-lab-pickers";

/**
 * The create-experiment form (qwen-advanced-image-subsystem.spec.md §Stage 0
 * control-probe protocol, step 2).
 *
 * Only the three Stage 0 kinds are offered. The other three experiment kinds
 * exist in the contract so the stored record survives Stages 1–3 without a
 * migration, but nothing can run them yet, and a picker offering a kind the
 * runner would refuse would be an admin's minute spent on a form that could not
 * work.
 *
 * The instruction is PRE-FILLED from the numbered-role template and then owned
 * by the admin: the template tracks the fixture until the text is edited, after
 * which it stays put (with an explicit way back). What is submitted is exactly
 * what is on screen — the runner does not rewrite prompts, because a verdict is
 * a ruling on a specific sentence.
 *
 * `mode` is deliberately never sent. A Stage 0 probe that declared a bias
 * between identity and composition would be claiming a recipe exists to be
 * biased, and none does yet (contracts §`imageLabModes`).
 */

const STAGE_0_KINDS = ["control_probe", "baseline_portrait", "baseline_scene"] as const satisfies readonly ImageLabExperimentKind[];

/** What the runner uses when the form names no model. Shown, never sent. */
const DEFAULT_MODEL_SLUG = "qwen/qwen-image-edit-2511";

/**
 * Whether a fixture may be sent at all.
 *
 * The runner refuses an unreviewed one outright
 * (`image_lab.control_unreviewed`), because a probe reading "ignores the
 * control" has to be able to eliminate "the fixture was wrong" first. Offering
 * one here would sell an admin a queued experiment that can only fail, so the
 * picker shows it greyed instead — visible, because a fixture that vanished from
 * a list the panel above still shows reads as a broken form.
 */
function isReviewedFixture(control: ImageLabControl): boolean {
  return control.meta.reviewedAt !== undefined;
}

export interface ImageLabExperimentFormProps {
  controls: ImageLabControl[];
  /** The created experiment's id — the caller arms its pending tile with it. */
  onCreated: (experimentId: string) => void;
}

export function ImageLabExperimentForm({ controls, onCreated }: ImageLabExperimentFormProps) {
  const toast = useToast();
  const characters = useLabCharacters();
  const chats = useAsyncData(() => chatsApi.list(), []);

  const [kind, setKind] = useState<ImageLabExperimentKind>("control_probe");
  const [characterId, setCharacterId] = useState("");
  const [sourceImageId, setSourceImageId] = useState<string | null>(null);
  const [chatId, setChatId] = useState("");
  const [controlImageId, setControlImageId] = useState<string | null>(null);
  const [modelSlug, setModelSlug] = useState("");
  const [instructionText, setInstructionText] = useState("");
  const [instructionEdited, setInstructionEdited] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const portraits = useLabPortraits(characterId);
  const portraitRows = portraits.data ?? [];

  // A character change invalidates the picked render (render-adjust, never a
  // setState inside an effect).
  const [prevCharacterId, setPrevCharacterId] = useState(characterId);
  if (characterId !== prevCharacterId) {
    setPrevCharacterId(characterId);
    setSourceImageId(null);
  }

  const control = controls.find((entry) => entry.imageId === controlImageId) ?? null;
  const isProbe = kind === "control_probe";
  const unreviewedCount = controls.filter((entry) => !isReviewedFixture(entry)).length;

  // The ordered send list. Positions are assigned HERE, in array order, because
  // the contract requires the two to agree and the numbered instruction below is
  // written against exactly these numbers.
  const inputs: ImageLabInput[] = [];
  if (isProbe) {
    if (sourceImageId !== null) {
      inputs.push({ position: inputs.length + 1, role: "identity", imageId: sourceImageId });
    }
    if (control !== null) {
      inputs.push({
        position: inputs.length + 1,
        role: imageLabControlRole(control.meta.controlKind),
        imageId: control.imageId,
      });
    }
  }

  const identityInput = inputs.find((entry) => entry.role === "identity") ?? null;
  const controlInput = control === null ? null : (inputs.find((entry) => entry.imageId === control.imageId) ?? null);

  const template =
    isProbe && control !== null && controlInput !== null
      ? imageLabProbeInstruction({
          controlKind: control.meta.controlKind,
          controlPosition: controlInput.position,
          identityPosition: identityInput?.position ?? null,
        })
      : "";
  const instruction = instructionEdited ? instructionText : template;

  const ready =
    kind === "control_probe"
      ? control !== null && isReviewedFixture(control)
      : kind === "baseline_portrait"
        ? characterId !== ""
        : chatId !== "";

  const describeInput = (input: ImageLabInput): string => {
    if (control !== null && input.imageId === control.imageId) {
      return `${imageLabControlKindLabel(control.meta.controlKind)} fixture`;
    }
    const portrait = portraitRows.find((image) => image.id === input.imageId);
    return portrait ? labRenderLabel(portrait) : input.imageId;
  };

  const submit = async () => {
    if (!ready) return;
    const body: ImageLabCreateExperimentRequest = {
      kind,
      instruction: instruction.trim(),
      inputs,
      modelSlug: modelSlug.trim() === "" ? undefined : modelSlug.trim(),
      // Each baseline names only its own subject: a scene baseline carrying a
      // leftover character id would record a subject it never rendered.
      characterId: kind === "baseline_scene" || characterId === "" ? undefined : characterId,
      chatId: kind === "baseline_scene" && chatId !== "" ? chatId : undefined,
      // A control image and its kind are recorded together or not at all — half a
      // pointer names a fixture nothing can check.
      controlImageId: isProbe && control !== null ? control.imageId : undefined,
      controlKind: isProbe && control !== null ? control.meta.controlKind : undefined,
    };
    setSubmitting(true);
    const result = await imageLabApi.experiments.create(body);
    setSubmitting(false);
    if (!result.ok) {
      toast.push({ title: "Couldn't start that experiment", description: result.error.message, tone: "error" });
      return;
    }
    toast.push({
      title: "Experiment queued",
      description: "One render, charged against the daily image budget.",
      tone: "success",
    });
    onCreated(result.data.experiment.id);
  };

  return (
    <section className="rounded-card border border-ink-600 bg-ink-850 p-5">
      <h2 className="prose-display text-lg">New experiment</h2>
      <p className="mt-1 mb-4 text-sm text-paper-400">
        One deliberate render whose every input, setting, and outcome is written down. Submitting spends real render
        budget.
      </p>

      <div className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Kind" hint="Stage 0 runs a probe or re-runs a lane's own settings as a control.">
            {(id) => (
              <Select id={id} value={kind} onChange={(e) => setKind(e.target.value as ImageLabExperimentKind)}>
                {STAGE_0_KINDS.map((entry) => (
                  <option key={entry} value={entry}>
                    {imageLabExperimentKindLabel(entry)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Model" hint={`Blank runs the plan's model (${DEFAULT_MODEL_SLUG}). Name another to probe a fallback connector.`}>
            {(id) => (
              <Input
                id={id}
                value={modelSlug}
                onChange={(e) => setModelSlug(e.target.value)}
                placeholder={DEFAULT_MODEL_SLUG}
                spellCheck={false}
                maxLength={200}
              />
            )}
          </Field>
        </div>

        {kind === "baseline_scene" ? (
          <Field label="Chat" hint="A scene baseline re-runs this conversation's own scene settings.">
            {(id) => (
              <Select id={id} value={chatId} onChange={(e) => setChatId(e.target.value)}>
                <option value="">— Choose a conversation —</option>
                {(chats.data ?? []).map((chat) => (
                  <option key={chat.id} value={chat.id}>
                    {chat.title || chat.characterName || chat.id}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        ) : (
          <div className="grid gap-4 sm:grid-cols-[16rem_1fr]">
            <Field
              label="Character"
              hint={isProbe ? "Whose identity the probe must preserve." : "The character whose portrait settings are re-run."}
            >
              {(id) => (
                <LabCharacterSelect
                  id={id}
                  characters={characters.data ?? []}
                  value={characterId}
                  onChange={setCharacterId}
                />
              )}
            </Field>
            {isProbe ? (
              <LabRenderPicker
                label="Identity reference"
                hint="The render whose face the output must keep. Optional — a probe may test structure alone."
                characterId={characterId}
                portraits={portraits}
                value={sourceImageId}
                onChange={setSourceImageId}
              />
            ) : null}
          </div>
        )}

        {isProbe ? (
          <>
            <Field
              label="Control fixture"
              hint="The structure the output must obey. Required for a probe, and only a reviewed fixture may be sent."
            >
              <ImageChoiceGrid
                choices={controls.map((entry) => ({
                  imageId: entry.imageId,
                  label: imageLabControlKindLabel(entry.meta.controlKind),
                  detail: isReviewedFixture(entry) ? "reviewed" : "unreviewed — review it first",
                  disabled: !isReviewedFixture(entry),
                }))}
                value={controlImageId}
                onChange={setControlImageId}
                fit="contain"
                emptyHint="No fixtures yet — extract or upload one above."
              />
            </Field>
            {unreviewedCount > 0 ? (
              <p className="text-xs text-paper-500">
                {unreviewedCount} fixture(s) above are greyed out because nobody has reviewed them. Look at each one in
                the fixtures panel and mark it reviewed — a probe that comes back &ldquo;ignores the control&rdquo; has
                to rule out a bad fixture before it rules on the model.
              </p>
            ) : null}
          </>
        ) : null}

        <div className="rounded-card border border-ink-700 bg-ink-950/40 px-3 py-2">
          <p className="text-[11px] tracking-wide text-paper-500 uppercase">
            Ordered inputs (up to {IMAGE_LAB_MAX_INPUTS})
          </p>
          {inputs.length === 0 ? (
            <p className="mt-1 text-xs text-paper-500">
              {isProbe
                ? "Nothing ordered yet — a probe with no inputs is refused as input_missing."
                : "None — a baseline resolves the lane's own references itself."}
            </p>
          ) : (
            <ol className="mt-1 flex flex-col gap-0.5 text-xs text-paper-300">
              {inputs.map((input) => (
                <li key={input.position}>
                  <span className="text-paper-500">Image {input.position} —</span> {imageLabRoleLabel(input.role)}
                  <span className="text-paper-500"> · {describeInput(input)}</span>
                </li>
              ))}
            </ol>
          )}
        </div>

        <Field
          label="Instruction"
          hint={
            isProbe
              ? "Pre-filled from the numbered-role template; the numbers match the list above. Sent exactly as written."
              : "Optional — a baseline renders the lane's own compiled prompt."
          }
        >
          {(id) => (
            <Textarea
              id={id}
              rows={5}
              value={instruction}
              spellCheck={false}
              onChange={(e) => {
                setInstructionEdited(true);
                setInstructionText(e.target.value);
              }}
              placeholder={isProbe ? "Pick a control fixture to fill the template." : ""}
              maxLength={8000}
            />
          )}
        </Field>
        {instructionEdited && template !== "" && instruction !== template ? (
          <div>
            <Button
              size="sm"
              variant="quiet"
              onClick={() => {
                setInstructionEdited(false);
                setInstructionText("");
              }}
            >
              Reset to the template
            </Button>
          </div>
        ) : null}

        <div className="flex items-center gap-3">
          <Button variant="primary" busy={submitting} disabled={!ready} onClick={() => void submit()}>
            Run experiment
          </Button>
          <p className="text-[11px] text-paper-500">
            The run is refused before any spend if the model&apos;s exact provider version cannot be pinned.
          </p>
        </div>
      </div>
    </section>
  );
}
