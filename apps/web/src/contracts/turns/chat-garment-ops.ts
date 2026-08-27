import { z } from "zod";
import { diag, DiagnosticCollector, type DiagnosticSink } from "../diagnostics";
import { clothingCategoryById } from "../items/clothing-categories";
import { garmentBehaviorBindingFor, type GarmentBlueprint } from "../items/garment-blueprint";
import { isFastenerSeriesBehavior } from "../items/garment-coverage";
import {
  garmentHandleActor,
  garmentHandleEntry,
  type GarmentHandleEntry,
  type GarmentHandleTable,
} from "../items/garment-handles";
import {
  garmentCleanTargetSchema,
  garmentConditionKeySchema,
  garmentDamageKindSchema,
  garmentDepositKindSchema,
  garmentDisplacementKindSchema,
  garmentTuckStateSchema,
  GARMENT_MAX_OPERATIONS,
  type ChatGarmentStore,
  type GarmentClosureState,
  type GarmentLocus,
  type GarmentOperation,
} from "../items/garment-instance";
import { garmentDegreeBandSchema, GARMENT_UNIT_ONE, type GarmentUnit } from "../items/garment-material";
import { applyGarmentOperations } from "../items/garment-presentation";
import {
  garmentBlueprintFor,
  garmentInstanceById,
  garmentLocusActorId,
  inferGarmentMaterialProfile,
  instantiateGarment,
} from "../items/garment-store";
import { mintGarmentBlueprint } from "../items/garment-templates";

/**
 * The continuity extractor's GARMENT PROPOSAL contract and its pure mapping layer.
 *
 * The design law this file implements: *"The continuity
 * prompt enumerates only in-scope opaque garment and part handles. The extractor
 * returns those handles, not names to fuzzy-match."* A proposal is therefore not
 * a `GarmentOperation` — it is a semantic sentence over HANDLES (`sabrina.shirt`,
 * `sabrina.shirt.sleeve_left`) and a small degree vocabulary, which this module
 * maps deterministically onto the typed union. Nothing here fuzzy-matches a name
 * and nothing here invents a value: `wetness: 73` is unreachable from a proposal.
 *
 * Rejections are drops with a stable code, never a throw (docs/resilience.md §2):
 *
 * - a garment handle that is not in the table ⇒ `garment_op.garment_unresolved`;
 * - a part handle that names no part of THAT garment ⇒ `garment_op.part_unresolved`,
 *   never widened to the root — a hallucination about which part is not evidence
 *   about the garment (audit OQ7). An EMPTY part list stays legal on the
 *   condition-class operations, where it means the whole garment by construction;
 * - everything structural — an unbound channel, a `gone` garment, a mismatched
 *   closure shape — is the dispatcher's own judgement, reached by handing it one
 *   operation at a time so each proposal's outcome is individually traceable.
 *
 * `introduce` is R2's guarded mint: a category id from the EXISTING
 * `clothingCategories` vocabulary, a conservative inferred material, and a locus.
 * It can only add a garment's own template coverage, never subtract anyone's, so
 * a minted garment never decides intimate coverage on its own.
 */

/** Max proposals accepted from one exchange — the same bound the operation list carries. */
export const GARMENT_PROPOSAL_MAX = GARMENT_MAX_OPERATIONS;
/** Max ad-hoc garments one exchange may introduce (R2 is a rare path, not a wardrobe faucet). */
export const GARMENT_INTRODUCE_MAX = 3;
/** Max part handles one proposal may name. */
export const GARMENT_PROPOSAL_MAX_PARTS = 8;
/** Max operation trace rows persisted for the inspector. */
export const GARMENT_TRACE_MAX = GARMENT_PROPOSAL_MAX;

// --- The proposal union -------------------------------------------------------

