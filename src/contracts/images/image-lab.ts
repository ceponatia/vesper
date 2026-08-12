import { z } from "zod";
import { imageReferenceRoleSchema, type ImageReferenceRole } from "./image-model-capabilities";
import { imageRenderControlsSchema, type ImageRenderControls } from "./image-model-profiles";
import type { ImageReferenceDropReason } from "./render-intent";

/**
 * The Advanced Image Lab's vocabulary and record shapes
 * (docs/developer-notes/qwen-advanced-image-subsystem.spec.md §Contracts).
 *
 * The lab is an admin-only bench: one experiment is one deliberate render whose
 * every input, setting, and outcome is written down, so a question nobody can
 * answer from a provider schema — "does this model actually honour a pose
 * skeleton?" — gets settled by evidence instead of by reading release notes. Its
 * whole reason to exist is that the ordinary lanes must not move while it runs,
 * which is why nothing here reaches the render-intent path: an experiment names
 * its model, its ordered references, and its prompt itself.
 *
 * Two vocabularies are deliberately IMPORTED rather than restated. Reference
 * roles come from `./image-model-capabilities` — a role a lab input can carry and
 * a role a model can be fed must be the same word, or a probe verdict would be
 * about a slot production does not have. Render controls come from
 * `./image-model-profiles` for the same reason: the lab's per-experiment overlay
 * is the normalized control set the profile layer already speaks, not a second
 * spelling of guidance and steps.
 *
 * Everything is pure data and shape. Persistence lives in
 * `src/server/images/image-lab.ts`, extraction in `image-lab-controls.ts`.
 */

/**
 * What one experiment is FOR.
 *
 * `control_probe` answers the plan's opening question (send a pose or depth map
 * as a numbered image and see whether the output obeys it); the two baselines
 * re-run an ordinary lane's own configuration so a later comparison has a
 * same-settings control to sit beside; the two controlled kinds ask whether the
 * control still holds when the request is production-shaped;
 * `two_character_scene` puts TWO people in one render; and `finishing_pass`
 * re-edits one of those results against the subject's identity pack, changing
 * nothing but the face.
 *
 * The first six were declared at once, three of them unused for two stages,
 * because the record shape had to survive Stages 1–3 without a migration — an
 * experiment kind arriving later would otherwise mean altering a column every
 * stored row uses. That bet paid off exactly as intended when Stage 6 added a
 * seventh: the column is plain `text`, so widening this tuple was a code change
 * and nothing else.
 *
 * `two_character_scene` is its own kind rather than a `controlled_scene`
 * carrying a second identity input, because the two ask different questions and
 * a shared kind could answer neither cleanly. A controlled scene's whole subject
 * is the CONTROL — it declares one, it requires one, and its verdict vocabulary
 * is about obedience to it. A two-character scene's subject is the CAST: whether
 * both people survive, unswapped and undoubled, with the control optional and
 * pose ownership a note rather than the ruling. One kind covering both would need
 * a verdict column that meant different things depending on how many identity
 * inputs the row happened to carry.
 *
 * `schema.ts` imports this tuple for its `text(..., { enum })` column (the
 * `trialRunStatuses` precedent), so the column and the parser cannot drift.
 */
export const imageLabExperimentKinds = [
  "control_probe",
  "baseline_portrait",
  "baseline_scene",
  "controlled_portrait",
  "controlled_scene",
  "two_character_scene",
  "finishing_pass",
] as const;
export const imageLabExperimentKindSchema = z.enum(imageLabExperimentKinds);
export type ImageLabExperimentKind = (typeof imageLabExperimentKinds)[number];

/**
 * Which pull an experiment is biased toward when identity and composition
 * compete — the knob the later stages tune, recorded from the start so a Stage 0
 * run can say it chose none.
 *
 * Optional on every Stage 0 experiment: a probe that declared a mode would be
 * claiming a recipe existed to be biased, and none does yet.
 */
export const imageLabModes = ["identity_priority", "controlled_composition", "balanced", "style_priority"] as const;
export const imageLabModeSchema = z.enum(imageLabModes);
export type ImageLabMode = (typeof imageLabModes)[number];

/**
 * The structural control an image carries. `pose` is a skeleton diagram, `depth`
 * a depth map, `edge` a white-on-black edge map.
 *
 * Deliberately NOT the same list as `imageReferenceRoles`: the reference roles
 * say what slot an image occupies in a model's inputs, while these three say
 * what a lab FIXTURE is — what was extracted, how it may be reviewed, and which
 * recipe can use it. The two lists now agree on all three names
 * ({@link imageLabControlRole} is one-to-one), but they remain separate lists
 * because `imageReferenceRoles` also carries structural roles no lab fixture is
 * extracted as (`mask`, and the generic `control`).
 */
export const imageLabControlKinds = ["pose", "depth", "edge"] as const;
export const imageLabControlKindSchema = z.enum(imageLabControlKinds);
export type ImageLabControlKind = (typeof imageLabControlKinds)[number];

/**
 * The reference role a control fixture of each kind is fed under.
 *
 * One-to-one since `edge` joined `imageReferenceRoles` with the control-role
 * slice. It used to send an edge map under the generic `control` role, which was
 * the honest answer while the role list had nothing edge-shaped in it, but it
 * meant a profile could not require an edge map specifically and a probe's
 * ordered inputs could not say whether a `control` slot held an edge map or a
 * segmentation mask.
 *
 * It lives here, beside the two vocabularies it bridges, rather than in the UI
 * helper that first needed it: the experiment form uses it to build the send
 * order AND the runner uses it to refuse a probe whose declared fixture is not
 * among the images it sends, and a second spelling would let those two disagree
 * about which slot a skeleton occupies.
 */
export function imageLabControlRole(kind: ImageLabControlKind): ImageReferenceRole {
  switch (kind) {
    case "pose":
      return "pose";
    case "depth":
      return "depth";
    case "edge":
      return "edge";
  }
}

/**
 * Every role a control fixture may be sent under.
 *
 * This is the image of {@link imageLabControlRole} over the three kinds PLUS the
 * generic `control`, which is retained for one reason: experiments recorded
 * before `edge` existed stored their edge fixtures under `control`, and a
 * validator that stopped accepting it would refuse to re-run — or even
 * re-read — probes already in the archive. New experiments never produce it.
 */
export const imageLabControlRoles = ["pose", "depth", "edge", "control"] as const satisfies
  readonly ImageReferenceRole[];

/** Whether an ordered input's role is one a control fixture may be sent under. */
export function isImageLabControlRole(role: ImageReferenceRole): boolean {
  return imageLabControlRoles.some((controlRole) => controlRole === role);
}

/**
 * Where a control fixture came from. Provenance is not decoration here: a
 * skeleton a human drew and a skeleton a preprocessor extracted fail in
 * different ways, and a probe that reads `ignores_control` has to be able to
 * rule out "the fixture was wrong" before it rules on the model.
 */
