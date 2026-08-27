import { z } from "zod";
import { fnv1aHex } from "@/lib/hash";
import { parseOr, parseOrNull } from "@/lib/parse";
import {
  activeLocatedFacts,
  appearanceFeatureKindRegistry,
  bodyLocusKey,
  bodyLocusRefSchema,
  validateBodyLocusRef,
  type BodyLocusRef,
  type LocatedAppearanceFact,
} from "../appearance-features";
import { attributeRegistry, resolveAttributes, type AttributeValue } from "../attributes";
import { unitIntervalSchema, type UnitInterval } from "../affordances/core";
import { diag, type DiagnosticSink } from "../diagnostics";
import {
  VISUAL_STATE_EXTRACTION_CONFLICT,
  VISUAL_STATE_EXTRACTION_OWNER_UNAVAILABLE,
  VISUAL_STATE_EXTRACTION_PROPOSAL_INVALID,
} from "./diagnostics";
import { visualStateFingerprint } from "./feature";
import { visualStateLocusKey } from "./locus";
import {
  presentationAspect,
  presentationOwnedKindIds,
  type CharacterPresentationState,
} from "./presentation";
import { visualStateKindRegistry } from "./registry";

/**
 * Reference-image extraction.
 *
 * A canonical image may PROPOSE structured identity and presentation facts; it
 * may never write them. This module owns the pure half of that workflow:
 *
 * - the untrusted proposal boundary (an extractor's output is model output,
 *   parsed per item exactly like a model's presentation proposal);
 * - slot identity, so "the same claim" survives an extractor upgrade;
 * - diffing a proposal against the canonical owners' current truth;
 * - carrying a human ruling forward when a re-run repeats the same claim, and
 *   surfacing a CONFLICT — never an overwrite — when it does not;
 * - the review-state transitions a human decision moves through;
 * - the apply plan an ACCEPTED proposal turns into, phrased as the target
 *   owner's own write vocabulary.
 *
 * Persistence, routes and the actual owner writes are server code
 * (`server/reference-extraction`); nothing in this file performs IO, and no
 * function here mutates a canonical owner's state. That is the plan's success
 * criterion ("Reference extraction cannot overwrite canonical truth without
 * review") held structurally: the only thing this module can produce is data a
 * reviewed server path may choose to act on.
 */

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** The canonical owners a proposal may target. */
export const visualExtractionTargetOwners = ["attribute", "located_fact", "presentation"] as const;
export const visualExtractionTargetOwnerSchema = z.enum(visualExtractionTargetOwners);
export type VisualExtractionTargetOwner = (typeof visualExtractionTargetOwners)[number];

/** An extraction run: open for review, or replaced by a newer run over the same source. */
export const visualExtractionRunStatuses = ["open", "superseded"] as const;
export type VisualExtractionRunStatus = (typeof visualExtractionRunStatuses)[number];

/**
 * One proposal's review lifecycle. `applied` is TERMINAL and reachable only
 * from `accepted` — application is a system act through the owner's write path,
 * distinct from the human ruling. `superseded` is terminal and reachable only
 * from `pending`: a decided proposal is a recorded human ruling and a newer run
 * never erases one.
 */
export const visualExtractionProposalStatuses = [
  "pending",
  "accepted",
  "rejected",
  "applied",
  "superseded",
] as const;
export type VisualExtractionProposalStatus = (typeof visualExtractionProposalStatuses)[number];

/** The two human review actions. Application is not an action; it follows acceptance. */
export const visualExtractionReviewActions = ["accept", "reject"] as const;
export type VisualExtractionReviewAction = (typeof visualExtractionReviewActions)[number];

/** Most proposals one run may carry; the boundary reports and drops the excess. */
export const VISUAL_EXTRACTION_MAX_PROPOSALS = 64;

/** `sourceId` prefix an applied attribute carries, so provenance survives in the profile row. */
export const VISUAL_EXTRACTION_SOURCE_ID_PREFIX = "reference_extraction";

/**
 * Where the evidence sat in the source image: a normalized rectangle in
 * fixed-point unit-interval coordinates (0…10 000 of the image's width and
 * height). EVIDENCE ONLY — it feeds a review UI's highlight and nothing else;
 * no consumer derives truth from a rectangle.
 */
