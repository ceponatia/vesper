import {
  compileReferenceRolePrompt,
  type ImageLabControl,
  imageLabControlRole,
  type ImageLabCreateExperimentRequest,
  type ImageLabExperimentKind,
  imageLabFinishingInstruction,
  type ImageLabInput,
  imageLabProbeInstruction,
  type ImageReferenceRole,
  isImageLabControlledKind,
} from "@vesper/image-core";
import { INTIMATE_SCENE_LORA_MODEL_SLUG } from "@/contracts/images/intimate-scene-lora";

/** What the runner uses when the form names no model. Shown, never sent. */
export const DEFAULT_MODEL_SLUG = "qwen/qwen-image-edit-2511";

/**
 * A staged scene's default model, and the one kind whose blank Model box IS
 * sent rather than left to the runner.
 *
 * Every other kind leaves its blank Model box to the runner, which resolves
 * "the plan's model" — whatever the deployment's scene default happens to be.
 * A staged scene is evidence ABOUT the intimate route, so it cannot afford
 * that: on a deployment whose scene default is another endpoint, the bench
 * would render a different model than production and still read as production.
 *
 * So the staged kind names the production intimate model and SENDS it. An admin
 * who names another slug still overrides it; this only fills the blank.
 *
 * It is the SAME constant the chat render route resolves, imported rather than
 * retyped: a second spelling here would drift the day the pairing moves to
 * another model, and a bench that ran a different model than production would
 * quietly stop being evidence about production.
 */
export const STAGED_DEFAULT_MODEL_SLUG = INTIMATE_SCENE_LORA_MODEL_SLUG;

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
 * Whether a fixture may be sent at all.
 *
 * The runner refuses an unreviewed one outright
 * (`image_lab.control_unreviewed`), because a run reading "ignores the
 * control" has to be able to eliminate "the fixture was wrong" first. Offering
 * one here would sell an admin a queued experiment that can only fail, so the
 * picker shows it greyed instead — visible, because a fixture that vanished from
 * a list the panel above still shows reads as a broken form.
 */
export function isReviewedFixture(control: ImageLabControl): boolean {
  return control.meta.reviewedAt !== undefined;
}

/**
 * Whom an ordered input depicts, by NAME — what the runner binds a subject by,
 * resolved here from the same character list the cast selects are drawn from.
 * `null` for an input that names nobody, which is every input of every other
 * kind. The runner falls back to the stored id when a name cannot be read, and
 * so does this: a preview that quietly dropped the subject would also drop the
 * cast clause, which is the one sentence a merged pair of faces is prevented by.
 */
export function boundSubject(
  input: ImageLabInput,
  characterRows: readonly { id: string; name: string }[],
): string | null {
  if (input.characterId === undefined) return null;
  return characterRows.find((character) => character.id === input.characterId)?.name ?? input.characterId;
}

export interface ImageLabFormValues {
  kind: ImageLabExperimentKind;
  characterId: string;
  characterBId: string;
  chatId: string;
  sourceImageId: string | null;
  sourceImageBId: string | null;
  control: ImageLabControl | null;
  extraRole: ImageReferenceRole | "";
  extraImageId: string | null;
  stagedLocationImageId: string | null;
  instructionEdited: boolean;
  instructionText: string;
  characterRows: readonly { id: string; name: string }[];
  sourceExperimentId: string;
  loraReady: boolean;
  loraOnlyArm: boolean;
  selectedLora: { id: string } | null;
  effectiveLoraScale: number | null;
  modelSlug: string;
  stagingId: string;
  stagingSetting: string;
  stagingLighting: string;
  stagingTimeOfDay: string;
}

/** Translate the current selections; the package schema remains the request authority. */
export function buildImageLabFormRequest(values: ImageLabFormValues) {
  const {
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
  } = values;
  const controlledKind = isImageLabControlledKind(kind) ? kind : null;
  const isProbe = kind === "control_probe";
  const isBaseline = kind === "baseline_portrait" || kind === "baseline_scene";
  const isFinishing = kind === "finishing_pass";
  const isTwoCharacter = kind === "two_character_scene";
  const isStaged = kind === "staged_scene";
  const sendsFixture = isProbe || controlledKind !== null;
  const offersFixture = sendsFixture || isTwoCharacter;
  const needsChat = kind === "baseline_scene" || kind === "controlled_scene" || isTwoCharacter;
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
  const controlInput =
    control === null ? null : (inputs.find((entry) => entry.imageId === control.imageId) ?? null);

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
            const subject = boundSubject(input, characterRows);
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
        references: (loraOnlyArm ? FINISHING_LORA_ONLY_PREVIEW_ROLES : FINISHING_PREVIEW_ROLES).map(
          (role) => ({
            role,
          }),
        ),
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
        // the cast selects, so this is the same kind of rail the reviewed-fixture
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

  const sendsCharacter =
    kind === "control_probe" || kind === "baseline_portrait" || kind === "controlled_portrait";
  // Blank normally means "let the runner resolve the plan's model". The staged
  // kind is the exception and fills its own blank (STAGED_DEFAULT_MODEL_SLUG):
  // it must NAME the production intimate model, because a deployment whose
  // scene default is another endpoint would otherwise bench a model the
  // intimate route does not run. A baseline sends NO slug at all, whatever
  // the (hidden) model state holds:
  // the runner resolves the production profile and overwrites a requested
  // slug anyway, and a stored value the run discarded would read as a choice.
  const namedModel =
    isBaseline || modelSlug.trim() === ""
      ? isStaged
        ? STAGED_DEFAULT_MODEL_SLUG
        : undefined
      : modelSlug.trim();
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
          // a bench. The staging fields show what goes instead of this.
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

  return { body, inputs, template, instruction, bindingPreview, finishingPreview, kindReady };
}
