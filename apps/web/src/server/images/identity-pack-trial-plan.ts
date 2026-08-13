import {
  buildTrialCellPlans,
  compileProfileRenderPlan,
  type EnsureIdentityPackResult,
  type EvaluateIdentityPackResult,
  type IdentityPackTrialPromptFixture,
  type IdentityReferenceRole,
  type IdentityReferenceStrategy,
  type ImageIdentityPackStatus,
  type ImageIdentityPackTrialCellSpec,
  type ImageIdentityPackTrialCreateRequest,
  imageIdentityPackTrialDiagnosticCode,
  type ImageIdentityPackTrialRefusalCode,
  type ImageIdentityPackV1,
  type ImageModel,
  type ImageModelProfile,
  imageProfileOffered,
  pinnedImageModelVersion,
  referenceCapacity,
  type TrialCellCounts,
  type TrialCellPlan,
  trialPromptFixtureById,
} from "@vesper/image-core";
import { diag, type DiagnosticSink } from "@/contracts/diagnostics";
import { newId } from "@/lib/ids";
import { disableSafetyChecker } from "../ai";
import { db, imageIdentityPackTrialCells, imageIdentityPackTrialRuns } from "../db";
import { ensureIdentityPack } from "./identity-pack-ensure";
import { IDENTITY_PACK_TRIAL_CORPORA } from "./identity-pack-preparation";
import { getIdentityPackRevisionForTrial, type IdentityPackRevisionForTrialResult } from "./identity-pack-read";
import {
  evaluateIdentityPackContractForProfile,
  evaluateIdentityPackForProfile,
  identityRolePlan,
} from "./identity-pack-references";
import { loadImageModels } from "./models";
import { loadImageModelProfiles } from "./model-profiles";
import {
  type IdentityPackTrialRefusal,
  refusal,
  trialCellCompiledIdentity,
  trialResult,
  zeroTrialCellCounts,
} from "./identity-pack-trial-store";

/**
 * Planning: resolve every cell of the requested grid — packs, profiles, models,
 * fixtures — and write the run with its cells pinned.
 *
 * The service's rules and its row/refusal layer are in
 * `./identity-pack-trial-store.ts`; what a planned cell then pins is re-checked
 * at execution time by `./identity-pack-trial-render.ts`.
 */

/* ------------------------------------------------------------------------ *
 * Run creation                                                              *
 * ------------------------------------------------------------------------ */

export interface CreateIdentityPackTrialRunInput {
  ownerId: string;
  request: ImageIdentityPackTrialCreateRequest;
  sink?: DiagnosticSink;
}

export type CreateIdentityPackTrialRunResult =
  | { ok: true; runId: string; counts: TrialCellCounts }
  | { ok: false; refusal: IdentityPackTrialRefusal };

type ResolvedTrialCell =
  | { status: "planned"; spec: ImageIdentityPackTrialCellSpec }
  | {
      status: "refused";
      code: ImageIdentityPackTrialRefusalCode;
      message: string;
      /** Whatever resolved before the refusal — honestly partial, never faked. */
      spec: Record<string, unknown>;
    };

interface TrialPlanResolution {
  ownerId: string;
  profilesById: Map<string, ImageModelProfile>;
  modelsById: Map<string, ImageModel>;
  /** One `ensureIdentityPack` per character per create call. */
  packs: Map<string, Promise<EnsureIdentityPackResult>>;
  /** One read per pinned `(character, revision)` per create call. */
  revisions: Map<string, Promise<IdentityPackRevisionForTrialResult>>;
  /** One profile-eligibility evaluation per (character, strategy, pack variant). */
  evaluations: Map<string, Promise<EvaluateIdentityPackResult>>;
  sink: DiagnosticSink | undefined;
}

/**
 * The one memo spelling the per-create caches share.
 *
 * Each of them keys work that is either expensive (a pack ensure, a pinned
 * revision read) or noisy (an evaluation that pushes diagnostics), and whose
 * answer cannot change inside one create call. The get/set dance is written once
 * because the DANGEROUS mistake in a cache like this is not the lookup, it is the
 * key: a cache whose key omits an axis silently answers one arm's question with
 * another arm's answer, and nothing about the code reads as wrong. Keeping the
 * mechanics in one place leaves the key expressions as the only thing to review.
 */
function memoized<T>(store: Map<string, Promise<T>>, key: string, produce: () => Promise<T>): Promise<T> {
  const cached = store.get(key);
  if (cached) return cached;
  const created = produce();
  store.set(key, created);
  return created;
}

