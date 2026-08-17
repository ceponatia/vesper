import { and, desc, eq, inArray } from "drizzle-orm";
import {
  DiagnosticCollector,
  characterProfileSchema,
  diffVisualExtractionProposal,
  emptyCharacterPresentationState,
  emptyCharacterProfile,
  materializeBodyDefaults,
  parseVisualContractProposals,
  planVisualExtractionApply,
  reconcileVisualExtractionProposal,
  visualExtractionReviewTransition,
  VISUAL_STATE_EXTRACTION_CONFLICT,
  diag,
  type AttributeValue,
  type BodyLocusRef,
  type CharacterProfile,
  type Diagnostic,
  type VisualExtractionCanonicalTruth,
  type VisualExtractionPriorDecision,
  type VisualExtractionProposalDiff,
  type VisualExtractionProposalStatus,
  type VisualExtractionReviewAction,
  type VisualExtractionRunStatus,
  type VisualExtractionTargetOwner,
  bodyLocusRefSchema,
} from "@/contracts";
import { parseOr, parseOrNull } from "@/lib/parse";
import {
  characters,
  db,
  images,
  visualReferenceExtractions,
  visualReferenceProposals,
} from "@/server/db";
import { readImageBytes, sourceContentHashOf } from "@/server/images";

/**
 * Reference-image extraction — the server half (visual-state.plan.md slice 9).
 *
 * Three operations, all admin-only through `/api/admin/self`:
 *
 * - **register** an offline extractor's proposal set against one canonical
 *   image (hashing the stored bytes, diffing against canonical truth, and
 *   reconciling with prior rulings);
 * - **list** a character's runs with FRESH diffs, so a reviewer always rules
 *   against canonical truth as it stands;
 * - **decide** one proposal — the human act — and, on acceptance, apply the
 *   fact through the target owner's own write path.
 *
 * The one canonical owner with a write path today is the attribute set on
 * `characters.profile`. Located facts and canonical presentation have pure
 * contracts and no persistence (recorded by slices 3 and 6), so an accepted
 * proposal for either stays `accepted` with `visual_state.extraction.owner_unavailable`
 * — the ruling preserved, nothing invented.
 */

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** Canonical-image kinds an extraction may claim to have read. */
const CANONICAL_SOURCE_IMAGE_KINDS = ["avatar", "portrait_variant"] as const;

export interface VisualExtractionProposalView {
  readonly id: string;
  readonly extractionId: string;
  readonly slotKey: string;
  readonly targetOwner: VisualExtractionTargetOwner;
  readonly kindId: string;
  readonly locus: BodyLocusRef | null;
  readonly value: unknown;
  readonly editedValue: unknown | null;
  readonly confidence: number;
  readonly evidenceRegion: unknown | null;
  readonly status: VisualExtractionProposalStatus;
  readonly carriedFromProposalId: string | null;
  readonly conflictWithProposalId: string | null;
  readonly reviewedAt: string | null;
  readonly appliedAt: string | null;
  /** The diff against canonical truth AS OF THIS READ — what an accept must echo. */
  readonly diff: VisualExtractionProposalDiff;
}

export interface VisualExtractionRunView {
  readonly id: string;
  readonly characterId: string;
  readonly sourceImageId: string | null;
  readonly sourceHash: string;
  readonly extractorId: string;
  readonly extractorVersion: string;
  readonly status: VisualExtractionRunStatus;
  readonly createdAt: string;
  readonly proposals: readonly VisualExtractionProposalView[];
}

export type VisualExtractionRegisterResult =
  | { readonly ok: true; readonly run: VisualExtractionRunView; readonly diagnostics: readonly Diagnostic[] }
  | { readonly ok: false; readonly code: string; readonly message: string };

export type VisualExtractionDecideResult =
  | {
      readonly ok: true;
      readonly proposal: VisualExtractionProposalView;
      readonly diagnostics: readonly Diagnostic[];
    }
  | {
      readonly ok: false;
      readonly code: string;
      readonly message: string;
      /** On a canonical-moved conflict: the fresh diff the reviewer must look at. */
      readonly diff?: VisualExtractionProposalDiff;
      readonly diagnostics?: readonly Diagnostic[];
    };

// ---------------------------------------------------------------------------
// Canonical truth
// ---------------------------------------------------------------------------

/**
 * The canonical owners' state for one character, as this lane can load it
 * today: attributes from the profile; located facts and presentation as their
 * honest empty states, since no lane persists canonical rows for either
 * (visual-state.spec.md, slices 3 and 6). `atMinutes: 0` with no located facts
 * is inert by construction.
 */
