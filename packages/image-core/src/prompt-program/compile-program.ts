import { diag, fnv1aHex, type DiagnosticSink } from "@vesper/contracts";
import type { ImagePromptBudget } from "../render-intent/prompt-segments";
import { stableJson } from "../render-kernel/stable-json";
import {
  imagePositiveProtections,
  imagePostMergeCollisions,
  lintImagePromptCollisions,
  type ImageCollisionDecision,
} from "./collision";
import {
  imagePromptDialect,
  type HiddenPromptSource,
  type ImageDialectReference,
  type ImageNegativeTransportOutcome,
  type ImagePromptDialectDefinition,
} from "./dialects";
import {
  imageNegativeGuardOf,
  providerDefaultOverrideConstraint,
  selectImageNegativeConstraints,
  type ImageNegativeConstraint,
} from "./negative-constraints";
import {
  isMandatoryImagePositiveClaim,
  orderImagePositiveClaims,
  selectImagePositiveClaims,
  type ImagePositiveClaim,
} from "./positive-claims";
import type { ImageNegativePackVersion, ImagePositivePackVersion, ImagePromptProfileBinding } from "./prompt-packs";
import type { ImagePromptProgramProvenance, ImageWorldStateProvenance } from "./provenance";
import {
  imageWorldDigestEntities,
  imageWorldDigestFacts,
  type ImageOperationContract,
  type ImageWorldDigest,
} from "./world-digest";

/**
 * THE prompt compile step: one immutable world digest plus one profile binding
 * in, one positive prompt and one negative field out.
 *
 * It is one function for the same reason `compileProfileRenderPlan` is: the
 * guarantees only hold if the stages cannot be reordered or skipped by a caller.
 * Specifically —
 *
 * - **No stage rereads canonical state.** Everything arrives as a value. The
 *   digest is frozen, the packs are data, the dialect is a pure pair of
 *   functions, and none of them is handed anything that could perform IO. That
 *   is what "compilers cannot reach back into application state" means in code
 *   rather than in a review comment.
 * - **The negative is linted BEFORE it is worded.** Collision checking happens on
 *   conflict keys against the positive claims, so a pack cannot forbid something
 *   the world requires no matter how it is phrased.
 * - **Replacement claims re-enter the positive list and are re-checked.** An
 *   endpoint with no negative field turns exclusions into affirmative claims, and
 *   those claims add protections, so the whole thing is checked once more after
 *   the merge. A contradiction surviving that second pass is a compiler bug and
 *   refuses rather than rendering.
 * - **Refusal beats a generic prompt.** An unregistered dialect, a missing pack,
 *   a stale read, a suppressed mandatory concept or an inexpressible required
 *   exclusion all stop the render before provider spend. Falling back to
 *   "something reasonable" is how a lane silently loses the guarantees the whole
 *   system exists to provide.
 */

export interface ImagePromptProgram {
  readonly version: 1;
  readonly worldFingerprint: string;
  readonly operation: ImageOperationContract;
  readonly positive: readonly ImagePositiveClaim[];
  readonly negative: readonly ImageNegativeConstraint[];
  /**
   * The subset of {@link negative} the payload actually carried.
   *
   * Separate from `negative` because the two answer different questions. The
   * constraint list is what the packs and the linter decided; this is what the
   * endpoint could be told, after the version's probed field availability. They
   * part company on exactly the case this system is currently in — a dialect
   * that declares a `negative_prompt` field bound to a version nobody has probed
   * — and identity has to follow the payload, not the intent.
   */
  readonly deliveredNegativeIds: readonly string[];
  readonly positivePackVersionId: string;
  readonly negativePackVersionId: string;
  readonly bindingVersionId: string;
  readonly fingerprint: string;
}

export interface CompiledImagePromptProgram {
  readonly program: ImagePromptProgram;
  /** The text that goes in the prompt field. */
  readonly positiveText: string;
  /** The text for the endpoint's negative field, or null when it has none to send. */
  readonly negativeText: string | null;
  /** Exclusions phrased inside the main instruction, for dialects that do that. */
  readonly inlineExclusions: readonly string[];
  readonly transports: readonly ImageNegativeTransportOutcome[];
  readonly collisions: readonly ImageCollisionDecision[];
  readonly droppedClaimIds: readonly string[];
  readonly hiddenSources: readonly HiddenPromptSource[];
  readonly promptProgramProvenance: ImagePromptProgramProvenance;
  readonly worldStateProvenance: ImageWorldStateProvenance;
}