export const visualExtractionImageRegionSchema = z.object({
  left: unitIntervalSchema,
  top: unitIntervalSchema,
  width: unitIntervalSchema,
  height: unitIntervalSchema,
});
export type VisualExtractionImageRegion = z.infer<typeof visualExtractionImageRegionSchema>;

// ---------------------------------------------------------------------------
// The proposal boundary
// ---------------------------------------------------------------------------

/**
 * The wire shape of one proposal, with `locus` deliberately added: a located
 * fact cannot be located and a presentation entry cannot be placed without one,
 * so located-fact and presentation proposals REQUIRE a body locus and attribute
 * proposals must NOT carry one — an attribute is body-wide by its own contract,
 * and a locus on one would smuggle a located claim under the wrong owner.
 */
export const visualContractProposalSchema = z.object({
  targetOwner: visualExtractionTargetOwnerSchema,
  kindId: z.string().trim().min(1).max(120),
  locus: bodyLocusRefSchema.optional(),
  value: z.unknown(),
  confidence: unitIntervalSchema,
  evidenceRegion: visualExtractionImageRegionSchema.optional(),
});
export type VisualContractProposal = z.infer<typeof visualContractProposalSchema>;

/** The spec's stored extraction record: one run's provenance plus its proposals. */
export interface VisualContractExtraction {
  readonly sourceImageId: string;
  readonly sourceHash: string;
  readonly extractorId: string;
  readonly extractorVersion: string;
  readonly createdAt: string;
  readonly proposals: readonly VisualContractProposal[];
}

/**
 * A proposal that survived the boundary: its value re-issued by the target
 * owner's own parser, its slot named, its fingerprint fixed.
 */
export interface VisualExtractionValidatedProposal {
  readonly targetOwner: VisualExtractionTargetOwner;
  readonly kindId: string;
  readonly locus?: BodyLocusRef;
  readonly value: unknown;
  readonly proposedFingerprint: string;
  readonly slotKey: string;
  readonly confidence: UnitInterval;
  readonly evidenceRegion?: VisualExtractionImageRegion;
}

function rejectProposal(
  sink: DiagnosticSink | undefined,
  path: string,
  message: string,
  context: Record<string, unknown>,
): null {
  sink?.push(diag("warn", VISUAL_STATE_EXTRACTION_PROPOSAL_INVALID, message, { path, context }));
  return null;
}

/**
 * A locus a proposal may write facts at: registry-valid AND un-coarsened. The
 * same rule the presentation owner and the feature contract apply — a healed
 * locus describes a different place than the extractor claimed, and a claim
 * about the wrong place is not evidence about the right one.
 */
function usableProposalLocus(
  locus: BodyLocusRef,
  sink: DiagnosticSink | undefined,
  path: string,
): boolean {
  const validation = validateBodyLocusRef(locus, sink, path);
  return validation.ok && !validation.coarsened;
}

/**
 * Validate one parsed proposal against its target owner's OWN vocabulary. This
 * is the rule that keeps the workflow honest: an extraction cannot introduce a
 * kind, a value shape, or a placement the canonical owner would itself refuse.
 */