function canonicalTruthOfProfile(profile: CharacterProfile): VisualExtractionCanonicalTruth {
  return {
    attributes: profile.attributes,
    locatedFacts: [],
    presentation: emptyCharacterPresentationState(),
    atMinutes: 0,
  };
}

function parseProfile(raw: unknown): CharacterProfile {
  return parseOr(characterProfileSchema, raw, emptyCharacterProfile(), undefined, "characters.profile");
}

// ---------------------------------------------------------------------------
// Row → view
// ---------------------------------------------------------------------------

type ProposalRow = typeof visualReferenceProposals.$inferSelect;
type RunRow = typeof visualReferenceExtractions.$inferSelect;

/** The stored locus, through its trust boundary; a corrupt one reads as absent. */
function rowLocus(row: ProposalRow): BodyLocusRef | null {
  if (row.locus === null || row.locus === undefined) return null;
  return parseOrNull(bodyLocusRefSchema, row.locus, undefined, "visual_reference_proposals.locus");
}

/** The value a ruling concerns: the reviewer's edit when one exists. */
function resolvedValue(row: Pick<ProposalRow, "value" | "editedValue">): unknown {
  return row.editedValue ?? row.value;
}

function proposalView(row: ProposalRow, truth: VisualExtractionCanonicalTruth): VisualExtractionProposalView {
  const locus = rowLocus(row);
  const diffed = diffVisualExtractionProposal(
    truth,
    row.targetOwner,
    row.kindId,
    locus ?? undefined,
    resolvedValue(row),
  );
  return {
    id: row.id,
    extractionId: row.extractionId,
    slotKey: row.slotKey,
    targetOwner: row.targetOwner,
    kindId: row.kindId,
    locus,
    value: row.value,
    editedValue: row.editedValue ?? null,
    confidence: row.confidence,
    evidenceRegion: row.evidenceRegion ?? null,
    status: row.status,
    carriedFromProposalId: row.carriedFromProposalId,
    conflictWithProposalId: row.conflictWithProposalId,
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
    appliedAt: row.appliedAt?.toISOString() ?? null,
    diff: diffed,
  };
}

function runView(run: RunRow, proposals: readonly ProposalRow[], truth: VisualExtractionCanonicalTruth): VisualExtractionRunView {
  return {
    id: run.id,
    characterId: run.characterId,
    sourceImageId: run.sourceImageId,
    sourceHash: run.sourceHash,
    extractorId: run.extractorId,
    extractorVersion: run.extractorVersion,
    status: run.status,
    createdAt: run.createdAt.toISOString(),
    proposals: proposals.map((row) => proposalView(row, truth)),
  };
}

// ---------------------------------------------------------------------------
// Register
// ---------------------------------------------------------------------------

export interface RegisterVisualReferenceExtractionInput {
  readonly ownerId: string;
  readonly characterId: string;
  readonly sourceImageId: string;
  readonly extractorId: string;
  readonly extractorVersion: string;
  /** Untrusted extractor output. */
  readonly proposals: readonly unknown[];
}

/**
 * Register one offline run. The workflow is offline and review-first by the
 * plan's own scope line: this endpoint receives an extractor's OUTPUT; no
 * vision call happens here or anywhere per-turn, and which extractor produced
 * the payload is provenance (`extractorId`/`extractorVersion`), not behavior —
 * extractors stay pluggable because the contract only ever sees their claims.
 */
