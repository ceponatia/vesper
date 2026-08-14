import { and, eq } from "drizzle-orm";
import {
  compileProfileRenderPlan,
  IMAGE_TARGET_ASPECT,
  type ImageIdentityPackTrialCellSpec,
  imageIdentityPackTrialCellSpecSchema,
  imageIdentityPackTrialDiagnosticCode,
  type ImageIdentityPackTrialRefusalCode,
  type ImageIdentityPackTrialResult,
  type ImageIdentityPackV1,
  type ImageModel,
  type ImageModelProfile,
  type ImageRenderDimensionFacts,
  pinnedImageModelVersion,
  providerVersionsDisagree,
  type TrialCellStatus,
  trialPromptFixtureById,
} from "@vesper/image-core";
import { diag, DiagnosticCollector, type DiagnosticSink, teeSink } from "@/contracts/diagnostics";
import { classifyImageFailure, disableSafetyChecker } from "../ai";
import { db, imageIdentityPackTrialCells, images } from "../db";
import { createImageAsset, deleteOwnedImage, imageMeta, readImageBytes, saveImageBuffer } from "./assets";
import { ensureIdentityPack } from "./identity-pack-ensure";
import { getIdentityPackRevisionForTrial } from "./identity-pack-read";
import { renderWithModel, type RenderWithModelResult } from "./models";
import {
  type ExecutedTrialCell,
  type IdentityPackTrialCellRow,
  refusal,
  trialCellCompiledIdentity,
  trialResult,
} from "./identity-pack-trial-store";

/**
 * One cell, rendered and settled: the renderer seam, the pinned-configuration
 * re-checks, the provider call, the hidden output asset and the compare-and-set
 * settle against the pass's claim.
 *
 * The pass that claims cells and calls in here is
 * `./identity-pack-trial-execute.ts`.
 */

/**
 * The two render-path diagnostics that mean "the provider did not receive what
 * this cell compiled". Spelled here so the watches in
 * {@link executeOneTrialCell} cannot drift from the codes the transport emits.
 *
 * - `image_model.references_trimmed` — a reference was dropped against
 *   `runRegistryImageModel`'s `data_url` inline-byte budget.
 * - `image_model.reserved_field_ignored` — a control field collided with one the
 *   render path owns and was discarded by `overlayControlInput`. The compile step
 *   filters those out beforehand, so reaching this means the two disagreed —
 *   which is exactly when a cell must not be trusted.
 */
const REFERENCES_TRIMMED_DIAGNOSTIC = "image_model.references_trimmed";
const RESERVED_FIELD_IGNORED_DIAGNOSTIC = "image_model.reserved_field_ignored";

/**
 * Exactly what the profile compiled, handed to the renderer.
 *
 * This seam is the PROOF SURFACE for "the trial renders the profile it says it
 * renders": an integration test captures this object and compares it against the
 * cell's stored `resolvedControls`. Anything the provider receives that is not
 * visible here is something the harness cannot prove it sent — which is why the
 * dimension inputs travel too: the transport wrapper negotiates the aspect/size
 * key from `targetRatio` and `dimensionFacts`, so a size a tier profile asks
 * for must be stated here or the seam would hide part of the payload.
 */
export interface TrialCellRenderInput {
  /** The EFFECTIVE model — post reviewed-quality seam, as the provider sees it. */
  model: ImageModel;
  /** The final compiled text, role preamble included. Hashed as `positivePromptHash`. */
  prompt: string;
  references: Buffer[];
  /**
   * The shape a trial cell renders: Vesper's 3:4, stated explicitly rather than
   * left to `renderWithModel`'s default so the captured input names it.
   */
  targetRatio: number;
  /**
   * The recompiled plan's dimension-resolver inputs — the merged tier and pair
   * a size-mode model's shape negotiation consumes. Without them a tier
   * profile's trial rendered the model's default size while production sent
   * the tier's, and the two were not the same experiment.
   */
  dimensionFacts: ImageRenderDimensionFacts;
  /** Mapped controls plus validated overrides, keyed by real provider fields. */
  controlInput: Record<string, unknown>;
  /**
   * The resolved prediction budget — a NUMBER, always. A trial cell never leaves
   * its deadline to `REPLICATE_PREDICTION_TIMEOUT_MS`: an env-resolved budget is
   * one the cell cannot record, cannot hash, and cannot bound, and the
   * stale-claim window above is sized against this being a real ceiling.
   */
  timeoutMs: number;
  /** The pinned provider version this cell must execute. */
  versionId: string | null;
}

