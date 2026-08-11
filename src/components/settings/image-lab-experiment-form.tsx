"use client";

import { useState } from "react";
import {
  IMAGE_LAB_MAX_INPUTS,
  imageLabModes,
  isImageLabControlledKind,
  type ImageLabControl,
  type ImageLabControlledKind,
  type ImageLabCreateExperimentRequest,
  type ImageLabExperimentKind,
  type ImageLabInput,
  type ImageLabMode,
  type ImageReferenceRole,
} from "@/contracts";
import { chatsApi, imageLabApi } from "@/lib/client/api";
import { imageLabControlRole, imageLabProbeInstruction } from "@/lib/images/image-lab-instruction";
import { compileReferenceRolePrompt } from "@/lib/images/reference-role-prompt";
import { useAsyncData } from "@/components/hooks/use-async";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import {
  imageLabControlKindLabel,
  imageLabExperimentKindLabel,
  imageLabModeLabel,
  imageLabRoleLabel,
} from "./image-lab-copy";
import {
  ImageChoiceGrid,
  LabCharacterSelect,
  LabRenderPicker,
  labRenderLabel,
  useLabCharacters,
  useLabChatScenes,
  useLabPortraits,
} from "./image-lab-pickers";

/**
 * The create-experiment form (qwen-advanced-image-subsystem.spec.md §Stage 0
 * control-probe protocol step 2, plus the Stage 1–2 controlled recipes).
 *
 * Every kind the runner accepts is offered — the three Stage 0 kinds and the
 * two controlled recipes. `finishing_pass` exists in the contract so the stored
 * record survives Stage 3 without a migration, but nothing can run it yet, and
 * a picker offering a kind the runner would refuse would be an admin's minute
 * spent on a form that could not work.
 *
 * The instruction field means two different things by kind, and the form is
 * explicit about which. A PROBE's instruction is the WHOLE prompt: pre-filled
 * from the numbered-role template and then owned by the admin (the template
 * tracks the fixture until the text is edited, with an explicit way back), sent
 * exactly as shown — the runner never rewrites prompts, because a verdict is a
 * ruling on a specific sentence. A CONTROLLED kind's instruction is the BASE
 * prompt only: the runner's compose strategy prefixes the numbered role
 * bindings itself, so pre-filling the probe template here would send the
 * bindings twice. The form shows a live read-only preview of that prefix
 * instead, compiled by the same pure function the server compiles it with.
 *
 * `mode` is sent by the controlled kinds alone (default
 * `controlled_composition` — the bias their recipes exist to exercise). A probe
 * or baseline still never sends one: declaring a bias claims a recipe exists to
 * be biased, and neither runs one (contracts §`imageLabModes`).
 *
 * No raw provider-JSON settings surface exists on this form at all — which for
 * the controlled kinds is load-bearing, not an omission: the server REFUSES a
 * controlled experiment carrying a `controlInput` bag (`settings_unsupported`),
 * because a production-shaped run has no raw bag to carry.
 */

/**
 * Every kind the runner will accept — the server's own RUNNABLE_KINDS, offered
 * in the same order the plan grew them.
 */
const RUNNABLE_KINDS = [
  "control_probe",
  "baseline_portrait",
  "baseline_scene",
  "controlled_portrait",
  "controlled_scene",
] as const satisfies readonly ImageLabExperimentKind[];
type RunnableLabKind = (typeof RUNNABLE_KINDS)[number];

/** What the runner uses when the form names no model. Shown, never sent. */
const DEFAULT_MODEL_SLUG = "qwen/qwen-image-edit-2511";

/**
 * The optional third reference each controlled recipe is offered, and the one
 * omission. The recipes allow [outfit, style, object] on a portrait and
 * [location, outfit, style] on a scene (`imageLabRecipeContentRoles`); `object`
 * is left out of the portrait select because no client-reachable list holds
 * item images — the lab's pickers surface character portraits and a chat's
 * scene renders, and filing a picture of a person as "an object reference"
 * would poison the record this bench exists to keep honest. When an
 * object-image source exists, adding the role here is a one-line change.
 */