/** A garment handle, exactly as the prompt enumerated it. */
const handleSchema = z.string().trim().min(1).max(80);
/** A part handle — `<garment>.<part>`, or the bare part id listed under that garment. */
const partSchema = z.string().trim().min(1).max(120);
const partsSchema = z
  .array(partSchema)
  .catch([])
  .default([])
  .transform((parts) => parts.slice(0, GARMENT_PROPOSAL_MAX_PARTS));
const anchorSchema = z.string().trim().max(80).optional().catch(undefined);

/** Structural closure states the model speaks (audit OQ8's `fastened|partly_open|open`). */
export const garmentClosureIntents = ["fastened", "partly_open", "open"] as const;
export const garmentClosureIntentSchema = z.enum(garmentClosureIntents);
export type GarmentClosureIntent = z.infer<typeof garmentClosureIntentSchema>;

/** Where a `move` puts a garment, in fiction words rather than locus shapes. */
export const garmentMoveTargets = ["worn", "held", "put_away", "left_here", "gone"] as const;
export const garmentMoveTargetSchema = z.enum(garmentMoveTargets);
export type GarmentMoveTarget = z.infer<typeof garmentMoveTargetSchema>;

/** Where an introduced garment starts out. */
export const garmentIntroduceLoci = ["worn", "held", "here"] as const;
export const garmentIntroduceLocusSchema = z.enum(garmentIntroduceLoci);

export const garmentOperationProposalSchema = z.discriminatedUnion("op", [
  z
    .object({
      op: z.literal("move"),
      garment: handleSchema,
      to: garmentMoveTargetSchema,
      /** Only when it moves onto someone ELSE; defaults to whoever has it now. */
      wearer: handleSchema.optional().catch(undefined),
      anchor: anchorSchema,
    })
    .strict(),
  z
    .object({
      op: z.literal("closure"),
      garment: handleSchema,
      part: partSchema,
      state: garmentClosureIntentSchema,
      /** "the top two buttons" — honored on a fastener series, ignored on a zip. */
      openFasteners: z.number().int().min(0).max(64).optional().catch(undefined),
    })
    .strict(),
  z
    .object({ op: z.literal("roll"), garment: handleSchema, part: partSchema, degree: garmentDegreeBandSchema })
    .strict(),
  z
    .object({ op: z.literal("tuck"), garment: handleSchema, part: partSchema, state: garmentTuckStateSchema })
    .strict(),
  z
    .object({
      op: z.literal("displace"),
      garment: handleSchema,
      part: partSchema,
      displacement: garmentDisplacementKindSchema,
      degree: garmentDegreeBandSchema,
    })
    .strict(),
  z.object({ op: z.literal("restore"), garment: handleSchema, parts: partsSchema }).strict(),
  z
    .object({
      op: z.literal("condition"),
      garment: handleSchema,
      parts: partsSchema,
      channel: garmentConditionKeySchema,
      direction: z.enum(["increase", "decrease"]),
      degree: garmentDegreeBandSchema,
    })
    .strict(),
  z
    .object({
      op: z.literal("deposit"),
      garment: handleSchema,
      parts: partsSchema,
      // An invented contaminant degrades to `unknown` rather than voiding the
      // operation: something IS on the garment, and the registry's fallback kind
      // is the honest way to say so.
      substance: garmentDepositKindSchema.catch("unknown"),
      degree: garmentDegreeBandSchema,
    })
    .strict(),
  z
    .object({
      op: z.literal("clean"),
      garment: handleSchema,
      parts: partsSchema,
      target: garmentCleanTargetSchema,
    })
    .strict(),
  z
    .object({
      op: z.literal("damage"),
      garment: handleSchema,
      part: partSchema,
      damage: garmentDamageKindSchema.catch("scuff"),
      degree: garmentDegreeBandSchema,
    })
    .strict(),
  z
    .object({
      op: z.literal("introduce"),
      /** The handle the model coins for it, so later proposals can address it. */
      handle: handleSchema,
      name: z.string().trim().min(1).max(120),
      /** A `clothingCategories` id — the template that supplies the whole graph. */
      category: z.string().trim().min(1).max(40),
      /** Free-text fabric hint, resolved by the conservative keyword mapper. */
      material: z.string().trim().max(40).optional().catch(undefined),
      wearer: handleSchema.optional().catch(undefined),
      at: garmentIntroduceLocusSchema.catch("worn"),
      anchor: anchorSchema,
    })
    .strict(),
]);
export type GarmentOperationProposal = z.infer<typeof garmentOperationProposalSchema>;
export type GarmentProposalKind = GarmentOperationProposal["op"];