function validateProposalTarget(
  proposal: VisualContractProposal,
  sink: DiagnosticSink | undefined,
  path: string,
): VisualExtractionValidatedProposal | null {
  const { targetOwner, kindId } = proposal;
  const context = { targetOwner, kindId };

  switch (targetOwner) {
    case "attribute": {
      const definition = attributeRegistry.byId(kindId);
      if (!definition) return rejectProposal(sink, path, `Unknown attribute ${kindId}`, context);
      // A reference image can testify about what a character LOOKS like and
      // nothing else. `sensory` attributes (scent, voice) are the registry's
      // non-visual tier — the same predicate every image prompt applies.
      if (definition.kind === "sensory") {
        return rejectProposal(sink, path, `${kindId} is non-visual; an image cannot testify about it`, context);
      }
      // Canonical extraction targets a CHARACTER's profile; an item- or
      // location-only attribute has no slot there to land in.
      if (!(definition.appliesToEntityKinds ?? ["character"]).includes("character")) {
        return rejectProposal(sink, path, `${kindId} does not apply to characters`, context);
      }
      if (proposal.locus !== undefined) {
        return rejectProposal(sink, path, "An attribute proposal is body-wide and may not carry a locus", context);
      }
      const parsed = attributeRegistry.parseValue(kindId, proposal.value);
      if (!parsed.ok) return rejectProposal(sink, path, parsed.issues.join("; "), context);
      return {
        targetOwner,
        kindId,
        value: parsed.value,
        proposedFingerprint: visualStateFingerprint(parsed.value),
        slotKey: visualExtractionSlotKey(targetOwner, kindId, undefined, parsed.value),
        confidence: proposal.confidence,
        ...(proposal.evidenceRegion === undefined ? {} : { evidenceRegion: proposal.evidenceRegion }),
      };
    }
    case "located_fact": {
      const definition = appearanceFeatureKindRegistry.byId(kindId);
      if (!definition) return rejectProposal(sink, path, `Unknown appearance feature kind ${kindId}`, context);
      if (proposal.locus === undefined) {
        return rejectProposal(sink, path, "A located-fact proposal requires a body locus", context);
      }
      if (!usableProposalLocus(proposal.locus, sink, path)) {
        return rejectProposal(sink, path, "Located-fact locus is not usable as written", context);
      }
      if (!appearanceFeatureKindRegistry.allowsBodyLocation(kindId, proposal.locus.bodyLocationId)) {
        return rejectProposal(sink, path, `${kindId} may not sit at ${proposal.locus.bodyLocationId}`, context);
      }
      const parsed = appearanceFeatureKindRegistry.parseValue(kindId, proposal.value);
      if (!parsed.ok) return rejectProposal(sink, path, parsed.issues.join("; "), context);
      return {
        targetOwner,
        kindId,
        locus: proposal.locus,
        value: parsed.value,
        proposedFingerprint: visualStateFingerprint(parsed.value),
        slotKey: visualExtractionSlotKey(targetOwner, kindId, proposal.locus, parsed.value),
        confidence: proposal.confidence,
        ...(proposal.evidenceRegion === undefined ? {} : { evidenceRegion: proposal.evidenceRegion }),
      };
    }
    case "presentation": {
      // The presentation owner's own ownership rule: a registered kind outside
      // its owned set (wardrobe.garment, say) is item-backed and not writable
      // here, exactly as the owner's reducer would refuse it.
      if (!(presentationOwnedKindIds as readonly string[]).includes(kindId)) {
        return rejectProposal(sink, path, `${kindId} is not a presentation-owned kind`, context);
      }
      if (proposal.locus === undefined) {
        return rejectProposal(sink, path, "A presentation proposal requires a body locus", context);
      }
      if (!usableProposalLocus(proposal.locus, sink, path)) {
        return rejectProposal(sink, path, "Presentation locus is not usable as written", context);
      }
      if (!visualStateKindRegistry.allowsLocus(kindId, "body")) {
        return rejectProposal(sink, path, `${kindId} may not sit at a body locus`, context);
      }
      const parsed = visualStateKindRegistry.parseValue(kindId, proposal.value);
      if (!parsed.ok) return rejectProposal(sink, path, parsed.issues.join("; "), context);
      return {
        targetOwner,
        kindId,
        locus: proposal.locus,
        value: parsed.value,
        proposedFingerprint: visualStateFingerprint(parsed.value),
        slotKey: visualExtractionSlotKey(targetOwner, kindId, proposal.locus, parsed.value),
        confidence: proposal.confidence,
        ...(proposal.evidenceRegion === undefined ? {} : { evidenceRegion: proposal.evidenceRegion }),
      };
    }
  }
}

/**
 * The trust boundary for an extractor's proposal list (docs/resilience.md §1).
 * Extractor output is model output: parsed PER ITEM so one malformed proposal
 * drops alone, capped with a report (the presentation-operation precedent —
 * a silently truncated submission would hide that part of what the extractor
 * claimed never reached review), and de-duplicated per slot so one run cannot
 * hold two live claims about one fact. Never throws.
 */
