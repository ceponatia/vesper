import { z } from "zod";
import { garmentDegreeBandSchema, garmentUnitSchema, GARMENT_UNIT_ONE, type GarmentUnit } from "./garment-material";
import {
  garmentBlueprintSchema,
  garmentPartIdSchema,
  GARMENT_ROOT_PART_ID,
  type GarmentBlueprint,
} from "./garment-blueprint";
import {
  effectiveCoverageReadSchema,
  emptyEffectiveCoverageRead,
  type EffectiveCoverageRead,
} from "./effective-coverage-read";

/**
 * Garment INSTANCE state (clothing-state-graph.plan.md §"Garment instance and
 * locus" / §"Condition vector" / §"Typed mutation surface"; slice-0 audit OQ2).
 *
 * A library item is a blueprint; a conversation needs a stable instance with its
 * own locus and mutable state. Instances carry a `blueprintHash` into the
 * chat-wide blueprint map (never a library pointer, OQ2), so a later library
 * edit cannot change an established scene and a retake restores instances and
 * blueprints together out of one rollback blob.
 *
 * This module is SCHEMAS + TYPES + DEGRADED DEFAULTS only. Reducers, condition
 * integration and the derived wardrobe read are slices 3–4; the typed operation
 * union here is the contract they and the slice-5 extractor share.
 */

// --- Caps (the chat-wide store is one JSONB field, so it is bounded) ----------

/** Max live instances in one chat's store; `gone` garments are evicted oldest-first. */
export const CHAT_GARMENTS_MAX = 48;
/** Max distinct blueprint snapshots — content hashing keeps this far below the instance cap. */
export const CHAT_GARMENT_BLUEPRINTS_MAX = 48;
/** Max deposits tracked on one garment (sparse located facts, not a ledger). */
export const GARMENT_MAX_DEPOSITS = 12;
/** Max damage marks on one garment. */
export const GARMENT_MAX_DAMAGE_MARKS = 12;
/** Max region overrides (parts differing from the garment baseline). */
export const GARMENT_MAX_REGION_OVERRIDES = 16;
/** Max operations accepted from one continuity proposal. */
export const GARMENT_MAX_OPERATIONS = 12;
/** Length cap on a scene anchor phrase ("over the desk chair"). */
export const GARMENT_ANCHOR_MAX_CHARS = 80;
/** Max actors whose captured effective-coverage read one store retains (character + player + slack). */
export const CHAT_GARMENT_COVERAGE_MAX_ACTORS = 8;

const garmentInstanceIdSchema = z.string().trim().min(1).max(64);
const actorHandleSchema = z.string().trim().min(1).max(64);
/** Chat clock reading (minutes since the conversation's first beat) — the lane's story time. */
const storyMinutesSchema = z.number().int().min(0).catch(0);

export type GarmentInstanceId = z.infer<typeof garmentInstanceIdSchema>;

// --- Locus --------------------------------------------------------------------

export const garmentGoneBases = ["lost", "destroyed", "discarded"] as const;
export const garmentGoneBasisSchema = z.enum(garmentGoneBases);
export type GarmentGoneBasis = z.infer<typeof garmentGoneBasisSchema>;

/**
 * Where a garment IS. The `scene` locus snapshots the place NAME rather than a
 * key, because chat `ScenePlace` has no id (audit wrong-assumption 2): it is
 * name-keyed, matched with `samePlaceName`, and evicted oldest-out at 12. The
 * snapshot means a garment survives its room falling out of scene memory — a
 * jacket must never vanish because the study was forgotten (R3).
 */
export const garmentLocusSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("wardrobe"), ownerId: actorHandleSchema }).strict(),
  z.object({ kind: z.literal("worn"), actorId: actorHandleSchema }).strict(),
  z.object({ kind: z.literal("held"), actorId: actorHandleSchema }).strict(),
  z
    .object({
      kind: z.literal("scene"),
      /** The place name as it read when the garment was left there. */
      placeName: z.string().trim().min(1).max(60),
      /** Short grounded anchor ("over the desk chair") — not a spatial model. */
      anchor: z.string().trim().max(GARMENT_ANCHOR_MAX_CHARS).catch("").default(""),
    })
    .strict(),
  z.object({ kind: z.literal("gone"), basis: garmentGoneBasisSchema }).strict(),
]);
export type GarmentLocus = z.infer<typeof garmentLocusSchema>;
export type GarmentLocusKind = GarmentLocus["kind"];