/**
 * The extraction field's list. Parsed PER ITEM so one malformed proposal is
 * dropped instead of voiding the whole exchange's wardrobe reads — the same
 * boundary discipline `garmentOperationListSchema` applies to the runtime union.
 */
export const garmentOperationProposalListSchema = z
  .array(z.unknown())
  .catch([])
  .default([])
  .transform((items) =>
    items
      .flatMap((item) => {
        const result = garmentOperationProposalSchema.safeParse(item);
        return result.success ? [result.data] : [];
      })
      .slice(0, GARMENT_PROPOSAL_MAX),
  );

// --- The trace (admin inspector) ----------------------------------------------

export const garmentOperationOutcomes = ["applied", "no_change", "rejected"] as const;
export const garmentOperationOutcomeSchema = z.enum(garmentOperationOutcomes);
export type GarmentOperationOutcome = z.infer<typeof garmentOperationOutcomeSchema>;

/**
 * One proposal's fate: what it proposed, which instance it resolved to, and
 * whether it landed. Persisted on the memory trace so drop rates are MEASURED
 * rather than guessed (audit OQ7) — and, riding that trace, rolled back with the
 * exchange it describes.
 */
export const garmentOperationTraceEntrySchema = z
  .object({
    op: z.string().catch("").default(""),
    /** The handle as proposed — the hallucination itself, when one happened. */
    garment: z.string().catch("").default(""),
    /** The resolved instance id; "" when the handle did not resolve. */
    garmentId: z.string().catch("").default(""),
    outcome: garmentOperationOutcomeSchema.catch("rejected").default("rejected"),
    /** Stable `garment_op.*` code on a rejection; "" otherwise. */
    code: z.string().catch("").default(""),
    detail: z.string().catch("").default(""),
  })
  .strict();
export type GarmentOperationTraceEntry = z.infer<typeof garmentOperationTraceEntrySchema>;

export const garmentOperationTraceSchema = z
  .array(garmentOperationTraceEntrySchema)
  .catch([])
  .default([])
  .transform((rows) => rows.slice(0, GARMENT_TRACE_MAX));

// --- Which mutation lane an exchange runs -------------------------------------

/**
 * Which wardrobe-mutation path this exchange takes. Exactly ONE ever runs — the
 * existing name matcher remains only a degraded legacy bridge:
 *
 * - `operations` — the extractor returned typed proposals. The free-text folds
 *   are skipped entirely, so no actor is mutated twice in one exchange.
 * - `legacy` — no proposals, but the old `outfit` / `playerOutfit` grammar came
 *   back (an unmodelled chat, an older cached prompt, a degraded model). The
 *   bridge runs unchanged, with `chat_garments.legacy_outfit_bridge` recorded so
 *   its use is observable.
 * - `none` — the common case: the fiction did not touch anyone's clothes.
 */
export const garmentMutationLanes = ["operations", "legacy", "none"] as const;
export const garmentMutationLaneSchema = z.enum(garmentMutationLanes);
export type GarmentMutationLane = z.infer<typeof garmentMutationLaneSchema>;

interface LegacyOutfitProposal {
  description: string;
  removed: readonly string[];
  added: readonly string[];
}

function legacyOutfitChanged(proposal: LegacyOutfitProposal | undefined): boolean {
  return Boolean(proposal && (proposal.description || proposal.removed.length || proposal.added.length));
}