export const imageLabControlGenerators = [
  "extracted_pose",
  "extracted_depth",
  "computed_edge",
  "hand_authored",
] as const;
export const imageLabControlGeneratorSchema = z.enum(imageLabControlGenerators);
export type ImageLabControlGenerator = (typeof imageLabControlGenerators)[number];

/**
 * The reviewing admin's ruling on a `control_probe`. This is the one fact the
 * whole Stage 0 protocol exists to produce, and no probe of a provider schema
 * can produce it: whether the output limbs match the skeleton is a judgment made
 * by looking at the image.
 *
 * `inconclusive` is a real outcome, not a missing one — a run whose fixture was
 * ambiguous or whose identity collapsed for unrelated reasons says so, rather
 * than being recorded as evidence it is not.
 */
export const imageLabProbeVerdicts = ["honours_control", "ignores_control", "inconclusive"] as const satisfies
  readonly ImageLabVerdict[];
export const imageLabProbeVerdictSchema = z.enum(imageLabProbeVerdicts);
export type ImageLabProbeVerdict = (typeof imageLabProbeVerdicts)[number];

/**
 * The reviewing admin's ruling on a `finishing_pass`, and the reason the verdict
 * vocabulary is not one list.
 *
 * "Honours the control" cannot be asked of a finishing pass: it declares no
 * control, and the question it exists to settle is a different one entirely —
 * the plan's promotion rule, which says a finishing pass is promoted only when
 * it "improves identity without materially changing structure, clothing, body,
 * camera, lighting, or setting". That rule has two independent halves, and the
 * three rulings are exactly the outcomes they produce:
 *
 * - `improves_identity` — the face matches the identity references better than
 *   the base did, and nothing else moved. The only promotable outcome.
 * - `identity_unchanged` — nothing meaningful changed either way. Recorded as a
 *   real result rather than as a failure: the plan warns that a second pass of
 *   the SAME model is a weak prior, so a pass that earns nothing is precisely
 *   the evidence the stage was told to look for.
 * - `changes_beyond_identity` — it moved the pose, clothing, body, camera,
 *   lighting, or setting. Not promotable whatever it did to the face, which is
 *   why it is one ruling rather than a note on the two above.
 *
 * `inconclusive` is shared with the probe vocabulary and means there what it
 * means here: this run settles nothing.
 */
export const imageLabFinishingVerdicts = [
  "improves_identity",
  "identity_unchanged",
  "changes_beyond_identity",
  "inconclusive",
] as const satisfies readonly ImageLabVerdict[];
export const imageLabFinishingVerdictSchema = z.enum(imageLabFinishingVerdicts);
export type ImageLabFinishingVerdict = (typeof imageLabFinishingVerdicts)[number];

/**
 * The reviewing admin's ruling on a `two_character_scene`, and the third
 * vocabulary for the same reason there was a second.
 *
 * Neither existing question fits. "Honours the control" cannot be the ruling
 * here because the control is OPTIONAL — half these runs declare none, and the
 * ones that do declare one are still not primarily about it. "Improves identity"
 * is a comparison against a base render this kind has no base for. The question
 * Stage 6 exists to settle is the CAST: put two people in one render and count
 * what comes back.
 *
 * The five substantive rulings are the failure modes the plan names ("identity
 * swapping, duplicated people, missing characters"), each kept separate because
 * each sends the trial somewhere different:
 *
 * - `both_identities_held` — both characters present exactly once, each matching
 *   their own reference. The only promotable outcome, and the whole bar: two
 *   recognisable people is what a two-character render IS.
 * - `identities_swapped` — both are there, but the faces or bodies are exchanged.
 *   Separate from a degradation because it is not one: the likenesses survived
 *   intact and the BINDING failed, which is a prompt problem (the numbered
 *   reference did not stick) rather than a model-capacity one.
 * - `character_missing` — fewer people than the row declared. The model collapsed
 *   the cast rather than getting it wrong.
 * - `character_duplicated` — one identity rendered more than once, or extra
 *   people who were never referenced. The opposite failure, and it reads
 *   identically to `character_missing` in a bare "the cast is wrong" bucket while
 *   pointing at the opposite fix.
 * - `identity_degraded` — both present, no swap and no duplicate, but a likeness
 *   drifted. The structural questions all came out right and the model simply
 *   could not hold two faces at once, which is the outcome that says the arity is
 *   the limit rather than the wording.
 *
 * `inconclusive` is shared with the other two vocabularies and means the same
 * thing: this run settles nothing.
 *
 * CONTROL OBEDIENCE IS NOT HERE. A controlled two-character run wants both
 * questions answered — did the cast survive, and did the pose take — but the row
 * has one verdict column, and a kind whose ruling could come from either of two
 * vocabularies is a kind whose stored verdict cannot be read without knowing
 * which question the reviewer happened to be answering. So the column carries the
 * kind's DEFINING question, which is the two-character one, and pose ownership is
 * written in `verdictNote` beside it. That is a deliberate ranking of two real
 * facts, not an oversight: a render that obeyed the skeleton perfectly and merged
 * both faces is a failure, and one that held both faces while ignoring the pose is
 * a result worth having.
 */
export const imageLabTwoCharacterVerdicts = [
  "both_identities_held",
  "identities_swapped",
  "character_missing",
  "character_duplicated",
  "identity_degraded",
  "inconclusive",
] as const satisfies readonly ImageLabVerdict[];
export const imageLabTwoCharacterVerdictSchema = z.enum(imageLabTwoCharacterVerdicts);
export type ImageLabTwoCharacterVerdict = (typeof imageLabTwoCharacterVerdicts)[number];

/**
 * Every ruling any experiment kind may record — the union the row's `verdict`
 * column and the record-verdict request both speak.
 *
 * ONE column, a widened vocabulary, and a per-kind gate ({@link
 * imageLabVerdictOptions}) rather than a second verdict field. An experiment
 * carries exactly one ruling whatever kind it is, so a second column would be
 * null on every row that used the first, and a reader assembling "the verdict"
 * would have to know which column its kind used before it could read it. The
 * `satisfies` on each sub-vocabulary above is the tie that keeps this list a
 * superset of both.
 *
 * The database column is plain `text` (drizzle's `{ enum }` is a TypeScript
 * refinement, not a check constraint), so widening this tuple is a code change
 * and never a migration — the same property the registries lean on.
 */
export const imageLabVerdicts = [
  "honours_control",
  "ignores_control",
  "improves_identity",
  "identity_unchanged",
  "changes_beyond_identity",
  "both_identities_held",
  "identities_swapped",
  "character_missing",
  "character_duplicated",
  "identity_degraded",
  "inconclusive",
] as const;
export const imageLabVerdictSchema = z.enum(imageLabVerdicts);
export type ImageLabVerdict = (typeof imageLabVerdicts)[number];