export type TrialCellRenderer = (
  input: TrialCellRenderInput,
  sink?: DiagnosticSink,
) => Promise<RenderWithModelResult>;

/** Test-only override; `null` restores the real registry render. Process-local —
 * the `setIdentityFaceDetectorForTesting` seam shape, for the same reason:
 * integration tests must drive every outcome without a provider call. */
let injectedRenderer: TrialCellRenderer | null = null;

export function setTrialRendererForTesting(renderer: TrialCellRenderer | null): void {
  injectedRenderer = renderer;
}

/**
 * The real renderer maps the compiled plan straight onto `renderWithModel` —
 * field for field, no interpretation. That is deliberate: the moment this seam
 * starts deciding anything, the captured input stops being evidence of what the
 * provider was sent.
 */
export function trialRenderer(): TrialCellRenderer {
  return (
    injectedRenderer ??
    ((input, sink) =>
      renderWithModel(
        {
          model: input.model,
          prompt: input.prompt,
          references: input.references,
          targetRatio: input.targetRatio,
          dimensionFacts: input.dimensionFacts,
          controlInput: input.controlInput,
          timeoutMs: input.timeoutMs,
          versionId: input.versionId,
        },
        sink,
      ))
  );
}

type ClaimedTrialSpecRead =
  | { ok: true; spec: ImageIdentityPackTrialCellSpec }
  | { ok: false; code: ImageIdentityPackTrialRefusalCode; message: string };

/**
 * One claimed cell's spec, or the terminal refusal it earns.
 *
 * Two distinct corruptions, two codes, both TERMINAL and both FREE:
 *
 * - A spec that does not parse is `spec_invalid`. Nothing can say what this cell
 *   was supposed to render, and a cell nothing can describe cannot be executed
 *   honestly.
 * - A spec that parses but carries `resolvedControls: null` is `cell_conflict`.
 *   It was planned before anything could compile what it would send, so running
 *   it now would put an uncompiled cell in a grid of compiled ones — not a
 *   comparison, a confound.
 *
 * Settling rather than skipping is the point, and the reason this read happens
 * BEFORE the budget charge. A malformed cell left `planned` is re-picked by
 * every later pass forever, and each of those passes charged for it before ever
 * discovering it could not run. Now it is charged never and settles exactly once.
 */
function readClaimedTrialSpec(cell: IdentityPackTrialCellRow): ClaimedTrialSpecRead {
  const parsed = imageIdentityPackTrialCellSpecSchema.safeParse(cell.specJson);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .slice(0, 3)
      .map((issue) => `${issue.path.join(".") || "spec"}: ${issue.message}`)
      .join("; ");
    return {
      ok: false,
      code: "spec_invalid",
      message: `the cell's stored spec no longer satisfies the manifest contract (${detail})`.slice(0, 500),
    };
  }
  if (parsed.data.resolvedControls === null) {
    return {
      ok: false,
      code: "cell_conflict",
      message: "the cell was planned before its controls were compiled, so nothing can say what it would send",
    };
  }
  return { ok: true, spec: parsed.data };
}

/**
 * One claimed cell's spec AND whether anything it names still exists — the whole
 * pre-charge judgment, in the one shape the loop settles on.
 *
 * The composition matters more than either half. `readClaimedTrialSpec` catches
 * a spec nothing can read; {@link unreachableClaimedTrialCell} catches a spec
 * that reads perfectly and names a fixture, model or profile that is gone. Both
 * are cells no provider will ever see, and both used to be discovered AFTER the
 * budget charge — so a run whose profile an admin deleted paid a unit per cell
 * per pass to keep rediscovering it.
 */
export function readRunnableTrialSpec(cell: IdentityPackTrialCellRow, context: ExecuteCellContext): ClaimedTrialSpecRead {
  const read = readClaimedTrialSpec(cell);
  if (!read.ok) return read;
  const unreachable = unreachableClaimedTrialCell(read.spec, context);
  return unreachable === null ? read : { ok: false, ...unreachable };
}