export function garmentMutationLane(extraction: {
  garmentOperations: readonly unknown[];
  outfit?: LegacyOutfitProposal;
  playerOutfit?: LegacyOutfitProposal;
}): GarmentMutationLane {
  if (extraction.garmentOperations.length > 0) return "operations";
  if (legacyOutfitChanged(extraction.outfit) || legacyOutfitChanged(extraction.playerOutfit)) return "legacy";
  return "none";
}

// --- Proposal → operation -----------------------------------------------------

/** A proposal that could not become an operation, with the code it is dropped under. */
interface ProposalRejection {
  code: string;
  detail: string;
}

function reject(code: string, detail: string): ProposalRejection {
  return { code, detail };
}

function isRejection(value: unknown): value is ProposalRejection {
  return typeof value === "object" && value !== null && "code" in value;
}

/**
 * Resolve a returned part handle against ONE garment. Accepts both the fully
 * qualified form the prompt renders (`sabrina.shirt.sleeve_left`) and the bare
 * part id listed under it (`sleeve_left`) — an exact prefix strip, never a fuzzy
 * match. `null` ⇒ the handle names no part of this garment (OQ7: drop).
 */
export function resolveGarmentPartHandle(
  entry: GarmentHandleEntry,
  raw: string,
  rootPartId: string,
): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const bare =
    trimmed === entry.handle
      ? ""
      : trimmed.startsWith(`${entry.handle}.`)
        ? trimmed.slice(entry.handle.length + 1).trim()
        : trimmed;
  // The garment handle alone (or a trailing dot) unambiguously means the whole
  // garment, which IS the explicitly enumerated root.
  if (bare.length === 0) return rootPartId;
  return entry.partIds.includes(bare) ? bare : null;
}

/** The closure state an intent compiles to, given what the part's behavior actually is. */
function closureStateFor(
  blueprint: GarmentBlueprint,
  partId: string,
  intent: GarmentClosureIntent,
  openFasteners: number | undefined,
): GarmentClosureState {
  const binding = garmentBehaviorBindingFor(blueprint, partId);
  if (!binding || !isFastenerSeriesBehavior(binding.behavior)) {
    const openness: GarmentUnit =
      intent === "fastened" ? 0 : intent === "open" ? GARMENT_UNIT_ONE : Math.round(GARMENT_UNIT_ONE / 2);
    return { kind: "continuous", openness };
  }
  const count = binding.fastenerCount ?? 0;
  const wanted =
    intent === "fastened"
      ? 0
      : intent === "open"
        ? count
        : Math.min(count, Math.max(1, openFasteners ?? Math.round(count / 3)));
  // Fasteners open top→bottom, which is the order the series is stored in.
  return { kind: "fastener_series", openFastenerIndexes: Array.from({ length: wanted }, (_, index) => index) };
}

/** The actor a `move` targets: an explicitly named one, else whoever has it now. */
function moveActorId(
  table: GarmentHandleTable,
  store: ChatGarmentStore,
  garmentId: string,
  wearer: string | undefined,
): string | null {
  if (wearer) return garmentHandleActor(table, wearer)?.actorId ?? null;
  const instance = garmentInstanceById(store, garmentId);
  return instance ? (garmentLocusActorId(instance.locus) ?? null) : null;
}