/**
 * The experiment kinds a verdict may be recorded on: every kind whose output
 * asks a question a reviewer can answer by looking at it.
 *
 * The list used to be "the kinds that declare a control", and it stopped being
 * that when `two_character_scene` joined — a two-character run may declare no
 * control at all and is still eminently rulable, because it is judged by looking
 * at the SUBJECTS rather than at obedience to a fixture. So the rule is the more
 * general one it always really was: a kind rules when its output settles the
 * question the kind was run to ask.
 *
 * How each kind earns its place: the probe was the first, while it was the only
 * kind that sent a fixture; the controlled recipes declare one too, and their
 * whole point is that the same limb-for-limb judgment applies to a
 * production-shaped render; a two-character scene is judged on its cast; and a
 * `finishing_pass` declares no control and is judged against its own base image.
 * Three different questions, which is why they rule in three vocabularies.
 *
 * Baselines still have none — a ruling recorded against a run that declares no
 * control, refines nothing, and depicts one person would be a fact about nothing.
 */
export const imageLabVerdictKinds = [
  "control_probe",
  "controlled_portrait",
  "controlled_scene",
  "two_character_scene",
  "finishing_pass",
] as const satisfies readonly ImageLabExperimentKind[];
export type ImageLabVerdictKind = (typeof imageLabVerdictKinds)[number];

/** Whether a kind asks a question an admin can rule on. */
export function isImageLabVerdictKind(kind: ImageLabExperimentKind): kind is ImageLabVerdictKind {
  return imageLabVerdictKinds.some((verdictKind) => verdictKind === kind);
}

/**
 * The rulings THIS kind may record, or `null` for a kind that records none.
 *
 * The gate lives here rather than at the route or in the form because both need
 * it and they must not disagree: a select offering "honours the control" on a
 * finishing pass would collect a ruling the service then refused, and a service
 * accepting one would file a control judgment against a run that sent no
 * control. Exhaustive over the kinds, so an eighth kind is a compile error here
 * rather than a silently unrulable experiment.
 */
export function imageLabVerdictOptions(kind: ImageLabExperimentKind): readonly ImageLabVerdict[] | null {
  switch (kind) {
    case "control_probe":
    case "controlled_portrait":
    case "controlled_scene":
      return imageLabProbeVerdicts;
    case "two_character_scene":
      return imageLabTwoCharacterVerdicts;
    case "finishing_pass":
      return imageLabFinishingVerdicts;
    case "baseline_portrait":
    case "baseline_scene":
      return null;
  }
}

/** Whether this ruling is one the kind's own vocabulary offers. */
export function isImageLabVerdictForKind(kind: ImageLabExperimentKind, verdict: ImageLabVerdict): boolean {
  const options = imageLabVerdictOptions(kind);
  return options !== null && options.some((option) => option === verdict);
}

/**
 * Which ARM of the Stage 5 comparison a finishing pass runs.
 *
 * The two are the same operation over two different reference sets, and the
 * difference is the whole measurement:
 *
 * - `identity` — the Stage 3 pass: the base render plus the subject's
 *   identity-pack references. What a finishing pass has always been, and what an
 *   absent variant means on every row written before this vocabulary existed.
 * - `lora_only` — the base render and NOTHING else, with a character LoRA
 *   blended in. It exists because Stage 5 asks what the LoRA contributes on its
 *   own, and that question cannot be answered by a run that also sends the pack:
 *   an improved face would be unattributable between the two.
 *
 * A variant is a fact about the run rather than a preference, so it is recorded
 * at create and read back by the runner — the recipe it selects is what the
 * outcome cites, and a pass whose record named the wrong arm would poison the
 * comparison it exists to feed.
 */
export const imageLabFinishingVariants = ["identity", "lora_only"] as const;
export const imageLabFinishingVariantSchema = z.enum(imageLabFinishingVariants);
export type ImageLabFinishingVariant = (typeof imageLabFinishingVariants)[number];

/**
 * An experiment's lifecycle position. `pending` has spent nothing, `running` has
 * begun charging the image budget, and the two terminal states are settled by
 * the runner — never by the reviewer, whose verdict is a separate field
 * (a `succeeded` render can still be ruled `ignores_control`).
 */
export const imageLabExperimentStatuses = ["pending", "running", "succeeded", "failed"] as const;
export const imageLabExperimentStatusSchema = z.enum(imageLabExperimentStatuses);
export type ImageLabExperimentStatus = (typeof imageLabExperimentStatuses)[number];

/**
 * Every way a lab run stops, as stable codes (spec §Resilience). Each is a
 * recorded outcome on the experiment row, never a thrown error: the runner
 * settles the row and returns, because a lab experiment that throws through
 * `startJob` leaves an admin staring at a `pending` record with no reason on it.
 *
 * - `input_missing` — the stored `inputs` are absent or no longer parse.
 * - `version_unpinned` — the model's exact provider version cannot be
 *   identified, so the run is refused BEFORE any provider spend. Production may
 *   happily run a floating latest; evidence rendered against an unknown version
 *   answers no question.
 * - `control_invalid` — the named control asset is not a `lab_control`, or its
 *   meta does not parse, so nothing can say what the fixture is.
 * - `control_unreviewed` — the fixture is readable but nobody has looked at it.
 *   The Stage 0 protocol reviews every fixture before a trial uses it, because a
 *   probe reading `ignores_control` has to be able to rule out "the fixture was
 *   wrong" first, and an unreviewed skeleton makes that elimination impossible.
 * - `control_source_sent` — the ordered inputs include the render the fixture was
 *   extracted from. The output could match the control by copying that reference,
 *   so the run is refused BEFORE any provider spend rather than recording a pass
 *   it could not have earned.
 * - `capacity_exceeded` — the experiment orders more references than the
 *   resolved model accepts. The render path TRIMS an overlong list, so the run
 *   is refused before it instead: a probe whose record claimed a control was
 *   sent that the provider never received is evidence about nothing. Raised by
 *   the probe over its whole ordered list, and by `two_character_scene` over its
 *   REQUIRED ones — the plan's own two-character rule ("if all required
 *   identities and the selected control do not fit, the workflow is ineligible
 *   rather than silently dropping a character"). It is not a probe-only code:
 *   the controlled kinds deliberately trim and record instead, because there the
 *   overflow can only reach an optional content role.
 * - `source_invalid` — a `finishing_pass` names a source experiment that is not
 *   an owned, succeeded run holding a result image of a finishable kind. The
 *   pass edits that render, so without it there is nothing to finish; refused
 *   before any provider spend.
 * - `subject_invalid` — a `two_character_scene`'s subject bindings cannot support
 *   its claim: the two characters resolve to one indistinguishable (or blank)
 *   name, or an identity input names an image that is not a render of the
 *   character it is bound to. Names are not unique and an image's subject is not
 *   implied by the id beside it, so both are reachable with perfectly valid rows
 *   — and either one turns the numbered bindings that say which face is whose
 *   into a statement the send does not honour, which is the one thing this kind's
 *   evidence rests on. Refused before any provider spend, because the resulting
 *   render would look exactly like a model that swapped or duplicated a person.
 * - `identity_unavailable` — no identity reference could be drawn for the
 *   subject: the finishing pass has nothing to improve the face TOWARD, and a
 *   run without one would be an unconstrained re-edit wearing the name of an
 *   identity pass. The pack's own blocking code is recorded in the message.
 * - `settings_unsupported` — a CONTROLLED experiment carries a raw
 *   provider-shaped `controlInput` bag. That bag is a probe tool; a controlled
 *   recipe exists to prove a production-shaped run and production has no raw
 *   bag, so a controlled experiment carrying one is refused before any spend
 *   rather than silently stripped.
 * - `preprocessor_output_invalid` — the extractor answered with bytes sharp
 *   could not decode; no asset is written.
 * - `render_failed` — the provider call failed; the render classifier's own code
 *   is recorded alongside.
 */