function ensurePackOnce(resolution: TrialPlanResolution, characterId: string): Promise<EnsureIdentityPackResult> {
  return memoized(resolution.packs, characterId, () =>
    ensureIdentityPack({ ownerId: resolution.ownerId, characterId, purpose: "admin_trial", sink: resolution.sink }),
  );
}

function pinnedRevisionOnce(
  resolution: TrialPlanResolution,
  characterId: string,
  revision: number,
): Promise<IdentityPackRevisionForTrialResult> {
  return memoized(resolution.revisions, `${characterId}:${revision}`, () =>
    getIdentityPackRevisionForTrial({
      ownerId: resolution.ownerId,
      characterId,
      revision,
      sink: resolution.sink,
    }),
  );
}

/**
 * The evaluation depends only on the pack a variant resolved and the strategy —
 * the profile policy in force is the v1 defaults for every profile, and no
 * reviewed effective-size fact exists yet (`effectiveReferenceSize` omitted keeps
 * the evaluation conservative) — so it is cached rather than run once per cell.
 *
 * The VARIANT KEY is part of the cache key, and that is load-bearing rather than
 * defensive: two arms of one run may ask the same (character, strategy) question
 * of two different pack revisions, and a cache that could not tell them apart
 * would hand one revision's verdict — its roles, its measurements — to the other
 * and call the result a comparison.
 */
function evaluateCurrentPackOnce(
  resolution: TrialPlanResolution,
  characterId: string,
  strategy: IdentityReferenceStrategy,
): Promise<EvaluateIdentityPackResult> {
  return memoized(resolution.evaluations, `${characterId}:${strategy}:current`, () =>
    evaluateIdentityPackForProfile({
      ownerId: resolution.ownerId,
      characterId,
      strategy,
      purpose: "admin_trial",
      sink: resolution.sink,
    }),
  );
}

/**
 * The SAME eligibility interpretation, run against a pinned historical revision
 * the caller already read.
 *
 * `evaluateIdentityPackContractForProfile` is the render path's own judgment
 * minus the ensure, which is the whole point: a trial-local copy of "may this
 * role be sent?" would drift, and the harness would end up measuring its own
 * rules. `treatRetiredRevisionAsReady` is set because a superseded or stale
 * revision — the OLD side of every old-vs-new comparison — would otherwise walk
 * past the policy projection unjudged.
 */
function evaluatePinnedRevisionOnce(
  resolution: TrialPlanResolution,
  pack: ImageIdentityPackV1,
  strategy: IdentityReferenceStrategy,
  variantKey: string,
): Promise<EvaluateIdentityPackResult> {
  return memoized(resolution.evaluations, `${pack.characterId}:${strategy}:${variantKey}`, () =>
    Promise.resolve(
      evaluateIdentityPackContractForProfile({
        pack,
        strategy,
        treatRetiredRevisionAsReady: true,
        sink: resolution.sink,
      }),
    ),
  );
}

/** The pack columns of a cell's spec — all null on the no-pack baseline. Sliced
 * off the contract rather than restated, so a pack field added there is a type
 * error here until this fills it. */
type TrialSpecPackFields = Pick<
  ImageIdentityPackTrialCellSpec,
  | "packId"
  | "packRevision"
  | "sourceImageId"
  | "sourceContentHash"
  | "cropMethod"
  | "crop"
  | "derivationVersion"
  | "policyVersion"
>;

/** The measurement columns a strategy evaluation fills in. */
type TrialSpecEvaluationFields = Pick<
  ImageIdentityPackTrialCellSpec,
  "effectiveReferenceSize" | "orderedReferenceRoles"
>;

/**
 * What a cell's PACK VARIANT resolves to: the pack identity and the reference
 * plan it supports, or the refusal that stops the cell.
 *
 * A refusal carries whatever pack identity it had already established — `null`
 * only when the refusal landed before any of it did. A partial spec is honest; a
 * spec padded out to parse would be a fabricated pack identity on a cell that
 * never resolved one.
 */
type TrialVariantResolution =
  | { ok: true; pack: TrialSpecPackFields; evaluation: TrialSpecEvaluationFields }
  | {
      ok: false;
      code: ImageIdentityPackTrialRefusalCode;
      message: string;
      pack: TrialSpecPackFields | null;
    };