/** The locus a `move` target compiles to, or a rejection. */
function moveLocus(
  proposal: Extract<GarmentOperationProposal, { op: "move" }>,
  table: GarmentHandleTable,
  store: ChatGarmentStore,
  garmentId: string,
  placeName: string | undefined,
): GarmentLocus | ProposalRejection {
  switch (proposal.to) {
    case "gone":
      return { kind: "gone", basis: "discarded" };
    case "left_here": {
      if (!placeName?.trim()) {
        return reject("garment_op.place_unresolved", "the scene has no named place — move dropped");
      }
      return { kind: "scene", placeName: placeName.trim(), anchor: proposal.anchor?.trim() ?? "" };
    }
    case "worn":
    case "held":
    case "put_away": {
      const actorId = moveActorId(table, store, garmentId, proposal.wearer);
      if (!actorId) {
        return reject(
          "garment_op.actor_unresolved",
          `no actor "${proposal.wearer ?? "(current holder)"}" — move dropped`,
        );
      }
      if (proposal.to === "put_away") return { kind: "wardrobe", ownerId: actorId };
      return proposal.to === "worn" ? { kind: "worn", actorId } : { kind: "held", actorId };
    }
  }
}

/** Where an `introduce` puts its new garment, or a rejection. */
function introduceLocus(
  proposal: Extract<GarmentOperationProposal, { op: "introduce" }>,
  table: GarmentHandleTable,
  placeName: string | undefined,
): GarmentLocus | ProposalRejection {
  if (proposal.at === "here") {
    if (!placeName?.trim()) {
      return reject("garment_op.place_unresolved", "the scene has no named place — introduce dropped");
    }
    return { kind: "scene", placeName: placeName.trim(), anchor: proposal.anchor?.trim() ?? "" };
  }
  // A named wearer wins; with exactly one modelled actor the answer is unambiguous
  // and defaulting is not a guess. With several, an unnamed wearer IS ambiguous —
  // dropping beats dressing the wrong body.
  const actor = proposal.wearer
    ? garmentHandleActor(table, proposal.wearer)
    : table.actors.length === 1
      ? table.actors[0]
      : undefined;
  if (!actor) {
    return reject(
      "garment_op.actor_unresolved",
      `no actor "${proposal.wearer ?? "(unnamed)"}" to give it to — introduce dropped`,
    );
  }
  return proposal.at === "worn"
    ? { kind: "worn", actorId: actor.actorId }
    : { kind: "held", actorId: actor.actorId };
}

/**
 * One non-`introduce` proposal → one typed operation, or a rejection. PURE.
 * Handles are resolved here; everything structural (channel bindings, closure
 * shapes, `gone` loci) is left to the dispatcher, which owns those rules.
 */