/** Why a compile refused, in the vocabulary the render path reports. */
export type ImagePromptProgramRefusalCode =
  | "image_prompt_program.dialect_unregistered"
  | "image_prompt_program.strategy_mismatch"
  | "image_prompt_program.world_stale"
  | "image_prompt_program.pack_dialect_mismatch"
  | "image_prompt_program.missing_required_fact"
  | "image_prompt_program.mandatory_concept_suppressed"
  | "image_prompt_program.mandatory_claim_dropped"
  | "image_prompt_program.required_exclusion_unexpressible"
  | "image_prompt_program.post_merge_collision";

export interface ImagePromptProgramRefusal {
  readonly code: ImagePromptProgramRefusalCode;
  readonly message: string;
  readonly context: Record<string, unknown>;
}

export type CompileImagePromptProgramResult =
  | { readonly ok: true; readonly compiled: CompiledImagePromptProgram }
  | { readonly ok: false; readonly refusal: ImagePromptProgramRefusal };

export interface CompileImagePromptProgramInput {
  readonly digest: ImageWorldDigest;
  readonly binding: ImagePromptProfileBinding;
  readonly positivePack: ImagePositivePackVersion;
  readonly negativePack: ImageNegativePackVersion;
  /**
   * Reference slots in FINAL send order, after planning and capacity trimming.
   *
   * Numbering happens before this call and never inside it (plan step 12): a
   * compiler that numbered its own references would write "Image 3" for a slot
   * capacity trimming had already removed, and the prompt would describe a
   * payload that does not exist.
   */
  readonly references: readonly ImageDialectReference[];
  /** The endpoint's probed prompt budget. Empty means no measured limit. */
  readonly budget: ImagePromptBudget;
  /** The negative field's own budget, when the endpoint declares one. */
  readonly negativeBudget?: ImagePromptBudget;
  /** Whether this version actually exposes a negative-prompt input right now. */
  readonly negativeFieldAvailable: boolean;
  /** A read token the caller pinned — the "retry same composition" check. */
  readonly expectedReadToken?: string;
  /**
   * Whether a subject's missing mandatory facts refuse the render.
   *
   * The caller's call, because it is a TASK question rather than a prompt one: a
   * variant of a specific person is worthless without her identity anchors, while
   * an establishing shot that lost one optional locus is still the right picture.
   */
  readonly refuseOnMissingRequired: boolean;
  readonly sink?: DiagnosticSink;
}

const PATH = "image_prompt_program";