/** True when a locus makes the garment contribute coverage this cut. */
export function garmentLocusIsWorn(locus: GarmentLocus): boolean {
  return locus.kind === "worn";
}

// --- Presentation -------------------------------------------------------------

/**
 * Closure state. BOTH shapes normalize in ONE direction: `0` means fully
 * fastened, `1` (GARMENT_UNIT_ONE) fully open. `fastener_series` stores which
 * fasteners are open, ordered top→bottom, so individual buttons change without
 * becoming graph nodes.
 */
export const garmentClosureStateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("continuous"), openness: garmentUnitSchema }).strict(),
  z
    .object({
      kind: z.literal("fastener_series"),
      openFastenerIndexes: z
        .array(z.number().int().min(0).max(64))
        .default([])
        .transform((values) => [...new Set(values)].sort((a, b) => a - b)),
    })
    .strict(),
]);
export type GarmentClosureState = z.infer<typeof garmentClosureStateSchema>;

export const garmentTuckStates = ["out", "partial", "in"] as const;
export const garmentTuckStateSchema = z.enum(garmentTuckStates);
export type GarmentTuckState = z.infer<typeof garmentTuckStateSchema>;

/**
 * Displacement kinds with a coverage law (OQ6). Deliberately only the two the
 * audit rules on — `off_shoulder` (a strap) and `lifted` (a hem). A kind with
 * no law would be a coverage decision nobody made.
 */
export const garmentDisplacementKinds = ["off_shoulder", "lifted"] as const;
export const garmentDisplacementKindSchema = z.enum(garmentDisplacementKinds);
export type GarmentDisplacementKind = z.infer<typeof garmentDisplacementKindSchema>;

export const garmentDisplacementSchema = z
  .object({
    partId: garmentPartIdSchema,
    kind: garmentDisplacementKindSchema,
    /** `0` = seated/down, `1` = fully displaced. */
    degree: garmentUnitSchema,
  })
  .strict();
export type GarmentDisplacement = z.infer<typeof garmentDisplacementSchema>;

/**
 * Sparse and typed: a channel is present only where a part's behavior binding
 * supports it, and absent means the neutral state (fastened · unrolled · out ·
 * seated). Storage is fixed point; models and UI speak bands.
 */
export const garmentPresentationStateSchema = z.object({
  closure: z.record(garmentPartIdSchema, garmentClosureStateSchema).catch({}).default({}),
  roll: z.record(garmentPartIdSchema, garmentUnitSchema).catch({}).default({}),
  tuck: z.record(garmentPartIdSchema, garmentTuckStateSchema).catch({}).default({}),
  displacement: z.array(garmentDisplacementSchema).catch([]).default([]),
});
export type GarmentPresentationState = z.infer<typeof garmentPresentationStateSchema>;

/** The neutral presentation: everything fastened, unrolled, out, seated. */
export function emptyGarmentPresentationState(): GarmentPresentationState {
  return { closure: {}, roll: {}, tuck: {}, displacement: [] };
}

/**
 * Normalized open fraction of any closure state (0 fastened → 1 open) — the ONE
 * place the two closure shapes are reconciled, so no consumer re-derives the
 * direction. `fastenerCount` comes from the part's behavior binding.
 */
export function garmentClosureOpenFraction(
  state: GarmentClosureState | undefined,
  fastenerCount: number | undefined,
): GarmentUnit {
  if (!state) return 0;
  switch (state.kind) {
    case "continuous":
      return state.openness;
    case "fastener_series": {
      if (fastenerCount === undefined || fastenerCount <= 0) return 0;
      const open = state.openFastenerIndexes.filter((index) => index >= 0 && index < fastenerCount).length;
      return Math.round((open / fastenerCount) * GARMENT_UNIT_ONE);
    }
  }
}

// --- Condition ----------------------------------------------------------------

/**
 * v1 channels (plan §"Condition vector"). Directions, all `0 → 1` in fixed
 * point: `wetness` dry→saturated, `cleanliness` soiled→clean (matching
 * `item-condition-v1`, where 10_000 is fresh), `crease_load` smooth→wrinkled,
 * `wear` pristine→worn out.
 */
