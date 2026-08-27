"use client";

import { useState } from "react";
import {
  baseImageModelSlug,
  compileReferenceRolePrompt,
  IMAGE_LAB_DEFAULT_SUBJECT_FACTS,
  IMAGE_LAB_MAX_INPUTS,
  type ImageLabControl,
  type ImageLabControlledKind,
  imageLabControlRole,
  type ImageLabCreateExperimentRequest,
  type ImageLabExperiment,
  type ImageLabExperimentKind,
  imageLabExperimentKinds,
  imageLabFinishingInstruction,
  type ImageLabInput,
  imageLabProbeInstruction,
  type ImageLabSubjectFactsMode,
  imageLabSubjectFactsModes,
  type ImageReferenceRole,
  isImageLabControlledKind,
  isImageLabFinishableKind,
  pinnedImageModelVersion,
} from "@vesper/image-core";
import { INTIMATE_SCENE_LORA_WRAPPER_SLUG } from "@/contracts/images/intimate-scene-lora";
import { sceneStagings, type SceneStaging } from "@/contracts/images/scene-staging";
import type { DaylightBand } from "@/lib/clock";
import {
  adminImageModelsApi,
  chatsApi,
  imageLabApi,
  imageLorasApi,
  type CharacterSummary,
  type ImageRecord,
} from "@/lib/client/api";
import { useAsyncData, type AsyncState } from "@/components/hooks/use-async";
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
  imageLabStagingBareSummary,
  imageLabStagingCameraSummary,
  imageLabStagingOptionLabel,
  imageLabStagingViewerPartsSummary,
  imageLabSubjectFactsHint,
  imageLabSubjectFactsLabel,
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
import { OwnedImagePicker } from "./owned-image-picker";

/**
 * The create-experiment form: the Stage 0 control-probe protocol, plus the
 * Stage 1–2 controlled recipes.
 *
 * Every declared kind is offered, because as of Stage 3 the runner accepts every
 * one of them.
 *
 * The instruction field means three different things by kind, and the form is
 * explicit about which. A PROBE's instruction is the WHOLE prompt: pre-filled
 * from the numbered-role template and then owned by the admin (the template
 * tracks the fixture until the text is edited, with an explicit way back), sent
 * exactly as shown — the runner never rewrites prompts, because a verdict is a
 * ruling on a specific sentence. A CONTROLLED kind's instruction is the BASE
 * prompt only: the runner's compose strategy prefixes the numbered role
 * bindings itself, so pre-filling the probe template here would send the
 * bindings twice. The form shows a live read-only preview of that prefix
 * instead, compiled by the same pure function the server compiles it with. A
 * FINISHING PASS's instruction is optional and additive: the rule it is judged
 * by is fixed text the runner always sends, previewed here in full, and what
 * the admin writes narrows it rather than replacing it.
 *
 * A finishing pass also picks no images. Its base render is whatever its source
 * experiment produced and its identity references come from the character's
 * identity pack, both resolved by the runner — so the form picks the SOURCE and
 * nothing else, and the ordered list below says so instead of showing an empty
 * send order.
 *
 * A TWO-CHARACTER SCENE is the one kind that picks two subjects. Each half names
 * a character AND the render carrying that character's face, and the two
 * identity inputs are BOUND to their characters — the trial it feeds rules on
 * which face landed on whom ("identities swapped"), and a slot whose subject was
 * only implied by its position could not be checked against that ruling. Its
 * control fixture is OPTIONAL, unlike every other fixture-sending kind: the
 * required references are the two identities, and a fixture spends the slot after
 * them, so "no control" is a legitimate arm and the default one. Like the
 * controlled kinds, the instruction is the base prompt only — the runner compiles
 * the numbered bindings from the send order below.
 *
 * `mode` is not sent at all. The stored modes are recorded metadata no runner
 * reads, so offering the knob here sold a choice with no render effect; the form
 * stopped offering it until one exists. Historic stored values remain readable
 * on the detail view.
 *
 * The BASELINE kinds name no model either. `runBaseline` resolves the active
 * production profile for the kind and overwrites any requested slug — a picker
 * here was a control whose value was discarded — so those kinds show read-only
 * copy in the Model slot and send no `modelSlug`.
 *
 * No raw provider-JSON settings surface exists on this form at all — which for
 * the controlled kinds is load-bearing, not an omission: the server REFUSES a
 * controlled experiment carrying a `controlInput` bag (`settings_unsupported`),
 * because a production-shaped run has no raw bag to carry.
 *
 * A finishing pass may additionally name one LoRA from the curated library, at a
 * scale inside that row's own band. It is offered on this kind alone because a
 * finishing pass is where the question is asked — does blending these weights in
 * improve the face without moving anything else? — and the picker sends a library
 * ID, never a locator: which weights that id points at is the library's ruling,
 * re-made at render time, so a record can never claim an address the run did not
 * use.
 *
 * With a LoRA picked, the pass may additionally be run as the Stage 5 LORA-ONLY
 * ARM: the base render goes alone, with no identity reference beside it, so what
 * the weights contribute can be read without the pack contributing to the same
 * face. The checkbox appears only once a LoRA is chosen, because the arm without
 * weights is not a comparison — it is the source image rendered twice.
 *
 * A STAGED SCENE is the second kind offered the LoRA picker, and the one it
 * matters most on. It writes no
 * instruction at all: the staging registry owns every explicit word of the act,
 * the runner compiles the same scene prompt the chat lane sends, and byte-parity
 * with that prompt is the entire reason this bench answers anything — a sentence
 * typed here would make it answer a different question. So the instruction box is
 * replaced by the staging's own sentence, read out of the registry with the
 * chosen character's name substituted, exactly as the render will state it.
 *
 * What the admin picks instead is the ACT (a registry id), the scene facts no
 * chat exists to supply (setting, lighting, time of day), the character, their
 * identity render, and the weights — where the SCALE is the knob the bench
 * exists to move, since "is scale 1 right?" is a question the chat lane cannot
 * ask at all.
 */