/**
 * Why this cell could never reach a provider, or null when it can.
 *
 * The three lookups are exactly the ones {@link executeOneTrialCell} performs
 * after the charge, asked here against the SAME maps that pass already loaded.
 * The post-charge copies stay — a registry row can be deleted between these two
 * moments, and the executor must still refuse rather than dereference nothing —
 * so this is a cheaper first answer to the same question, never a replacement
 * for it. The codes and messages match their post-charge counterparts on
 * purpose: an operator reading a refused cell should not be able to tell which
 * of the two noticed.
 */
function unreachableClaimedTrialCell(
  spec: ImageIdentityPackTrialCellSpec,
  context: ExecuteCellContext,
): { code: ImageIdentityPackTrialRefusalCode; message: string } | null {
  if (!trialPromptFixtureById(spec.promptFixtureId)) {
    return { code: "fixture_unknown", message: "the cell's prompt fixture is no longer checked in" };
  }
  if (!context.modelsBySlug.has(spec.modelSlug) || !context.profilesById.has(spec.profileId)) {
    return { code: "cell_conflict", message: "the pinned model or profile is no longer registered" };
  }
  return null;
}

export interface ExecuteCellContext {
  runId: string;
  ownerId: string;
  /** This pass's claim; every settle compares against it. */
  claimToken: string;
  modelsBySlug: Map<string, ImageModel>;
  profilesById: Map<string, ImageModelProfile>;
  render: TrialCellRenderer;
  sink: DiagnosticSink | undefined;
}

/**
 * Where a cell records the output it has already stored, so the containment
 * catch can settle WITH it.
 *
 * A mutable holder rather than a return value because the point is to survive a
 * THROW: `executeOneTrialCell` writes `imageId` the moment `saveImageBuffer`
 * reports ready, and anything that throws after that — a failing settle, a bug
 * in the audit checks — leaves the id readable to the catch below. Without it a
 * throw between store and settle produced a `ready`, owner-scoped, hidden image
 * that no cell pointed at, which means the run's delete sweep (it walks cell
 * pointers) could never find it and nothing in the app could either.
 */
interface StoredTrialOutput {
  imageId: string | null;
}

/**
 * One cell with its exceptions contained. A throw out of
 * {@link executeOneTrialCell} — a DB error storing the output, a bug — may land
 * AFTER provider spend, and letting it abort the batch would 500 the route and
 * leave the cell `planned`, so the next execute would re-render it: double
 * provider spend for one cell's evidence. Instead the thrown cell settles
 * `failed` through the same claim CAS every other settle uses, CARRYING whatever
 * output was already stored, and the batch continues.
 *
 * Settling with the stored id is what keeps the bytes accounted for: the cell
 * owns them, the run's delete sweep reaches them, and an operator can look at
 * the image a failed cell paid for. `failed` cells never pair, so an image that
 * arrived through a broken path still cannot enter the comparison grid.
 *
 * Only a failure of that settle itself stops the pass (`null`) — at that point
 * nothing can be recorded, and continuing would repeat the same write failure
 * cell after cell. The caller returns this pass's UNREACHED claims to the grid;
 * this cell's own claim stays `running` and waits out stale recovery, because
 * writing more rows to a database that just refused a write is not a recovery
 * plan.
 */
export async function executeTrialCellContained(
  cell: IdentityPackTrialCellRow,
  spec: ImageIdentityPackTrialCellSpec,
  context: ExecuteCellContext,
): Promise<ExecutedTrialCell["status"] | null> {
  const stored: StoredTrialOutput = { imageId: null };
  try {
    return await executeOneTrialCell(cell, spec, context, stored);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    context.sink?.push(
      diag("warn", "images.identity_pack.trial.cell_degraded", "cell execution threw; settling the cell failed", {
        context: {
          runId: context.runId,
          cellId: cell.id,
          cellKey: cell.cellKey,
          outputImageId: stored.imageId,
          error: message.slice(0, 300),
        },
      }),
    );
    try {
      return await settleTrialCell(
        cell,
        context,
        "failed",
        trialResult({
          outputImageId: stored.imageId,
          failureCode: "other",
          failureMessage: message.slice(0, 2000),
        }),
        stored.imageId,
      );
    } catch {
      context.sink?.push(
        diag("error", "images.identity_pack.trial.cell_degraded", "could not settle a thrown cell; stopping this pass", {
          context: { runId: context.runId, cellId: cell.id, cellKey: cell.cellKey, outputImageId: stored.imageId },
        }),
      );
      return null;
    }
  }
}