/**
 * Detector-derived cells are structurally supported but unbuildable until a
 * reviewed detector ships (the null adapter finds nothing, so this only fires for
 * injected or future detectors) — refused, never faked. Spelled once because
 * BOTH pack arms apply it, to whichever revision they resolved: a pinned
 * revision derived by a detector is exactly as unreproducible as a current one.
 */
const DETECTOR_UNAVAILABLE_MESSAGE =
  "detector-derived cells are not runnable until a reviewed face detector ships";

/** The pack identity a resolved revision contributes to a cell's spec. */
function trialSpecPackFields(pack: ImageIdentityPackV1, sourceImageId: string): TrialSpecPackFields {
  return {
    packId: pack.id,
    packRevision: pack.revision,
    sourceImageId,
    sourceContentHash: pack.source.contentHash,
    cropMethod: pack.derivation.method,
    crop: pack.faceDetail.crop,
    derivationVersion: pack.derivation.derivationVersion,
    policyVersion: pack.derivation.policyVersion,
  };
}

/** The measurement half of a cell's spec, from an eligible evaluation. */
function trialSpecEvaluationFields(
  evaluated: Extract<EvaluateIdentityPackResult, { eligible: true }>,
): TrialSpecEvaluationFields {
  const primary = evaluated.candidates[0];
  return {
    effectiveReferenceSize: {
      widthPx: primary?.evaluation.effectiveReferenceWidthPx ?? null,
      heightPx: primary?.evaluation.effectiveReferenceHeightPx ?? null,
      faceWidthPx: primary?.evaluation.effectiveFaceWidthPx ?? null,
      faceHeightPx: primary?.evaluation.effectiveFaceHeightPx ?? null,
    },
    orderedReferenceRoles: evaluated.candidates.map((candidate) => candidate.role),
  };
}

/**
 * Whether a pinned revision has a finished derivation a comparison arm can
 * actually render from.
 *
 * `superseded` and `stale` PASS, and that is the entire point of the axis: the
 * old side of a manual-vs-automatic or old-vs-new comparison is by definition no
 * longer current, and refusing it would leave the variant axis able to express
 * only the arm it was already able to run. Their crop bytes exist and their own
 * source row and content hash are recorded on the revision — `stale` says the
 * CHARACTER's canonical source moved on, not that this revision's bytes did, and
 * execution re-checks that identity before rendering either way.
 *
 * `failed` and `unusable` have no crop to send, and `pending` never finished.
 * Those are refusals, never a fallback to some other revision.
 */
function pinnedRevisionIsRenderable(status: ImageIdentityPackStatus): boolean {
  switch (status) {
    case "ready":
    case "superseded":
    case "stale":
      return true;
    case "pending":
    case "unusable":
    case "failed":
      return false;
  }
}

/**
 * The `current` arm: ensure the character's pack and evaluate the strategy
 * against it. This is the historical single-variant behavior, unchanged — it
 * pins whatever revision is current at planning time, and execution re-ensures
 * and refuses `cell_conflict` if that moved.
 */
async function currentPackVariantResolution(
  resolution: TrialPlanResolution,
  characterId: string,
  strategy: IdentityReferenceStrategy,
): Promise<TrialVariantResolution> {
  const ensured = await ensurePackOnce(resolution, characterId);
  const sourceImageId = ensured.status === "ready" ? ensured.pack.source.imageId : null;
  if (ensured.status !== "ready" || sourceImageId === null) {
    const code = ensured.status === "ready" ? "source_missing" : ensured.code;
    return { ok: false, code: "pack_blocked", message: `identity pack unavailable (${code})`, pack: null };
  }
  const pack = trialSpecPackFields(ensured.pack, sourceImageId);
  if (ensured.pack.derivation.method === "detector") {
    return { ok: false, code: "detector_unavailable", message: DETECTOR_UNAVAILABLE_MESSAGE, pack };
  }
  const evaluated = await evaluateCurrentPackOnce(resolution, characterId, strategy);
  if (!evaluated.eligible) {
    const message = `identity references unavailable for this strategy (${evaluated.messageKey})`;
    return { ok: false, code: "profile_ineligible", message, pack };
  }
  return { ok: true, pack, evaluation: trialSpecEvaluationFields(evaluated) };
}