/** What the runner uses when the form names no model. Shown, never sent. */
const DEFAULT_MODEL_SLUG = "qwen/qwen-image-edit-2511";

/**
 * A staged scene's default model, and the one kind whose blank Model box IS
 * sent rather than left to the runner.
 *
 * The ordinary default cannot carry a LoRA at all — `qwen-image-edit-2511`
 * exposes no `lora_weights` input, which is the entire reason the wrapper row
 * exists (docs/image-models/models/qwen-image-edit-plus-lora.md). A staged run seeds
 * the builtin intimate LoRA below, so defaulting the model the way every other
 * kind does would pair weights with a model that cannot load them and settle
 * the run `image_lora.incompatible` before rendering — a form that queues a
 * request it knows will fail.
 *
 * So the staged kind defaults its own model and SENDS it. An admin who names
 * another slug still overrides it; this only fills the blank.
 *
 * It is the SAME constant the chat render route resolves, imported rather than
 * retyped: a second spelling here would drift the day the wrapper is
 * re-registered, and a bench that ran a different model than production would
 * quietly stop being evidence about production.
 */
const STAGED_DEFAULT_MODEL_SLUG = INTIMATE_SCENE_LORA_WRAPPER_SLUG;

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
 * The send order a finishing pass compiles its numbered bindings over: the base
 * render, then one identity reference — and on the LoRA-only arm, the base render
 * alone.
 *
 * One identity, because the recipe draws pack references under
 * `IMAGE_LAB_FINISHING_IDENTITY_STRATEGY` and that strategy is `canonical_only`.
 * The count is restated here rather than derived because deriving it needs the
 * pack machinery, which is server-side by construction — so a strategy change is
 * a two-line change, and this comment is the second line's address.
 */
const FINISHING_PREVIEW_ROLES: readonly ImageReferenceRole[] = ["before", "identity"];
const FINISHING_LORA_ONLY_PREVIEW_ROLES: readonly ImageReferenceRole[] = ["before"];