export const garmentConditionKeys = ["wetness", "cleanliness", "crease_load", "wear"] as const;
export const garmentConditionKeySchema = z.enum(garmentConditionKeys);
export type GarmentConditionKey = z.infer<typeof garmentConditionKeySchema>;

export const garmentConditionVectorSchema = z
  .object({
    wetness: garmentUnitSchema.catch(0).default(0),
    cleanliness: garmentUnitSchema.catch(GARMENT_UNIT_ONE).default(GARMENT_UNIT_ONE),
    crease_load: garmentUnitSchema.catch(0).default(0),
    wear: garmentUnitSchema.catch(0).default(0),
  })
  .strict();
export type GarmentConditionVector = z.infer<typeof garmentConditionVectorSchema>;

/** A dry, clean, smooth, pristine garment. */
export function pristineGarmentConditionVector(): GarmentConditionVector {
  return garmentConditionVectorSchema.parse({});
}

/**
 * Per-part deviation from the base vector — a wet hem on an otherwise dry shirt.
 *
 * Spelled out rather than `garmentConditionVectorSchema.partial()`, because the
 * vector's per-field `.default()`s survive `.partial()`: that spelling parses a
 * one-channel override into a DENSE four-channel one on every jsonb round trip,
 * which would make every part claim to override everything, defeat the
 * converge-and-drop lifecycle, and break byte-identical retake restore. An
 * absent channel here means "inherit the base", and must stay absent.
 */
export const garmentConditionOverrideSchema = z
  .object({
    wetness: garmentUnitSchema.optional().catch(undefined),
    cleanliness: garmentUnitSchema.optional().catch(undefined),
    crease_load: garmentUnitSchema.optional().catch(undefined),
    wear: garmentUnitSchema.optional().catch(undefined),
  })
  .strict();
export type GarmentConditionOverride = z.infer<typeof garmentConditionOverrideSchema>;

export const garmentDepositKinds = ["mud", "blood", "dust", "food", "paint", "cosmetic", "unknown"] as const;
export const garmentDepositKindSchema = z.enum(garmentDepositKinds);
export type GarmentDepositKind = z.infer<typeof garmentDepositKindSchema>;

export const garmentDepositSchema = z
  .object({
    id: z.string().trim().min(1).max(64),
    kind: garmentDepositKindSchema.catch("unknown").default("unknown"),
    /** Parts carrying it; empty ⇒ the whole garment (the root). */
    partIds: z.array(garmentPartIdSchema).catch([]).default([]),
    intensity: garmentUnitSchema.catch(0).default(0),
    extent: garmentUnitSchema.catch(0).default(0),
    /** `1` = just happened, decaying toward dried/set — drives phrasing, not removal. */
    freshness: garmentUnitSchema.catch(GARMENT_UNIT_ONE).default(GARMENT_UNIT_ONE),
    cause: z.string().trim().max(80).optional().catch(undefined),
    atMinutes: storyMinutesSchema.default(0),
  })
  .strict();
export type GarmentDeposit = z.infer<typeof garmentDepositSchema>;

export const garmentDamageKinds = ["tear", "hole", "fray", "scuff", "burn", "missing_fastener"] as const;
export const garmentDamageKindSchema = z.enum(garmentDamageKinds);
export type GarmentDamageKind = z.infer<typeof garmentDamageKindSchema>;

export const garmentDamageMarkSchema = z
  .object({
    id: z.string().trim().min(1).max(64),
    kind: garmentDamageKindSchema.catch("scuff").default("scuff"),
    /** Exactly one part — a torn cuff is located, not a global `damage = 62`. */
    partId: garmentPartIdSchema,
    severity: garmentUnitSchema.catch(0).default(0),
    extent: garmentUnitSchema.catch(0).default(0),
    cause: z.string().trim().max(80).optional().catch(undefined),
    atMinutes: storyMinutesSchema.default(0),
  })
  .strict();
export type GarmentDamageMark = z.infer<typeof garmentDamageMarkSchema>;

/**
 * The base gradient is a DEFAULT, not an average that overwrites detail: a wet
 * hem override coexists with a dry garment base, and whole-garment bands derive
 * from the visible weighted regions rather than replacing them.
 */