export function compileImagePromptProgram(input: CompileImagePromptProgramInput): CompileImagePromptProgramResult {
  const { digest, binding, positivePack, negativePack, sink } = input;

  // --- 1. Validate the read and the binding ---------------------------------
  if (input.expectedReadToken !== undefined && input.expectedReadToken !== digest.read.token) {
    return refuse("image_prompt_program.world_stale", "this digest describes a different read than the retry asked for", {
      expected: input.expectedReadToken,
      actual: digest.read.token,
    });
  }
  if (binding.promptStrategy !== digest.operation.strategy) {
    return refuse("image_prompt_program.strategy_mismatch", "the binding and the operation disagree about the job", {
      binding: binding.promptStrategy,
      operation: digest.operation.strategy,
    });
  }
  for (const pack of [positivePack, negativePack]) {
    if (pack.dialectId !== binding.promptDialectId) {
      return refuse("image_prompt_program.pack_dialect_mismatch", "a bound pack was authored for another dialect", {
        pack: pack.id,
        packDialect: pack.dialectId,
        bindingDialect: binding.promptDialectId,
      });
    }
  }
  const missingRequired = [
    ...digest.subjects.flatMap((subject) => subject.missingRequired),
    ...digest.items.flatMap((item) => item.missingRequired),
    ...(digest.location?.missingRequired ?? []),
  ];
  if (missingRequired.length > 0) {
    if (input.refuseOnMissingRequired) {
      return refuse("image_prompt_program.missing_required_fact", "a required world fact never reached the digest", {
        keys: missingRequired,
      });
    }
    sink?.push(
      diag("warn", "image_prompt_program.missing_required_fact", "this render is missing a fact its owner marked required", {
        path: PATH,
        context: { keys: missingRequired, task: digest.operation.task },
      }),
    );
  }

  // --- 2. Resolve the dialect -----------------------------------------------
  const dialect = imagePromptDialect(binding.promptDialectId);
  if (dialect === null) {
    return refuse("image_prompt_program.dialect_unregistered", "no compiler is registered for this endpoint dialect", {
      dialect: binding.promptDialectId,
      model: binding.modelSlug,
    });
  }

  // --- 3. Positive claims, shaped by the positive pack ----------------------
  const selected = selectImagePositiveClaims(digest);
  const suppressed = new Set<string>(positivePack.manifest.suppressedConcepts);
  const suppressedMandatory = selected.filter(
    (claim) => suppressed.has(claim.concept) && isMandatoryImagePositiveClaim(claim),
  );
  if (suppressedMandatory.length > 0) {
    return refuse(
      "image_prompt_program.mandatory_concept_suppressed",
      "this endpoint's pack suppresses a concept the render may not lose",
      { concepts: [...new Set(suppressedMandatory.map((claim) => claim.concept))] },
    );
  }
  const adjustments = positivePack.manifest.priorityAdjustments;
  // Suppression governs BOTH claim sources. The pack's own rendering-intent
  // descriptors used to be appended after this filter, so a pack that suppressed
  // `style.descriptor` — the reason to suppress it is a model that degrades when
  // style words appear — still emitted its own. A concept a pack says this
  // endpoint may not carry is one it may not carry from any source.
  const packClaims = orderImagePositiveClaims(
    [...selected, ...renderingIntentClaims(positivePack, digest.operation)]
      .filter((claim) => !suppressed.has(claim.concept))
      .map((claim) => {
        const delta = adjustments[claim.concept];
        return delta === undefined ? claim : { ...claim, priority: claim.priority + delta };
      }),
  );

  // --- 4. Negative constraints, selected by guard and pack ------------------
  const guard = imageNegativeGuardOf(digest);
  const hiddenSources = dialect.hiddenPromptSources;
  const selectedConstraints: ImageNegativeConstraint[] = [
    ...selectImageNegativeConstraints({
      enabledBlockIds: negativePack.manifest.enabledBlockIds,
      guard,
      packVersionId: negativePack.id,
      evidenceIds: negativePack.manifest.evidenceIds,
      priorityOverrides: negativePack.manifest.priorityOverrides,
    }),
  ];
  // --- 5. Provider defaults become an explicit exclusion --------------------
  // Only when the wrapper actually injects something. An endpoint whose declared
  // default is the empty string has nothing to neutralize, and synthesizing an
  // override for it would put a clause in the payload that says nothing.
  const injected = hiddenSources.find(
    (source) => source.kind === "provider_default_negative" && (source.value ?? "").trim().length > 0,
  );
  if (injected !== undefined) {
    selectedConstraints.unshift(
      providerDefaultOverrideConstraint({ packVersionId: negativePack.id, evidenceIds: [], overridable: injected.overridable }),
    );
  }

  // --- 6. Lint ---------------------------------------------------------------
  const protections = imagePositiveProtections({
    claims: packClaims,
    operation: digest.operation,
    camera: digest.camera,
  });
  const linted = lintImagePromptCollisions({ constraints: selectedConstraints, protections });
  if (linted.refusedRequired.length > 0) {
    return refuse(
      "image_prompt_program.required_exclusion_unexpressible",
      "a required exclusion is contradicted by this render's own world facts",
      { constraints: linted.refusedRequired },
    );
  }
  for (const decision of linted.decisions) {
    if (decision.outcome === "kept") continue;
    sink?.push(
      diag("info", `image_prompt_program.negative_${decision.outcome}`, "world truth outranked part of the negative pack", {
        path: PATH,
        context: {
          constraint: decision.constraintId,
          removed: decision.removed.map((entry) => ({ key: entry.key, by: entry.claimId })),
          kept: decision.keptKeys,
        },
      }),
    );
  }

  // --- 7. Transport ----------------------------------------------------------
  const negativeCompiled = dialect.compileNegative({
    constraints: linted.constraints,
    guard,
    hiddenSources,
    budget: input.negativeBudget ?? {},
    sink,
  });
  // A dialect may claim a dedicated field the CURRENT version does not expose —
  // an endpoint schema change is exactly the drift that must never be
  // guessed at. The field's real availability is a probe fact supplied by the
  // caller, and it wins.
  const negativeText = input.negativeFieldAvailable ? negativeCompiled.text : null;
  const transports: readonly ImageNegativeTransportOutcome[] = input.negativeFieldAvailable
    ? negativeCompiled.outcomes
    : negativeCompiled.outcomes.map((outcome) =>
        outcome.transport.kind === "dedicated_field"
          ? { constraintId: outcome.constraintId, transport: { kind: "dropped", reason: "no_negative_field_on_version" } }
          : outcome,
      );
  if (!input.negativeFieldAvailable && negativeCompiled.text !== null) {
    sink?.push(
      diag("warn", "image_prompt_program.negative_field_absent", "this version exposes no negative field, so its exclusions were dropped", {
        path: PATH,
        context: { model: binding.modelSlug, dialect: dialect.id },
      }),
    );
  }

  // The exclusions that actually TRAVEL, after the version's real field
  // availability has had its say. Everything downstream of transport reasons
  // about this list rather than `linted.constraints`: a constraint the payload
  // does not carry cannot contradict anything, and cannot change the picture.
  const deliveredIds = new Set(
    transports.filter((outcome) => outcome.transport.kind !== "dropped").map((outcome) => outcome.constraintId),
  );
  const deliveredConstraints = linted.constraints.filter((constraint) => deliveredIds.has(constraint.id));

  // --- 8. Merge replacement claims and re-check -----------------------------
  const mergedClaims = orderImagePositiveClaims([...packClaims, ...negativeCompiled.replacementClaims]);
  const mergedProtections = imagePositiveProtections({
    claims: mergedClaims,
    operation: digest.operation,
    camera: digest.camera,
  });
  // Checked against the DELIVERED exclusions, not every linted one. A dialect
  // that turns exclusions into affirmative claims can otherwise refuse the whole
  // render over a contradiction with an exclusion this version already dropped
  // for having no field to put it in — a refusal about a payload nobody sent.
  const postMerge = imagePostMergeCollisions({ constraints: deliveredConstraints, protections: mergedProtections });
  if (postMerge.length > 0) {
    return refuse("image_prompt_program.post_merge_collision", "a replacement claim contradicts a surviving exclusion", {
      collisions: postMerge.map((entry) => ({ key: entry.key, claim: entry.claimId })),
    });
  }

  // --- 9–11. Compile ---------------------------------------------------------
  const positiveCompiled = dialect.compilePositive({
    claims: mergedClaims,
    operation: digest.operation,
    references: input.references,
    entityLabels: Object.fromEntries(imageWorldDigestEntities(digest).map((entity) => [entity.ref, entity.label])),
    budget: input.budget,
    sink,
  });
  const droppedMandatory = mergedClaims.filter(
    (claim) => positiveCompiled.droppedClaimIds.includes(claim.id) && isMandatoryImagePositiveClaim(claim),
  );
  if (droppedMandatory.length > 0) {
    return refuse(
      "image_prompt_program.mandatory_claim_dropped",
      "this endpoint could not express a claim the render may not lose",
      { claims: droppedMandatory.map((claim) => ({ id: claim.id, concept: claim.concept })) },
    );
  }

  // --- 12–14. Program, fingerprint, provenance -------------------------------
  const keptClaims = mergedClaims.filter((claim) => !positiveCompiled.droppedClaimIds.includes(claim.id));
  const programCore = {
    version: 1 as const,
    worldFingerprint: digest.fingerprint,
    operation: digest.operation,
    positive: keptClaims,
    negative: linted.constraints,
    deliveredNegativeIds: deliveredConstraints.map((constraint) => constraint.id),
    positivePackVersionId: positivePack.id,
    negativePackVersionId: negativePack.id,
    bindingVersionId: binding.id,
  };
  const program: ImagePromptProgram = { ...programCore, fingerprint: imagePromptProgramFingerprint(programCore) };

  return {
    ok: true,
    compiled: {
      program,
      positiveText: positiveCompiled.text,
      negativeText,
      inlineExclusions: negativeCompiled.inlineText,
      transports,
      collisions: linted.decisions,
      droppedClaimIds: positiveCompiled.droppedClaimIds,
      hiddenSources,
      promptProgramProvenance: {
        version: 1,
        programFingerprint: program.fingerprint,
        worldFingerprint: digest.fingerprint,
        bindingVersionId: binding.id,
        positivePackVersionId: positivePack.id,
        negativePackVersionId: negativePack.id,
        promptDialectId: dialect.id,
        promptStrategy: binding.promptStrategy,
        task: binding.task,
        modelSlug: binding.modelSlug,
        pinnedVersionId: binding.versionId,
        positiveClaimIds: keptClaims.map((claim) => claim.id),
        droppedClaimIds: [...positiveCompiled.droppedClaimIds],
        negativeOutcomes: transports.map((outcome) => {
          const decision = linted.decisions.find((entry) => entry.constraintId === outcome.constraintId);
          return {
            constraintId: outcome.constraintId,
            transport: outcome.transport.kind,
            ...(outcome.transport.kind === "dropped" ? { reason: outcome.transport.reason } : {}),
            keptKeys: [...(decision?.keptKeys ?? [])],
            removedKeys: (decision?.removed ?? []).map((entry) => ({ key: entry.key, claimId: entry.claimId })),
          };
        }),
        hiddenPromptSources: hiddenSources.map((source) => ({
          kind: source.kind,
          field: source.field,
          overridable: source.overridable,
          ...(source.value === undefined ? {} : { value: source.value }),
        })),
        positivePromptHash: fnv1aHex(positiveCompiled.text),
        negativePromptHash: negativeText === null ? null : fnv1aHex(negativeText),
        references: input.references.map((reference) => ({
          position: reference.position,
          role: reference.role,
          ...(reference.subjectRef === undefined ? {} : { subjectRef: reference.subjectRef }),
        })),
      },
      worldStateProvenance: {
        version: 1,
        readKind: digest.read.kind,
        readToken: digest.read.token,
        ...(digest.read.atMinutes === undefined ? {} : { atMinutes: digest.read.atMinutes }),
        worldFingerprint: digest.fingerprint,
        subjectRefs: digest.subjects.map((subject) => subject.ref),
        locationRef: digest.location?.ref ?? null,
        itemRefs: digest.items.map((item) => item.ref),
        factKeys: imageWorldDigestFacts(digest).map((fact) => fact.key),
        sourceRevisions: digest.sourceRevisions.map((entry) => ({ ...entry })),
        suppressions: digest.suppressions.map((entry) => ({ ...entry })),
      },
    },
  };
}