/**
 * The optional third reference each controlled recipe is offered — exactly the
 * roles the recipes allow: [outfit, style, object] on a portrait and
 * [location, outfit, style] on a scene (`imageLabRecipeContentRoles`).
 * `object` joined when the general owned-image picker existed to feed it: the
 * character/scene pickers hold no item imagery, and filing a picture of a
 * person as "an object reference" would have poisoned the record — so the role
 * waited for a source that can honestly supply one.
 */
const EXTRA_REFERENCE_ROLES = {
  controlled_portrait: ["outfit", "style", "object"],
  controlled_scene: ["location", "outfit", "style"],
} as const satisfies Record<ImageLabControlledKind, readonly ImageReferenceRole[]>;
type ExtraReferenceRole = (typeof EXTRA_REFERENCE_ROLES)[ImageLabControlledKind][number];

/**
 * Which picker feeds each extra role. A scene's location and style come from
 * the conversation's own scene renders (a previous scene IS a picture of the
 * place, and of the scene lane's look); wardrobe comes from the character's
 * portrait renders in both kinds, because a variant render wearing the outfit
 * is the only wardrobe imagery the lab can reach. An object is the one role no
 * scoped list can supply — an item is not a portrait and not a scene — so it
 * draws from the general owned-image picker.
 */
