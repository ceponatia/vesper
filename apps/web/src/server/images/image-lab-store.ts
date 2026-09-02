import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  emptyImageLabSettings,
  type ImageLabExperiment,
  type ImageLabFinishingVariant,
  imageLabFinishingVariantSchema,
  type ImageLabInputList,
  imageLabInputListSchema,
  type ImageLabOutcome,
  imageLabOutcomeSchema,
  type ImageLabRecordVerdictRequest,
  type ImageLabSettings,
  imageLabSettingsSchema,
  type ImageLabStaging,
  imageLabStagingSchema,
  isImageLabFinishableKind,
  isImageLabVerdictForKind,
  isImageLabVerdictKind,
} from "@vesper/image-core";
import { diag, type DiagnosticSink } from "@/contracts/diagnostics";
import {
  characterProfileSchema,
  emptyCharacterProfile,
  type CharacterProfile,
} from "@/contracts/world/profile";
import { parseOr, parseOrNull } from "@/lib/parse";
import { characters, chatParticipants, db, imageLabExperiments } from "../db";
import { deleteOwnedImage, imageMeta } from "./assets";

/**
 * The Advanced Image Lab's experiment service.
 *
 * One experiment is one deliberate render whose every input, setting and outcome
 * is written down. The bench exists because a question nobody can answer from a
 * provider schema — "does this model actually honour a pose skeleton?" — gets
 * settled by evidence, and evidence needs a record of what was sent.
 *
 * THE ownership rule, which every function here keeps: the lab writes
 * `image_lab_experiments` rows and `lab_output` images and nothing else. It
 * never touches `characters`, `chats`, identity packs, or a non-lab image row,
 * and it never enqueues a lane's own job type. A lab run leaves the app exactly
 * as it found it, minus one hidden image and one row.
 *
 * Stage 0 renders bypass the render-intent path for `control_probe`: the runner
 * calls `runRegistryImageModel`
 * directly with an explicit ordered reference list and a pinned `versionId`,
 * a ruling made while role-aware selection did not
 * exist and kept for the probe because an exact ordered list is what a probe
 * IS. The two BASELINE kinds do the opposite on purpose — they go through the
 * very path their lane goes through, since a baseline that compiled its
 * settings some other way would not be a baseline. The two CONTROLLED kinds
 * ride that same intent path but pin the exact version and run a code-defined
 * recipe profile (`imageLabRecipeProfile`), because their question is whether
 * the control still holds when the request is production-shaped — and a
 * controlled comparison must be able to name what it executed. `finishing_pass`
 * runs the same way over a different pair of references: another experiment's
 * RESULT under the `before` role, plus the subject's identity-pack references,
 * under an instruction that forbids every change but the face.
 * `two_character_scene` rides the intent path too, sending one NAMED identity
 * reference per character beside an optional control — the one kind whose
 * references carry a subject into the prompt, because it is the one kind whose
 * references would otherwise be indistinguishable from each other.
 * `staged_scene` rides it as well, and is the one kind whose PROMPT is compiled
 * rather than typed: the lane assembles a scene render plan around one staging
 * registry entry and hands the chat lane's own builder the job of wording it, so
 * the bench sends the sentence production sends.
 *
 * The job seam lives at the ROUTE, not here: `@/server/api` imports
 * `@/server/images`, so a `startJob` call from this module would close an import
 * cycle (`pnpm lint:cycles`). Every other image lane is arranged the same way —
 * the route starts the job, the service is the body of it. Which is also why
 * every run reports a {@link ImageLabProviderOutcome} in its payload rather than
 * calling the breaker itself: the breaker lives on the other side of that
 * boundary, and the route is where the two meet.
 */

export type ImageLabExperimentRow = typeof imageLabExperiments.$inferSelect;

/** A refusal reported to the admin as a 400: nothing was stored, nothing spent. */
export interface ImageLabRefusal {
  code: string;
  message: string;
}

/**
 * One refusal, in the shape the identity-pack trial settled: the envelope
 * carries the BARE code — the token a client narrows on — and the dotted
 * `image_lab.` spelling is the diagnostic sink's alone. A wire code a client had
 * to strip a namespace off would be a sink's spelling read off a wire.
 */
export function labRefusal(
  code: string,
  message: string,
  sink: DiagnosticSink | undefined,
  context: Record<string, unknown>,
): ImageLabRefusal {
  sink?.push(diag("warn", `image_lab.${code}`, message, { context }));
  return { code, message };
}