export function parseVisualContractProposals(
  raw: unknown,
  sink?: DiagnosticSink,
  path = "visual_state.extraction.proposal",
): readonly VisualExtractionValidatedProposal[] {
  const items = parseOr(z.array(z.unknown()), raw, [], sink, path);
  const bySlot = new Map<string, VisualExtractionValidatedProposal>();
  let kept = 0;
  for (const item of items) {
    // No sink on the inner parse: a per-item failure is reported once, in this
    // family's own vocabulary, rather than twice under two different codes.
    const shaped = parseOrNull(visualContractProposalSchema, item, undefined, path);
    if (shaped === null) {
      sink?.push(
        diag("warn", VISUAL_STATE_EXTRACTION_PROPOSAL_INVALID, "Proposal is not a usable record", { path }),
      );
      continue;
    }
    const validated = validateProposalTarget(shaped, sink, path);
    if (validated === null) continue;
    if (bySlot.has(validated.slotKey)) {
      rejectProposal(sink, path, "Run already carries a proposal for this slot; the first wins", {
        slotKey: validated.slotKey,
      });
      continue;
    }
    kept += 1;
    if (kept > VISUAL_EXTRACTION_MAX_PROPOSALS) continue;
    bySlot.set(validated.slotKey, validated);
  }
  if (kept > VISUAL_EXTRACTION_MAX_PROPOSALS) {
    sink?.push(
      diag(
        "warn",
        VISUAL_STATE_EXTRACTION_PROPOSAL_INVALID,
        `Run carried ${kept} proposals; only the first ${VISUAL_EXTRACTION_MAX_PROPOSALS} were kept`,
        { path, context: { received: kept, cap: VISUAL_EXTRACTION_MAX_PROPOSALS } },
      ),
    );
  }
  // Deterministic order: slot key, which is unique within the run by the map.
  return [...bySlot.values()].sort((left, right) =>
    left.slotKey < right.slotKey ? -1 : left.slotKey > right.slotKey ? 1 : 0,
  );
}

// ---------------------------------------------------------------------------
// Slot identity
// ---------------------------------------------------------------------------

/**
 * The identity of a CLAIM, stable across extractor versions and re-runs:
 * `<owner>/<placement>/<aspect>`. Two runs proposing about the same slot are
 * talking about the same fact, which is what carrying a ruling forward and
 * detecting a conflict both key on.
 *
 * The presentation aspect reuses the presentation owner's own discriminator
 * rule (`presentation.grooming:brows`), so a slot here and the entry it would
 * become can never disagree about which fact they name.
 */
export function visualExtractionSlotKey(
  targetOwner: VisualExtractionTargetOwner,
  kindId: string,
  locus: BodyLocusRef | undefined,
  value: unknown,
): string {
  switch (targetOwner) {
    case "attribute":
      return `attribute/${kindId}`;
    case "located_fact":
      return `located_fact/${locus === undefined ? "" : bodyLocusKey(locus)}/${kindId}`;
    case "presentation":
      return `presentation/${locus === undefined ? "" : bodyLocusKey(locus)}/${presentationAspect(kindId, value)}`;
  }
}

// ---------------------------------------------------------------------------
// Diffing against canonical truth
// ---------------------------------------------------------------------------

/**
 * The canonical owners' current state, loaded by the caller. Located facts and
 * presentation are included for the day their lanes persist canonical state;
 * today the server hands empty ones in, and the diff honestly reports every
 * such proposal as `new`.
 */
export interface VisualExtractionCanonicalTruth {
  readonly attributes: readonly AttributeValue[];
  readonly locatedFacts: readonly LocatedAppearanceFact[];
  readonly presentation: CharacterPresentationState;
  /** Story minutes the located-fact validity windows are judged at. */
  readonly atMinutes: number;
}

export const visualExtractionDiffVerdicts = ["new", "same", "different"] as const;
export type VisualExtractionDiffVerdict = (typeof visualExtractionDiffVerdicts)[number];

/**
 * One proposal against the canonical owner that would receive it. `current`
 * is a LIST because located facts are multi-instance by design: three scars on
 * one forearm are three current values for one slot.
 */
