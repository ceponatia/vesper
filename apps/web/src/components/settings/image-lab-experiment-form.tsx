"use client";

import { useState } from "react";
import {
  baseImageModelSlug,
  IMAGE_LAB_MAX_INPUTS,
  type ImageLabControl,
  type ImageLabControlledKind,
  type ImageLabExperiment,
  type ImageLabExperimentKind,
  imageLabExperimentKinds,
  type ImageLabInput,
  isImageLabControlledKind,
  isImageLabFinishableKind,
  pinnedImageModelVersion,
} from "@vesper/image-core";
import { INTIMATE_SCENE_LORA_ID } from "@/contracts/images/intimate-scene-lora";
import { adminImageModelsApi, chatsApi, imageLabApi, imageLorasApi } from "@/lib/client/api";
import { useAsyncData } from "@/components/hooks/use-async";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import {
  imageLabControlKindLabel,
  imageLabExperimentKindDescription,
  imageLabExperimentKindLabel,
  imageLabRoleLabel,
} from "./image-lab-copy";
import { labRenderLabel, useLabCharacters, useLabChatScenes, useLabPortraits } from "./image-lab-pickers";
import { LabCharacterFields, LabChatFields } from "./image-lab-form/baseline-fields";
import {
  EXTRA_REFERENCE_ROLES,
  type ExtraReferenceRole,
  LabControlledFields,
  LabFixtureFields,
  LabIdentityFields,
} from "./image-lab-form/controlled-fields";
import { LabFinishingFields, LabLoraFields } from "./image-lab-form/finishing-fields";
import { LabStagedFields } from "./image-lab-form/staged-fields";
import { LabTwoCharacterFields } from "./image-lab-form/two-character-fields";
import {
  boundSubject,
  buildImageLabFormRequest,
  DEFAULT_MODEL_SLUG,
  STAGED_DEFAULT_MODEL_SLUG,
} from "./image-lab-form/request";

/**
 * Owns form state, render-time resets, data hooks, and submission. Experiment
 * fields render controlled selections; request.ts translates their current values
 * into the existing Lab contract and compiles previews with the runner's helpers.
 */

/**
 * The Model select's two options that are not a registered slug.
 *
 * Both are values a real slug can never take, so neither can collide with a row
 * the registry returns: a slug is `owner/name`, so it is never blank, and it
 * never contains a space.
 *
 * The default keeps its old spelling — the empty string — because blank ALREADY
 * means "let the runner resolve the kind's model" everywhere below, and every
 * submit path reads that. The select changed how the choice is made, not what an
 * unmade choice means.
 */
const DEFAULT_MODEL_CHOICE = "";
const OTHER_MODEL_CHOICE = "other model";

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
   * The experiment list the page already holds — the source picker's options. A
   * finishing pass refines one of these, so the form reads the same rows the
   * list below shows rather than fetching a second copy that could disagree
   * with it about which runs succeeded.
   */
  experiments: ImageLabExperiment[];
  /**
   * Seed values for a paired baseline. Read once, at mount: the page remounts
   * the form (key) when a new pre-fill arrives — the detail view's own idiom —
   * so a half-edited form is never rewritten under the admin's hands.
   */
  prefill?: ImageLabExperimentPrefill | null;
  /**
   * The created experiment's id — the caller arms its pending tile with it, and
   * remounts this form blank (the same key idiom the pre-fill uses). A create
   * ends this form's life on purpose: a submitted experiment left sitting in the
   * fields is one stray click from being rendered, and paid for, twice.
   */
  onCreated: (experimentId: string) => void;
}