/**
 * What one lab run proved about the image provider lane, in the circuit
 * breaker's vocabulary (`startJob`'s `reportProviderOutcome` →
 * `recordProviderOutcome`).
 *
 * `null` — say nothing — is the answer for most of this module, and the reason
 * the channel exists at all. Every stop here is a SETTLED ROW rather than a
 * throw, so the runner's promise resolves whether Replicate answered, refused,
 * or was never called; read as an outcome, that resolution would report a
 * healthy provider for a dead one and would close a tripped breaker on the
 * strength of a probe that only ever touched this database.
 */
export type ImageLabProviderOutcome = boolean | null;

/**
 * The record one lab run returns: the human-readable payload the `jobs` row
 * carries, plus what the run told the breaker. The route reports the second and
 * stores the whole thing, so the job row also says what was reported.
 */
export interface ImageLabRunPayload extends Record<string, unknown> {
  providerOutcome: ImageLabProviderOutcome;
}

/**
 * The codes this runner needs beyond {@link ImageLabFailureCode}'s own.
 *
 * The contract deliberately types `failureCode` as a bounded string rather than
 * that enum, "because it also carries codes from the render-failure classifier"
 * — the same reason applies here. Each of these names a state the contract's
 * codes cannot: a task the profile registry offers nothing for, and a runner
 * that died on something other than a provider call. Inventing another enum
 * member for each would freeze them into the wire contract, where a UI would
 * have to know about a state it can only display verbatim anyway.
 *
 * A third code, `image_lab.kind_unsupported`, is gone as of Stage 3: it existed
 * while `finishing_pass` was declared but unbuilt, and every declared kind now
 * has a runner arm, which the exhaustive dispatch below enforces at compile
 * time rather than at run time.
 *
 * Dotted, because every one of them is written to a settled ROW or a sink. A
 * refusal envelope spells its code bare — see {@link labRefusal}.
 */
export const LAB_PROFILE_UNAVAILABLE = "image_lab.profile_unavailable";
export const LAB_RUN_THREW = "image_lab.run_threw";

/** How many experiments the lab page lists. */
const EXPERIMENT_LIST_LIMIT = 50;

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * One stored row as the routes report it.
 *
 * Both jsonb columns cross `parseOr` (docs/resilience.md §1): a settings bag
 * that no longer parses costs the experiment its knobs in the display, never the
 * page. The enum columns need no parse — the database constrains them — and
 * `ownerId` is deliberately absent, because every lab surface is owner-scoped by
 * its route and the owner id would be a fact the client already knows travelling
 * where it can only leak.
 */