/**
 * Settle one cell with a compare-and-set against THIS PASS'S CLAIM — the row
 * must still be `running` under the same token — so a writer that took the cell
 * over (a stale-claim recovery elsewhere, a second machine) loses cleanly rather
 * than overwriting an outcome that already exists.
 *
 * The claim columns are deliberately LEFT ON the terminal row. They are the
 * audit trail of which pass settled it and when the render started; clearing
 * them would erase the only evidence tying a stored output to the pass that paid
 * for it.
 *
 * When the CAS finds nothing, any output this settle was carrying is ORPHANED —
 * the cell's pointer was never written, so nothing in the app references those
 * bytes again and the run's delete sweep (which walks cell pointers) would never
 * find them. It is deleted here, immediately, guarded by owner and kind.
 */
async function settleTrialCell(
  cell: IdentityPackTrialCellRow,
  context: ExecuteCellContext,
  status: Extract<TrialCellStatus, "rendered" | "failed" | "refused">,
  result: ImageIdentityPackTrialResult,
  outputImageId: string | null,
): Promise<Extract<TrialCellStatus, "rendered" | "failed" | "refused"> | "skipped"> {
  const updated = await db()
    .update(imageIdentityPackTrialCells)
    .set({ status, resultJson: result, outputImageId })
    .where(
      and(
        eq(imageIdentityPackTrialCells.id, cell.id),
        eq(imageIdentityPackTrialCells.status, "running"),
        eq(imageIdentityPackTrialCells.claimToken, context.claimToken),
      ),
    )
    .returning({ id: imageIdentityPackTrialCells.id });
  if (updated.length === 0) {
    context.sink?.push(
      diag("warn", "images.identity_pack.trial.cell_degraded", "another writer took this cell's claim first", {
        context: { runId: context.runId, cellId: cell.id, cellKey: cell.cellKey },
      }),
    );
    await discardOrphanedTrialOutput(outputImageId, context, cell);
    return "skipped";
  }
  return status;
}

/**
 * Remove a stored output whose settle lost the claim race.
 *
 * One helper rather than a check at each settle site: several post-render paths
 * carry an output image, and a cleanup written once per site is a cleanup that
 * eventually exists at only some of them.
 *
 * Best-effort, and the cost of "best" failing is worth stating plainly: nothing
 * reconciles a leftover. A `ready` `identity_trial_output` whose delete failed
 * is a hidden row no cell points at, so the run's delete sweep (which walks cell
 * pointers) will never reach it and the Gallery cannot show it — it survives
 * until the CHARACTER is deleted and the owner-scoped image cascade takes it.
 * That is a small, bounded leak; throwing here instead would turn a lost claim
 * race into a failed pass, which is worse and far more likely.
 */
async function discardOrphanedTrialOutput(
  outputImageId: string | null,
  context: ExecuteCellContext,
  cell: IdentityPackTrialCellRow,
): Promise<void> {
  if (outputImageId === null) return;
  const removed = await deleteOwnedImage(outputImageId, context.ownerId, { kind: "identity_trial_output" }).catch(
    () => false,
  );
  context.sink?.push(
    diag("warn", "images.identity_pack.trial.output_orphaned", "discarded a trial output whose cell was taken over", {
      context: { runId: context.runId, cellId: cell.id, cellKey: cell.cellKey, outputImageId, removed },
    }),
  );
}

export function refuseTrialCell(
  cell: IdentityPackTrialCellRow,
  context: ExecuteCellContext,
  code: ImageIdentityPackTrialRefusalCode,
  message: string,
): Promise<Extract<TrialCellStatus, "rendered" | "failed" | "refused"> | "skipped"> {
  refusal(code, message, context.sink, { runId: context.runId, cellId: cell.id, cellKey: cell.cellKey });
  return settleTrialCell(
    cell,
    context,
    "refused",
    trialResult({ failureCode: code, failureMessage: message.slice(0, 2000) }),
    null,
  );
}