export const imageLabFailureCodes = [
  "input_missing",
  "version_unpinned",
  "control_invalid",
  "control_unreviewed",
  "control_source_sent",
  "capacity_exceeded",
  "source_invalid",
  "subject_invalid",
  "identity_unavailable",
  "settings_unsupported",
  "preprocessor_output_invalid",
  "render_failed",
] as const;
export const imageLabFailureCodeSchema = z.enum(imageLabFailureCodes);
export type ImageLabFailureCode = (typeof imageLabFailureCodes)[number];

/** The dotted diagnostic code a lab failure is reported under. */
export function imageLabDiagnosticCode(code: ImageLabFailureCode): string {
  return `image_lab.${code}`;
}

/**
 * The lab failure code behind a recorded diagnostic, or `null` for a code this
 * vocabulary does not own. It lives beside `imageLabDiagnosticCode` because the
 * `image_lab.` prefix is this file's fact, and a reader that re-spells it
 * elsewhere drifts apart from the writer the first time either end moves.
 *
 * Experiment rows record the DOTTED form — the runner settles every failure
 * through `imageLabDiagnosticCode` — so a reader parsing the bare enum against a
 * stored code matches nothing. The bare form parses too, for callers holding a
 * code that was never namespaced.
 *
 * A `render_failed` row carries the render classifier's own code alongside, and
 * that vocabulary is not this one: a code from outside this enum answers `null`
 * so the caller can surface it verbatim, since a reason translated into the
 * wrong one is worse than a reason left untranslated.
 */
export function imageLabFailureCodeFromDiagnostic(code: string): ImageLabFailureCode | null {
  const bare = code.startsWith("image_lab.") ? code.slice("image_lab.".length) : code;
  const parsed = imageLabFailureCodeSchema.safeParse(bare);
  return parsed.success ? parsed.data : null;
}

/**
 * A wire sanity rail on how many images one experiment may order, not a model
 * capability: the pinned version's own reference arity is the real ceiling, and a
 * run asking for more than it exposes is refused at render time with the reason.
 */
export const IMAGE_LAB_MAX_INPUTS = 8;

/**
 * How long a hand-drawn fixture's data URL may be, in CHARACTERS — the transport
 * rail the upload route's body schema enforces, matching the avatar upload's.
 *
 * It lives here rather than in the route because the file picker has to refuse
 * an oversized drawing BEFORE reading it, and the two limits are the same limit:
 * a panel carrying its own byte number drifts from the route the first time
 * either moves, and the drift shows up as a 400 on a file the UI said was fine.
 * Base64 carries 3 bytes per 4 characters, so the byte budget a client derives
 * from this is `floor(cap / 4) * 3` less the `data:image/…;base64,` prefix.
 */
export const IMAGE_LAB_UPLOAD_DATA_URL_MAX_CHARS = 3_000_000;

/**
 * One ordered reference an experiment sends.
 *
 * `position` is 1-based because the prompt dialect the lab writes talks about
 * "Image 1" and "Image 2" — a 0-based slot would make the instruction and the
 * payload disagree by one, in the single place where that disagreement is
 * invisible in the output and fatal to the conclusion.
 *
 * `note` is the admin's own annotation ("skeleton drawn over the sofa shot"),
 * carried so a verdict written weeks later can still say what the slot held.
 *
 * `characterId` is which character an IDENTITY input depicts, and it is a fact
 * about the slot rather than about the experiment — which is why it rides here
 * and not in a second top-level column. A `two_character_scene` files one row
 * against two people, so "the subject" stops being a single value the moment the
 * kind exists; binding each face to its own input is the only placement that
 * survives it, and it is also what lets the runner name the right person in the
 * right numbered binding. Meaningful only on an identity input of that kind:
 * every other kind's runner reads no per-input subject, so the create request
 * refuses one there rather than storing a fact with no effect.
 */
export const imageLabInputSchema = z.object({
  position: z.number().int().min(1).max(IMAGE_LAB_MAX_INPUTS),
  role: imageReferenceRoleSchema,
  imageId: z.string().min(1),
  note: z.string().trim().max(500).optional(),
  /** Whom this identity reference depicts. See the note above on placement. */
  characterId: z.string().min(1).optional(),
});
export type ImageLabInput = z.infer<typeof imageLabInputSchema>;

/**
 * An experiment's ordered inputs, with the one rule that holds for every kind.
 *
 * **Positions are contiguous from 1 AND match array order.** The looser reading
 * — "the set of positions is {1..n}" — would allow an array whose order
 * disagrees with its own numbering, leaving the runner to choose which of the
 * two orderings it sends. There is no safe choice there: reference order is what
 * the numbered-role prompt is written against, so a shuffled array and its
 * numbering describe two different renders wearing one record. Requiring
 * `position === index + 1` collapses that to one answer.
 *
 * **The identity cap is NOT here**, and its absence is deliberate rather than an
 * omission. Every kind but one still carries it — two faces would make an
 * unhonoured control unattributable, which was the Stage 0 argument — but a
 * `two_character_scene` sends exactly two by definition, so the cap became
 * kind-dependent and moved one layer up, to
 * {@link imageLabCreateExperimentRequestSchema} where the kind is in hand, with
 * the runner re-checking it for rows that arrive around the request schema.
 *
 * It could not simply stay here and be relaxed for one kind, because this schema
 * has a second reader with no kind to consult:
 * {@link imageLabStoredInputListSchema} derives from it and degrades a failing
 * parse to `[]`. A two-identity list refused here would therefore read back as NO
 * inputs, and the runner would settle the row `input_missing` — a stored,
 * valid two-character experiment failing with a reason that describes nothing
 * about it.
 *
 * An EMPTY list is valid: a baseline experiment resolves the lane's own
 * references itself and orders none.
 */