export const garmentConditionStateSchema = z.object({
  base: garmentConditionVectorSchema.catch(pristineGarmentConditionVector()).default(pristineGarmentConditionVector()),
  regionOverrides: z
    .record(garmentPartIdSchema, garmentConditionOverrideSchema)
    .catch({})
    .default({})
    .transform((overrides) =>
      Object.fromEntries(Object.entries(overrides).slice(0, GARMENT_MAX_REGION_OVERRIDES)),
    ),
  deposits: z
    .array(garmentDepositSchema)
    .catch([])
    .default([])
    .transform((deposits) => deposits.slice(-GARMENT_MAX_DEPOSITS)),
  damageMarks: z
    .array(garmentDamageMarkSchema)
    .catch([])
    .default([])
    .transform((marks) => marks.slice(-GARMENT_MAX_DAMAGE_MARKS)),
  /** Chat clock minute the gradients were last integrated to. */
  integratedAtMinutes: storyMinutesSchema.default(0),
});
export type GarmentConditionState = z.infer<typeof garmentConditionStateSchema>;

/** A fresh garment: pristine base, nothing local, integrated at story minute 0. */
export function pristineGarmentConditionState(): GarmentConditionState {
  return {
    base: pristineGarmentConditionVector(),
    regionOverrides: {},
    deposits: [],
    damageMarks: [],
    integratedAtMinutes: 0,
  };
}

// --- Instance -----------------------------------------------------------------

/**
 * Coarse novelty stamp for the cue ranker — WHAT last changed and WHEN, not a
 * replay log. Finer provenance rides the operation trace (slice 5).
 */
export const garmentChangeKinds = ["mint", "transfer", "presentation", "condition", "damage", "repair"] as const;
export const garmentChangeKindSchema = z.enum(garmentChangeKinds);
export type GarmentChangeKind = z.infer<typeof garmentChangeKindSchema>;

export const garmentChangeStampSchema = z
  .object({
    kind: garmentChangeKindSchema.catch("mint").default("mint"),
    atMinutes: storyMinutesSchema.default(0),
  })
  .strict();
export type GarmentChangeStamp = z.infer<typeof garmentChangeStampSchema>;

export const garmentInstanceStateSchema = z.object({
  id: garmentInstanceIdSchema,
  /** Content hash into the chat store's `blueprints` map (OQ2) — never a library id. */
  blueprintHash: z.string().trim().min(1).max(64),
  /** Provenance only. A dangling/edited library row can never change this instance. */
  definitionId: z.string().trim().min(1).max(64).optional().catch(undefined),
  /** Display name captured at mint time so a deleted library row still reads. */
  name: z.string().trim().min(1).max(120).catch("garment").default("garment"),
  locus: garmentLocusSchema,
  presentation: garmentPresentationStateSchema
    .catch(emptyGarmentPresentationState())
    .default(emptyGarmentPresentationState()),
  condition: garmentConditionStateSchema
    .catch(pristineGarmentConditionState())
    .default(pristineGarmentConditionState()),
  lastChange: garmentChangeStampSchema.catch({ kind: "mint", atMinutes: 0 }).default({ kind: "mint", atMinutes: 0 }),
});
export type GarmentInstanceState = z.infer<typeof garmentInstanceStateSchema>;

// --- Cue memory (slice 6) -----------------------------------------------------

/** Max entries any one cue-memory record retains (oldest keys drop on overflow). */
export const GARMENT_CUE_MEMORY_MAX = 48;

const cueKeySchema = z.string().trim().min(1).max(160);
const cueBandSchema = z.string().trim().min(1).max(40);

/** Bound one cue-memory record — the same slice-the-entries shape the blueprint map uses. */
function capCueRecord<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).slice(0, GARMENT_CUE_MEMORY_MAX));
}