async function readOwnedImageBytes(imageId: string, ownerId: string): Promise<Buffer | null> {
  const [row] = await db()
    .select()
    .from(images)
    .where(and(eq(images.id, imageId), eq(images.ownerId, ownerId)))
    .limit(1);
  if (!row || row.status !== "ready") return null;
  return readImageBytes(row);
}

/** An images-row meta number, or null — never a fabricated dimension. */
function metaDimension(meta: Record<string, unknown>, key: string): number | null {
  const value = meta[key];
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : null;
}

type ResolvedTrialCellPack = { ok: true; pack: ImageIdentityPackV1 | null } | { ok: false; message: string };

/** Whether a pack IS the one this cell pinned — identity, revision, and the
 * bytes it was derived from, all three. */
function packMatchesTrialCell(pack: ImageIdentityPackV1, spec: ImageIdentityPackTrialCellSpec): boolean {
  return (
    pack.id === spec.packId &&
    pack.revision === spec.packRevision &&
    pack.source.contentHash === spec.sourceContentHash
  );
}

/**
 * The pack this cell renders from, by the variant its spec names.
 *
 * The three arms are genuinely different reads, and collapsing them would be a
 * correctness bug rather than a tidy-up:
 *
 * - `none` — the no-pack baseline. No pack work at all, no references.
 * - `current` — ensure the character's pack and check it has not moved. This arm
 *   MAY derive a fresh revision (that is what `ensureIdentityPack` does), which
 *   is precisely why the check that follows exists.
 * - `rev:…` — a PINNED historical revision, read strictly read-only. This arm
 *   must never call `ensureIdentityPack`: a pinned-revision cell that quietly
 *   re-derived, or silently fell back to the current pack, would render a
 *   different comparison under the name of the one that was planned — which is
 *   the exact corruption the pack-variant axis exists to measure and must not
 *   itself commit. A swept revision is a refusal, not a fallback.
 */
async function resolveTrialCellPack(
  spec: ImageIdentityPackTrialCellSpec,
  context: ExecuteCellContext,
): Promise<ResolvedTrialCellPack> {
  const { ownerId, sink } = context;
  if (spec.referenceSource === "none") return { ok: true, pack: null };

  if (spec.packVariantKey === "current") {
    const ensured = await ensureIdentityPack({ ownerId, characterId: spec.characterId, purpose: "admin_trial", sink });
    if (ensured.status !== "ready" || !packMatchesTrialCell(ensured.pack, spec)) {
      return { ok: false, message: "the identity pack moved since this cell was planned" };
    }
    return { ok: true, pack: ensured.pack };
  }

  if (spec.packVariantKey.startsWith("rev:")) {
    if (spec.packRevision === null) return { ok: false, message: "the pinned-revision cell names no revision" };
    const pinned = await getIdentityPackRevisionForTrial({
      ownerId,
      characterId: spec.characterId,
      revision: spec.packRevision,
      sink,
    });
    if (!pinned.ok) return { ok: false, message: `the pinned pack revision is unavailable (${pinned.code})` };
    if (!packMatchesTrialCell(pinned.pack, spec)) {
      return { ok: false, message: "the pinned pack revision no longer matches the identity this cell recorded" };
    }
    return { ok: true, pack: pinned.pack };
  }

  return { ok: false, message: `the cell names a pack variant this build cannot resolve (${spec.packVariantKey})` };
}

/**
 * One cell, end to end: re-verify the pinned world (provider version, compiled
 * prompt, compiled negative, resolved controls, and the pack identity behind its
 * variant), read the reference bytes in role order, render through the seam, and
 * store the output through the normal row-before-file pipeline as a hidden
 * `identity_trial_output`.
 *
 * Anything that moved since planning is `cell_conflict`: the cell describes a
 * comparison that can no longer be run AS PLANNED, and running some other
 * comparison under its name would poison the whole grid's evidence.
 *
 * Anything the PROVIDER did differently from what was compiled is `failed` with
 * the output kept ({@link postRenderAuditFailure}): a trimmed reference, a
 * discarded control field, a version that is not the pinned one. The image is
 * real and auditable, and a failed cell never pairs, so it cannot enter the
 * comparison grid it does not belong in.
 *
 * The spec arrives already parsed. The pass parsed it once at the claim boundary
 * — a cell whose spec does not parse never reaches here, it settles terminally
 * and free — so there is no second interpretation of the same JSON to drift.
 *
 * `stored` is the containment wrapper's holder: the output id is written into it
 * the instant the bytes land, so a throw anywhere after that still settles a
 * cell that OWNS its image rather than orphaning it (see
 * {@link executeTrialCellContained}).
 */