export const imageLabInputListSchema = z
  .array(imageLabInputSchema)
  .max(IMAGE_LAB_MAX_INPUTS)
  .superRefine((inputs, ctx) => {
    inputs.forEach((input, index) => {
      if (input.position !== index + 1) {
        ctx.addIssue({
          code: "custom",
          path: [index, "position"],
          message: "inputs must be numbered contiguously from 1, in array order",
        });
      }
    });
  });
export type ImageLabInputList = z.infer<typeof imageLabInputListSchema>;

/**
 * Degraded-safe read of an experiment's stored inputs: a malformed list parses
 * to `[]`, which the runner then refuses with `input_missing` rather than
 * rendering against a half-read order (docs/resilience.md §1).
 */
export const imageLabStoredInputListSchema = imageLabInputListSchema.catch((): ImageLabInputList => []);

/**
 * What a `lab_control` asset is, stored in its `images.meta`.
 *
 * It lives in the asset's own meta rather than in a fixtures table because a
 * fixture IS an image — the row already exists, already carries owner and
 * bytes, already rides the sweep — and a parallel table would only add a second
 * thing to keep in step with it.
 *
 * The two notes are two different facts, so they are two different fields.
 * `originNote` is the annotation whichever path CREATED the fixture carried —
 * the extract request's `note`, or the upload's — and it records what the
 * fixture was made for. `reviewedAt`/`reviewNote` record the later human check
 * the Stage 0 protocol demands before a fixture is used ("extract a pose
 * skeleton and a depth map … review both in the fixtures panel"), and they
 * record what looking at it settled. They stay apart because one shared field
 * makes reviewing a fixture destroy the record of what it was for — half of the
 * provenance a disputed `ignores_control` verdict is re-examined against, and
 * the half that names what was being controlled for. An absent `reviewedAt`
 * means unreviewed, which is a fact the panel shows rather than a default it
 * hides.
 *
 * Rows written before the split are left exactly as they are — `images.meta` is
 * a bag, so there is nothing to migrate in bulk and no review date to invent —
 * and they are read by that same absent `reviewedAt`: a row carrying
 * `reviewNote` with no `reviewedAt` predates the split, and that string is what
 * would be written as `originNote` today. It is genuinely unreviewed, so the
 * panel says so and shows no review line rather than filing a creation note as
 * a ruling. Reviewing such a row ADOPTS the stranded string as its `originNote`
 * in the same write that stamps the ruling, because that write is the only
 * thing left that could destroy it: the migration these rows need, done once
 * each, by the hand that would otherwise do the damage.
 *
 * `originNote` is capped like `reviewNote` rather than like the 500 its two
 * create requests enforce: a stored cap is a ceiling over every rail that
 * writes the field, so widening a rail later stays a request-schema edit
 * instead of a question about rows already written.
 *
 * Unknown keys are dropped, not rejected: `images.meta` is a shared bag that
 * already carries encode metadata, so a strict parse would fail on every real
 * row.
 */
export const imageLabControlMetaSchema = z.object({
  controlKind: imageLabControlKindSchema,
  generator: imageLabControlGeneratorSchema,
  /** The render this fixture was derived from. Absent on a hand-authored skeleton
   * drawn from nothing. */
  sourceImageId: z.string().min(1).optional(),
  preprocessorSlug: z.string().min(1).max(200).optional(),
  preprocessorVersionId: z.string().min(1).max(200).optional(),
  /** What the admin said this fixture was for, written by the path that made it.
   * A review never touches it. */
  originNote: z.string().trim().max(2000).optional(),
  /** ISO instant. Nothing in this module reads a clock. */
  reviewedAt: z.string().min(1).optional(),
  /** What looking at the fixture settled — the ruling, never the reason it exists
   * (with the one pre-split exception read above). */
  reviewNote: z.string().trim().max(2000).optional(),
});
export type ImageLabControlMeta = z.infer<typeof imageLabControlMetaSchema>;

/**
 * One control fixture as the fixtures panel reads it — ids and metadata only, no
 * bytes and no URLs (the owner reads the pixels through the ordinary image file
 * route, exactly as the trial review UI does).
 */
export const imageLabControlSchema = z.object({
  imageId: z.string().min(1),
  meta: imageLabControlMetaSchema,
  createdAt: z.string().min(1),
});
export type ImageLabControl = z.infer<typeof imageLabControlSchema>;

/** Degraded-safe list: a malformed payload parses to `[]` so one bad fixture
 * empties a slot rather than breaking the admin page. */
export const imageLabControlListSchema = z.array(imageLabControlSchema).catch((): ImageLabControl[] => []);

/**
 * The per-experiment settings overlay.
 *
 * Two layers on purpose. `controls` is the NORMALIZED vocabulary — the same one
 * profiles carry — so a control the pinned version cannot express is dropped
 * with a reason instead of being sent under a guessed field name. `controlInput`
 * is the raw provider-shaped escape hatch merged last, which the lab needs and
 * production does not: settling whether a model honours an undocumented input is
 * precisely the kind of question this bench exists to answer, and it cannot be
 * asked through a vocabulary that predates the answer.
 *
 * Seed and LoRA arrive inside `controls` when their transports exist (the
 * capabilities plan owns both); modelling them now means a seeded rerun is a
 * value change rather than a schema change.
 *
 * Both defaults are THUNKS — zod hands a default through without cloning, so a
 * literal `{}` would be one object shared by every parsed experiment.
 */
export const imageLabSettingsSchema = z.object({
  controls: imageRenderControlsSchema.default((): ImageRenderControls => ({})),
  controlInput: z.record(z.string(), z.unknown()).default((): Record<string, unknown> => ({})),
});
export type ImageLabSettings = z.infer<typeof imageLabSettingsSchema>;

/** The inert overlay: send no normalized control and no raw key — what a Stage 0
 * probe stores, and what `{}` parses to. A function for the reason above. */
export function emptyImageLabSettings(): ImageLabSettings {
  return { controls: {}, controlInput: {} };
}

/** Degraded-safe read of a stored overlay: an unreadable settings bag falls back
 * to the inert one, so a bad row costs the experiment its knobs, not its run. */
export const imageLabStoredSettingsSchema = imageLabSettingsSchema.catch(emptyImageLabSettings);

/**
 * Why a reference the plan considered was not sent — the render-intent path's
 * own three answers, restated as a tuple so this file's schema can enumerate
 * them. The `satisfies` is the tie: a member here that stopped being one of
 * `planIntentReferences`' reasons would fail to compile, so the recorded
 * outcome cannot drift from the vocabulary of the planner that produced it.
 */