export interface VisualExtractionProposalDiff {
  readonly slotKey: string;
  readonly verdict: VisualExtractionDiffVerdict;
  readonly currentValues: readonly unknown[];
  readonly currentFingerprints: readonly string[];
  /** Digest of the canonical side — what an accept request must echo back. */
  readonly currentDigest: string;
  readonly proposedValue: unknown;
  readonly proposedFingerprint: string;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** The canonical values currently in the proposal's slot, sorted by fingerprint. */
function currentCanonicalSlotValues(
  truth: VisualExtractionCanonicalTruth,
  targetOwner: VisualExtractionTargetOwner,
  kindId: string,
  locus: BodyLocusRef | undefined,
  value: unknown,
): readonly unknown[] {
  switch (targetOwner) {
    case "attribute": {
      const effective = resolveAttributes(truth.attributes, []);
      const held = effective.find((attribute) => attribute.id === kindId);
      return held === undefined ? [] : [held.value];
    }
    case "located_fact": {
      if (locus === undefined) return [];
      const locusKey = bodyLocusKey(locus);
      return activeLocatedFacts(truth.locatedFacts, truth.atMinutes)
        .filter((fact) => fact.kindId === kindId && bodyLocusKey(fact.locus) === locusKey)
        .map((fact) => fact.value);
    }
    case "presentation": {
      if (locus === undefined) return [];
      const locusKey = visualStateLocusKey({ kind: "body", locus });
      const aspect = presentationAspect(kindId, value);
      return truth.presentation.entries
        .filter(
          (entry) =>
            visualStateLocusKey(entry.locus) === locusKey && presentationAspect(entry.kindId, entry.value) === aspect,
        )
        .map((entry) => entry.value);
    }
  }
}

const DIGEST_SEPARATOR = "";

/**
 * A fixed-width digest over the canonical side of one slot's diff. The accept
 * path requires the reviewer to echo it back, which is what makes "cannot
 * overwrite canonical truth without review" mechanical: an accept can only land
 * against the exact canonical state the reviewer was shown, and a canonical
 * edit between the look and the accept surfaces as a conflict instead of being
 * silently overwritten.
 */
export function visualExtractionCurrentDigest(currentFingerprints: readonly string[]): string {
  return fnv1aHex([...currentFingerprints].sort(compareStrings).join(DIGEST_SEPARATOR));
}

/**
 * Diff one proposal (with any manual edit already resolved into
 * `resolvedValue`) against canonical truth. PURE — reads truth, writes nothing.
 */
export function diffVisualExtractionProposal(
  truth: VisualExtractionCanonicalTruth,
  targetOwner: VisualExtractionTargetOwner,
  kindId: string,
  locus: BodyLocusRef | undefined,
  resolvedValue: unknown,
): VisualExtractionProposalDiff {
  const currentValues = [...currentCanonicalSlotValues(truth, targetOwner, kindId, locus, resolvedValue)].sort(
    (left, right) => compareStrings(visualStateFingerprint(left), visualStateFingerprint(right)),
  );
  const currentFingerprints = currentValues.map((held) => visualStateFingerprint(held));
  const proposedFingerprint = visualStateFingerprint(resolvedValue);
  const verdict: VisualExtractionDiffVerdict =
    currentFingerprints.length === 0
      ? "new"
      : currentFingerprints.includes(proposedFingerprint)
        ? "same"
        : "different";
  return {
    slotKey: visualExtractionSlotKey(targetOwner, kindId, locus, resolvedValue),
    verdict,
    currentValues,
    currentFingerprints,
    currentDigest: visualExtractionCurrentDigest(currentFingerprints),
    proposedValue: resolvedValue,
    proposedFingerprint,
  };
}

// ---------------------------------------------------------------------------
// Carrying rulings forward, and conflicts
// ---------------------------------------------------------------------------

/** A prior HUMAN ruling on a slot — what a re-run must preserve. */
export interface VisualExtractionPriorDecision {
  readonly proposalId: string;
  readonly slotKey: string;
  readonly status: Extract<VisualExtractionProposalStatus, "accepted" | "rejected" | "applied">;
  /** Fingerprint of the MACHINE's proposal the ruling answered. */
  readonly proposedFingerprint: string;
  /** The reviewer's manual edit, when the acceptance carried one. */
  readonly editedValue?: unknown;
}

/**
 * What registration does with one incoming proposal, given the slot's history.
 */
export type VisualExtractionDisposition =
  | { readonly kind: "fresh" }
  | {
      readonly kind: "carried";
      readonly fromProposalId: string;
      readonly status: Extract<VisualExtractionProposalStatus, "accepted" | "rejected">;
      readonly editedValue?: unknown;
    }
  | { readonly kind: "conflict"; readonly withProposalId: string };

/**
 * The manual-edit preservation law (plan slice 9: "preserve manual edits when a
 * better extractor is run later"):
 *
 * - The extractor repeats the exact claim a human already ruled on → the ruling
 *   CARRIES, edit included. Re-reviewing an identical claim is toil, and losing
 *   the edit under it would be the clobbering this slice exists to prevent. A
 *   prior `applied` carries as `accepted` — application is an act, not a fact
 *   about the new row, and the diff will already read `same`.
 * - The extractor claims something DIFFERENT about a ruled slot → CONFLICT. The
 *   new claim goes to review beside the preserved ruling, with the reserved
 *   diagnostic; nothing is auto-resolved, whatever the confidence says.
 * - No ruling exists → fresh review.
 *
 * `priorDecisions` is ordered newest ruling first; only the newest ruling for
 * the slot is consulted.
 */
export function reconcileVisualExtractionProposal(
  priorDecisions: readonly VisualExtractionPriorDecision[],
  slotKey: string,
  proposedFingerprint: string,
  sink?: DiagnosticSink,
  path = "visual_state.extraction.reconcile",
): VisualExtractionDisposition {
  const prior = priorDecisions.find((decision) => decision.slotKey === slotKey);
  if (prior === undefined) return { kind: "fresh" };
  if (prior.proposedFingerprint === proposedFingerprint) {
    return {
      kind: "carried",
      fromProposalId: prior.proposalId,
      status: prior.status === "rejected" ? "rejected" : "accepted",
      ...(prior.editedValue === undefined ? {} : { editedValue: prior.editedValue }),
    };
  }
  sink?.push(
    diag(
      "warn",
      VISUAL_STATE_EXTRACTION_CONFLICT,
      "A newer extraction disagrees with a reviewed proposal for this slot; the ruling is preserved and the new claim needs review",
      { path, context: { slotKey, withProposalId: prior.proposalId, reason: "reviewed_value_differs" } },
    ),
  );
  return { kind: "conflict", withProposalId: prior.proposalId };
}

// ---------------------------------------------------------------------------
// Review transitions
// ---------------------------------------------------------------------------

export type VisualExtractionTransitionResult =
  | { readonly ok: true; readonly next: Extract<VisualExtractionProposalStatus, "accepted" | "rejected"> }
  | { readonly ok: false; readonly reason: string };

/**
 * May a human ruling move this proposal? Undecided and decided-but-unapplied
 * proposals may be ruled and re-ruled freely — a reviewer is allowed to change
 * their mind until the fact has actually reached an owner. `applied` is
 * immutable history (the owner now holds the fact; disagreeing with it is an
 * edit of the OWNER, through the owner's surface), and `superseded` is a closed
 * run's leftover.
 */
export function visualExtractionReviewTransition(
  status: VisualExtractionProposalStatus,
  action: VisualExtractionReviewAction,
): VisualExtractionTransitionResult {
  switch (status) {
    case "pending":
    case "accepted":
    case "rejected":
      return { ok: true, next: action === "accept" ? "accepted" : "rejected" };
    case "applied":
      return { ok: false, reason: "already applied; edit the canonical owner instead" };
    case "superseded":
      return { ok: false, reason: "superseded by a newer extraction run" };
  }
}

// ---------------------------------------------------------------------------
// The apply plan
// ---------------------------------------------------------------------------

/**
 * What accepting a proposal writes, phrased in the target owner's own
 * vocabulary — or an honest refusal.
 *
 * Only the attribute owner has a canonical write path today: located facts and
 * canonical presentation have pure contracts but no lane persists either
 * (recorded by slices 3 and 6). Per the plan's "missing owners mean silence",
 * an accepted proposal for an ownerless target stays ACCEPTED — the ruling is
 * preserved — and produces `unavailable` plus the diagnostic instead of an
 * invented store.
 */
export type VisualExtractionApplyPlan =
  | { readonly kind: "attribute"; readonly next: AttributeValue }
  | { readonly kind: "unavailable"; readonly targetOwner: VisualExtractionTargetOwner };

export interface VisualExtractionApplyInput {
  readonly proposalId: string;
  readonly targetOwner: VisualExtractionTargetOwner;
  readonly kindId: string;
  readonly locus?: BodyLocusRef;
  /** The accepted value: the reviewer's edit when one exists, else the proposal's. */
  readonly value: unknown;
}

/**
 * Plan the owner write for an accepted proposal, or `null` with a diagnostic
 * when even the plan cannot be built (the value no longer parses — a registry
 * edit since registration, or a corrupt stored row).
 *
 * The attribute write is a `manual`-source value: acceptance is a deliberate
 * human act, which is exactly the authority `overlaySourceMayChange` demands
 * before an inherent trait may change. The `sourceId` records which proposal
 * put it there, so the profile row itself carries the provenance trail.
 */
export function planVisualExtractionApply(
  input: VisualExtractionApplyInput,
  sink?: DiagnosticSink,
  path = "visual_state.extraction.apply",
): VisualExtractionApplyPlan | null {
  switch (input.targetOwner) {
    case "attribute": {
      const parsed = attributeRegistry.parseValue(input.kindId, input.value);
      if (!parsed.ok) {
        sink?.push(
          diag("warn", VISUAL_STATE_EXTRACTION_PROPOSAL_INVALID, parsed.issues.join("; "), {
            path,
            context: { proposalId: input.proposalId, kindId: input.kindId },
          }),
        );
        return null;
      }
      return {
        kind: "attribute",
        next: {
          id: input.kindId as AttributeValue["id"],
          value: parsed.value,
          source: "manual",
          sourceId: `${VISUAL_EXTRACTION_SOURCE_ID_PREFIX}:${input.proposalId}`,
        },
      };
    }
    case "located_fact":
    case "presentation": {
      sink?.push(
        diag(
          "warn",
          VISUAL_STATE_EXTRACTION_OWNER_UNAVAILABLE,
          `No lane persists canonical ${input.targetOwner} state yet; the accepted proposal is preserved unapplied`,
          { path, context: { proposalId: input.proposalId, targetOwner: input.targetOwner } },
        ),
      );
      return { kind: "unavailable", targetOwner: input.targetOwner };
    }
  }
}

// ---------------------------------------------------------------------------
// Route wire schemas
// ---------------------------------------------------------------------------

/** POST /api/admin/self/reference-extractions — register one offline run. */
export const visualExtractionSubmissionSchema = z.object({
  characterId: z.string().min(1),
  sourceImageId: z.string().min(1),
  extractorId: z.string().trim().min(1).max(120),
  extractorVersion: z.string().trim().min(1).max(64),
  /** Untrusted extractor output; parsed per item by `parseVisualContractProposals`. */
  proposals: z.array(z.unknown()).max(256),
});
export type VisualExtractionSubmission = z.infer<typeof visualExtractionSubmissionSchema>;

/** POST /api/admin/self/reference-extractions/proposals/[proposalId] — one human ruling. */
export const visualExtractionDecisionSchema = z.object({
  action: z.enum(visualExtractionReviewActions),
  /**
   * Required on accept: the `currentDigest` of the diff the reviewer was shown.
   * The server recomputes it; a mismatch means canonical truth moved since the
   * look and the accept is refused with a fresh diff.
   */
  currentDigest: z.string().min(1).optional(),
  /** The reviewer's manual edit of the proposed value, when accepting with one. */
  editedValue: z.unknown().optional(),
});
export type VisualExtractionDecision = z.infer<typeof visualExtractionDecisionSchema>;