/**
 * The program's identity: ordered claims, ordered
 * constraints, both pack versions, the binding, and the world it came from.
 *
 * Claims contribute id, concept and VALUE. Value rather than id alone because
 * two renders of the same character an hour apart select the same claim ids with
 * different hair, and "same program" has to mean the same picture was asked for.
 * The compiled TEXT is deliberately absent: it is hashed separately in
 * provenance, so a dialect wording fix moves the prompt hash without invalidating
 * every stored program fingerprint that described the same request.
 *
 * Exclusions contribute TWICE — the constraint list, and the subset that was
 * actually delivered — because the same reasoning applies to them. A render
 * before its version was probed drops every exclusion, and one after it sends
 * them all; the packs, the linter and the world are identical across that
 * boundary, so the constraint list alone would give the two the same identity
 * while they asked the provider for materially different pictures.
 */
export function imagePromptProgramFingerprint(program: Omit<ImagePromptProgram, "fingerprint">): string {
  return fnv1aHex(
    stableJson({
      version: program.version,
      world: program.worldFingerprint,
      binding: program.bindingVersionId,
      positivePack: program.positivePackVersionId,
      negativePack: program.negativePackVersionId,
      positive: program.positive.map((claim) => [claim.id, claim.concept, claim.value, claim.required, claim.priority]),
      negative: program.negative.map((constraint) => [constraint.id, [...constraint.conflictKeys]]),
      delivered: [...program.deliveredNegativeIds].sort(),
      operation: {
        kind: program.operation.kind,
        task: program.operation.task,
        strategy: program.operation.strategy,
        subjectCount: program.operation.subjectCount,
      },
    }),
  );
}