/**
 * The `rev:…` arm: one NAMED revision, read strictly read-only.
 *
 * It never calls `ensureIdentityPack` and never falls back to the current pack.
 * A pinned arm that quietly resolved against the current revision would render a
 * different comparison under the name of the one that was planned — which is the
 * exact corruption this axis exists to MEASURE, and so is the one thing it must
 * not itself commit. A revision that cannot be read, cannot be rendered from, or
 * that today's policy refuses is `pack_revision_unavailable`; the cell is
 * recorded and nothing is spent.
 */
async function pinnedRevisionVariantResolution(
  resolution: TrialPlanResolution,
  characterId: string,
  revision: number,
  strategy: IdentityReferenceStrategy,
  variantKey: string,
): Promise<TrialVariantResolution> {
  const pinned = await pinnedRevisionOnce(resolution, characterId, revision);
  if (!pinned.ok) {
    const message = `pinned pack revision ${revision} is unavailable (${pinned.code})`;
    return { ok: false, code: "pack_revision_unavailable", message, pack: null };
  }
  const sourceImageId = pinned.pack.source.imageId;
  if (!pinnedRevisionIsRenderable(pinned.pack.status) || sourceImageId === null) {
    const message = `pinned pack revision ${revision} has no usable derivation (${pinned.pack.status})`;
    return { ok: false, code: "pack_revision_unavailable", message, pack: null };
  }
  const pack = trialSpecPackFields(pinned.pack, sourceImageId);
  if (pinned.pack.derivation.method === "detector") {
    return { ok: false, code: "detector_unavailable", message: DETECTOR_UNAVAILABLE_MESSAGE, pack };
  }
  const evaluated = await evaluatePinnedRevisionOnce(resolution, pinned.pack, strategy, variantKey);
  if (!evaluated.eligible) {
    // The same split the current arm makes one step earlier, at its ensure: a
    // code from the PACK's own failure vocabulary means today's policy refuses
    // this revision outright, while `profile_ineligible` means the revision is
    // fine and it is the STRATEGY that cannot be carried from it.
    const code = evaluated.code === "profile_ineligible" ? "profile_ineligible" : "pack_revision_unavailable";
    const message = `pinned pack revision ${revision} cannot carry this strategy (${evaluated.messageKey})`;
    return { ok: false, code, message, pack };
  }
  return { ok: true, pack, evaluation: trialSpecEvaluationFields(evaluated) };
}

/**
 * The `none` arm: the no-pack baseline, which resolves no pack at all.
 *
 * It is expressible only on a GENERATE profile, for two reasons of different
 * weight. Mechanically, an edit profile with zero references has nothing to
 * edit. More importantly, a zero-reference generate IS the reproducible
 * historical behavior this control arm is supposed to represent, whereas an edit
 * lane's historical behavior always involved reference wiring the trial cannot
 * reproduce — so a zero-reference edit cell would be a baseline for a render
 * nobody ever made.
 */
function baselineVariantResolution(profile: ImageModelProfile): TrialVariantResolution {
  if (profile.operation !== "generate") {
    return {
      ok: false,
      code: "profile_ineligible",
      message:
        `the no-pack baseline needs a generate profile; ${profile.key} is an edit profile, ` +
        "whose zero-reference behavior this trial cannot reproduce",
      pack: null,
    };
  }
  return {
    ok: true,
    pack: {
      packId: null,
      packRevision: null,
      sourceImageId: null,
      sourceContentHash: null,
      cropMethod: null,
      crop: null,
      derivationVersion: null,
      policyVersion: null,
    },
    evaluation: {
      // Nothing was measured because nothing was selected — null is "not
      // measured", never zero.
      effectiveReferenceSize: { widthPx: null, heightPx: null, faceWidthPx: null, faceHeightPx: null },
      orderedReferenceRoles: [],
    },
  };
}

/** Dispatch one cell to the arm its variant names. Three genuinely different
 * reads — collapsing any two of them would be a correctness bug, not a tidy-up
 * (the same ruling {@link resolveTrialCellPack} records for execution). */