/**
 * What the narrator has already SAID about the wardrobe, and the bands it said it
 * in (clothing-state-graph.plan.md §"Narration and image policy"; audit §1.6).
 *
 * It lives inside the store rather than beside it for exactly one reason: fixture
 * F13 requires a retake to restore "instances, blueprint map, presentation,
 * condition, `integratedAt`, **and the observation repeat-key map**" identically.
 * Riding the same JSONB value as the state it describes makes that structural —
 * mention history can never be restored one exchange out of step with the
 * garments it mentions, and no second rollback anchor exists to drift.
 *
 * Three records, all flat `key → band` maps so a change is a string compare:
 *
 * - `cues` — `garment:part:kind` → the band last surfaced (the plan's `repeatKey`
 *   minus its band suffix, exactly the `surfacedCues` shape);
 * - `bands` — `garmentId` → the condition bands last REPORTED, which is the
 *   durable home slice 4's `hystereticGarmentConditionBand` asks for, so a value
 *   parked on a boundary cannot alternate damp/wet between exchanges;
 * - `changedAt` — `garment:part:kind` → the chat-clock minute that band last moved.
 */
export const garmentCueStateSchema = z.object({
  cues: z.record(cueKeySchema, cueBandSchema).catch({}).default({}).transform(capCueRecord),
  // Keyed by `GarmentConditionKey`, but typed as a plain string record on purpose:
  // an enum-keyed `z.record` is TOTAL in zod, and a garment that reported only
  // `wetness` must not round-trip as claiming all four channels.
  bands: z.record(cueKeySchema, z.record(cueKeySchema, cueBandSchema).catch({})).catch({}).default({}).transform(capCueRecord),
  changedAt: z.record(cueKeySchema, storyMinutesSchema).catch({}).default({}).transform(capCueRecord),
});
export type GarmentCueState = z.infer<typeof garmentCueStateSchema>;

/** No mention history yet — the degraded default and the pre-seed value. */
export function emptyGarmentCueState(): GarmentCueState {
  return { cues: {}, bands: {}, changedAt: {} };
}

// --- Chat-wide store ----------------------------------------------------------

/**
 * The chat-wide garment store (audit ruling P): ONE field, so it inherits the
 * existing `pre_exchange_scenario` rollback wholesale — instances and their
 * blueprint map restore together and a hash can never dangle across a retake.
 *
 * `seeded` breaks the same ambiguity `ChatPlayerState.seeded` does: an empty
 * store means "not migrated" before seeding and "wearing nothing" after.
 */
const garmentBlueprintHashKeySchema = z.string().trim().min(1).max(64);

export const chatGarmentStoreSchema = z
  .object({
    seeded: z.boolean().catch(false).default(false),
    /**
     * Parsed PER ENTRY, never with a map-wide `.catch({})`: `instances` parse
     * independently and `seeded` stays true, so a map-wide catch would turn ONE
     * unreadable snapshot into "every garment in the chat covers nothing" — the
     * empty-because-failed → confirmed-bare class PR #152 closed. A malformed
     * entry drops alone; an object entry that lost construction still parses,
     * as a `degraded`-marked blueprint the resolution layer reports unreliable.
     */
    blueprints: z
      .record(z.string(), z.unknown())
      .catch({})
      .default({})
      .transform((entries) => {
        const kept: Record<string, GarmentBlueprint> = {};
        for (const [key, value] of Object.entries(entries)) {
          const hash = garmentBlueprintHashKeySchema.safeParse(key);
          const blueprint = garmentBlueprintSchema.safeParse(value);
          if (hash.success && blueprint.success) kept[hash.data] = blueprint.data;
        }
        return kept;
      }),
    instances: z
      .array(garmentInstanceStateSchema)
      .catch([])
      .default([])
      .transform((instances) => capGarmentInstances(instances)),
    /** Narrator mention history + reported bands (slice 6) — see `garmentCueStateSchema`. */
    cues: garmentCueStateSchema.catch(emptyGarmentCueState()).default(emptyGarmentCueState()),
    /**
     * The CAPTURED effective-coverage read per garment actor handle
     * (body-attribute-affordances slice 6; the owner ruling "effective coverage is
     * captured, not reconstructed").
     *
     * It rides inside the store for the same structural reason `cues` does: the
     * store is the presentation cut, and a derived read that lived anywhere else
     * could be restored one exchange out of step with the garments it describes.
     * One JSONB field, one rollback anchor (`pre_exchange_scenario`), byte-stable
     * on a retake.
     *
     * DERIVED, never truth: nothing reads it to decide what a garment IS. It
     * exists so narration, body affordances, retakes, and images share one answer
     * about what is still concealed rather than each recomputing one.
     */
    coverage: z
      .record(actorHandleSchema, effectiveCoverageReadSchema)
      .catch({})
      .default({})
      .transform((captures) => Object.fromEntries(Object.entries(captures).slice(0, CHAT_GARMENT_COVERAGE_MAX_ACTORS))),
  })
  .transform((store) => ({ ...store, blueprints: capGarmentBlueprints(store.blueprints, store.instances) }));