export async function registerVisualReferenceExtraction(
  input: RegisterVisualReferenceExtractionInput,
): Promise<VisualExtractionRegisterResult> {
  const sink = new DiagnosticCollector();

  const [character] = await db()
    .select()
    .from(characters)
    .where(and(eq(characters.id, input.characterId), eq(characters.ownerId, input.ownerId)))
    .limit(1);
  if (!character) return { ok: false, code: "not_found", message: "character not found" };

  const [image] = await db()
    .select()
    .from(images)
    .where(and(eq(images.id, input.sourceImageId), eq(images.ownerId, input.ownerId)))
    .limit(1);
  if (
    !image ||
    image.entityKind !== "character" ||
    image.entityId !== character.id ||
    !(CANONICAL_SOURCE_IMAGE_KINDS as readonly string[]).includes(image.kind) ||
    image.status !== "ready"
  ) {
    return { ok: false, code: "source_not_canonical", message: "source image is not one of this character's canonical portraits" };
  }

  // Hash the STORED bytes — the system must never claim the proposals were
  // derived from bytes it did not read (the identity-pack rule).
  const bytes = await readImageBytes(image);
  if (bytes === null) return { ok: false, code: "source_unreadable", message: "source image bytes are missing" };
  const sourceHash = sourceContentHashOf(bytes);

  const validated = parseVisualContractProposals(input.proposals, sink);
  if (validated.length === 0) {
    return { ok: false, code: "no_usable_proposals", message: "no proposal survived validation" };
  }

  const truth = canonicalTruthOfProfile(parseProfile(character.profile));

  // Prior rulings, newest first, one per slot consulted by the reconciler.
  const decided = await db()
    .select()
    .from(visualReferenceProposals)
    .where(
      and(
        eq(visualReferenceProposals.characterId, character.id),
        inArray(visualReferenceProposals.status, ["accepted", "rejected", "applied"]),
      ),
    )
    .orderBy(desc(visualReferenceProposals.createdAt));
  const priorDecisions: VisualExtractionPriorDecision[] = decided.map((row) => ({
    proposalId: row.id,
    slotKey: row.slotKey,
    status: row.status as VisualExtractionPriorDecision["status"],
    proposedFingerprint: row.proposedFingerprint,
    ...(row.editedValue === null || row.editedValue === undefined ? {} : { editedValue: row.editedValue }),
  }));

  const now = new Date();
  const run = await db().transaction(async (tx) => {
    // A newer run REPLACES the open one over the same source: pending proposals
    // close as superseded; decided rows keep their ruling forever.
    const openRuns = await tx
      .select({ id: visualReferenceExtractions.id })
      .from(visualReferenceExtractions)
      .where(
        and(
          eq(visualReferenceExtractions.characterId, character.id),
          eq(visualReferenceExtractions.sourceImageId, image.id),
          eq(visualReferenceExtractions.status, "open"),
        ),
      );
    if (openRuns.length > 0) {
      const ids = openRuns.map((row) => row.id);
      await tx
        .update(visualReferenceExtractions)
        .set({ status: "superseded" })
        .where(inArray(visualReferenceExtractions.id, ids));
      await tx
        .update(visualReferenceProposals)
        .set({ status: "superseded" })
        .where(
          and(
            inArray(visualReferenceProposals.extractionId, ids),
            eq(visualReferenceProposals.status, "pending"),
          ),
        );
    }

    const [inserted] = await tx
      .insert(visualReferenceExtractions)
      .values({
        ownerId: input.ownerId,
        characterId: character.id,
        sourceImageId: image.id,
        sourceHash,
        extractorId: input.extractorId,
        extractorVersion: input.extractorVersion,
        status: "open",
      })
      .returning();
    if (!inserted) throw new Error("extraction insert returned no row");

    const proposalRows = validated.map((proposal) => {
      const disposition = reconcileVisualExtractionProposal(priorDecisions, proposal.slotKey, proposal.proposedFingerprint, sink);
      const diffed = diffVisualExtractionProposal(
        truth,
        proposal.targetOwner,
        proposal.kindId,
        proposal.locus,
        disposition.kind === "carried" && disposition.editedValue !== undefined
          ? disposition.editedValue
          : proposal.value,
      );
      return {
        extractionId: inserted.id,
        characterId: character.id,
        slotKey: proposal.slotKey,
        targetOwner: proposal.targetOwner,
        kindId: proposal.kindId,
        locus: proposal.locus ?? null,
        value: proposal.value,
        proposedFingerprint: proposal.proposedFingerprint,
        confidence: proposal.confidence,
        evidenceRegion: proposal.evidenceRegion ?? null,
        baseline: diffed,
        status: (disposition.kind === "carried" ? disposition.status : "pending") as VisualExtractionProposalStatus,
        editedValue: disposition.kind === "carried" ? (disposition.editedValue ?? null) : null,
        carriedFromProposalId: disposition.kind === "carried" ? disposition.fromProposalId : null,
        conflictWithProposalId: disposition.kind === "conflict" ? disposition.withProposalId : null,
        // A carried ruling keeps its human provenance out of this row: the
        // reviewer fields stay null and `carried_from_proposal_id` points at
        // the row that holds who ruled and when.
      };
    });
    const insertedProposals = await tx.insert(visualReferenceProposals).values(proposalRows).returning();
    return { run: inserted, proposals: insertedProposals };
  });

  return { ok: true, run: runView(run.run, run.proposals, truth), diagnostics: sink.items };
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export async function listVisualReferenceExtractions(input: {
  readonly ownerId: string;
  readonly characterId: string;
}): Promise<{ ok: true; runs: readonly VisualExtractionRunView[] } | { ok: false; code: string; message: string }> {
  const [character] = await db()
    .select()
    .from(characters)
    .where(and(eq(characters.id, input.characterId), eq(characters.ownerId, input.ownerId)))
    .limit(1);
  if (!character) return { ok: false, code: "not_found", message: "character not found" };

  const truth = canonicalTruthOfProfile(parseProfile(character.profile));
  const runs = await db()
    .select()
    .from(visualReferenceExtractions)
    .where(
      and(
        eq(visualReferenceExtractions.characterId, character.id),
        eq(visualReferenceExtractions.ownerId, input.ownerId),
      ),
    )
    .orderBy(desc(visualReferenceExtractions.createdAt));
  if (runs.length === 0) return { ok: true, runs: [] };

  const proposals = await db()
    .select()
    .from(visualReferenceProposals)
    .where(inArray(visualReferenceProposals.extractionId, runs.map((row) => row.id)))
    .orderBy(visualReferenceProposals.slotKey);
  const byRun = new Map<string, ProposalRow[]>();
  for (const row of proposals) {
    const list = byRun.get(row.extractionId) ?? [];
    list.push(row);
    byRun.set(row.extractionId, list);
  }
  return { ok: true, runs: runs.map((row) => runView(row, byRun.get(row.id) ?? [], truth)) };
}

// ---------------------------------------------------------------------------
// Decide (the human act) + apply-on-accept
// ---------------------------------------------------------------------------

export interface DecideVisualReferenceProposalInput {
  readonly ownerId: string;
  readonly proposalId: string;
  readonly action: VisualExtractionReviewAction;
  /** Required on accept: the fresh diff's `currentDigest` the reviewer saw. */
  readonly currentDigest?: string;
  /** Optional manual edit accompanying an accept. */
  readonly editedValue?: unknown;
}

/**
 * Record one human ruling and, on acceptance, write the fact through the
 * target owner's own path. Never an auto-apply: this function runs only from
 * the admin decision route, one proposal per call.
 */
export async function decideVisualReferenceProposal(
  input: DecideVisualReferenceProposalInput,
): Promise<VisualExtractionDecideResult> {
  const sink = new DiagnosticCollector();

  const [row] = await db()
    .select()
    .from(visualReferenceProposals)
    .where(eq(visualReferenceProposals.id, input.proposalId))
    .limit(1);
  if (!row) return { ok: false, code: "not_found", message: "proposal not found" };

  const [run] = await db()
    .select()
    .from(visualReferenceExtractions)
    .where(
      and(
        eq(visualReferenceExtractions.id, row.extractionId),
        eq(visualReferenceExtractions.ownerId, input.ownerId),
      ),
    )
    .limit(1);
  if (!run) return { ok: false, code: "not_found", message: "proposal not found" };

  const transition = visualExtractionReviewTransition(row.status, input.action);
  if (!transition.ok) return { ok: false, code: "not_reviewable", message: transition.reason };

  const [character] = await db()
    .select()
    .from(characters)
    .where(and(eq(characters.id, row.characterId), eq(characters.ownerId, input.ownerId)))
    .limit(1);
  if (!character) return { ok: false, code: "not_found", message: "character not found" };
  const profile = parseProfile(character.profile);
  const truth = canonicalTruthOfProfile(profile);

  if (input.action === "reject") {
    const rejected = await db()
      .update(visualReferenceProposals)
      .set({ status: "rejected", reviewedByUserId: input.ownerId, reviewedAt: new Date() })
      .where(and(eq(visualReferenceProposals.id, row.id), eq(visualReferenceProposals.status, row.status)))
      .returning();
    const updated = rejected[0];
    if (!updated) return { ok: false, code: "conflict", message: "proposal changed underneath the ruling; reload" };
    return { ok: true, proposal: proposalView(updated, truth), diagnostics: sink.items };
  }

  // Accept. The reviewer's edit, when present, must survive the same target
  // validation the machine's value did — an edit is still untrusted input.
  const locus = rowLocus(row);
  let editedValue: unknown = row.editedValue ?? null;
  if (input.editedValue !== undefined) {
    const revalidated = parseVisualContractProposals(
      [
        {
          targetOwner: row.targetOwner,
          kindId: row.kindId,
          ...(locus === null ? {} : { locus }),
          value: input.editedValue,
          confidence: row.confidence,
        },
      ],
      sink,
    );
    const edited = revalidated[0];
    if (!edited || edited.slotKey !== row.slotKey) {
      return {
        ok: false,
        code: "edit_invalid",
        message: "the edited value does not parse for this slot",
        diagnostics: sink.items,
      };
    }
    editedValue = edited.value;
  }

  const acceptedValue = editedValue ?? row.value;
  const freshDiff = diffVisualExtractionProposal(truth, row.targetOwner, row.kindId, locus ?? undefined, acceptedValue);

  if (input.currentDigest === undefined) {
    return {
      ok: false,
      code: "digest_required",
      message: "an accept must echo the reviewed diff's currentDigest",
      diff: freshDiff,
    };
  }

  // The review-first guarantee, mechanically: an accept lands only against the
  // canonical state the reviewer was just shown. Anything else is a conflict —
  // canonical truth is preserved and the reviewer looks again.
  if (input.currentDigest !== freshDiff.currentDigest) {
    sink.push(
      diag(
        "warn",
        VISUAL_STATE_EXTRACTION_CONFLICT,
        "Canonical truth moved since the reviewed diff; nothing was written",
        {
          path: "visual_state.extraction.decide",
          context: { proposalId: row.id, slotKey: row.slotKey, reason: "canonical_moved" },
        },
      ),
    );
    return {
      ok: false,
      code: "canonical_moved",
      message: "canonical truth changed since this diff was read; review the fresh diff",
      diff: freshDiff,
      diagnostics: sink.items,
    };
  }

  const accepted = await db()
    .update(visualReferenceProposals)
    .set({
      status: "accepted",
      editedValue,
      reviewedByUserId: input.ownerId,
      reviewedAt: new Date(),
    })
    .where(and(eq(visualReferenceProposals.id, row.id), eq(visualReferenceProposals.status, row.status)))
    .returning();
  let updated = accepted[0];
  if (!updated) return { ok: false, code: "conflict", message: "proposal changed underneath the ruling; reload" };

  // Apply through the owner's write path — the only door canonical truth opens.
  const plan = planVisualExtractionApply(
    {
      proposalId: row.id,
      targetOwner: row.targetOwner,
      kindId: row.kindId,
      ...(locus === null ? {} : { locus }),
      value: acceptedValue,
    },
    sink,
  );
  if (plan !== null && plan.kind === "attribute") {
    await applyAttributeToProfile(character.id, plan.next);
    const applied = await db()
      .update(visualReferenceProposals)
      .set({ appliedAt: new Date(), status: "applied" })
      .where(and(eq(visualReferenceProposals.id, row.id), eq(visualReferenceProposals.status, "accepted")))
      .returning();
    updated = applied[0] ?? updated;
  }

  // Recompute the view against post-apply truth so the response's diff answers
  // "what does the owner hold NOW".
  const [after] = await db().select().from(characters).where(eq(characters.id, character.id)).limit(1);
  const afterTruth = canonicalTruthOfProfile(parseProfile(after?.profile ?? character.profile));
  return { ok: true, proposal: proposalView(updated, afterTruth), diagnostics: sink.items };
}

/**
 * The attribute owner's write path, as the character PATCH route walks it:
 * parse the stored profile, replace the value at its id, re-materialize the
 * persisted-baseline facts against the profile's own body, write the whole
 * profile back. One entry per id — the canonical array is a value store with
 * provenance, and `resolveAttributes` precedence is for overlays, not for two
 * stored rows arguing.
 */
async function applyAttributeToProfile(characterId: string, next: AttributeValue): Promise<void> {
  // The profile is re-read under a row lock INSIDE the write transaction, not
  // reused from the read that produced the diff. This write replaces the whole
  // profile document, so applying it to a copy fetched earlier in the request
  // would silently revert any edit that landed in between — the reviewed slot
  // is guarded by the `currentDigest` echo, but every other attribute is not.
  await db().transaction(async (tx) => {
    const [row] = await tx
      .select({ profile: characters.profile })
      .from(characters)
      .where(eq(characters.id, characterId))
      .for("update")
      .limit(1);
    if (!row) return;
    const profile = parseProfile(row.profile);
    const attributes = [...profile.attributes.filter((attribute) => attribute.id !== next.id), next];
    const merged = { ...profile, attributes };
    await tx
      .update(characters)
      .set({ profile: { ...merged, attributes: materializeBodyDefaults(merged.attributes, merged) } })
      .where(eq(characters.id, characterId));
  });
}