export function garmentOperationForProposal(input: {
  proposal: Exclude<GarmentOperationProposal, { op: "introduce" }>;
  entry: GarmentHandleEntry;
  table: GarmentHandleTable;
  store: ChatGarmentStore;
  placeName?: string;
}): GarmentOperation | ProposalRejection {
  const { proposal, entry, store } = input;
  const garmentId = entry.garmentId;
  const instance = garmentInstanceById(store, garmentId);
  if (!instance) {
    return reject(
      "garment_op.garment_unresolved",
      `garment handle "${proposal.garment}" no longer names an instance — ${proposal.op} dropped`,
    );
  }
  const blueprint = garmentBlueprintFor(store, instance);
  const rootPartId = blueprint.rootNodeId;

  const onePart = (raw: string): string | ProposalRejection => {
    const partId = resolveGarmentPartHandle(entry, raw, rootPartId);
    return partId === null
      ? reject("garment_op.part_unresolved", `no garment part "${raw}" on ${entry.handle} — ${proposal.op} dropped`)
      : partId;
  };
  const manyParts = (raws: readonly string[]): string[] | ProposalRejection => {
    const out: string[] = [];
    for (const raw of raws) {
      const partId = onePart(raw);
      if (typeof partId !== "string") return partId;
      if (!out.includes(partId)) out.push(partId);
    }
    return out;
  };

  switch (proposal.op) {
    case "move": {
      const to = moveLocus(proposal, input.table, store, garmentId, input.placeName);
      return isRejection(to) ? to : { kind: "transfer", garmentId, to };
    }
    case "closure": {
      const partId = onePart(proposal.part);
      if (typeof partId !== "string") return partId;
      return {
        kind: "set_closure",
        garmentId,
        partId,
        state: closureStateFor(blueprint, partId, proposal.state, proposal.openFasteners),
      };
    }
    case "roll": {
      const partId = onePart(proposal.part);
      if (typeof partId !== "string") return partId;
      return { kind: "set_roll", garmentId, partId, degree: proposal.degree };
    }
    case "tuck": {
      const partId = onePart(proposal.part);
      if (typeof partId !== "string") return partId;
      return { kind: "set_tuck", garmentId, partId, state: proposal.state };
    }
    case "displace": {
      const partId = onePart(proposal.part);
      if (typeof partId !== "string") return partId;
      return {
        kind: "set_displacement",
        garmentId,
        partId,
        displacement: proposal.displacement,
        degree: proposal.degree,
      };
    }
    case "damage": {
      const partId = onePart(proposal.part);
      if (typeof partId !== "string") return partId;
      return { kind: "damage", garmentId, partId, damageKind: proposal.damage, degree: proposal.degree };
    }
    case "restore": {
      const partIds = manyParts(proposal.parts);
      if (!Array.isArray(partIds)) return partIds;
      return { kind: "restore_presentation", garmentId, partIds };
    }
    case "condition": {
      const partIds = manyParts(proposal.parts);
      if (!Array.isArray(partIds)) return partIds;
      return {
        kind: "apply_condition",
        garmentId,
        partIds,
        channel: proposal.channel,
        change: { direction: proposal.direction, degree: proposal.degree },
      };
    }
    case "deposit": {
      const partIds = manyParts(proposal.parts);
      if (!Array.isArray(partIds)) return partIds;
      return { kind: "deposit", garmentId, partIds, depositKind: proposal.substance, degree: proposal.degree };
    }
    case "clean": {
      const partIds = manyParts(proposal.parts);
      if (!Array.isArray(partIds)) return partIds;
      return { kind: "clean", garmentId, partIds, target: proposal.target };
    }
  }
}

// --- The fold -----------------------------------------------------------------

export interface GarmentProposalFold {
  store: ChatGarmentStore;
  trace: GarmentOperationTraceEntry[];
  /** How many proposals actually changed the store (the look-refresh trigger). */
  applied: number;
}

export interface GarmentProposalContext {
  store: ChatGarmentStore;
  table: GarmentHandleTable;
  atMinutes: number;
  /** Fresh instance ids for R2 mints (the caller passes `newId`; tests a counter). */
  mintId: () => string;
  /** The place the scene is in — where `left_here` / `at: "here"` land. */
  placeName?: string;
  sink?: DiagnosticSink;
}

/**
 * Apply a whole exchange's proposals to the store, IN FICTION ORDER — an
 * impossible later operation is dropped with a stable diagnostic. PURE: the
 * caller injects `mintId` and persists.
 *
 * Each proposal goes to the ONE dispatcher (`applyGarmentOperations`) on its own,
 * threading the store forward, so a transfer really does precede a part operation
 * on the transferred garment and each proposal's own outcome stays attributable —
 * which a single batched call could not give the trace. An `introduce` mints in
 * place and registers its coined handle, so a later proposal in the same list can
 * address the garment the fiction just produced.
 */