export type ChatGarmentStore = z.infer<typeof chatGarmentStoreSchema>;

/**
 * Cap the blueprint map at `CHAT_GARMENT_BLUEPRINTS_MAX`. At or under the cap
 * the map is returned UNTOUCHED, so every store the reducers produce round-trips
 * byte-identically. Over it — the bounded overfill `instantiateGarment` may
 * persist rather than mint a dangling instance — instance-referenced entries are
 * kept before orphans, each side in stored order, so trimming can never dangle a
 * hash a live instance points at (a blind first-N slice would cut the NEWEST
 * entry: exactly the one the over-cap mint just referenced).
 */
function capGarmentBlueprints(
  blueprints: Record<string, GarmentBlueprint>,
  instances: readonly GarmentInstanceState[],
): Record<string, GarmentBlueprint> {
  const entries = Object.entries(blueprints);
  if (entries.length <= CHAT_GARMENT_BLUEPRINTS_MAX) return blueprints;
  const referenced = new Set(instances.map((instance) => instance.blueprintHash));
  const ranked = [
    ...entries.filter(([hash]) => referenced.has(hash)),
    ...entries.filter(([hash]) => !referenced.has(hash)),
  ];
  return Object.fromEntries(ranked.slice(0, CHAT_GARMENT_BLUEPRINTS_MAX));
}

/** The empty store — the degraded default and the pre-seed value. */
export function emptyChatGarmentStore(): ChatGarmentStore {
  return { seeded: false, blueprints: {}, instances: [], cues: emptyGarmentCueState(), coverage: {} };
}

/** This actor's captured coverage read, or the empty one when nothing was captured. */
export function capturedGarmentCoverage(store: ChatGarmentStore, actorId: string): EffectiveCoverageRead {
  return store.coverage[actorId] ?? emptyEffectiveCoverageRead();
}

/**
 * Cap the instance list at `CHAT_GARMENTS_MAX`, evicting `gone` garments
 * oldest-first before ever dropping a live one (a jacket on a chair outranks a
 * garment the fiction destroyed three scenes ago).
 */
export function capGarmentInstances(instances: readonly GarmentInstanceState[]): GarmentInstanceState[] {
  if (instances.length <= CHAT_GARMENTS_MAX) return [...instances];
  let overflow = instances.length - CHAT_GARMENTS_MAX;
  const kept: GarmentInstanceState[] = [];
  for (const instance of instances) {
    if (overflow > 0 && instance.locus.kind === "gone") {
      overflow -= 1;
      continue;
    }
    kept.push(instance);
  }
  return kept.slice(-CHAT_GARMENTS_MAX);
}

// --- Typed mutation surface ---------------------------------------------------

/**
 * The semantic degree change an `apply_condition` operation carries — a band
 * and a direction, never a raw value. The reducer maps it to a clamped
 * fixed-point source (slice 4).
 */
export const garmentDegreeDeltaSchema = z
  .object({
    direction: z.enum(["increase", "decrease"]),
    degree: garmentDegreeBandSchema,
  })
  .strict();
export type GarmentDegreeDelta = z.infer<typeof garmentDegreeDeltaSchema>;

/** How thoroughly a `clean` operation is meant to land. */
export const garmentCleanTargets = ["spot", "clean", "pristine"] as const;
export const garmentCleanTargetSchema = z.enum(garmentCleanTargets);
export type GarmentCleanTarget = z.infer<typeof garmentCleanTargetSchema>;

/**
 * `partIds: []` is LEGAL on the condition-class operations and means the ROOT —
 * a first-class garment-scoped change, not a fallback (OQ7). Every other
 * operation names an exact part and is DROPPED with a diagnostic when the
 * handle does not resolve.
 */