export const imageLabOutcomeDropReasons = [
  "role_not_allowed",
  "role_cap",
  "model_capacity",
] as const satisfies readonly ImageReferenceDropReason[];

/** One reference the plan left out, with the reason and (when it came from a
 * stored asset) which image it was. */
export const imageLabOutcomeDropSchema = z.object({
  role: imageReferenceRoleSchema,
  reason: z.enum(imageLabOutcomeDropReasons),
  sourceImageId: z.string().min(1).optional(),
});
export type ImageLabOutcomeDrop = z.infer<typeof imageLabOutcomeDropSchema>;

/**
 * What the reference plan actually DECIDED for one intent-path run, recorded by
 * the runner in the row's meta.
 *
 * It exists because the controlled kinds trim instead of refusing: the intent
 * path fits an overlong reference list to the model the way every production
 * lane does, and the record is what keeps that honest — a verdict written weeks
 * later can see that the style reference never went, rather than trusting the
 * ordered inputs as if all of them had. `sentRoles` is the send order the
 * compiled prompt numbers; `dropped` names what stayed behind and why;
 * `renumbered` flags the one state where the prompt's numbering and the payload
 * could disagree. `recipeKey` is the code-defined recipe that shaped the run —
 * absent on a baseline, which runs the lane's own profile instead.
 *
 * Array defaults are THUNKS for the reason every default in this file is: zod
 * hands a default through without cloning.
 */
export const imageLabOutcomeSchema = z.object({
  recipeKey: z.string().min(1).optional(),
  sentRoles: z.array(imageReferenceRoleSchema).default((): ImageReferenceRole[] => []),
  dropped: z.array(imageLabOutcomeDropSchema).default((): ImageLabOutcomeDrop[] => []),
  renumbered: z.boolean().default(false),
});
export type ImageLabOutcome = z.infer<typeof imageLabOutcomeSchema>;

/**
 * One experiment as the lab's routes report it.
 *
 * Timestamps are ISO strings and `ownerId` is absent, matching
 * `imageIdentityPackTrialRunSummarySchema`: every lab surface is owner-scoped by
 * the route, so the owner id would be a fact the client already knows travelling
 * where it can only leak.
 *
 * `failureCode` is a bounded string rather than {@link imageLabFailureCodeSchema}
 * for the reason the trial's result schema gives: it also carries codes from the
 * render-failure classifier, and freezing the union here would make adding a
 * classifier code a contract change.
 *
 * Everything an unfinished run has not learned yet is nullable — a `pending`
 * experiment has no executed version, no prediction id, no result, and no
 * verdict, and a fabricated placeholder in any of those would be indistinguish-
 * able from a recorded one later.
 */
export const imageLabExperimentSchema = z.object({
  id: z.string().min(1),
  kind: imageLabExperimentKindSchema,
  mode: imageLabModeSchema.nullable().default(null),
  characterId: z.string().min(1).nullable().default(null),
  chatId: z.string().min(1).nullable().default(null),

  modelSlug: z.string().min(1),
  /** The version the experiment ASKED for (the pin resolved at start). */
  requestedVersionId: z.string().min(1).nullable().default(null),
  /** The version the provider says it RAN. A disagreement between the two is what
   * makes an unannounced provider-side bump visible instead of silent. */
  executedVersionId: z.string().min(1).nullable().default(null),
  /** The resolved profile — baselines only; a probe resolves no profile. Stored
   * as a plain id snapshot, so deleting a profile cannot erase what a finished
   * baseline says it ran. */
  profileId: z.string().min(1).nullable().default(null),

  /** What the admin typed. */
  instruction: z.string().default(""),
  /** What was actually sent, recorded by the runner. */
  finalPrompt: z.string().nullable().default(null),

  inputs: imageLabStoredInputListSchema.default((): ImageLabInputList => []),
  controlImageId: z.string().min(1).nullable().default(null),
  controlKind: imageLabControlKindSchema.nullable().default(null),

  settings: imageLabStoredSettingsSchema.default(emptyImageLabSettings),
  resultImageId: z.string().min(1).nullable().default(null),

  /** What the reference plan decided, for intent-path runs. Nullable because
   * Stage 0 rows predate it; `.catch` because it rides the meta bag, so one bad
   * bag costs the field, never the row. */
  outcome: imageLabOutcomeSchema.nullable().catch(null).default(null),

  /**
   * The experiment a `finishing_pass` refines — null on every other kind.
   *
   * It rides the row's meta bag rather than a column of its own, so Stage 3
   * needed no migration, and it is addressed by EXPERIMENT id rather than by the
   * base image's: a finishing pass is a second arm of one comparison, and the
   * arm it is compared against is a record — its instruction, its recipe, its
   * pinned version and its own verdict — of which the image is only the visible
   * part. `.catch` for the reason the outcome has one: a bag that no longer
   * parses costs the field, never the row.
   */
  sourceExperimentId: z.string().min(1).nullable().catch(null).default(null),

  /**
   * Which arm a `finishing_pass` runs — null on every other kind, and null on a
   * pass that declared none, which MEANS {@link imageLabFinishingVariants}'
   * `identity` (the Stage 3 behavior every row written before Stage 5 has).
   *
   * Null rather than a defaulted `"identity"` because the two facts are
   * different: a row that says nothing is a row nobody asked a question of, and
   * writing the default here would make a Stage 3 pass indistinguishable from a
   * Stage 5 one that deliberately chose the identity arm. The RUNNER applies the
   * default, in one place, where the recipe is chosen.
   *
   * It rides the meta bag beside `sourceExperimentId`, and carries `.catch` for
   * the same reason: a bag that no longer parses costs the field, never the row.
   */
  finishingVariant: imageLabFinishingVariantSchema.nullable().catch(null).default(null),

  status: imageLabExperimentStatusSchema,
  failureCode: z.string().min(1).max(120).nullable().default(null),
  verdict: imageLabVerdictSchema.nullable().default(null),
  verdictNote: z.string().max(2000).nullable().default(null),

  predictionId: z.string().min(1).nullable().default(null),
  createdAt: z.string().min(1),
  startedAt: z.string().min(1).nullable().default(null),
  finishedAt: z.string().min(1).nullable().default(null),
});
export type ImageLabExperiment = z.infer<typeof imageLabExperimentSchema>;

/** Degraded-safe list: a malformed payload parses to `[]` (docs/resilience.md §1). */
export const imageLabExperimentListSchema = z.array(imageLabExperimentSchema).catch((): ImageLabExperiment[] => []);