export function toWireExperiment(row: ImageLabExperimentRow, sink?: DiagnosticSink): ImageLabExperiment {
  return {
    id: row.id,
    kind: row.kind,
    mode: row.mode,
    characterId: row.characterId,
    chatId: row.chatId,
    modelSlug: row.modelSlug,
    requestedVersionId: row.requestedVersionId,
    executedVersionId: row.executedVersionId,
    profileId: row.profileId,
    instruction: row.instruction,
    finalPrompt: row.finalPrompt,
    inputs: storedInputs(row, sink),
    controlImageId: row.controlImageId,
    controlKind: row.controlKind,
    settings: storedSettings(row, sink),
    resultImageId: row.resultImageId,
    outcome: storedOutcome(row, sink),
    sourceExperimentId: storedSourceExperimentId(row, sink),
    finishingVariant: storedFinishingVariant(row, sink),
    staging: storedStaging(row, sink),
    status: row.status,
    failureCode: row.failureCode,
    verdict: row.verdict,
    verdictNote: row.verdictNote,
    predictionId: row.predictionId,
    providerAttempts: storedProviderAttempts(row, sink),
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}

/**
 * The stored order, degraded to `[]`.
 *
 * Parsed with the STRICT list schema through `parseOr` rather than the
 * contract's `.catch`-carrying read-back schema, so a malformed order produces a
 * diagnostic as well as the empty default. The `.catch` variant is for a client
 * re-parsing a wire experiment, where there is nobody to tell.
 */
export function storedInputs(row: ImageLabExperimentRow, sink?: DiagnosticSink): ImageLabInputList {
  return parseOr(imageLabInputListSchema, row.inputs, [], sink, "image_lab_experiments.inputs");
}

export function storedSettings(row: ImageLabExperimentRow, sink?: DiagnosticSink): ImageLabSettings {
  return parseOr(imageLabSettingsSchema, row.settings, emptyImageLabSettings(), sink, "image_lab_experiments.settings");
}

/**
 * The recorded reference-plan outcome, read out of the row's meta bag — where
 * the runner writes it, beside `error` and `renderFailure`, rather than in a
 * column of its own: it is a per-run record like those, not a queryable fact.
 * Absent means the row predates the field (every Stage 0 row) and stays a quiet
 * null; a bag that no longer parses costs the field with a diagnostic, never
 * the row.
 */
function storedOutcome(row: ImageLabExperimentRow, sink?: DiagnosticSink): ImageLabOutcome | null {
  const raw = imageMeta(row.meta)["outcome"];
  if (raw === undefined || raw === null) return null;
  return parseOrNull(imageLabOutcomeSchema, raw, sink, "image_lab_experiments.meta.outcome");
}

/**
 * The provider attempt history, read out of the meta bag on the same terms as
 * `outcome` and as the Generator's own copy of this field: absent (every run
 * that created one prediction) is a quiet null, loose records because the
 * transport owns the attempt vocabulary, and a bag that no longer parses costs
 * the field rather than the row.
 */
const storedAttemptListSchema = z.array(z.record(z.string(), z.unknown()));

function storedProviderAttempts(row: ImageLabExperimentRow, sink?: DiagnosticSink): Record<string, unknown>[] | null {
  const raw = imageMeta(row.meta)["providerAttempts"];
  if (raw === undefined || raw === null) return null;
  return parseOrNull(storedAttemptListSchema, raw, sink, "image_lab_experiments.meta.providerAttempts");
}

const sourceExperimentIdSchema = z.string().min(1);

/**
 * The experiment a finishing pass refines, read out of the same meta bag.
 *
 * It lives there rather than in a column because the row already had a bag for
 * per-experiment facts and Stage 3 wanted no migration — but that put one
 * requirement on the runner, which {@link labMeta} carries: this key is written
 * at CREATE and every later write to the bag has to preserve it, or the pointer
 * would survive exactly until the run that used it settled.
 */
export function storedSourceExperimentId(row: ImageLabExperimentRow, sink?: DiagnosticSink): string | null {
  const raw = imageMeta(row.meta)["sourceExperimentId"];
  if (raw === undefined || raw === null) return null;
  return parseOrNull(sourceExperimentIdSchema, raw, sink, "image_lab_experiments.meta.sourceExperimentId");
}

/**
 * What a staged scene STAGES, out of the same meta bag — the registry id and the
 * scene facts a bench row has to state for itself.
 *
 * The staged lane reads this rather than the create request, which is why it
 * lives on the row at all: the runner sees a row and nothing else, so a staging
 * that did not survive the write would leave the kind unrunnable. Meta rather
 * than `settings` for the reason the contract gives — `settings` is the per-run
 * knobs, and the staging is the SUBJECT of the run, the same category as a
 * finishing pass's source experiment.
 *
 * Null on every other kind (the create schema refuses the field there), and null
 * on a bag that no longer parses — which costs the display its staging and the
 * run its refusal, never the row.
 */
export function storedStaging(row: ImageLabExperimentRow, sink?: DiagnosticSink): ImageLabStaging | null {
  const raw = imageMeta(row.meta)["staging"];
  if (raw === undefined || raw === null) return null;
  return parseOrNull(imageLabStagingSchema, raw, sink, "image_lab_experiments.meta.staging");
}

/**
 * The arm a finishing pass DECLARED, or null when it declared none — the wire
 * field, which reports the record rather than the runner's reading of it.
 *
 * Absent is a real state and is reported as one: every Stage 3 row predates the
 * vocabulary, and writing today's default into their display would claim they
 * chose an arm nobody offered them. {@link finishingPassVariant} is where that
 * absence becomes a decision, once, at the point the recipe is chosen.
 */
function storedFinishingVariant(row: ImageLabExperimentRow, sink?: DiagnosticSink): ImageLabFinishingVariant | null {
  const raw = imageMeta(row.meta)["finishingVariant"];
  if (raw === undefined || raw === null) return null;
  return parseOrNull(imageLabFinishingVariantSchema, raw, sink, "image_lab_experiments.meta.finishingVariant");
}

/**
 * The arm this pass RUNS: the declared one, or `identity` when the row declares
 * none — which is every row written before Stage 5, and every pass created
 * without asking for the isolating arm.
 *
 * An unreadable value degrades to `identity` rather than failing the run
 * (docs/resilience.md §1), and the degradation is honest rather than silent: the
 * recipe key recorded on the outcome is the identity arm's, so a reader of that
 * record sees the run it actually got. `storedFinishingVariant` has already
 * reported the unparseable value to the sink by the time the fallback applies.
 */
export function finishingPassVariant(row: ImageLabExperimentRow, sink?: DiagnosticSink): ImageLabFinishingVariant {
  return storedFinishingVariant(row, sink) ?? "identity";
}

/**
 * One meta write, over whatever the bag already held.
 *
 * Every settle in this module writes `meta` as a whole value, so an assignment
 * would silently drop the create-time keys — which was harmless while the bag
 * held nothing but the settle's own record, and is not harmless now that a
 * finishing pass's `sourceExperimentId` rides in it. Merging costs nothing for
 * the kinds that write no create-time meta (their stored bag is `{}`) and keeps
 * the pointer readable after the row settles, which is when the detail screen
 * asks for it.
 */
export function labMeta(row: ImageLabExperimentRow, written: Record<string, unknown>): Record<string, unknown> {
  return { ...imageMeta(row.meta), ...written };
}

/** One experiment, matched on `(id, owner)` — the authorization root. */
export async function ownedExperiment(experimentId: string, ownerId: string): Promise<ImageLabExperimentRow | null> {
  const [row] = await db()
    .select()
    .from(imageLabExperiments)
    .where(and(eq(imageLabExperiments.id, experimentId), eq(imageLabExperiments.ownerId, ownerId)))
    .limit(1);
  return row ?? null;
}

/** This admin's experiments, newest first. */
export async function listImageLabExperiments(ownerId: string, sink?: DiagnosticSink): Promise<ImageLabExperiment[]> {
  const rows = await db()
    .select()
    .from(imageLabExperiments)
    .where(eq(imageLabExperiments.ownerId, ownerId))
    .orderBy(desc(imageLabExperiments.createdAt))
    .limit(EXPERIMENT_LIST_LIMIT);
  return rows.map((row) => toWireExperiment(row, sink));
}

/**
 * One experiment. Null when it is not this owner's — indistinguishable from
 * never having existed, so the route never confirms a foreign experiment.
 */
export async function getImageLabExperimentDetail(
  experimentId: string,
  ownerId: string,
  sink?: DiagnosticSink,
): Promise<ImageLabExperiment | null> {
  const row = await ownedExperiment(experimentId, ownerId);
  return row ? toWireExperiment(row, sink) : null;
}


/**
 * Why this experiment cannot be finished — or `null` when it can.
 *
 * Three separate answers rather than one, because they ask three different
 * things of the admin: find the right id, pick a different experiment, or wait
 * for (and fix) a run that has not produced an image. One shared "invalid
 * source" would tell them none of that.
 *
 * A source that is not this owner's is reported as missing, exactly as the
 * detail route reports a foreign experiment: the refusal must not confirm that
 * someone else's id exists.
 */
export function sourceRefusal(
  sourceExperimentId: string,
  source: ImageLabExperimentRow | null,
  sink: DiagnosticSink | undefined,
): ImageLabRefusal | null {
  const context = { sourceExperimentId };
  if (!source) {
    return labRefusal("source_not_found", "the experiment this pass would refine was not found", sink, context);
  }
  if (!isImageLabFinishableKind(source.kind)) {
    return labRefusal(
      "source_kind_unsupported",
      `a ${source.kind} cannot be finished; a finishing pass refines a baseline or a controlled run`,
      sink,
      { ...context, sourceKind: source.kind },
    );
  }
  if (source.status !== "succeeded" || source.resultImageId === null) {
    return labRefusal(
      "source_not_rendered",
      "that experiment has no result image to refine yet",
      sink,
      { ...context, sourceStatus: source.status },
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Verdict, deletion
// ---------------------------------------------------------------------------

export type RecordImageLabVerdictResult =
  | { ok: true; experiment: ImageLabExperiment }
  | { ok: false; refusal: ImageLabRefusal };

/**
 * Record the reviewing admin's ruling.
 *
 * Verdict kinds only (`isImageLabVerdictKind`) — the kinds that ask a question a
 * reviewer can answer — and that restriction is the point of the whole protocol:
 * the verdict answers "did the output obey the skeleton?", which is a judgment
 * made by looking at an image, and a baseline has no control to obey. A ruling
 * recorded against one would be a fact about nothing.
 *
 * The ruling must also belong to THIS kind's vocabulary
 * (`isImageLabVerdictForKind`). The wire request speaks the whole union because
 * it does not know the kind, so this is the one place both facts are in hand —
 * and without the check a finishing pass could be filed `honours_control`,
 * recording a control judgment against a run that sent no control.
 *
 * The verdict is INDEPENDENT of `status`: a `succeeded` render can still be
 * ruled `ignores_control`, which is the most informative outcome the bench can
 * produce. Null when the experiment is not this owner's.
 */
export async function recordImageLabVerdict(
  experimentId: string,
  ownerId: string,
  request: ImageLabRecordVerdictRequest,
  sink?: DiagnosticSink,
): Promise<RecordImageLabVerdictResult | null> {
  const row = await ownedExperiment(experimentId, ownerId);
  if (!row) return null;
  if (!isImageLabVerdictKind(row.kind)) {
    return {
      ok: false,
      refusal: labRefusal("verdict_not_applicable", `a ${row.kind} experiment has nothing to rule on`, sink, {
        experimentId,
        kind: row.kind,
      }),
    };
  }
  if (!isImageLabVerdictForKind(row.kind, request.verdict)) {
    return {
      ok: false,
      refusal: labRefusal(
        "verdict_not_in_vocabulary",
        `${request.verdict} is not a ruling a ${row.kind} experiment can record`,
        sink,
        { experimentId, kind: row.kind, verdict: request.verdict },
      ),
    };
  }
  const [updated] = await db()
    .update(imageLabExperiments)
    .set({ verdict: request.verdict, verdictNote: request.note })
    .where(and(eq(imageLabExperiments.id, experimentId), eq(imageLabExperiments.ownerId, ownerId)))
    .returning();
  if (!updated) return null;
  return { ok: true, experiment: toWireExperiment(updated, sink) };
}

export interface DeleteImageLabExperimentResult {
  deleted: boolean;
  outputImagesRemoved: number;
}

/**
 * Hard-delete one experiment and the render it produced.
 *
 * The OUTPUT goes first, exactly as the trial's delete sweep does: the row is
 * the only pointer to its hidden image, so deleting the row first and crashing
 * would orphan a `lab_output` nothing can find again. Output-first fails safe —
 * a crash leaves the experiment intact with an FK-nulled pointer, and the delete
 * can simply be run again.
 *
 * Control FIXTURES are deliberately untouched. A fixture is shared bench
 * equipment: several experiments cite one skeleton, and deleting the experiment
 * that happened to be deleted last would take the skeleton with it.
 *
 * A `pending` or `running` experiment is deletable, and that is deliberate: a
 * deploy that killed its job leaves a row stuck `running` forever, and refusing
 * to delete one would make that row permanent. The render still in flight
 * settles against nothing and discards its own output (see `storeLabRender`), so
 * the race costs one wasted render rather than one invisible image.
 */
export async function deleteImageLabExperiment(
  experimentId: string,
  ownerId: string,
): Promise<DeleteImageLabExperimentResult> {
  const row = await ownedExperiment(experimentId, ownerId);
  if (!row) return { deleted: false, outputImagesRemoved: 0 };

  const outputRemoved =
    row.resultImageId === null ? false : await deleteOwnedImage(row.resultImageId, ownerId, { kind: "lab_output" });
  await db()
    .delete(imageLabExperiments)
    .where(and(eq(imageLabExperiments.id, experimentId), eq(imageLabExperiments.ownerId, ownerId)));
  return { deleted: true, outputImagesRemoved: outputRemoved ? 1 : 0 };
}


// ---------------------------------------------------------------------------
// Shared owner-scoped reads
// ---------------------------------------------------------------------------

/**
 * The names of the characters two identity inputs point at, keyed by id — or
 * `null` when any of them is not this owner's.
 *
 * All-or-nothing rather than best-effort, because a partial answer would leave
 * one face bound by name and the other anonymous, which is a worse prompt than
 * either extreme: the model would be told exactly one of the two people matters
 * enough to identify. One query rather than a lookup per subject, matching how
 * `ownsCharacter` scopes its own read — the owner predicate is what makes a
 * foreign character indistinguishable from a missing one.
 */
export async function labCharacterNames(characterIds: readonly string[], ownerId: string): Promise<Map<string, string> | null> {
  const rows = await db()
    .select({ id: characters.id, name: characters.name })
    .from(characters)
    .where(and(inArray(characters.id, [...characterIds]), eq(characters.ownerId, ownerId)));
  const names = new Map(rows.map((row) => [row.id, row.name]));
  return characterIds.every((characterId) => names.has(characterId)) ? names : null;
}


/**
 * One character's SHEET, as a lane that describes them from committed state
 * needs it: the authored profile and the row revision a standalone read token is
 * minted from.
 *
 * Separate from {@link labCharacterNames} rather than folded into it, because
 * the two answer different questions. Every character-bearing kind needs the
 * NAME — a prompt binds faces to labels. Only the staged scene needs the SHEET:
 * it is the one kind that realizes its subject's visual cut itself, from
 * committed state, and compiles a prompt program over it.
 *
 * Owner-scoped on the same terms as every other lab read: a character this owner
 * does not have is indistinguishable from one that does not exist.
 */
export interface LabCharacterSheet {
  readonly profile: CharacterProfile;
  /** `characters.updatedAt` as an ISO string — the read token's character half. */
  readonly revision: string;
}

export async function labCharacterSheet(
  characterId: string,
  ownerId: string,
  sink?: DiagnosticSink,
): Promise<LabCharacterSheet | null> {
  const [row] = await db()
    .select({ profile: characters.profile, updatedAt: characters.updatedAt })
    .from(characters)
    .where(and(eq(characters.id, characterId), eq(characters.ownerId, ownerId)))
    .limit(1);
  if (!row) return null;
  // `parseOr` at the trust boundary (docs/resilience.md §1): a profile column
  // that no longer parses costs the render its authored facts, not the row — and
  // the digest's own required-fact gate is what decides whether the emptied
  // sheet is still renderable, in the one place that decision belongs.
  return {
    profile: parseOr(characterProfileSchema, row.profile ?? {}, emptyCharacterProfile(), sink, "characters.profile"),
    revision: row.updatedAt.toISOString(),
  };
}

/** A cast this kind can name, or why prompt text cannot carry these two. */
type TwoCharacterCast = { ok: true; names: Map<string, string> } | { ok: false; message: string };

/**
 * The two names a scene binds its faces to, trimmed — or the refusal, when the
 * pair cannot be spoken as two people.
 *
 * `characters.name` is neither unique nor guaranteed non-blank, so two REAL,
 * distinct subjects can arrive wearing one label. That matters here and nowhere
 * else in the lab: the compose strategy binds a face to a NAME ("Image 1: the
 * identity reference for Sabrina") and dedupes its subjects by string, so an
 * identical pair yields no cast clause at all and two byte-identical bindings —
 * the kind's entire disambiguation mechanism silently off, on a paid render whose
 * `identities_swapped` verdict would then be a fact about the prompt. A blank
 * name binds nothing whatsoever.
 *
 * There is no wording that fixes it, because prompt text cannot attach two
 * different faces to one name at any length, so the honest answer is a refusal
 * naming something the admin can do — rename one character — rather than a
 * modified clause. The COMPILER is deliberately left alone: its distinct-subject
 * trigger is correct for what labels can express.
 *
 * Compared case-insensitively because the model reads both bindings as prose,
 * where "sabrina vale" and "Sabrina Vale" are one person.
 */
export function twoCharacterCast(subjectIds: readonly string[], cast: Map<string, string>): TwoCharacterCast {
  const names = new Map(subjectIds.map((characterId) => [characterId, (cast.get(characterId) ?? "").trim()]));
  const blank = [...names].find(([, name]) => name === "");
  if (blank) {
    return {
      ok: false,
      message: `character ${blank[0]} has no name, and a two-character scene binds each face to one; name that character before running this scene`,
    };
  }
  const spellings = [...names.values()];
  if (new Set(spellings.map((name) => name.toLowerCase())).size !== spellings.length) {
    return {
      ok: false,
      message: `both characters in this scene are called "${spellings[0] ?? ""}", and a prompt cannot bind two different faces to one name; rename one of them and run it again`,
    };
  }
  return { ok: true, names };
}

export async function primaryChatCharacterId(chatId: string): Promise<string | null> {
  const [participant] = await db()
    .select({ characterId: chatParticipants.characterId })
    .from(chatParticipants)
    .where(eq(chatParticipants.chatId, chatId))
    .orderBy(asc(chatParticipants.sort))
    .limit(1);
  return participant?.characterId ?? null;
}