async function executeOneTrialCell(
  cell: IdentityPackTrialCellRow,
  spec: ImageIdentityPackTrialCellSpec,
  context: ExecuteCellContext,
  stored: StoredTrialOutput,
): Promise<ExecutedTrialCell["status"]> {
  const { ownerId, runId, sink } = context;

  const fixture = trialPromptFixtureById(spec.promptFixtureId);
  if (!fixture) return refuseTrialCell(cell, context, "fixture_unknown", "the cell's prompt fixture is no longer checked in");

  const model = context.modelsBySlug.get(spec.modelSlug);
  const profile = context.profilesById.get(spec.profileId);
  if (!model || !profile) {
    return refuseTrialCell(cell, context, "cell_conflict", "the pinned model or profile is no longer registered");
  }

  // The version is checked BEFORE anything is compiled: a model whose pin moved
  // or vanished cannot execute this cell at all, and saying "the controls
  // changed" about a version bump would send an operator looking in the wrong place.
  const modelVersion = pinnedImageModelVersion(model);
  if (modelVersion === null || modelVersion !== spec.modelVersion) {
    return refuseTrialCell(cell, context, "cell_conflict", "the pinned provider version moved or vanished");
  }

  // Recompile from the rows in force NOW, with the SAME compiler planning used,
  // and compare all three fingerprints. Between them they cover fixture text
  // drift, role-wording drift (the preamble is part of the prompt), a changed
  // negative, and any registry or profile edit that would change what is sent.
  // A cell pinned a configuration; running a different one under its name
  // poisons the grid's evidence, so every difference is a conflict.
  const recompiled = compileProfileRenderPlan({
    model,
    profile,
    basePrompt: fixture.prompt,
    baseNegativePrompt: fixture.negativePrompt,
    safetyCheckerDisabled: disableSafetyChecker(),
    references: { vocabulary: "identity_pack", roles: spec.orderedReferenceRoles },
  });
  if (!recompiled.ok) {
    // Planning refuses an unexecutable prompt strategy outright, so a cell that
    // reaches execution and meets one did not come from a planner that allowed
    // it — the PROFILE ROW moved under the cell (its strategy was edited after
    // the grid was planned). That is a conflict, not an ineligibility: the cell
    // pinned a comparison whose configuration no longer exists.
    return refuseTrialCell(
      cell,
      context,
      "cell_conflict",
      `the profile's prompt strategy changed to ${recompiled.promptStrategy}, which the identity trial cannot execute`,
    );
  }
  const plan = recompiled.plan;
  const compiled = trialCellCompiledIdentity(plan, profile, spec.orderedReferenceRoles);
  if (compiled.positivePromptHash !== spec.positivePromptHash) {
    return refuseTrialCell(cell, context, "cell_conflict", "the compiled prompt text changed since planning");
  }
  if (compiled.negativePromptHash !== spec.negativePromptHash) {
    return refuseTrialCell(cell, context, "cell_conflict", "the compiled negative prompt changed since planning");
  }
  if (compiled.resolvedControlsHash !== spec.resolvedControlsHash) {
    return refuseTrialCell(cell, context, "cell_conflict", "the resolved model/profile controls changed since planning");
  }

  const resolvedPack = await resolveTrialCellPack(spec, context);
  if (!resolvedPack.ok) return refuseTrialCell(cell, context, "cell_conflict", resolvedPack.message);
  const pack = resolvedPack.pack;

  // A null pack is the no-pack baseline, whose contract forbids reference roles
  // outright — so this loop simply does not run for it, and no reference is
  // ever read from a pack that is not there.
  const references: Buffer[] = [];
  if (pack !== null) {
    for (const role of spec.orderedReferenceRoles) {
      const imageId = role === "canonical_identity" ? pack.source.imageId : pack.faceDetail.imageId;
      const buffer = imageId === null ? null : await readOwnedImageBytes(imageId, ownerId);
      if (!buffer) return refuseTrialCell(cell, context, "cell_conflict", `the ${role} reference bytes are unreadable`);
      references.push(buffer);
    }
  }

  // Everything above this line is a read; everything below it costs money. The
  // claim was re-asserted at this cell's queue boundary
  // ({@link beatTrialQueueClaims}) and the pass would not have reached here
  // without holding it, so a race lost before now cost ZERO provider calls. Only
  // the bounded reads between that boundary and this point — the pack resolution
  // and the reference bytes — sit inside the gap, which is what the stale
  // window's margin exists to cover.

  // Tee the renderer's diagnostics through a local collector: the plan-time
  // capacity check makes `fitReferences` a no-op here, but the `data_url`
  // transport can still drop a reference against its inline byte budget
  // (`withinDataUrlBudget`), and the control overlay can still refuse a field
  // that collided with one the render path owns. Both surface ONLY as warn
  // diagnostics — a cell rendered from fewer references, or fewer controls, than
  // its spec names is not the comparison the grid claims, so they have to be
  // observed, not assumed.
  const renderDiagnostics = new DiagnosticCollector();
  const startedMs = Date.now();
  const rendered = await context.render(
    {
      // The EFFECTIVE model and the COMPILED prompt: what crosses this seam is
      // exactly what the profile compiled and exactly what the hashes cover.
      model: plan.effectiveModel,
      prompt: plan.finalPrompt,
      references,
      // The trial's one shape, and the plan's dimension inputs — so a size-mode
      // tier profile trial-renders the same size production sends.
      targetRatio: IMAGE_TARGET_ASPECT,
      dimensionFacts: plan.dimensionFacts,
      controlInput: plan.controlInput,
      timeoutMs: plan.timeoutMs,
      versionId: plan.versionId,
    },
    sink ? teeSink(sink, renderDiagnostics) : renderDiagnostics,
  );
  const latencyMs = Date.now() - startedMs;
  // The provider's own handles on this attempt, recorded on every outcome below.
  // `providerVersionId` is what Replicate says it RAN, as against `modelVersion`,
  // which is what the cell asked for; null means it echoed nothing, never "it
  // matched". Whatever it says is recorded VERBATIM — including the literal
  // `"hidden"` an official model answers — because the record's job is to
  // preserve what the provider said, not to interpret it. The interpreting
  // happens once, in `postRenderAuditFailure`.
  //
  // `moderationOutcome` and `postCrop` stay null throughout: the Replicate
  // adapter exposes neither a moderation verdict nor a post-download crop
  // rectangle, and a fabricated value in a provenance field is worse than an
  // honest absence.
  const provenance = {
    providerPredictionId: rendered.predictionId ?? null,
    providerVersionId: rendered.executedVersionId ?? null,
  };

  if (!rendered.ok || !rendered.image) {
    const message = rendered.error ?? `${model.slug} returned no image`;
    sink?.push(
      diag("warn", imageIdentityPackTrialDiagnosticCode("provider_failed"), message.slice(0, 300), {
        context: { runId, cellId: cell.id, cellKey: cell.cellKey, ...provenance },
      }),
    );
    return settleTrialCell(
      cell,
      context,
      "failed",
      trialResult({
        ...provenance,
        failureCode: classifyImageFailure(message),
        failureMessage: message.slice(0, 2000),
        latencyMs,
      }),
      null,
    );
  }

  const asset = await createImageAsset({
    ownerId,
    kind: "identity_trial_output",
    entityKind: "character",
    entityId: spec.characterId,
    // Null only on the no-pack baseline, which has no source to record; the
    // provenance column is optional, so absent is the honest value there.
    sourceImageId: spec.sourceImageId ?? undefined,
    prompt: plan.finalPrompt,
    meta: { hidden: true, trialRunId: runId, trialCellId: cell.id, cellKey: cell.cellKey },
  });
  const saved = await saveImageBuffer(asset.id, rendered.image, sink);
  if (saved?.status !== "ready") {
    // The pending row is removed rather than left `failed`: nothing references
    // it (the cell's pointer is only ever set on success), so a straggler here
    // would outlive even the run's delete sweep.
    await deleteOwnedImage(asset.id, ownerId, { kind: "identity_trial_output" });
    const message = "trial output could not be written";
    return settleTrialCell(
      cell,
      context,
      "failed",
      trialResult({
        ...provenance,
        failureCode: classifyImageFailure(message),
        failureMessage: message,
        latencyMs,
      }),
      null,
    );
  }
  // The bytes exist and this cell owns them, from HERE — before any step that
  // could throw. If one does, the containment catch settles the cell carrying
  // this id, so the image stays owned, auditable and reachable by the run's
  // delete sweep instead of becoming a hidden row nothing points at.
  stored.imageId = saved.id;

  const meta = imageMeta(saved.meta);
  const measured = {
    ...provenance,
    outputImageId: saved.id,
    latencyMs,
    finalWidthPx: metaDimension(meta, "width"),
    finalHeightPx: metaDimension(meta, "height"),
  };

  // A render the provider did not make as compiled is a FAILED cell that KEEPS
  // its output: the image exists and is auditable (why did the provider get
  // fewer references? which version actually ran?), but it is not the comparison
  // the grid claims, and failed cells never pair.
  const audit = postRenderAuditFailure(spec, renderDiagnostics, provenance.providerVersionId);
  if (audit !== null) {
    return settleTrialCell(
      cell,
      context,
      "failed",
      trialResult({ ...measured, failureCode: audit.code, failureMessage: audit.message.slice(0, 2000) }),
      saved.id,
    );
  }

  return settleTrialCell(cell, context, "rendered", trialResult(measured), saved.id);
}