export const garmentPartIdsSchema = z.array(garmentPartIdSchema).catch([]).default([]);

export const garmentOperationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("transfer"), garmentId: garmentInstanceIdSchema, to: garmentLocusSchema }).strict(),
  z
    .object({
      kind: z.literal("set_closure"),
      garmentId: garmentInstanceIdSchema,
      partId: garmentPartIdSchema,
      state: garmentClosureStateSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("set_roll"),
      garmentId: garmentInstanceIdSchema,
      partId: garmentPartIdSchema,
      degree: garmentDegreeBandSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("set_tuck"),
      garmentId: garmentInstanceIdSchema,
      partId: garmentPartIdSchema,
      state: garmentTuckStateSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("set_displacement"),
      garmentId: garmentInstanceIdSchema,
      partId: garmentPartIdSchema,
      displacement: garmentDisplacementKindSchema,
      degree: garmentDegreeBandSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("restore_presentation"),
      garmentId: garmentInstanceIdSchema,
      partIds: garmentPartIdsSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("apply_condition"),
      garmentId: garmentInstanceIdSchema,
      partIds: garmentPartIdsSchema,
      channel: garmentConditionKeySchema,
      change: garmentDegreeDeltaSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("deposit"),
      garmentId: garmentInstanceIdSchema,
      partIds: garmentPartIdsSchema,
      // A contaminant the model invented ("glitter") degrades to `unknown`
      // rather than voiding the operation: something IS on the garment, and the
      // registry's fallback kind is the honest way to say so.
      depositKind: garmentDepositKindSchema.catch("unknown"),
      degree: garmentDegreeBandSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("clean"),
      garmentId: garmentInstanceIdSchema,
      partIds: garmentPartIdsSchema,
      target: garmentCleanTargetSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("damage"),
      garmentId: garmentInstanceIdSchema,
      partId: garmentPartIdSchema,
      /** An unregistered damage word degrades to the mildest mark, never to a drop. */
      damageKind: garmentDamageKindSchema.catch("scuff"),
      degree: garmentDegreeBandSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("repair"),
      garmentId: garmentInstanceIdSchema,
      markIds: z.array(z.string().trim().min(1).max(64)).catch([]).default([]),
    })
    .strict(),
]);
export type GarmentOperation = z.infer<typeof garmentOperationSchema>;
export type GarmentOperationKind = GarmentOperation["kind"];

/**
 * The three CONDITION-CLASS operations for which an empty `partIds` legally
 * means the whole garment (OQ7) — "rain soaked her coat" needs no fallback.
 * `restore_presentation` is deliberately NOT here: the audit lists it among the
 * operations that never fall back, so an empty list restores nothing — the slice-3
 * reducer drops it with `garment_op.restore_no_parts` rather than silently
 * no-opping, and a whole-garment restore is authored by naming the parts.
 */
export const GARMENT_ROOT_SCOPED_OPERATIONS: readonly GarmentOperationKind[] = [
  "apply_condition",
  "deposit",
  "clean",
];

/** The part ids an operation addresses; empty `partIds` resolves to the root only for the three above. */
export function garmentOperationPartIds(operation: GarmentOperation): readonly string[] {
  switch (operation.kind) {
    case "set_closure":
    case "set_roll":
    case "set_tuck":
    case "set_displacement":
    case "damage":
      return [operation.partId];
    case "apply_condition":
    case "deposit":
    case "clean":
      return operation.partIds.length > 0 ? operation.partIds : [GARMENT_ROOT_PART_ID];
    case "restore_presentation":
      return operation.partIds;
    case "transfer":
    case "repair":
      return [];
  }
}

/**
 * A continuity proposal's operation list. Parsed PER ITEM so one malformed
 * operation is dropped instead of voiding the whole proposal — the plan's
 * "invalid or ambiguous proposals are no-ops with diagnostics", enforced at the
 * schema boundary rather than in the reducer.
 */
export const garmentOperationListSchema = z
  .array(z.unknown())
  .catch([])
  .default([])
  .transform((items) =>
    items
      .flatMap((item) => {
        const result = garmentOperationSchema.safeParse(item);
        return result.success ? [result.data] : [];
      })
      .slice(0, GARMENT_MAX_OPERATIONS),
  );