async function resolveTrialCellVariant(
  resolution: TrialPlanResolution,
  plan: TrialCellPlan,
  profile: ImageModelProfile,
): Promise<TrialVariantResolution> {
  const variant = plan.packVariant;
  if (variant.source === "none") return baselineVariantResolution(profile);

  // Both pack arms need a strategy to evaluate. The planner pairs a null
  // strategy with the `none` variant and nothing else, so this is an invariant
  // guard rather than a reachable product state — spelled out because a `!` here
  // would turn a planner bug into a cell claiming references it never chose.
  const strategy = plan.identityStrategy;
  if (strategy === null) {
    return {
      ok: false,
      code: "profile_ineligible",
      message: "a pack-source cell was planned with no reference strategy",
      pack: null,
    };
  }

  switch (variant.source) {
    case "current":
      return currentPackVariantResolution(resolution, plan.characterId, strategy);
    case "revision":
      // The CELL's character, not the selector's: the planner emits a revision
      // variant only for its own character, and reading under the selector
      // instead would let a mismatch resolve a pack for somebody the cell does
      // not name.
      return pinnedRevisionVariantResolution(
        resolution,
        plan.characterId,
        variant.revision,
        strategy,
        plan.packVariantKey,
      );
  }
}

/**
 * Why this evaluated arm would be a DUPLICATE of a shorter one, or null when it
 * is a real comparison.
 *
 * `identityRolePlan` marks `face_detail` optional in both two-role strategies.
 * A pack whose face crop is unusable therefore evaluates `eligible` for
 * `canonical_then_face_detail` with a warning and a candidate list of just the
 * canonical portrait — which is byte-for-byte what `canonical_only` sends. That
 * is the RIGHT answer for a production render (a slightly weaker likeness beats
 * no image) and the wrong one for a trial: the grid would render the same
 * request twice, pair the two, and report whatever the model did differently
 * between them as an effect of reference ordering.
 *
 * So the trial refuses the cell instead of letting a degenerate arm into the
 * grid — a refusal of the CELL, never a change to the evaluation. Production's
 * interpretation of eligibility is exactly what the harness exists to measure,
 * and editing `identityRolePlan` to suit the harness would make it measure
 * itself. The refusal is also cheap in the right way: it happens at planning, so
 * the arm costs nothing and reads back with its reason attached.
 */
function degenerateArmRefusal(
  strategy: IdentityReferenceStrategy,
  roles: readonly IdentityReferenceRole[],
): string | null {
  const missing = identityRolePlan(strategy)
    .map((entry) => entry.role)
    .filter((role) => !roles.includes(role));
  if (missing.length === 0) return null;
  // Only `face_detail` is ever optional, and a missing REQUIRED role already
  // refused inside the evaluation — so in practice this names the face crop and
  // the surviving arm is `canonical_only`. The general spelling is here so a
  // future role plan cannot make the message quietly untrue.
  const surviving = roles.length === 1 && roles[0] === "canonical_identity" ? "canonical_only" : "a shorter arm";
  return (
    `the ${missing.join(", ").replaceAll("_", "-")} reference is unavailable for this pack; ` +
    `the cell would duplicate ${surviving}`
  );
}

/**
 * Resolve one planned cell to a full spec, or to the refusal that stops it
 * (spec.trial.md §"Trial manifest"). The order is the design's: profile, then
 * the fixture's task, then production offerability, then the version pin, then
 * the pack variant and its strategy evaluation, then capacity — each refusal
 * records everything that DID resolve, so the run report can say how far a cell
 * got.
 *
 * The two eligibility gates before the version pin are what keep the grid from
 * grading renders production could never make:
 *
 * - **Task match.** A profile answers for ONE job. Running a scene profile
 *   against a variant fixture produces an image, and grading it produces a
 *   number, but the number describes a combination the render path would never
 *   resolve — evidence for a render nobody can have.
 * - **Offerability**, through {@link imageProfileOffered} — the same predicate
 *   production selection reads, reused rather than restated. That single call
 *   carries the profile's `enabled` switch, the task's legacy model surface
 *   during the capabilities migration, operation-vs-model support, `edit_kind`,
 *   and the identity ratings that keep an img2img or weak-identity model out of
 *   an identity-critical task. Restating any of them here would let trial
 *   eligibility drift from production eligibility, which is the one thing this
 *   harness cannot afford.
 *
 * Two further gates keep the grid from grading arms that are not comparisons at
 * all, and they sit either side of the pack resolution because that is where
 * their evidence arrives:
 *
 * - **The reference-policy floor**, just before the variant resolves. A profile
 *   whose reviewed policy allows roles but not `identity` would never be handed
 *   an identity reference in production; an empty policy is the unreviewed
 *   default and stays permissive.
 * - **Degenerate arms** ({@link degenerateArmRefusal}), just after the
 *   evaluation. An arm whose optional role was dropped sends exactly what a
 *   shorter strategy sends, and pairing two identical requests measures provider
 *   noise under a strategy's name.
 *
 * The control COMPILE sits between the evaluation and the capacity check, and it
 * is the LAST gate. Running it before the capacity check is what lets a
 * `capacity_exceeded` cell keep a fully parseable spec — the one refusal that has
 * resolved everything and should read back complete.
 *
 * It refuses on exactly one thing: a `promptStrategy` the identity-reference path
 * cannot execute (`text_repair`, `example_transform`, `style_render`,
 * `coherent_set` — see {@link compileProfileRenderPlan}). The refusal is
 * `profile_ineligible` and names the strategy, because that is what it is: a
 * profile configured for a job this harness has no vocabulary for. The check is
 * NOT hoisted up beside the profile-row gates even though the profile row alone
 * answers it — a second copy of "which strategies are executable?" living here
 * would be free to drift from the dispatch that actually compiles them, and the
 * cell would then be planned against a prompt nobody can produce.
 */