const EXTRA_REFERENCE_ROLES = {
  controlled_portrait: ["outfit", "style"],
  controlled_scene: ["location", "outfit", "style"],
} as const satisfies Record<ImageLabControlledKind, readonly ImageReferenceRole[]>;
type ExtraReferenceRole = (typeof EXTRA_REFERENCE_ROLES)[ImageLabControlledKind][number];

/**
 * Which picker feeds each extra role. A scene's location and style come from
 * the conversation's own scene renders (a previous scene IS a picture of the
 * place, and of the scene lane's look); wardrobe comes from the character's
 * portrait renders in both kinds, because a variant render wearing the outfit
 * is the only wardrobe imagery the lab can reach.
 */
function extraReferenceSource(kind: ImageLabControlledKind, role: ExtraReferenceRole): "portraits" | "scenes" {
  return kind === "controlled_scene" && role !== "outfit" ? "scenes" : "portraits";
}

/** What picking each extra role means — the picker's hint, in the recipe's terms. */
function extraRoleHint(role: ExtraReferenceRole): string {
  switch (role) {
    case "outfit":
      return "Dress the subject in exactly this render's clothing.";
    case "style":
      return "Take this render's palette and finish; no subject from it.";
    case "location":
      return "The place the scene is set — one of this conversation's scene renders.";
  }
}

/** The scene-sourced pickers' empty states, in the noun the admin actually failed to choose. */
const SCENE_EMPTY_HINTS = {
  unscoped: "Choose a conversation first.",
  none: "This conversation has no finished scene renders yet.",
};

/**
 * Why a render that fed a fixture is barred from every picker on this form —
 * the server's `control_source_sent` refusal, explained before it is spent.
 */
const FIXTURE_SOURCE_REASON = "source of the selected fixture — sending it invalidates the run";

/**
 * Whether a fixture may be sent at all.
 *
 * The runner refuses an unreviewed one outright
 * (`image_lab.control_unreviewed`), because a run reading "ignores the
 * control" has to be able to eliminate "the fixture was wrong" first. Offering
 * one here would sell an admin a queued experiment that can only fail, so the
 * picker shows it greyed instead — visible, because a fixture that vanished from
 * a list the panel above still shows reads as a broken form.
 */
function isReviewedFixture(control: ImageLabControl): boolean {
  return control.meta.reviewedAt !== undefined;
}

/**
 * A client-side pre-fill of this form — the paired-baseline action on a
 * succeeded controlled experiment's detail. Values only; nothing submits until
 * the admin does. `fromExperimentId` is display-only provenance and is never
 * sent: the create request has no pairing field, because the SHARED INSTRUCTION
 * is what pairs the two arms of a comparison.
 */
export interface ImageLabExperimentPrefill {
  kind: Extract<ImageLabExperimentKind, "baseline_portrait" | "baseline_scene">;
  characterId?: string;
  chatId?: string;
  instruction: string;
  fromExperimentId?: string;
}

export interface ImageLabExperimentFormProps {
  controls: ImageLabControl[];
  /**
   * Seed values for a paired baseline. Read once, at mount: the page remounts
   * the form (key) when a new pre-fill arrives — the detail view's own idiom —
   * so a half-edited form is never rewritten under the admin's hands.
   */
  prefill?: ImageLabExperimentPrefill | null;
  /** The created experiment's id — the caller arms its pending tile with it. */
  onCreated: (experimentId: string) => void;
}