/**
 * The create-experiment request.
 *
 * `modelSlug` is optional because the runner's default is the model the plan is
 * about (`qwen/qwen-image-edit-2511`); naming one is how the fallback connector
 * gets probed if the first verdict is `ignores_control`.
 *
 * The cross-field rules, each grounded in what the runner must be able to do:
 *
 * - a `baseline_portrait` needs a character (it renders that character's variant
 *   configuration from the canonical avatar) and a `baseline_scene` needs a chat
 *   (it renders through the scene profile from that chat's reference anchor). A
 *   baseline missing its subject is not a baseline, it is a run with nothing to
 *   compare against.
 * - the controlled kinds carry the same subject rule: a `controlled_portrait`
 *   names its character and a `controlled_scene` names its chat. The runner
 *   reads no anchor from either — the ordered inputs are the references — but
 *   the experiment is evidence ABOUT that subject, and its output is filed
 *   against it.
 * - a control image and a control kind travel TOGETHER. Half a pointer is
 *   unreadable: an asset with no declared kind cannot be checked against the
 *   fixture it claims to be, and a kind with no asset names a control that was
 *   never sent.
 * - a declared control image is one of the images actually SENT, exactly once,
 *   under a role a fixture may occupy. The runner validates the declared
 *   fixture but renders the ordered inputs, so a request declaring fixture A
 *   while ordering fixture B would file a verdict against a skeleton the
 *   provider never saw — the one failure a bench cannot survive.
 * - EVERY kind but `two_character_scene` carries at most one identity input.
 *   Two faces would make an unhonoured control unattributable — was the pose
 *   ignored, or was the model reconciling two people? This is the Stage 0 rule,
 *   which lived on {@link imageLabInputListSchema} until a kind existed that
 *   legitimately sends two; see that schema for why it could not stay there and
 *   simply be relaxed.
 * - only a `two_character_scene` input carries a `characterId`. Every other
 *   kind's runner reads no per-input subject, so one stored there would record a
 *   fact with no effect on the render — indistinguishable, later, from a subject
 *   binding that did something.
 * - a `two_character_scene` names its CHAT and never a top-level character. The
 *   subjects ride the identity inputs, one each, because the row files against
 *   two people and a single `characterId` column cannot say which of them the
 *   experiment is about. It carries exactly TWO identity inputs, each naming a
 *   character, and the two characters DIFFER — a run naming one person twice is
 *   not a two-character scene, it is a duplication the render was supposed to be
 *   tested for. Its control is OPTIONAL (the pairing and sent-exactly-once rules
 *   above still apply to a control it does declare), because "does one control
 *   guide both people?" and "do two people survive at all?" are separate
 *   questions and the second is answerable without a fixture.
 * - a `finishing_pass` names its source experiment and nothing else: no
 *   subject, no ordered inputs, no control. Every one of those is INHERITED or
 *   RESOLVED — the subject from the source (so the two arms of a comparison can
 *   never be filed against two different characters), the ordered inputs by the
 *   runner (the base render plus the subject's identity-pack references, which
 *   no client can select), and a control it never sends. A request carrying one
 *   anyway is describing a run that cannot happen, so it is refused rather than
 *   quietly ignored, which would leave a record of an input that had no effect.
 * - no other kind carries a source experiment. A pointer on a kind that never
 *   reads one is a client bug, and storing it would leave a row claiming a
 *   lineage its render did not have. A `finishingVariant` is refused everywhere
 *   else for the same reason: no other kind's runner reads one, so a stored
 *   variant would describe an arm the render never ran.
 * - a `lora_only` pass names the LoRA it measures. The arm withholds the
 *   identity references precisely so the weights can be judged alone, and
 *   without weights there is nothing left to judge — the run would re-render its
 *   own source image under the name of a comparison arm.
 *
 * Deliberately NOT enforced here: that a probe carries any particular inputs, or
 * that it declares a control at all. Both are the runner's recorded refusals
 * (spec §Algorithms steps 1 and 3), settled on the experiment where the admin
 * can see the reason, instead of a 400 that leaves no trace of the attempt. The
 * rules above only police a request that is internally inconsistent, which is a
 * client bug rather than an attempt worth recording; the RUNNER stays
 * authoritative on all of it, because rows also arrive from earlier deploys.
 */
export const imageLabCreateExperimentRequestSchema = z
  .object({
    kind: imageLabExperimentKindSchema,
    mode: imageLabModeSchema.optional(),
    modelSlug: z.string().trim().min(1).max(200).optional(),
    characterId: z.string().min(1).optional(),
    chatId: z.string().min(1).optional(),
    instruction: z.string().trim().max(8000).default(""),
    inputs: imageLabInputListSchema.default((): ImageLabInputList => []),
    controlImageId: z.string().min(1).optional(),
    controlKind: imageLabControlKindSchema.optional(),
    /** The succeeded experiment a `finishing_pass` refines. Required there, refused everywhere else. */
    sourceExperimentId: z.string().min(1).optional(),
    /** Which arm a `finishing_pass` runs. Absent means `identity`; refused on every other kind. */
    finishingVariant: imageLabFinishingVariantSchema.optional(),
    settings: imageLabSettingsSchema.optional(),
  })
  .superRefine((request, ctx) => {
    if (request.kind === "finishing_pass") {
      if (request.sourceExperimentId === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["sourceExperimentId"],
          message: "a finishing pass names the experiment whose result it refines",
        });
      }
      if (request.inputs.length > 0) {
        ctx.addIssue({
          code: "custom",
          path: ["inputs"],
          message: "a finishing pass orders no inputs; the runner sends the source render and the pack's references",
        });
      }
      if (request.controlImageId !== undefined || request.controlKind !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["controlImageId"],
          message: "a finishing pass sends no control fixture; it refines identity and changes nothing else",
        });
      }
      if (request.characterId !== undefined || request.chatId !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["characterId"],
          message: "a finishing pass inherits its subject from the source experiment",
        });
      }
      if (request.finishingVariant === "lora_only" && request.settings?.controls.lora === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["settings", "controls", "lora"],
          message:
            "a LoRA-only pass names the LoRA it measures; with no LoRA and no identity reference it would only re-render the source image",
        });
      }
    } else {
      if (request.sourceExperimentId !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["sourceExperimentId"],
          message: "only a finishing pass refines another experiment's result",
        });
      }
      if (request.finishingVariant !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["finishingVariant"],
          message: "only a finishing pass declares which arm it runs",
        });
      }
    }
    if (request.kind === "two_character_scene") {
      if (request.chatId === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["chatId"],
          message: "a two-character scene names the chat it is about",
        });
      }
      if (request.characterId !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["characterId"],
          message: "a two-character scene names its subjects on the identity inputs, not on the experiment",
        });
      }
      const identities = request.inputs.filter((input) => input.role === "identity");
      if (identities.length !== 2) {
        ctx.addIssue({
          code: "custom",
          path: ["inputs"],
          message: `a two-character scene sends exactly two identity references, one per character; this one sends ${String(identities.length)}`,
        });
      }
      const named = identities.filter((input) => input.characterId !== undefined);
      if (named.length !== identities.length) {
        ctx.addIssue({
          code: "custom",
          path: ["inputs"],
          message: "each identity reference names the character it depicts, so the prompt can bind the right face to the right image",
        });
      }
      const subjects = new Set(named.map((input) => input.characterId));
      if (named.length > 1 && subjects.size !== named.length) {
        ctx.addIssue({
          code: "custom",
          path: ["inputs"],
          message: "a two-character scene names two DIFFERENT characters; one character twice is the duplication this kind measures",
        });
      }
      // A subject on a location or a pose map would claim the render binds a
      // person to an image that does not depict one.
      if (request.inputs.some((input) => input.role !== "identity" && input.characterId !== undefined)) {
        ctx.addIssue({
          code: "custom",
          path: ["inputs"],
          message: "only an identity reference names a character",
        });
      }
    } else {
      if (request.inputs.filter((input) => input.role === "identity").length > 1) {
        ctx.addIssue({
          code: "custom",
          path: ["inputs"],
          message: "an experiment carries at most one identity reference",
        });
      }
      if (request.inputs.some((input) => input.characterId !== undefined)) {
        ctx.addIssue({
          code: "custom",
          path: ["inputs"],
          message: `only a two-character scene binds a character to an input; a ${request.kind} runner reads none`,
        });
      }
    }
    if (request.kind === "baseline_portrait" && request.characterId === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["characterId"],
        message: "a portrait baseline names the character it re-runs",
      });
    }
    if (request.kind === "baseline_scene" && request.chatId === undefined) {
      ctx.addIssue({ code: "custom", path: ["chatId"], message: "a scene baseline names the chat it re-runs" });
    }
    if (request.kind === "controlled_portrait" && request.characterId === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["characterId"],
        message: "a controlled portrait names the character it is about",
      });
    }
    if (request.kind === "controlled_scene" && request.chatId === undefined) {
      ctx.addIssue({ code: "custom", path: ["chatId"], message: "a controlled scene names the chat it is about" });
    }
    if ((request.controlImageId === undefined) !== (request.controlKind === undefined)) {
      ctx.addIssue({
        code: "custom",
        path: ["controlKind"],
        message: "a control image and its kind are recorded together",
      });
    }
    if (request.controlImageId !== undefined) {
      const ordered = request.inputs.filter((input) => input.imageId === request.controlImageId);
      const sent = ordered.length === 1 ? ordered[0] : undefined;
      if (sent === undefined || !isImageLabControlRole(sent.role)) {
        ctx.addIssue({
          code: "custom",
          path: ["inputs"],
          message: "the declared control image is sent exactly once, under a pose, depth, or control role",
        });
      }
    }
  });