async function resolveTrialCell(
  resolution: TrialPlanResolution,
  cellId: string,
  plan: TrialCellPlan,
  fixture: IdentityPackTrialPromptFixture,
): Promise<ResolvedTrialCell> {
  const planFields = {
    id: cellId,
    characterId: plan.characterId,
    task: fixture.task,
    promptFixtureId: plan.promptFixtureId,
    profileId: plan.profileId,
    identityStrategy: plan.identityStrategy,
    packVariantKey: plan.packVariantKey,
    // Derived from the variant rather than assumed: `none` is the one arm that
    // sends nothing, and the spec contract's cross-field rules key off exactly
    // this value.
    referenceSource: plan.packVariant.source === "none" ? ("none" as const) : ("pack" as const),
    // No seed transport exists anywhere in the render path yet, so every cell
    // records the honest null rather than a number nothing would send.
    requestedSeed: null,
  };

  const profile = resolution.profilesById.get(plan.profileId);
  const model = profile ? resolution.modelsById.get(profile.imageModelId) : undefined;
  if (!profile || !model) {
    return {
      status: "refused",
      code: "profile_ineligible",
      message: `profile ${plan.profileId} is not a runnable registry profile`,
      spec: planFields,
    };
  }
  const profileFields = { modelSlug: model.slug, profileKey: profile.key };

  if (profile.task !== fixture.task) {
    return {
      status: "refused",
      code: "profile_ineligible",
      message: `profile task ${profile.task} cannot run a ${fixture.task} fixture`,
      spec: { ...planFields, ...profileFields },
    };
  }

  const offered = imageProfileOffered(profile, model);
  if (!offered.ok) {
    return {
      status: "refused",
      code: "profile_ineligible",
      message: `profile ${profile.key} is not offered on ${model.slug} (${offered.reason})`,
      spec: { ...planFields, ...profileFields },
    };
  }

  // A controlled comparison must know EXACTLY which provider version produced
  // its evidence. Production is happy to follow a model's floating latest; a
  // trial that did would be comparing whatever Replicate shipped that hour, and
  // the execute-time re-check would have nothing real to compare against.
  const modelVersion = pinnedImageModelVersion(model);
  if (modelVersion === null) {
    return {
      status: "refused",
      code: "version_unpinned",
      message: `${model.slug} has no probed or slug-pinned provider version, so a controlled trial cannot pin it`,
      spec: { ...planFields, ...profileFields },
    };
  }
  const versionFields = { modelVersion };

  // The reference-policy floor, and the LAST gate that can be answered from the
  // profile row alone. A profile whose reviewed policy names allowed roles and
  // omits `identity` is one production would never hand an identity reference
  // to, so a trial cell that sent one would be grading a configuration the
  // render path cannot produce. An EMPTY `allowedRoles` is the seeded default —
  // "nobody has reviewed a policy for this profile yet" — and stays permissive,
  // because reading "nothing recorded" as "nothing allowed" would refuse all 17
  // seeded profiles and empty the grid. The no-pack baseline sends no references
  // at all and is untouched either way.
  if (planFields.referenceSource === "pack") {
    const allowedRoles = profile.referencePolicy.allowedRoles;
    if (allowedRoles.length > 0 && !allowedRoles.includes("identity")) {
      return {
        status: "refused",
        code: "profile_ineligible",
        message: `the profile's reference policy does not allow identity references (allows ${allowedRoles.join(", ")})`,
        spec: { ...planFields, ...profileFields, ...versionFields },
      };
    }
  }

  const variant = await resolveTrialCellVariant(resolution, plan, profile);
  if (!variant.ok) {
    return {
      status: "refused",
      code: variant.code,
      message: variant.message,
      spec: { ...planFields, ...profileFields, ...versionFields, ...(variant.pack ?? {}) },
    };
  }
  const roles = variant.evaluation.orderedReferenceRoles;

  // The evaluation is production's, and production's answer to a missing
  // OPTIONAL role is "render anyway with a warning" — right for a portrait, and
  // a fabricated experiment for a grid. See {@link degenerateArmRefusal}.
  const degenerate = plan.identityStrategy === null ? null : degenerateArmRefusal(plan.identityStrategy, roles);
  if (degenerate !== null) {
    return {
      status: "refused",
      code: "profile_ineligible",
      message: degenerate,
      spec: { ...planFields, ...profileFields, ...versionFields, ...variant.pack, ...variant.evaluation },
    };
  }

  // Compile what this cell WOULD send, with the roles now known: the profile's
  // prompt strategy applied to the fixture text (numbered role bindings and
  // model dialect included), the negative that survives to a real provider
  // field, and the resolved control payload with every drop recorded. These are
  // the facts the execute-time re-check recomputes — the planner and the
  // executor call the same compiler, so a mismatch means the world moved, never
  // that the two disagreed. The baseline compiles with an EMPTY role list, which
  // is what leaves its prompt as the fixture wrote it: the control arm must not
  // differ from the pack arms by any text the harness itself added.
  const compiled = compileProfileRenderPlan({
    model,
    profile,
    basePrompt: fixture.prompt,
    baseNegativePrompt: fixture.negativePrompt,
    // Read at the application boundary, exactly where the payload builder reads
    // it: the compile step is pure and takes the enforcement in force NOW as a
    // value, which is what makes a flip between planning and execution a
    // `cell_conflict` rather than an invisible change.
    safetyCheckerDisabled: disableSafetyChecker(),
    references: { vocabulary: "identity_pack", roles },
  });
  if (!compiled.ok) {
    return {
      status: "refused",
      code: "profile_ineligible",
      message: `prompt strategy ${compiled.promptStrategy} is not executable by the identity trial`,
      spec: { ...planFields, ...profileFields, ...versionFields, ...variant.pack, ...variant.evaluation },
    };
  }
  const renderPlan = compiled.plan;
  const controlFields = {
    ...trialCellCompiledIdentity(renderPlan, profile, roles),
    resolvedControls: renderPlan.resolvedControls,
  };

  const capacity = referenceCapacity(model);
  if (roles.length > capacity.max) {
    return {
      status: "refused",
      code: "capacity_exceeded",
      message: `${roles.length} reference(s) exceed ${model.slug}'s capacity of ${capacity.max}`,
      spec: {
        ...planFields,
        ...profileFields,
        ...versionFields,
        ...variant.pack,
        ...variant.evaluation,
        ...controlFields,
      },
    };
  }

  const spec: ImageIdentityPackTrialCellSpec = {
    ...planFields,
    ...profileFields,
    ...versionFields,
    ...variant.pack,
    ...variant.evaluation,
    ...controlFields,
  };
  return { status: "planned", spec };
}