export function applyGarmentProposals(
  proposals: readonly GarmentOperationProposal[],
  ctx: GarmentProposalContext,
): GarmentProposalFold {
  let store = ctx.store;
  let applied = 0;
  let introduced = 0;
  const trace: GarmentOperationTraceEntry[] = [];
  /** Handles minted this exchange, so a later proposal can address a new garment. */
  const minted = new Map<string, GarmentHandleEntry>();

  const rejectRow = (op: string, garment: string, garmentId: string, rejection: ProposalRejection): void => {
    trace.push({ op, garment, garmentId, outcome: "rejected", code: rejection.code, detail: rejection.detail });
    ctx.sink?.push(diag("info", rejection.code, rejection.detail));
  };

  for (const proposal of proposals.slice(0, GARMENT_PROPOSAL_MAX)) {
    if (proposal.op === "introduce") {
      const handle = proposal.handle.trim();
      const duplicate = garmentHandleEntry(ctx.table, handle) ?? minted.get(handle);
      if (duplicate) {
        rejectRow(
          proposal.op,
          handle,
          duplicate.garmentId,
          reject(
            "garment_op.introduce_duplicate",
            `handle "${handle}" already names a garment in scope — introduce dropped`,
          ),
        );
        continue;
      }
      if (introduced >= GARMENT_INTRODUCE_MAX) {
        rejectRow(
          proposal.op,
          handle,
          "",
          reject(
            "garment_op.introduce_capped",
            `more than ${GARMENT_INTRODUCE_MAX} garments introduced this exchange — dropped`,
          ),
        );
        continue;
      }
      const locus = introduceLocus(proposal, ctx.table, ctx.placeName);
      if (isRejection(locus)) {
        rejectRow(proposal.op, handle, "", locus);
        continue;
      }
      const category = clothingCategoryById(proposal.category);
      if (!category) {
        ctx.sink?.push(
          diag(
            "info",
            "garment_op.introduce_category_unknown",
            `unknown clothing category "${proposal.category}" — minted a bare garment that covers nothing`,
          ),
        );
      }
      const blueprint = mintGarmentBlueprint({
        ...(category ? { categoryId: category.id } : {}),
        materialProfileId: inferGarmentMaterialProfile([proposal.name, proposal.material ?? ""].join(" ")),
      });
      const result = instantiateGarment(
        store,
        { id: ctx.mintId(), blueprint, name: proposal.name, locus, atMinutes: ctx.atMinutes },
        ctx.sink,
      );
      store = result.store;
      introduced += 1;
      applied += 1;
      const partIds = blueprint.nodes.map((node) => node.id);
      minted.set(handle, {
        handle,
        garmentId: result.instance.id,
        name: result.instance.name,
        where: "introduced this exchange",
        locusKind: locus.kind,
        partHandles: partIds,
        partIds,
      });
      trace.push({
        op: proposal.op,
        garment: handle,
        garmentId: result.instance.id,
        outcome: "applied",
        code: "",
        detail: `minted ${proposal.name}${category ? ` (${category.id})` : ""}`,
      });
      continue;
    }

    const entry = garmentHandleEntry(ctx.table, proposal.garment) ?? minted.get(proposal.garment.trim());
    if (!entry) {
      rejectRow(
        proposal.op,
        proposal.garment,
        "",
        reject(
          "garment_op.garment_unresolved",
          `no garment handle "${proposal.garment}" in scope — ${proposal.op} dropped`,
        ),
      );
      continue;
    }
    const operation = garmentOperationForProposal({
      proposal,
      entry,
      table: ctx.table,
      store,
      ...(ctx.placeName === undefined ? {} : { placeName: ctx.placeName }),
    });
    if (isRejection(operation)) {
      rejectRow(proposal.op, proposal.garment, entry.garmentId, operation);
      continue;
    }
    const local = new DiagnosticCollector();
    const result = applyGarmentOperations(store, [operation], { atMinutes: ctx.atMinutes, sink: local });
    store = result.store;
    for (const item of local.items) ctx.sink?.push(item);
    const dropped = local.items.find((item) => item.code.startsWith("garment_op."));
    if (result.applied > 0) applied += 1;
    trace.push({
      op: proposal.op,
      garment: proposal.garment,
      garmentId: entry.garmentId,
      outcome: dropped ? "rejected" : result.applied > 0 ? "applied" : "no_change",
      code: dropped?.code ?? "",
      detail: dropped?.message ?? "",
    });
  }

  return { store, trace: trace.slice(0, GARMENT_TRACE_MAX), applied };
}