export type ImageLabCreateExperimentRequest = z.infer<typeof imageLabCreateExperimentRequestSchema>;

/**
 * The extract-controls request: one `lab_control_extract` job per source image,
 * producing one fixture per requested kind.
 *
 * Both lists are deduplicated by refusal rather than silently: a request naming
 * `pose` twice would otherwise charge two preprocessor runs and leave two
 * indistinguishable fixtures for the admin to pick between. The `sourceImageIds`
 * cap is a spend rail — extraction is a paid provider call for pose and depth.
 */
export const imageLabExtractControlsRequestSchema = z
  .object({
    sourceImageIds: z.array(z.string().min(1)).min(1).max(4),
    controlKinds: z.array(imageLabControlKindSchema).min(1).max(imageLabControlKinds.length),
    /** What this extraction is for, stored as every produced fixture's
     * {@link imageLabControlMetaSchema} `originNote`. */
    note: z.string().trim().max(500).optional(),
  })
  .superRefine((request, ctx) => {
    if (new Set(request.sourceImageIds).size !== request.sourceImageIds.length) {
      ctx.addIssue({ code: "custom", path: ["sourceImageIds"], message: "name each source image once" });
    }
    if (new Set(request.controlKinds).size !== request.controlKinds.length) {
      ctx.addIssue({ code: "custom", path: ["controlKinds"], message: "name each control kind once" });
    }
  });
export type ImageLabExtractControlsRequest = z.infer<typeof imageLabExtractControlsRequestSchema>;

/**
 * The upload-control request — the metadata beside a hand-drawn skeleton's
 * bytes.
 *
 * `generator` is absent on purpose: this route always writes `hand_authored`. A
 * client that could name its own provenance could file a drawing as an
 * extraction, and provenance is exactly what a disputed probe verdict is
 * re-examined against.
 */
export const imageLabUploadControlRequestSchema = z.object({
  controlKind: imageLabControlKindSchema,
  /** What the skeleton was drawn over, when it was drawn over something. */
  sourceImageId: z.string().min(1).optional(),
  /** How it was drawn, stored as the fixture's {@link imageLabControlMetaSchema}
   * `originNote` — the create path's annotation, not a review. */
  note: z.string().trim().max(500).optional(),
});
export type ImageLabUploadControlRequest = z.infer<typeof imageLabUploadControlRequestSchema>;

/**
 * The review-fixture request — the human check the Stage 0 protocol demands
 * before a trial uses a fixture ("extract a pose skeleton and a depth map …
 * review both in the fixtures panel").
 *
 * The note is REQUIRED for the same reason a verdict's is: an unreviewed fixture
 * and one reviewed with nothing written beside it read identically six months
 * later, and "the fixture was wrong" is the first thing an `ignores_control`
 * verdict has to be able to rule out. The cap matches
 * {@link imageLabControlMetaSchema}'s own `reviewNote`, so nothing a client may
 * send is silently truncated on the way into `images.meta`.
 *
 * `reviewedAt` is deliberately ABSENT: the server stamps it from its own clock,
 * because a request that could name its own review time could file today's
 * glance as last week's review, and a fixture's review date is exactly what a
 * disputed verdict is re-examined against.
 */
export const imageLabReviewControlRequestSchema = z.object({
  reviewNote: z.string().trim().min(1).max(2000),
});
export type ImageLabReviewControlRequest = z.infer<typeof imageLabReviewControlRequestSchema>;

/**
 * The record-verdict request. The note is REQUIRED for the reason a trial
 * verdict's reason is: a ruling with nothing written beside it is
 * indistinguishable from a misclick six months later, and this ruling decides
 * whether the whole plan runs on 2511 or on a second registered connector.
 *
 * The verdict is the WHOLE union, not the kind's own slice, because the request
 * does not know the kind — the experiment does. Whether this ruling belongs to
 * this experiment's vocabulary is settled by the service against the stored row
 * ({@link isImageLabVerdictForKind}), which is the only place both facts are in
 * hand at once.
 */
export const imageLabRecordVerdictRequestSchema = z.object({
  verdict: imageLabVerdictSchema,
  note: z.string().trim().min(1).max(2000),
});
export type ImageLabRecordVerdictRequest = z.infer<typeof imageLabRecordVerdictRequestSchema>;