function extraReferenceSource(
  kind: ImageLabControlledKind,
  role: ExtraReferenceRole,
): "portraits" | "scenes" | "general" {
  if (role === "object") return "general";
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
    case "object":
      return "An item the render should include beside the subject — any of your stored images can supply it.";
  }
}

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
const INTIMATE_STAGINGS: readonly SceneStaging[] = sceneStagings.filter((staging) => staging.intimate);

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
          <LabCharacterSelect id={id} characters={characters} value={characterId} onChange={onCharacterChange} />
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
  // Which arm describes the subject. Seeded from the contract's own default
  // rather than a literal, and SENT explicitly on every staged run: the record
  // has to name the arm even when the operator took the default, because the
  // two arms compile different prompts and a silent row could not be read back
  // as either one.
  const [subjectFacts, setSubjectFacts] = useState<ImageLabSubjectFactsMode>(IMAGE_LAB_DEFAULT_SUBJECT_FACTS);
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
  /** The act itself, or null while nothing is chosen (and for an id no entry answers to). */
  const staging = INTIMATE_STAGINGS.find((entry) => entry.id === stagingId) ?? null;
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
  // A staged scene ARRIVES with the intimate builtin already chosen, at its own
  // curated default — the chat lane sends those weights on every intimate staged
  // render, and a bench that started at none would answer a question the lane
  // never asks. `builtin` is what names it: a seeded row is the one the migration
  // wrote for this route, where anything hand-curated is somebody's own arm.
  //
  // Seeded ONCE (render-adjust with a latch, never a setState inside an effect),
  // so an admin who clears it back to none — the no-weights control arm, and a
  // legitimate one — is not overruled on the next keystroke.
  //
  // The latch remembers WHICH id it seeded, so leaving the kind can take it back:
  // a pick this form made on the admin's behalf must not ride into a finishing
  // pass as if it had been chosen there. A row they picked themselves is left
  // alone, like every other field that survives a change of kind.
  const stagedDefaultLora = isStaged ? (offerableLoras.find((lora) => lora.builtin) ?? null) : null;
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
  // LoRA wrapper, because its seeded weights have nowhere else to load.
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
    registeredModels.find((model) => baseImageModelSlug(model.slug) === baseImageModelSlug(effectiveModelSlug)) ??
    null;
  const modelHint = ((): string => {
    const base = isStaged
      ? `Default runs the LoRA wrapper (${STAGED_DEFAULT_MODEL_SLUG}) — the only Qwen edit model that loads weights.`
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
    selectedLora === null ? null : Number.isFinite(requestedScale) ? requestedScale : selectedLora.defaultScale;
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

  /**
   * Whom an ordered input depicts, by NAME — what the runner binds a subject by,
   * resolved here from the same character list the selects above are drawn from.
   * `null` for an input that names nobody, which is every input of every other
   * kind. The runner falls back to the stored id when a name cannot be read, and
   * so does this: a preview that quietly dropped the subject would also drop the
   * cast clause, which is the one sentence a merged pair of faces is prevented by.
   */
  const boundSubject = (input: ImageLabInput): string | null => {
    if (input.characterId === undefined) return null;
    return characterRows.find((character) => character.id === input.characterId)?.name ?? input.characterId;
  };

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

  // The ordered send list. Positions are assigned HERE, in array order, because
  // the contract requires the two to agree. A probe's numbered template below is
  // written against exactly these numbers; a controlled kind's numbered
  // bindings are compiled by the RUNNER from this same order (previewed below).
  // Identity leads and the fixture follows, matching the recipes' own
  // roleOrder, so the send order and the recipe never disagree about a slot.
  const inputs: ImageLabInput[] = [];
  if (isTwoCharacter) {
    // One identity per character, in cast order, each BOUND to the character it
    // is a reference for. The binding is not decoration: the trial this kind
    // feeds rules on which face landed on whom, and a slot whose subject was only
    // implied by its position could not be checked against that ruling.
    if (characterId !== "" && sourceImageId !== null) {
      inputs.push({ position: inputs.length + 1, role: "identity", imageId: sourceImageId, characterId });
    }
    if (characterBId !== "" && sourceImageBId !== null) {
      inputs.push({
        position: inputs.length + 1,
        role: "identity",
        imageId: sourceImageBId,
        characterId: characterBId,
      });
    }
    // The optional fixture takes the slot after both identities — identity first,
    // then the control, the same order every other fixture-sending kind uses.
    if (control !== null) {
      inputs.push({
        position: inputs.length + 1,
        role: imageLabControlRole(control.meta.controlKind),
        imageId: control.imageId,
      });
    }
  } else if (sendsFixture) {
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
  } else if (isStaged) {
    // One identity, then — only when picked — one location. The staged policy
    // has always allowed the optional `location` role; what was missing was a
    // source, because this kind refuses a chat outright and the lab's place
    // imagery used to be a conversation's own scene renders. The general
    // owned-image picker is that chat-free source, so the role is offered now,
    // identity first to match the recipe's own order.
    //
    // Both inputs are UNBOUND — no `characterId` on them — because only a
    // two-character scene binds a subject to a slot; this kind names its
    // character at the top level, and the contract refuses the other spelling.
    if (sourceImageId !== null) {
      inputs.push({ position: inputs.length + 1, role: "identity", imageId: sourceImageId });
    }
    if (stagedLocationImageId !== null) {
      inputs.push({ position: inputs.length + 1, role: "location", imageId: stagedLocationImageId });
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

  // What the runner will PREFIX to a controlled or two-character instruction: the
  // compose strategy's numbered role bindings over exactly this send order.
  // Compiled by the same pure function the server compiles it with — never
  // restated — so the preview cannot drift from what runs. An empty base prompt
  // yields the bindings alone; trimmed because the joiner leaves a seam for the
  // base text.
  //
  // A two-character send names its subjects, because the compiler needs them to
  // say which face belongs to which numbered image — and because two or more
  // distinct subjects are what make it emit the cast clause at all, which is the
  // sentence standing between this kind and a merged pair of faces. That is worth
  // reading before the render is paid for.
  const bindingPreview =
    (controlledKind !== null || isTwoCharacter) && inputs.length > 0
      ? compileReferenceRolePrompt({
          basePrompt: "",
          references: inputs.map((input) => {
            const subject = boundSubject(input);
            return subject === null ? { role: input.role } : { role: input.role, subject };
          }),
        }).trimEnd()
      : "";

  // A finishing pass previews the WHOLE fixed text, bindings and rule together,
  // because unlike the controlled kinds none of it is the admin's: they can only
  // add to it. Compiled by the same two pure functions the runner calls, over the
  // same roles the chosen ARM sends, so what is read here is what is sent — the
  // images filling the slots are the only thing this preview cannot show, and the
  // note below says so.
  const finishingPreview = isFinishing
    ? compileReferenceRolePrompt({
        basePrompt: imageLabFinishingInstruction("", loraOnlyArm ? "lora_only" : "identity"),
        // Roles alone: a finishing pass names no subject, and a binding without
        // one compiles exactly as the bare role always did.
        references: (loraOnlyArm ? FINISHING_LORA_ONLY_PREVIEW_ROLES : FINISHING_PREVIEW_ROLES).map((role) => ({
          role,
        })),
      })
    : "";

  const controlReady = control !== null && isReviewedFixture(control);
  // The optional-fixture reading of the same rule: none is a legitimate arm, and
  // a fixture that IS picked must still be reviewed. Unreviewed tiles are already
  // unclickable, so this is a rail rather than a reachable state — but a queued
  // run whose only possible outcome is `control_unreviewed` is worse than a
  // disabled button.
  const optionalControlReady = control === null || isReviewedFixture(control);
  // A role picked with no image is an unfinished thought, not a request with a
  // hole in it — the submit waits for the pair or for none.
  const extraComplete = extraRole === "" || extraImageId !== null;
  const kindReady = ((): boolean => {
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
      case "two_character_scene":
        // Both halves whole, and different people. The distinctness is enforced by
        // the selects above, so this is the same kind of rail the reviewed-fixture
        // check is: the request it would send is one the server refuses.
        return (
          chatId !== "" &&
          characterId !== "" &&
          characterBId !== "" &&
          characterId !== characterBId &&
          sourceImageId !== null &&
          sourceImageBId !== null &&
          optionalControlReady
        );
      case "finishing_pass":
        return sourceExperimentId !== "" && loraReady;
      case "staged_scene":
        // The act, the person, and a face to keep. The scene fields are all
        // optional — each has a default the lane owns — and the LoRA is checked
        // only for a scale inside its own band, the same rail a finishing pass
        // gets. The staging id is guaranteed to be a real entry because the
        // select is built from the registry, so nothing here re-checks it; the
        // lane does that anyway, against rows that may arrive from anywhere.
        return characterId !== "" && sourceImageId !== null && stagingId !== "" && loraReady;
    }
  })();

  // "Other" is a promise to name a model, so an empty box holds the run rather
  // than falling through to the kind's default. Falling through is what BLANK
  // means, and the admin who picked Other said they wanted something else — a
  // run recorded against the default under a choice that reads otherwise is the
  // one mistake this control exists to remove. A baseline is exempt: its model
  // controls are not on screen, so a choice left over from another kind must
  // not hold the run on a box the admin cannot see.
  const ready = kindReady && (isBaseline || modelChoice !== OTHER_MODEL_CHOICE || customModelSlug.trim() !== "");

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
    const subject = boundSubject(input);
    return subject === null ? rendered : `${subject} · ${rendered}`;
  };

  const submit = async () => {
    if (!ready) return;
    const sendsCharacter = kind === "control_probe" || kind === "baseline_portrait" || kind === "controlled_portrait";
    // Blank normally means "let the runner resolve the plan's model". The staged
    // kind is the exception and fills its own blank (STAGED_DEFAULT_MODEL_SLUG):
    // its seeded LoRA cannot load on the ordinary default, so a blank box there
    // would queue a run whose only outcome is `image_lora.incompatible`. A
    // baseline sends NO slug at all, whatever the (hidden) model state holds:
    // the runner resolves the production profile and overwrites a requested
    // slug anyway, and a stored value the run discarded would read as a choice.
    const namedModel =
      isBaseline || modelSlug.trim() === "" ? (isStaged ? STAGED_DEFAULT_MODEL_SLUG : undefined) : modelSlug.trim();
    // A finishing pass sends its source and nothing else: the subject is
    // inherited from that run and the references are resolved by the runner, so
    // every other field here would be a value the server refuses.
    const body: ImageLabCreateExperimentRequest = isFinishing
      ? {
          kind: "finishing_pass",
          instruction: instruction.trim(),
          inputs: [],
          modelSlug: namedModel,
          sourceExperimentId,
          // Only when a LoRA is picked. A pass without one sends no `settings`
          // key at all — an overlay nobody chose is an overlay the record would
          // then claim was configured, and the raw provider bag stays empty
          // either way (a recipe run that carries one is refused outright).
          //
          // The arm rides in the same conditional, and is likewise sent only when
          // asked for: an absent `finishingVariant` MEANS the identity arm, so
          // stating it would make every ordinary pass indistinguishable from one
          // that deliberately chose the pack. The server refuses `lora_only`
          // without a LoRA, and this shape cannot produce that pair.
          ...(selectedLora === null || effectiveLoraScale === null
            ? {}
            : {
                settings: {
                  controls: { lora: { id: selectedLora.id, scale: effectiveLoraScale } },
                  controlInput: {},
                },
                ...(loraOnlyArm ? { finishingVariant: "lora_only" as const } : {}),
              }),
        }
      : isStaged
        ? {
            kind: "staged_scene",
            // Deliberately empty, and the one field on this form with no control
            // behind it. The prompt is compiled from the staging registry by the
            // runner, byte for byte as the chat lane compiles it; a sentence sent
            // from here would be appended to that and the bench would stop being
            // a bench. The panel below shows what goes instead of this.
            instruction: "",
            inputs,
            modelSlug: namedModel,
            characterId,
            // Each optional scene field is sent only when the admin filled it: an
            // empty string is a value, and a stored `setting: ""` would claim a
            // backdrop was specified and left blank, where an ABSENT one means
            // the lane's own default — which is the fact the record should keep.
            staging: {
              id: stagingId,
              ...(stagingSetting.trim() === "" ? {} : { setting: stagingSetting.trim() }),
              ...(stagingLighting.trim() === "" ? {} : { lighting: stagingLighting.trim() }),
              ...(stagingTimeOfDay === "" ? {} : { timeOfDay: stagingTimeOfDay }),
            },
            // Always stated, never left to the server's default — the opposite
            // rule to `finishingVariant` above, and for the opposite reason: an
            // absent subject-facts mode on a stored row means "written before
            // this question existed", which is the ablation. A run that took
            // today's default has to say so or it becomes unreadable.
            subjectFacts,
            // The same rule the finishing pass sends its weights under, and the
            // same shape: a library id and the scale, never a locator. No
            // `finishingVariant` — no other kind's runner reads one, and the
            // contract refuses it here.
            ...(selectedLora === null || effectiveLoraScale === null
              ? {}
              : {
                  settings: {
                    controls: { lora: { id: selectedLora.id, scale: effectiveLoraScale } },
                    controlInput: {},
                  },
                }),
          }
        : {
            kind,
            instruction: instruction.trim(),
            inputs,
            modelSlug: namedModel,
            // Each kind names only its own subject: a scene run carrying a leftover
            // character id would record a subject it never rendered, and vice versa.
            characterId: sendsCharacter && characterId !== "" ? characterId : undefined,
            chatId: needsChat && chatId !== "" ? chatId : undefined,
            // A control image and its kind are recorded together or not at all — half
            // a pointer names a fixture nothing can check. Guarded on the kind
            // OFFERING a fixture, so a pick left over from a kind that sends one
            // cannot ride into a request from a kind that does not.
            controlImageId: offersFixture && control !== null ? control.imageId : undefined,
            controlKind: offersFixture && control !== null ? control.meta.controlKind : undefined,
            // No `mode`: the contract still accepts one, but the stored modes are
            // recorded metadata no runner reads, and a request stating a bias with
            // no render effect would file a choice nobody made anything of.
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

  const extraSource: "portraits" | "scenes" | "general" =
    controlledKind !== null && extraRole !== "" ? extraReferenceSource(controlledKind, extraRole) : "portraits";

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

  // The identity column probes and controlled kinds share — one JSX value so
  // the character-scoped and chat-scoped layouts cannot drift apart.
  const identityColumn = (
    <div className="flex flex-col gap-2">
      <LabRenderPicker
        label="Identity reference"
        hint={
          isProbe
            ? "The render whose face the output must keep. Optional — a probe may test structure alone."
            : isStaged
              ? "The render whose face this act is performed by. Required — a staged render with no likeness in it is the act happening to a stranger."
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

  /**
   * The curated-LoRA control, shared by the two kinds that offer one — one JSX
   * value for the same reason the identity column is one: the band, the default,
   * and the compatibility warning must not come to differ between them.
   *
   * The two kinds ask different questions of the same control. A finishing pass
   * asks whether blending weights in fixes a face; a staged scene asks whether
   * the SCALE is right for this act, which is the question the chat lane cannot
   * ask at all — it sends the row's default and has nowhere to say otherwise. The
   * LoRA-only checkbox stays finishing-only, because `finishingVariant` is a
   * finishing pass's field and the contract refuses it anywhere else.
   */
  const loraFields = (
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
                ? "The weights the act is rendered with. The intimate builtin is chosen for you because it is what the chat lane sends on every intimate staged render — clear it to none to see the same act without them."
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
            {"A scale outside it is refused before any spend rather than clamped. The row's trigger words and "}
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
              {"so as it stands the run is refused before any spend and nothing is rendered. Name a listed model in "}
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
          {/* The hint describes the SELECTED kind rather than listing all of them:
              the old enumeration was already a run-on at seven kinds, and an admin
              in this select is asking about the one in the box. */}
          <Field label="Kind" hint={imageLabExperimentKindDescription(kind)}>
            {(id) => (
              <Select id={id} value={kind} onChange={(e) => setKind(e.target.value as ImageLabExperimentKind)}>
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
        ) : needsChat ? (
          <div className="grid gap-4 sm:grid-cols-[16rem_1fr]">
            <Field
              label="Chat"
              hint={
                kind === "baseline_scene"
                  ? "A scene baseline re-runs this conversation's own scene settings."
                  : isTwoCharacter
                    ? "The conversation this evidence is filed against. Both characters are picked below, so this says where the scene belongs — not who is in it."
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
                    : isStaged
                      ? "Who performs the act. Named here rather than bound to the reference below, because only a two-character scene binds its subjects to their inputs."
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
            {isProbe || kind === "controlled_portrait" || isStaged ? identityColumn : null}
          </div>
        )}

        {isTwoCharacter ? (
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
                excluded={fixtureSourceId === null ? null : { imageId: fixtureSourceId, reason: FIXTURE_SOURCE_REASON }}
              />
              <LabCastSlot
                slot="B"
                characters={castBOptions}
                characterId={characterBId}
                onCharacterChange={setCharacterBId}
                portraits={portraitsB}
                imageId={sourceImageBId}
                onImageChange={setSourceImageBId}
                excluded={fixtureSourceId === null ? null : { imageId: fixtureSourceId, reason: FIXTURE_SOURCE_REASON }}
              />
            </div>
            <p className="text-xs text-paper-500">
              {"A is sent first and B second, and the runner's numbered bindings follow that order — so the "}
              {"instruction below should name both characters rather than image numbers. "}
              {`${DEFAULT_MODEL_SLUG} accepts at most 3 reference images, which the two identities and one control `}
              {"fixture fill exactly."}
            </p>
          </>
        ) : null}

        {isStaged ? (
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
                    {"sentence exactly as the chat lane does: the setting, the lighting, the shot line, and — on the "}
                    {"parity arm below — the character's own description. That parity is what makes this a bench, so "}
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
              <Field label="Time of day" hint="The lane's own shorthand — what an empty lighting box is derived from.">
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

            <Field
              label="Subject facts"
              hint={imageLabSubjectFactsHint(subjectFacts)}
            >
              {(id) => (
                <Select
                  id={id}
                  value={subjectFacts}
                  onChange={(e) => setSubjectFacts(e.target.value as ImageLabSubjectFactsMode)}
                >
                  {imageLabSubjectFactsModes.map((mode) => (
                    <option key={mode} value={mode}>
                      {imageLabSubjectFactsLabel(mode)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>

            <OwnedImagePicker
              label="Location reference (optional)"
              hint="A picture of the place the act happens — any of your stored images. Sent after the identity reference; the words above still say the setting, so none is a fine arm."
              value={stagedLocationImageId}
              onChange={setStagedLocationImageId}
            />

            <div className="flex flex-col gap-2">{loraFields}</div>
          </>
        ) : null}

        {offersFixture ? (
          <>
            <Field
              label={isTwoCharacter ? "Control fixture (optional)" : "Control fixture"}
              hint={
                isTwoCharacter
                  ? "Optional here — the two identities are the required references, and a fixture spends the slot after them. Click a chosen tile again to go back to no control. Only a reviewed fixture may be sent."
                  : "The structure the output must obey. Required, and only a reviewed fixture may be sent."
              }
            >
              <ImageChoiceGrid
                choices={controls.map((entry) => ({
                  imageId: entry.imageId,
                  label: imageLabControlKindLabel(entry.meta.controlKind),
                  detail: isReviewedFixture(entry) ? "reviewed" : "unreviewed — review it first",
                  disabled: !isReviewedFixture(entry),
                }))}
                value={controlImageId}
                // Clicking the chosen tile again clears it — the render picker's own
                // idiom, needed here because one kind's fixture is optional and a
                // picker with no way back to none would hide that arm.
                onChange={(imageId) => setControlImageId(imageId === controlImageId ? null : imageId)}
                fit="contain"
                emptyHint="No fixtures yet — extract or upload one above."
              />
            </Field>
            {isTwoCharacter ? (
              <p className="text-xs text-paper-500">
                {control === null
                  ? "No control — the scene is composed from the two identity references alone, which is the arm this kind starts on."
                  : `Controlled arm — the ${imageLabControlKindLabel(control.meta.controlKind)} is sent after both identities, and the trial reads it for pose ownership: whose body the structure claimed.`}
              </p>
            ) : null}
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
                extraSource === "general" ? (
                  // The object role's source is the GENERAL picker: no scoped
                  // list holds item imagery, and the recipe already accepts the
                  // role — same fixture-source bar as every other slot.
                  <OwnedImagePicker
                    label={imageLabRoleLabel(extraRole)}
                    hint={extraRoleHint(extraRole)}
                    value={extraImageId}
                    onChange={setExtraImageId}
                    excluded={
                      fixtureSourceId === null ? null : { imageId: fixtureSourceId, reason: FIXTURE_SOURCE_REASON }
                    }
                  />
                ) : (
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
                )
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
                  <span className="text-paper-500">Image {input.position} —</span> {imageLabRoleLabel(input.role)}
                  <span className="text-paper-500"> · {describeInput(input)}</span>
                </li>
              ))}
            </ol>
          )}
        </div>

        {controlledKind !== null || isTwoCharacter ? (
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

        {isFinishing ? (
          <div className="rounded-card border border-ink-700 bg-ink-950/40 px-3 py-2">
            <p className="text-[11px] tracking-wide text-paper-500 uppercase">Prompt (compiled by the runner)</p>
            <p className="mt-1 text-xs whitespace-pre-wrap text-paper-300">{finishingPreview}</p>
            <p className="mt-2 text-xs text-paper-500">
              Sent on every finishing pass, before anything you write below. It is the rule the result is judged by —
              improve the face, change nothing else — so it is not editable; an instruction that could delete it would
              let a run claim a comparison it never ran.
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
              {"None, on this kind alone. The registry owns every word of the act and the runner compiles the same "}
              {"scene prompt production sends, so there is nothing to write and nothing that could be written "}
              {"without making this run answer a different question. Choose the act above; the render states it."}
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