export function ImageLabExperimentForm({ controls, prefill = null, onCreated }: ImageLabExperimentFormProps) {
  const toast = useToast();
  const characters = useLabCharacters();
  const chats = useAsyncData(() => chatsApi.list(), []);

  const [kind, setKind] = useState<RunnableLabKind>(prefill?.kind ?? "control_probe");
  const [characterId, setCharacterId] = useState(prefill?.characterId ?? "");
  const [sourceImageId, setSourceImageId] = useState<string | null>(null);
  const [chatId, setChatId] = useState(prefill?.chatId ?? "");
  const [controlImageId, setControlImageId] = useState<string | null>(null);
  const [mode, setMode] = useState<ImageLabMode>("controlled_composition");
  const [extraRole, setExtraRole] = useState<ExtraReferenceRole | "">("");
  const [extraImageId, setExtraImageId] = useState<string | null>(null);
  const [modelSlug, setModelSlug] = useState("");
  const [instructionText, setInstructionText] = useState(prefill?.instruction ?? "");
  const [instructionEdited, setInstructionEdited] = useState(prefill !== null && prefill.instruction !== "");
  const [submitting, setSubmitting] = useState(false);

  const controlledKind: ImageLabControlledKind | null = isImageLabControlledKind(kind) ? kind : null;
  const isProbe = kind === "control_probe";
  /** Kinds that declare a control fixture and send an ordered input list. */
  const sendsFixture = isProbe || controlledKind !== null;
  const needsChat = kind === "baseline_scene" || kind === "controlled_scene";

  // Whose portraits the identity picker (and the wardrobe extra) draw from: the
  // picked character — or, for a controlled scene, the conversation's own
  // character, resolved off the chat row so the evidence and its identity
  // reference cannot name two different people.
  const chatCharacterId = (chats.data ?? []).find((chat) => chat.id === chatId)?.characterId ?? "";
  const identityCharacterId = kind === "controlled_scene" ? chatCharacterId : characterId;
  const portraits = useLabPortraits(identityCharacterId);
  const portraitRows = portraits.data ?? [];
  const scenes = useLabChatScenes(kind === "controlled_scene" ? chatId : "");
  const sceneRows = scenes.data ?? [];

  // A change of identity source — the picked character, or the chat whose
  // character it is — invalidates the picked render (render-adjust, never a
  // setState inside an effect).
  const [prevIdentityCharacterId, setPrevIdentityCharacterId] = useState(identityCharacterId);
  if (identityCharacterId !== prevIdentityCharacterId) {
    setPrevIdentityCharacterId(identityCharacterId);
    setSourceImageId(null);
  }

  // An extra role the current kind does not offer resets to none — a stale role
  // would ride into the request and come back as a recorded `role_not_allowed`
  // drop the admin never chose. No latch: clearing extinguishes the condition.
  const extraRoleOptions: readonly ExtraReferenceRole[] =
    controlledKind === null ? [] : EXTRA_REFERENCE_ROLES[controlledKind];
  if (extraRole !== "" && !extraRoleOptions.some((role) => role === extraRole)) {
    setExtraRole("");
  }

  // The extra picker's source list is decided by (kind, role, character, chat);
  // when any of those moves, the picked image belongs to a list no longer on
  // screen (render-adjust again).
  const extraSourceKey = `${kind}|${extraRole}|${identityCharacterId}|${chatId}`;
  const [prevExtraSourceKey, setPrevExtraSourceKey] = useState(extraSourceKey);
  if (extraSourceKey !== prevExtraSourceKey) {
    setPrevExtraSourceKey(extraSourceKey);
    setExtraImageId(null);
  }

  const control = controls.find((entry) => entry.imageId === controlImageId) ?? null;
  const unreviewedCount = controls.filter((entry) => !isReviewedFixture(entry)).length;

  // The render the chosen fixture was extracted from, when it has one (a
  // hand-authored skeleton names none). Sending it in ANY slot hands the model
  // the answer: the output can match the control by copying that reference, and
  // the run reads as a pass it never earned — the server refuses it outright as
  // `control_source_sent`. So it is barred in the pickers below — and cleared
  // here if it was already picked, which the order render-then-fixture makes
  // reachable (render-adjust, never a setState inside an effect). No
  // previous-value latch: clearing the pick extinguishes the condition, so this
  // cannot run twice.
  const fixtureSourceId = control?.meta.sourceImageId ?? null;
  if (fixtureSourceId !== null && sourceImageId === fixtureSourceId) {
    setSourceImageId(null);
  }
  if (fixtureSourceId !== null && extraImageId === fixtureSourceId) {
    setExtraImageId(null);
  }
  // The bar is only something to explain while the barred tile is on screen —
  // it is a render of whichever character the picker is currently showing.
  const fixtureSourceShown =
    sendsFixture && fixtureSourceId !== null && portraitRows.some((image) => image.id === fixtureSourceId);

  // The ordered send list. Positions are assigned HERE, in array order, because
  // the contract requires the two to agree. A probe's numbered template below is
  // written against exactly these numbers; a controlled kind's numbered
  // bindings are compiled by the RUNNER from this same order (previewed below).
  // Identity leads and the fixture follows, matching the recipes' own
  // roleOrder, so the send order and the recipe never disagree about a slot.
  const inputs: ImageLabInput[] = [];
  if (sendsFixture) {
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
    if (controlledKind !== null && extraRole !== "" && extraImageId !== null) {
      inputs.push({ position: inputs.length + 1, role: extraRole, imageId: extraImageId });
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

  // What the runner will PREFIX to a controlled instruction: the compose
  // strategy's numbered role bindings over exactly this send order. Compiled by
  // the same pure function the server compiles it with — never restated — so
  // the preview cannot drift from what runs. An empty base prompt yields the
  // bindings alone; trimmed because the joiner leaves a seam for the base text.
  const bindingPreview =
    controlledKind !== null && inputs.length > 0
      ? compileReferenceRolePrompt({ basePrompt: "", roles: inputs.map((input) => input.role) }).trimEnd()
      : "";

  const controlReady = control !== null && isReviewedFixture(control);
  // A role picked with no image is an unfinished thought, not a request with a
  // hole in it — the submit waits for the pair or for none.
  const extraComplete = extraRole === "" || extraImageId !== null;
  const ready = ((): boolean => {
    switch (kind) {
      case "control_probe":
        return controlReady;
      case "baseline_portrait":
        return characterId !== "";
      case "baseline_scene":
        return chatId !== "";
      case "controlled_portrait":
        return characterId !== "" && sourceImageId !== null && controlReady && extraComplete;
      case "controlled_scene":
        return chatId !== "" && sourceImageId !== null && controlReady && extraComplete;
    }
  })();

  const describeInput = (input: ImageLabInput): string => {
    if (control !== null && input.imageId === control.imageId) {
      return `${imageLabControlKindLabel(control.meta.controlKind)} fixture`;
    }
    const record =
      portraitRows.find((image) => image.id === input.imageId) ??
      sceneRows.find((image) => image.id === input.imageId);
    return record ? labRenderLabel(record) : input.imageId;
  };

  const submit = async () => {
    if (!ready) return;
    const sendsCharacter = kind === "control_probe" || kind === "baseline_portrait" || kind === "controlled_portrait";
    const body: ImageLabCreateExperimentRequest = {
      kind,
      instruction: instruction.trim(),
      inputs,
      modelSlug: modelSlug.trim() === "" ? undefined : modelSlug.trim(),
      // Each kind names only its own subject: a scene run carrying a leftover
      // character id would record a subject it never rendered, and vice versa.
      characterId: sendsCharacter && characterId !== "" ? characterId : undefined,
      chatId: needsChat && chatId !== "" ? chatId : undefined,
      // A control image and its kind are recorded together or not at all — half a
      // pointer names a fixture nothing can check.
      controlImageId: sendsFixture && control !== null ? control.imageId : undefined,
      controlKind: sendsFixture && control !== null ? control.meta.controlKind : undefined,
      // The bias knob belongs to the controlled recipes alone: a probe or
      // baseline declaring one would claim a recipe existed to be biased, and
      // neither runs one (contracts §`imageLabModes`) — Stage 0 behavior kept.
      mode: controlledKind !== null ? mode : undefined,
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

  // The scene kind's portrait-sourced pickers scope on the CONVERSATION (the
  // character is derived from it), so their empty states must say
  // "conversation" — the noun the admin actually failed to choose.
  const chatPortraitEmptyHints =
    kind === "controlled_scene"
      ? {
          unscoped:
            chatId === ""
              ? "Choose a conversation first."
              : "This conversation has no primary character whose renders can be offered.",
          none: "This conversation's character has no finished renders yet.",
        }
      : undefined;

  const extraSource: "portraits" | "scenes" =
    controlledKind !== null && extraRole !== "" ? extraReferenceSource(controlledKind, extraRole) : "portraits";

  // The identity column probes and controlled kinds share — one JSX value so
  // the character-scoped and chat-scoped layouts cannot drift apart.
  const identityColumn = (
    <div className="flex flex-col gap-2">
      <LabRenderPicker
        label="Identity reference"
        hint={
          isProbe
            ? "The render whose face the output must keep. Optional — a probe may test structure alone."
            : "The render whose face the output must keep. Required — the controlled recipes refuse to run without one."
        }
        scopeId={identityCharacterId}
        images={portraits}
        value={sourceImageId}
        onChange={setSourceImageId}
        excluded={fixtureSourceId === null ? null : { imageId: fixtureSourceId, reason: FIXTURE_SOURCE_REASON }}
        emptyHints={chatPortraitEmptyHints}
      />
      {fixtureSourceShown ? (
        <p className="text-xs text-paper-500">
          One render is greyed out because the selected fixture was extracted from it. Sending that render as the
          identity reference would hand the model the answer — the output could match the control by copying it,
          instead of proving the model obeys a control at all.
        </p>
      ) : null}
    </div>
  );

  return (
    <section className="rounded-card border border-ink-600 bg-ink-850 p-5">
      <h2 className="prose-display text-lg">New experiment</h2>
      <p className="mt-1 mb-4 text-sm text-paper-400">
        One deliberate render whose every input, setting, and outcome is written down. Submitting spends real render
        budget.
      </p>
      {prefill?.fromExperimentId !== undefined ? (
        <p className="mb-4 rounded-card border border-accent-500/40 bg-ink-950/40 px-3 py-2 text-xs text-paper-400">
          Pre-filled as the direct-edit baseline of experiment{" "}
          <code className="break-all">{prefill.fromExperimentId}</code>
          {/* String-expression children: swc in next 16.2.x drops the leading space of a multi-line JSX text node
              containing an HTML entity (swc#11521; fixed in next 16.3.0). */}
          {" — same instruction, the lane's own configuration. Review it; nothing runs until you submit."}
        </p>
      ) : null}

      <div className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Kind"
            hint="A probe asks whether the model obeys a control at all; a controlled run asks whether that holds production-shaped; a baseline re-runs a lane's own settings beside it."
          >
            {(id) => (
              <Select id={id} value={kind} onChange={(e) => setKind(e.target.value as RunnableLabKind)}>
                {RUNNABLE_KINDS.map((entry) => (
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
          {controlledKind !== null ? (
            <Field
              label="Mode"
              hint="Recorded bias between identity and composition — the knob Stages 1–2 tune."
            >
              {(id) => (
                <Select id={id} value={mode} onChange={(e) => setMode(e.target.value as ImageLabMode)}>
                  {imageLabModes.map((entry) => (
                    <option key={entry} value={entry}>
                      {imageLabModeLabel(entry)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          ) : null}
        </div>

        {needsChat ? (
          <div className="grid gap-4 sm:grid-cols-[16rem_1fr]">
            <Field
              label="Chat"
              hint={
                kind === "baseline_scene"
                  ? "A scene baseline re-runs this conversation's own scene settings."
                  : "The conversation this evidence is filed against; its character and scene renders feed the pickers."
              }
            >
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
            {kind === "controlled_scene" ? identityColumn : null}
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-[16rem_1fr]">
            <Field
              label="Character"
              hint={
                isProbe
                  ? "Whose identity the probe must preserve."
                  : kind === "controlled_portrait"
                    ? "The character this evidence is filed against — whose identity the render must keep."
                    : "The character whose portrait settings are re-run."
              }
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
            {isProbe || kind === "controlled_portrait" ? identityColumn : null}
          </div>
        )}

        {sendsFixture ? (
          <>
            <Field
              label="Control fixture"
              hint="The structure the output must obey. Required, and only a reviewed fixture may be sent."
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
                {unreviewedCount}
                {" fixture(s) above are greyed out because nobody has reviewed them. Look at each one in "}
                {"the fixtures panel and mark it reviewed — a run that comes back “ignores the control” has "}
                {"to rule out a bad fixture before it rules on the model."}
              </p>
            ) : null}
          </>
        ) : null}

        {controlledKind !== null ? (
          <>
            <div className="grid gap-4 sm:grid-cols-[16rem_1fr]">
              <Field
                label="Extra reference"
                hint="Optional third reference the recipe allows. Pick a role, then its image — or leave it at none."
              >
                {(id) => (
                  <Select
                    id={id}
                    value={extraRole}
                    onChange={(e) => setExtraRole(e.target.value as ExtraReferenceRole | "")}
                  >
                    <option value="">— None —</option>
                    {extraRoleOptions.map((role) => (
                      <option key={role} value={role}>
                        {imageLabRoleLabel(role)}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              {extraRole !== "" ? (
                <LabRenderPicker
                  label={imageLabRoleLabel(extraRole)}
                  hint={extraRoleHint(extraRole)}
                  scopeId={extraSource === "scenes" ? chatId : identityCharacterId}
                  images={extraSource === "scenes" ? scenes : portraits}
                  value={extraImageId}
                  onChange={setExtraImageId}
                  excluded={
                    fixtureSourceId === null ? null : { imageId: fixtureSourceId, reason: FIXTURE_SOURCE_REASON }
                  }
                  emptyHints={extraSource === "scenes" ? SCENE_EMPTY_HINTS : chatPortraitEmptyHints}
                />
              ) : null}
            </div>
            <p className="text-xs text-paper-500">
              {`${DEFAULT_MODEL_SLUG} accepts at most 3 reference images, so identity, the control, and one `}
              {"extra fill it exactly. References past a model's capacity are not refused on a controlled "}
              {"run — the plan drops them and records the drop on the result."}
            </p>
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
                : controlledKind !== null
                  ? "Nothing ordered yet — a controlled run sends its identity, its control fixture, and at most one extra."
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

        {controlledKind !== null ? (
          <div className="rounded-card border border-ink-700 bg-ink-950/40 px-3 py-2">
            <p className="text-[11px] tracking-wide text-paper-500 uppercase">Prompt prefix (compiled by the runner)</p>
            {bindingPreview === "" ? (
              <p className="mt-1 text-xs text-paper-500">
                Pick references above to see the numbered role bindings the runner will prefix to your instruction.
              </p>
            ) : (
              <p className="mt-1 text-xs whitespace-pre-wrap text-paper-300">{bindingPreview}</p>
            )}
          </div>
        ) : null}

        <Field
          label="Instruction"
          hint={
            isProbe
              ? "Pre-filled from the numbered-role template; the numbers match the list above. Sent exactly as written."
              : controlledKind !== null
                ? "The base prompt only. The runner prefixes the numbered bindings shown above and records the full text as the final prompt."
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
              placeholder={
                isProbe
                  ? "Pick a control fixture to fill the template."
                  : controlledKind !== null
                    ? "What the render should be, past the bindings — sent after the prefix."
                    : ""
              }
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