/**
 * Plan a run: expand the grid, resolve every cell, and persist the run with its
 * cells — eligible ones `planned`, blocked ones `refused` with the code that
 * stopped them (spending nothing). Whole-run refusals — an unknown corpus, an
 * unknown fixture, a revision selector naming a character outside the run, a grid
 * over `TRIAL_MAX_CELLS` — create no rows at all: they are configuration errors,
 * not outcomes worth recording.
 *
 * An unowned character is NOT a whole-run refusal: its cells resolve exactly
 * like a character that does not exist (`pack_blocked` over `source_missing`,
 * the batch surface's deliberate not-yours ≡ gone indistinguishability).
 */
export async function createIdentityPackTrialRun(
  input: CreateIdentityPackTrialRunInput,
): Promise<CreateIdentityPackTrialRunResult> {
  const { ownerId, request, sink } = input;

  let characterIds: readonly string[];
  if (request.corpusId !== undefined) {
    const corpus = IDENTITY_PACK_TRIAL_CORPORA.get(request.corpusId);
    if (!corpus) {
      return {
        ok: false,
        refusal: refusal("unknown_corpus", `no checked-in trial corpus named "${request.corpusId}"`, sink, {
          corpusId: request.corpusId,
        }),
      };
    }
    characterIds = corpus;
  } else {
    characterIds = request.characterIds ?? [];
  }

  const fixturesById = new Map<string, IdentityPackTrialPromptFixture>();
  for (const fixtureId of request.promptFixtureIds) {
    const fixture = trialPromptFixtureById(fixtureId);
    if (!fixture) {
      return {
        ok: false,
        refusal: refusal("fixture_unknown", `no checked-in prompt fixture named "${fixtureId}"`, sink, { fixtureId }),
      };
    }
    fixturesById.set(fixtureId, fixture);
  }

  // A revision selector is CHARACTER-SCOPED, so one naming a character this run
  // does not include produces no cells at all — the planner would drop it in
  // silence and the reviewer would believe an arm ran that never existed. That is
  // a configuration error like an unknown corpus or fixture, not an outcome worth
  // recording, so it refuses the whole run and creates no rows.
  for (const selector of request.packVariants ?? []) {
    if (selector.source !== "revision" || characterIds.includes(selector.characterId)) continue;
    return {
      ok: false,
      refusal: refusal(
        "pack_revision_unavailable",
        "a revision selector names a character this run does not include",
        sink,
        { characterId: selector.characterId, revision: selector.revision },
      ),
    };
  }

  const planned = buildTrialCellPlans({
    characterIds,
    profileIds: request.profileIds,
    strategies: request.strategies,
    promptFixtureIds: request.promptFixtureIds,
    packVariants: request.packVariants,
  });
  if (!planned.ok) {
    return {
      ok: false,
      refusal: refusal(
        "too_many_cells",
        `${planned.requestedCells} cells exceed the ${planned.maximumCells} allowed in one run`,
        sink,
        { requestedCells: planned.requestedCells },
      ),
    };
  }

  const [profiles, models] = await Promise.all([loadImageModelProfiles(sink), loadImageModels(sink)]);
  const resolution: TrialPlanResolution = {
    ownerId,
    profilesById: new Map(profiles.map((profile) => [profile.id, profile])),
    modelsById: new Map(models.map((model) => [model.id, model])),
    packs: new Map(),
    revisions: new Map(),
    evaluations: new Map(),
    sink,
  };

  const counts = zeroTrialCellCounts();
  const cellValues: (typeof imageIdentityPackTrialCells.$inferInsert)[] = [];
  const runId = newId();
  for (const plan of planned.plans) {
    const fixture = fixturesById.get(plan.promptFixtureId);
    if (!fixture) continue; // unreachable: every fixture id was resolved above
    const cellId = newId();
    const resolved = await resolveTrialCell(resolution, cellId, plan, fixture);
    counts[resolved.status] += 1;
    if (resolved.status === "planned") {
      cellValues.push({ id: cellId, runId, cellKey: plan.cellKey, status: "planned", specJson: resolved.spec });
      continue;
    }
    sink?.push(
      diag("warn", imageIdentityPackTrialDiagnosticCode(resolved.code), resolved.message, {
        context: { runId, cellKey: plan.cellKey },
      }),
    );
    cellValues.push({
      id: cellId,
      runId,
      cellKey: plan.cellKey,
      status: "refused",
      specJson: resolved.spec,
      resultJson: trialResult({ failureCode: resolved.code, failureMessage: resolved.message.slice(0, 2000) }),
    });
  }

  // A run with nothing plannable is born in `review`, not `draft`: nothing will
  // ever execute (the Execute affordance hides at planned = 0, and the
  // draft→review settle only fires on execute), so `draft` would wedge it
  // forever. `review` is the honest position — its refused cells are its whole
  // record — and the vacuous-completion rule keeps it from claiming `complete`.
  //
  // Both inserts go in ONE transaction: a run row is a claim about a grid, and a
  // crash between the two writes left a draft run with zero cells — permanently
  // wedged (nothing to execute, so nothing ever settles it) and indistinguishable
  // from a run whose cells were all deleted. Either the whole grid exists or the
  // run does not.
  await db().transaction(async (tx) => {
    await tx
      .insert(imageIdentityPackTrialRuns)
      .values({
        id: runId,
        ownerId,
        label: request.label,
        status: counts.planned === 0 ? "review" : "draft",
        configJson: request,
      });
    if (cellValues.length > 0) await tx.insert(imageIdentityPackTrialCells).values(cellValues);
  });

  return { ok: true, runId, counts };
}