/**
 * The pack's rendering-intent descriptors, as claims — but only when the world
 * did not state its own.
 *
 * Only-when-silent because the pack is a DEFAULT, not an override: a lane that
 * asked for a specific look has said something more authoritative than a
 * per-endpoint house style, and appending both would produce a prompt asking for
 * two aesthetics at once.
 */
function renderingIntentClaims(
  pack: ImagePositivePackVersion,
  operation: ImageOperationContract,
): readonly ImagePositiveClaim[] {
  if (operation.style.descriptors.length > 0) return [];
  return pack.manifest.renderingIntent.map((descriptor, index) => ({
    id: `pack.rendering_intent.${index}`,
    concept: "style.descriptor" as const,
    segmentKind: "style" as const,
    value: descriptor,
    semanticTags: [],
    required: false,
    priority: 0.4,
    source: { owner: "image.prompt_pack", key: pack.id },
  }));
}

function refuse(
  code: ImagePromptProgramRefusalCode,
  message: string,
  context: Record<string, unknown>,
): CompileImagePromptProgramResult {
  return { ok: false, refusal: { code, message, context } };
}

/** The dialect a binding resolves to, for callers that need it before compiling. */
export function imagePromptDialectForBinding(binding: ImagePromptProfileBinding): ImagePromptDialectDefinition | null {
  return imagePromptDialect(binding.promptDialectId);
}