/**
 * Why a produced image is not the evidence this cell promised, or null when it
 * is.
 *
 * Three different ways a render can succeed and still be worthless as a
 * comparison, all discovered only AFTER the provider answered — which is why
 * each one keeps the image (it was paid for, and an operator investigating
 * needs to see it) and settles the cell `failed` rather than `rendered`:
 *
 * - `references_trimmed` — the `data_url` transport dropped a reference against
 *   its inline byte budget, so the render used fewer references than its spec
 *   names.
 * - `controls_trimmed` — the transport refused a control field for colliding
 *   with one the render path owns. `compileProfileRenderPlan` filters those
 *   before they enter the payload, so reaching this means the compile step and
 *   the transport disagree about what is reserved; a cell whose controls were
 *   silently narrowed in transit is not the configuration the hash records.
 * - `version_mismatch` — Replicate echoed a version that is not the pinned one.
 *   The whole reason a trial pins a version is that "whatever ran that hour" is
 *   not a controlled comparison; an echo that disagrees says plainly that
 *   something else ran. A MISSING echo is not a mismatch — the provider simply
 *   did not say, and refusing on silence would fail every cell against a model
 *   endpoint that omits the field. Neither is an UNDISCLOSED echo (`"hidden"`,
 *   what Replicate answers for an official model, which publishes no versions
 *   list at all): that names no version to disagree with, and the cell's
 *   evidence identity is the requested pin, which Replicate validated at create
 *   time — an unresolvable version is refused `422` before any spend, so the
 *   accepted prediction is itself proof the pin resolved. Both readings live in
 *   `providerVersionsDisagree` so the lab screen and this audit cannot drift.
 */
function postRenderAuditFailure(
  spec: ImageIdentityPackTrialCellSpec,
  renderDiagnostics: DiagnosticCollector,
  providerVersionId: string | null,
): { code: string; message: string } | null {
  const trimmed = renderDiagnostics.items.find((entry) => entry.code === REFERENCES_TRIMMED_DIAGNOSTIC);
  if (trimmed) {
    return {
      code: "references_trimmed",
      message:
        `a planned reference was dropped in transport (${trimmed.code}): ` +
        `planned roles ${spec.orderedReferenceRoles.join(", ")} — ${trimmed.message}`,
    };
  }
  const narrowed = renderDiagnostics.items.find((entry) => entry.code === RESERVED_FIELD_IGNORED_DIAGNOSTIC);
  if (narrowed) {
    return {
      code: "controls_trimmed",
      message: `a compiled control field was refused in transport (${narrowed.code}): ${narrowed.message}`,
    };
  }
  if (providerVersionsDisagree(spec.modelVersion, providerVersionId)) {
    return {
      code: "version_mismatch",
      message: `the provider ran version ${providerVersionId ?? "?"}, not the pinned ${spec.modelVersion}`,
    };
  }
  return null;
}