export function ImageLabExperimentForm({
  controls,
  experiments,
  prefill = null,
  onCreated,
}: ImageLabExperimentFormProps) {
  const toast = useToast();
  const characters = useLabCharacters();
  const chats = useAsyncData(() => chatsApi.list(), []);
  const loras = useAsyncData(() => imageLorasApi.list(), []);
  // The registered models, so the Model box is a list of rows that exist rather
  // than a slug an admin has to remember exactly. Same admin-only endpoint the
  // registry page reads; the lab is already behind that gate.
  const models = useAsyncData(() => adminImageModelsApi.list(), []);

  const [kind, setKind] = useState<ImageLabExperimentKind>(prefill?.kind ?? "control_probe");
  const [characterId, setCharacterId] = useState(prefill?.characterId ?? "");
  const [sourceImageId, setSourceImageId] = useState<string | null>(null);
  // The SECOND half of a two-character cast. The first half reuses the character
  // and identity-render state every other subject-picking kind already holds — so
  // a character chosen before the kind was switched is still chosen after — and
  // only the extra subject needs state of its own.
  const [characterBId, setCharacterBId] = useState("");
  const [sourceImageBId, setSourceImageBId] = useState<string | null>(null);
  const [chatId, setChatId] = useState(prefill?.chatId ?? "");
  const [controlImageId, setControlImageId] = useState<string | null>(null);
  const [sourceExperimentId, setSourceExperimentId] = useState("");
  const [extraRole, setExtraRole] = useState<ExtraReferenceRole | "">("");
  const [extraImageId, setExtraImageId] = useState<string | null>(null);
  // Which model a run names, in two parts: the select holds the choice, and only
  // the "Other" branch keeps free text. `modelSlug` stays a plain string with
  // the same meaning it always had — blank is the kind's default — so no submit
  // path had to learn about the control that now produces it.
  const [modelChoice, setModelChoice] = useState<string>(DEFAULT_MODEL_CHOICE);
  const [customModelSlug, setCustomModelSlug] = useState("");
  const modelSlug = modelChoice === OTHER_MODEL_CHOICE ? customModelSlug : modelChoice;
  // A staged scene's own four fields: the act, and the three scene facts no chat
  // exists here to supply. Kept as their own state rather than folded into the
  // instruction, because they are structured values the request carries under
  // `staging` — the runner reads them, nothing parses them back out of prose.
  const [stagingId, setStagingId] = useState("");
  const [stagingSetting, setStagingSetting] = useState("");
  const [stagingLighting, setStagingLighting] = useState("");
  const [stagingTimeOfDay, setStagingTimeOfDay] = useState("");
  // The staged kind's optional place imagery, from the general picker — this
  // kind refuses a chat outright, so no scene-scoped list could ever feed it.
  const [stagedLocationImageId, setStagedLocationImageId] = useState<string | null>(null);
  const [loraId, setLoraId] = useState("");
  const [loraScale, setLoraScale] = useState("");
  const [loraOnly, setLoraOnly] = useState(false);
  const [instructionText, setInstructionText] = useState(prefill?.instruction ?? "");
  const [instructionEdited, setInstructionEdited] = useState(prefill !== null && prefill.instruction !== "");
  const [submitting, setSubmitting] = useState(false);

  const controlledKind: ImageLabControlledKind | null = isImageLabControlledKind(kind) ? kind : null;
  const isProbe = kind === "control_probe";
  // The two kinds whose model is not this form's to pick: `runBaseline` resolves
  // the active production profile and overwrites any requested slug, so the
  // Model slot shows what happens instead of a select, and no slug is sent.
  const isBaseline = kind === "baseline_portrait" || kind === "baseline_scene";
  const isFinishing = kind === "finishing_pass";
  const isTwoCharacter = kind === "two_character_scene";
  const isStaged = kind === "staged_scene";
  /** Kinds whose send order REQUIRES a control fixture. */
  const sendsFixture = isProbe || controlledKind !== null;
  /**
   * Kinds that offer the fixture picker at all. A two-character scene is the one
   * kind whose fixture is optional — its required references are the two
   * identities, and a control spends the slot after them — so it offers the
   * picker without requiring it, and "no control" is the arm it starts on.
   */
  const offersFixture = sendsFixture || isTwoCharacter;
  const needsChat = kind === "baseline_scene" || kind === "controlled_scene" || isTwoCharacter;

  // What a finishing pass may refine: a succeeded run of a finishable kind that
  // still holds its render. The server refuses anything else outright, so a
  // fuller list would be a menu of choices that cannot be taken.
  const finishableSources = experiments.filter(
    (experiment) =>
      isImageLabFinishableKind(experiment.kind) &&
      experiment.status === "succeeded" &&
      experiment.resultImageId !== null,
  );
  // A source that left the list (deleted, or refetched away) must not ride into
  // a request as an id nothing matches — render-adjust, no latch, because
  // clearing the pick extinguishes the condition.
  if (sourceExperimentId !== "" && !finishableSources.some((entry) => entry.id === sourceExperimentId)) {
    setSourceExperimentId("");
  }

  // Only ENABLED library rows are offerable: a switched-off row is refused at
  // resolution time (`image_lora.unreachable_configuration`), so listing one
  // would sell an admin a queued experiment that can only fail.
  const enabledLoras = (loras.data ?? []).filter((lora) => lora.enabled);
  // A staged scene's recipe declares task `scene`, and the library refuses a row
  // that does not allow the task outright (`image_lora.incompatible`) — so the
  // same rule that keeps switched-off rows out of this select keeps out rows this
  // KIND could only be refused for. The filter is scoped to the staged kind
  // because it is the one place the task is known here: a finishing pass runs the
  // identity recipe, and narrowing its list on a guess about the task would hide
  // rows that work today.
  const offerableLoras = enabledLoras.filter((lora) => !isStaged || lora.allowedTasks.includes("scene"));
  const selectedLora = offerableLoras.find((lora) => lora.id === loraId) ?? null;
  // A LoRA that left the library — deleted, or switched off since the list
  // loaded — must not ride into a request as an id nothing matches. Guarded on
  // the fetch having ANSWERED, so the first render's empty list cannot clear a
  // pick; no latch, because clearing the pick extinguishes the condition.
  if (loras.data !== null && loraId !== "" && selectedLora === null) {
    setLoraId("");
  }
  // A different LoRA is a different curated band, so the scale returns to that
  // row's own default rather than carrying the previous row's number across
  // (render-adjust with a latch, never a setState inside an effect). The arm
  // resets with it: "measure THESE weights alone" is a decision about one row,
  // and a checkbox left standing through a change of LoRA would silently apply it
  // to a different question — including when the pick is cleared, after which the
  // checkbox is no longer on screen to be unticked.
  const [prevLoraId, setPrevLoraId] = useState(loraId);
  if (loraId !== prevLoraId) {
    setPrevLoraId(loraId);
    setLoraScale(selectedLora === null ? "" : String(selectedLora.defaultScale));
    setLoraOnly(false);
  }
  // A staged scene ARRIVES with the intimate LoRA already chosen, at its own
  // curated default — the chat lane sends those weights on every intimate staged
  // render, and a bench that started at none would answer a question the lane
  // never asks. It is found by the PRODUCTION row's id, not by being the first
  // `builtin` row: builtin only means "seeded by a migration", so a second
  // seeded row landing ahead of it would silently displace the weights this
  // bench exists to measure.
  //
  // Seeded ONCE (render-adjust with a latch, never a setState inside an effect),
  // so an admin who clears it back to none — the no-weights control arm, and a
  // legitimate one — is not overruled on the next keystroke.
  //
  // The latch remembers WHICH id it seeded, so leaving the kind can take it back:
  // a pick this form made on the admin's behalf must not ride into a finishing
  // pass as if it had been chosen there. A row they picked themselves is left
  // alone, like every other field that survives a change of kind.
  const stagedDefaultLora = isStaged
    ? (offerableLoras.find((lora) => lora.id === INTIMATE_SCENE_LORA_ID) ?? null)
    : null;
  const [seededLoraId, setSeededLoraId] = useState<string | null>(null);
  if (isStaged && seededLoraId === null && loraId === "" && stagedDefaultLora !== null) {
    setSeededLoraId(stagedDefaultLora.id);
    setLoraId(stagedDefaultLora.id);
  }
  if (!isStaged && seededLoraId !== null) {
    setSeededLoraId(null);
    if (loraId === seededLoraId) setLoraId("");
  }
  // The model the run will actually resolve — what the admin named, or the
  // kind's own default when the box is blank. A staged scene's default is the
  // production intimate-scene model, so the bench spends on the pairing the
  // chat lane actually renders.
  const blankModelDefault = isStaged ? STAGED_DEFAULT_MODEL_SLUG : DEFAULT_MODEL_SLUG;
  const effectiveModelSlug = modelSlug.trim() === "" ? blankModelDefault : modelSlug.trim();
  // The registry's rows, in the order the registry sorts them. A fetch that is
  // still in flight or has failed leaves the list empty rather than holding the
  // form: Default and Other both still work, and Other never depended on the
  // list — which is what keeps a registry outage from closing the bench.
  const registeredModels = models.data?.models ?? [];
  // The registry row a run would actually resolve, by the runner's own rule:
  // exact slug first, then the pinned and unpinned spellings of one slug
  // (`resolveLabModel`). Asking it here means what the form says about a model
  // is what the runner will do with it — including for a pasted path, which is
  // how an admin learns the path is unregistered BEFORE submitting.
  const resolvedModel =
    registeredModels.find((model) => model.slug === effectiveModelSlug) ??
    registeredModels.find(
      (model) => baseImageModelSlug(model.slug) === baseImageModelSlug(effectiveModelSlug),
    ) ??
    null;
  const modelHint = ((): string => {
    const base = isStaged
      ? `Default runs the production intimate-scene model (${STAGED_DEFAULT_MODEL_SLUG}) with the same LoRA the chat lane sends.`
      : `Default runs the plan's model (${DEFAULT_MODEL_SLUG}).`;
    if (models.error !== null) {
      return `${base} The registered list could not be loaded — name a model with Other to run one.`;
    }
    // The unrunnable-row sentence appears only when there IS such a row. A
    // standing explanation of a condition nobody can see reads as a warning
    // about the model in the box.
    return registeredModels.some((model) => pinnedImageModelVersion(model) === null)
      ? `${base} A row with no pinned version cannot run here — the lab pins an exact version before it spends.`
      : base;
  })();
  // Whether the chosen weights can reach that model at all. The library compares
  // BASE slugs (a version suffix is not a different model), so this asks the same
  // question the same way, and a mismatch is the run's only possible outcome:
  // `image_lora.incompatible`, before any spend.
  //
  // It WARNS rather than disabling the button, unlike the scale check beside it.
  // The scale is judged against the row's own numbers and cannot be wrong about
  // itself; the model is free text resolved through the registry, so a slug this
  // list does not recognise may still be the right one, and a disabled submit
  // would be this form overruling the registry about a name it cannot see.
  const loraModelMismatch =
    selectedLora !== null &&
    !selectedLora.compatibleModelSlugs.some(
      (compatible) => baseImageModelSlug(compatible) === baseImageModelSlug(effectiveModelSlug),
    );
  // The arm as the request will state it. Guarded on the pick rather than trusted
  // from the checkbox alone, so the one render between a vanished LoRA and the
  // latch above cannot describe an arm with no weights in it.
  const loraOnlyArm = selectedLora !== null && loraOnly;
  // An emptied box means the row's own default, which is the same fallback the
  // evaluator applies server-side — spelled here so the disabled-submit check
  // below judges the number that will actually be sent.
  const requestedScale = Number.parseFloat(loraScale);
  const effectiveLoraScale =
    selectedLora === null
      ? null
      : Number.isFinite(requestedScale)
        ? requestedScale
        : selectedLora.defaultScale;
  // The curated band is the row's own, and a scale outside it is refused rather
  // than clamped — checked here so that refusal is a disabled button instead of
  // a queued experiment whose only possible outcome is `image_lora.incompatible`.
  const loraReady =
    selectedLora === null ||
    (effectiveLoraScale !== null &&
      effectiveLoraScale >= selectedLora.minimumScale &&
      effectiveLoraScale <= selectedLora.maximumScale);

  // Whose portraits the identity picker (and the wardrobe extra) draw from: the
  // picked character — or, for a controlled scene, the conversation's own
  // character, resolved off the chat row so the evidence and its identity
  // reference cannot name two different people.
  const chatCharacterId = (chats.data ?? []).find((chat) => chat.id === chatId)?.characterId ?? "";
  const identityCharacterId = kind === "controlled_scene" ? chatCharacterId : characterId;
  const portraits = useLabPortraits(identityCharacterId);
  const portraitRows = portraits.data ?? [];
  // The second cast slot's own renders. Scoped to the kind so a character left
  // picked here does not keep fetching while another kind is on screen; the hook
  // itself is called unconditionally, and an empty id resolves to an empty list
  // without a request.
  const portraitsB = useLabPortraits(isTwoCharacter ? characterBId : "");
  const portraitBRows = portraitsB.data ?? [];
  const scenes = useLabChatScenes(kind === "controlled_scene" ? chatId : "");
  const sceneRows = scenes.data ?? [];

  // Nobody is both halves of a two-character scene: each select hides the other
  // slot's pick, so "identities swapped" stays a ruling about the model rather
  // than about a form that let one character be sent twice.
  const characterRows = characters.data ?? [];
  const castAOptions = characterRows.filter((character) => character.id !== characterBId);
  const castBOptions = characterRows.filter((character) => character.id !== characterId);

  // A change of identity source — the picked character, or the chat whose
  // character it is — invalidates the picked render (render-adjust, never a
  // setState inside an effect).
  const [prevIdentityCharacterId, setPrevIdentityCharacterId] = useState(identityCharacterId);
  if (identityCharacterId !== prevIdentityCharacterId) {
    setPrevIdentityCharacterId(identityCharacterId);
    setSourceImageId(null);
  }
  // The same rule for the second cast slot, whose list is scoped to its own
  // character (render-adjust with a latch, for the reason above).
  const [prevCharacterBId, setPrevCharacterBId] = useState(characterBId);
  if (characterBId !== prevCharacterBId) {
    setPrevCharacterBId(characterBId);
    setSourceImageBId(null);
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

  // The render the chosen fixture was extracted from, when it has one (a
  // hand-authored skeleton names none). Sending it in ANY slot hands the model
  // the answer: the output can match the control by copying that reference, and
  // the run reads as a pass it never earned — the server refuses it outright as
  // `control_source_sent`. So it is barred in the pickers below — and cleared
  // here if it was already picked, which the order render-then-fixture makes
  // reachable (render-adjust, never a setState inside an effect). No
  // previous-value latch: clearing the pick extinguishes the condition, so this
  // cannot run twice.
  //
  // Gated on the kind OFFERING a fixture, because a fixture pick survives a
  // change of kind and the refusal it protects against does not: a staged scene
  // sends no control at all, so a leftover pick from a probe must not grey out —
  // let alone silently clear — a perfectly good identity render on it.
  const fixtureSourceId = offersFixture ? (control?.meta.sourceImageId ?? null) : null;
  if (fixtureSourceId !== null && sourceImageId === fixtureSourceId) {
    setSourceImageId(null);
  }
  if (fixtureSourceId !== null && extraImageId === fixtureSourceId) {
    setExtraImageId(null);
  }
  if (fixtureSourceId !== null && sourceImageBId === fixtureSourceId) {
    setSourceImageBId(null);
  }
  // The bar is only something to explain while the barred tile is on screen — it
  // is a render of whichever character a picker is currently showing, and a
  // two-character scene shows two of them.
  const fixtureSourceShown =
    offersFixture &&
    fixtureSourceId !== null &&
    (portraitRows.some((image) => image.id === fixtureSourceId) ||
      portraitBRows.some((image) => image.id === fixtureSourceId));

  const { body, inputs, template, instruction, bindingPreview, finishingPreview, kindReady } =
    buildImageLabFormRequest({
      kind,
      characterId,
      characterBId,
      chatId,
      sourceImageId,
      sourceImageBId,
      control,
      extraRole,
      extraImageId,
      stagedLocationImageId,
      instructionEdited,
      instructionText,
      characterRows,
      sourceExperimentId,
      loraReady,
      loraOnlyArm,
      selectedLora,
      effectiveLoraScale,
      modelSlug,
      stagingId,
      stagingSetting,
      stagingLighting,
      stagingTimeOfDay,
    });

  // "Other" is a promise to name a model, so an empty box holds the run rather
  // than falling through to the kind's default. Falling through is what BLANK
  // means, and the admin who picked Other said they wanted something else — a
  // run recorded against the default under a choice that reads otherwise is the
  // one mistake this control exists to remove. A baseline is exempt: its model
  // controls are not on screen, so a choice left over from another kind must
  // not hold the run on a box the admin cannot see.
  const ready =
    kindReady && (isBaseline || modelChoice !== OTHER_MODEL_CHOICE || customModelSlug.trim() !== "");

  const describeInput = (input: ImageLabInput): string => {
    if (control !== null && input.imageId === control.imageId) {
      return `${imageLabControlKindLabel(control.meta.controlKind)} fixture`;
    }
    const record =
      portraitRows.find((image) => image.id === input.imageId) ??
      portraitBRows.find((image) => image.id === input.imageId) ??
      sceneRows.find((image) => image.id === input.imageId);
    const rendered = record ? labRenderLabel(record) : input.imageId;
    // A two-character send order has two identity rows, and a caption reading
    // "portrait" twice says nothing about who is who. The bound subject does, and
    // it is the same name the compiled bindings below will use.
    const subject = boundSubject(input, characterRows);
    return subject === null ? rendered : `${subject} · ${rendered}`;
  };

  const submit = async () => {
    if (!ready) return;
    setSubmitting(true);
    const result = await imageLabApi.experiments.create(body);
    setSubmitting(false);
    if (!result.ok) {
      toast.push({
        title: "Couldn't start that experiment",
        description: result.error.message,
        tone: "error",
      });
      return;
    }
    toast.push({
      title: "Experiment queued",
      description: "One render, charged against the daily image budget.",
      tone: "success",
    });
    onCreated(result.data.experiment.id);
  };

  const identityColumn = (
    <LabIdentityFields
      isProbe={isProbe}
      isStaged={isStaged}
      kind={kind}
      chatId={chatId}
      identityCharacterId={identityCharacterId}
      portraits={portraits}
      sourceImageId={sourceImageId}
      setSourceImageId={setSourceImageId}
      fixtureSourceId={fixtureSourceId}
      fixtureSourceShown={fixtureSourceShown}
    />
  );

  const loraFields = (
    <LabLoraFields
      offerableLoras={offerableLoras}
      isStaged={isStaged}
      isFinishing={isFinishing}
      loraId={loraId}
      setLoraId={setLoraId}
      selectedLora={selectedLora}
      loraScale={loraScale}
      setLoraScale={setLoraScale}
      loraModelMismatch={loraModelMismatch}
      effectiveModelSlug={effectiveModelSlug}
      loraOnly={loraOnly}
      setLoraOnly={setLoraOnly}
    />
  );

  return (
    <section className="rounded-card border border-ink-600 bg-ink-850 p-5">
      <h2 className="prose-display text-lg">New experiment</h2>
      <p className="mt-1 mb-4 text-sm text-paper-400">
        One deliberate render whose every input, setting, and outcome is written down. Submitting spends real
        render budget.
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
          {/* The hint describes the SELECTED kind rather than listing all of them:
              the old enumeration was already a run-on at seven kinds, and an admin
              in this select is asking about the one in the box. */}
          <Field label="Kind" hint={imageLabExperimentKindDescription(kind)}>
            {(id) => (
              <Select
                id={id}
                value={kind}
                onChange={(e) => setKind(e.target.value as ImageLabExperimentKind)}
              >
                {imageLabExperimentKinds.map((entry) => (
                  <option key={entry} value={entry}>
                    {imageLabExperimentKindLabel(entry)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {isBaseline ? (
            /* No select: `runBaseline` resolves the production profile for the
               kind when the run starts and overwrites any requested slug, so a
               picker here was a control whose value was discarded. The slot
               states what actually decides the model instead. */
            <Field
              label="Model"
              hint="A baseline re-runs the production lane as it stands, so there is no model to choose here."
            >
              <p className="text-sm text-paper-300">
                Resolved from the active production profile when the run starts.
              </p>
            </Field>
          ) : (
            <Field label="Model" hint={modelHint}>
              {(id) => (
                <>
                  <Select id={id} value={modelChoice} onChange={(e) => setModelChoice(e.target.value)}>
                    {/* Flat options, no optgroup: the shared Select styles direct-child
                        options only (`[&>option]:bg-ink-850`), and a nested group would
                        render its rows unstyled. */}
                    <option value={DEFAULT_MODEL_CHOICE}>{`Default — ${blankModelDefault}`}</option>
                    {registeredModels.map((model) => {
                      // A row with no exact version to pin is refused by the runner
                      // before it spends (`resolvePinnedLabModel`), so it is offered
                      // as what it is — visible, named, and unselectable — rather
                      // than silently absent or, worse, a click that buys a refusal.
                      const runnable = pinnedImageModelVersion(model) !== null;
                      return (
                        <option key={model.id} value={model.slug} disabled={!runnable}>
                          {`${model.label} — ${baseImageModelSlug(model.slug)}${runnable ? "" : " · no pinned version"}`}
                        </option>
                      );
                    })}
                    <option value={OTHER_MODEL_CHOICE}>Other — name a model by path</option>
                  </Select>
                  {/* What the runner knows about the model now standing in the box —
                      inside the field, not beside it, because the row above is a
                      two-column grid and a sibling here would take a cell of its own.
                      The profile picker's idiom (image-profile-select), for the same
                      reason: a caveat an operator wrote is worth reading BEFORE the
                      render is paid for, not after it comes back wrong. Held until
                      the list has loaded — an empty registry resolves nothing, and
                      "no registered model matches" mid-fetch would be a lie. */}
                  {models.data !== null ? (
                    resolvedModel === null ? (
                      <p className="text-xs text-danger-300" role="alert">
                        {`No registered model matches ${effectiveModelSlug} — the run is refused before it spends.`}
                      </p>
                    ) : resolvedModel.operatorWarning ? (
                      <p className="text-xs text-paper-500" title={resolvedModel.operatorWarning}>
                        {resolvedModel.operatorWarning}
                      </p>
                    ) : null
                  ) : null}
                </>
              )}
            </Field>
          )}
          {!isBaseline && modelChoice === OTHER_MODEL_CHOICE ? (
            <Field
              label="Model path"
              hint="A provider path — owner/name, or owner/name:version to pin one exactly. An unregistered model still has to resolve to a registered row to run."
            >
              {(id) => (
                <Input
                  id={id}
                  value={customModelSlug}
                  onChange={(e) => setCustomModelSlug(e.target.value)}
                  placeholder="owner/name"
                  // Italic on top of the shared muted placeholder colour: this
                  // placeholder is shaped like a model path, and one sitting in
                  // the box reads exactly like one somebody typed.
                  className="placeholder:italic"
                  spellCheck={false}
                  maxLength={200}
                  autoFocus
                />
              )}
            </Field>
          ) : null}
        </div>

        {isFinishing ? (
          <LabFinishingFields
            sourceExperimentId={sourceExperimentId}
            setSourceExperimentId={setSourceExperimentId}
            finishableSources={finishableSources}
            loraOnlyArm={loraOnlyArm}
            loraFields={loraFields}
          />
        ) : needsChat ? (
          <LabChatFields
            kind={kind}
            isTwoCharacter={isTwoCharacter}
            chats={chats}
            chatId={chatId}
            setChatId={setChatId}
            identityColumn={identityColumn}
          />
        ) : (
          <LabCharacterFields
            kind={kind}
            isProbe={isProbe}
            isStaged={isStaged}
            characterRows={characterRows}
            characterId={characterId}
            setCharacterId={setCharacterId}
            identityColumn={identityColumn}
          />
        )}

        {isTwoCharacter ? (
          <LabTwoCharacterFields
            castAOptions={castAOptions}
            castBOptions={castBOptions}
            characterId={characterId}
            setCharacterId={setCharacterId}
            characterBId={characterBId}
            setCharacterBId={setCharacterBId}
            portraits={portraits}
            portraitsB={portraitsB}
            sourceImageId={sourceImageId}
            setSourceImageId={setSourceImageId}
            sourceImageBId={sourceImageBId}
            setSourceImageBId={setSourceImageBId}
            fixtureSourceId={fixtureSourceId}
          />
        ) : null}

        {isStaged ? (
          <LabStagedFields
            stagingId={stagingId}
            setStagingId={setStagingId}
            stagingSetting={stagingSetting}
            setStagingSetting={setStagingSetting}
            stagingLighting={stagingLighting}
            setStagingLighting={setStagingLighting}
            stagingTimeOfDay={stagingTimeOfDay}
            setStagingTimeOfDay={setStagingTimeOfDay}
            stagedLocationImageId={stagedLocationImageId}
            setStagedLocationImageId={setStagedLocationImageId}
            characterId={characterId}
            characterRows={characterRows}
            loraFields={loraFields}
          />
        ) : null}

        {offersFixture ? (
          <LabFixtureFields
            isTwoCharacter={isTwoCharacter}
            controls={controls}
            control={control}
            controlImageId={controlImageId}
            setControlImageId={setControlImageId}
          />
        ) : null}

        {controlledKind !== null ? (
          <LabControlledFields
            controlledKind={controlledKind}
            chatId={chatId}
            identityCharacterId={identityCharacterId}
            extraRole={extraRole}
            setExtraRole={setExtraRole}
            extraRoleOptions={extraRoleOptions}
            extraImageId={extraImageId}
            setExtraImageId={setExtraImageId}
            fixtureSourceId={fixtureSourceId}
            portraits={portraits}
            scenes={scenes}
          />
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
                  : isTwoCharacter
                    ? "Nothing ordered yet — a two-character scene sends one identity reference per character, and a control fixture after them only if you pick one."
                    : isFinishing
                      ? loraOnlyArm
                        ? "Resolved at run time — the source run's result, and nothing else. The LoRA-only arm sends no identity reference at all."
                        : "Resolved at run time — the source run's result, then the identity pack's reference. The finished record lists both."
                      : isStaged
                        ? "Nothing ordered yet — a staged scene sends one identity reference, a location reference only if you pick one, and no fixture: its structure arrives as the staging's own words rather than as an image."
                        : "None — a baseline resolves the lane's own references itself."}
            </p>
          ) : (
            <ol className="mt-1 flex flex-col gap-0.5 text-xs text-paper-300">
              {inputs.map((input) => (
                <li key={input.position}>
                  <span className="text-paper-500">Image {input.position} —</span>{" "}
                  {imageLabRoleLabel(input.role)}
                  <span className="text-paper-500"> · {describeInput(input)}</span>
                </li>
              ))}
            </ol>
          )}
        </div>

        {controlledKind !== null || isTwoCharacter ? (
          <div className="rounded-card border border-ink-700 bg-ink-950/40 px-3 py-2">
            <p className="text-[11px] tracking-wide text-paper-500 uppercase">
              Prompt prefix (compiled by the runner)
            </p>
            {bindingPreview === "" ? (
              <p className="mt-1 text-xs text-paper-500">
                Pick references above to see the numbered role bindings the runner will prefix to your
                instruction.
              </p>
            ) : (
              <p className="mt-1 text-xs whitespace-pre-wrap text-paper-300">{bindingPreview}</p>
            )}
          </div>
        ) : null}

        {isFinishing ? (
          <div className="rounded-card border border-ink-700 bg-ink-950/40 px-3 py-2">
            <p className="text-[11px] tracking-wide text-paper-500 uppercase">
              Prompt (compiled by the runner)
            </p>
            <p className="mt-1 text-xs whitespace-pre-wrap text-paper-300">{finishingPreview}</p>
            <p className="mt-2 text-xs text-paper-500">
              Sent on every finishing pass, before anything you write below. It is the rule the result is
              judged by — improve the face, change nothing else — so it is not editable; an instruction that
              could delete it would let a run claim a comparison it never ran.
            </p>
          </div>
        ) : null}

        {/* A staged scene has NO instruction box, and that is the kind's defining
            constraint rather than a simplification. Its prompt is compiled from
            the staging registry byte for byte as the chat lane compiles it, and
            the byte-parity is the whole reason a ruling made here transfers to
            production — a sentence typed on this form would be appended to that
            prompt and the bench would be measuring something else. A field the
            runner ignored would be worse still. */}
        {isStaged ? (
          <div className="rounded-card border border-ink-700 bg-ink-950/40 px-3 py-2">
            <p className="text-[11px] tracking-wide text-paper-500 uppercase">Instruction</p>
            <p className="mt-1 text-xs text-paper-500">
              {
                "None, on this kind alone. The registry owns every word of the act and the runner compiles the same "
              }
              {
                "scene prompt production sends, so there is nothing to write and nothing that could be written "
              }
              {
                "without making this run answer a different question. Choose the act above; the render states it."
              }
            </p>
          </div>
        ) : (
          <Field
            label="Instruction"
            hint={
              isProbe
                ? "Pre-filled from the numbered-role template; the numbers match the list above. Sent exactly as written."
                : controlledKind !== null
                  ? "The base prompt only. The runner prefixes the numbered bindings shown above and records the full text as the final prompt."
                  : isTwoCharacter
                    ? "Describe the scene, naming both characters and what each is doing. The base prompt only — the runner prefixes the numbered bindings shown above, which name each face themselves, so don't number the images here."
                    : isFinishing
                      ? "Optional — appended after the rule above to narrow it (“the left eye is wrong”), never to replace it."
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
                      : isTwoCharacter
                        ? "Name both characters and say what each is doing — “Sabrina sits at the bar; Wren leans against it, talking to her.”"
                        : isFinishing
                          ? "Leave blank to send the rule alone."
                          : ""
                }
                maxLength={8000}
              />
            )}
          </Field>
        )}
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
