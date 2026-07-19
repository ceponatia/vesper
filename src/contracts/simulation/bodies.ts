import { z } from "zod";
import {
  createCommandEnvelopeSchema,
  createCommandResultSchema,
  createEventEnvelopeSchema,
  createStableStringSetSchema,
} from "./envelopes";
import {
  bodyConditionIdSchema,
  bodyModifierIdSchema,
  eventIdSchema,
  storySecondSchema,
  worldCharacterIdSchema,
} from "./identity";

/**
 * E5.1 — the unified body substrate (engine.spec §25.1–25.3, plan §"Gate 5
 * build order"). Three layers, never conflated: SUBSTRATE (stored fixed-point
 * body facts moved only by drift and sources), RESOLUTION (analytic drift
 * laws, one modifier contract, thresholds as material events), and READ
 * (E5.2's pure perception-gated projections — no read lives here).
 *
 * Meter membership is registry DATA under ruling 15: the parity meters land
 * as entries in {@link bodyMeterRegistryV1}, and adding satiation, hydration,
 * desire, or bladder later is a data edit plus a bumped registry version,
 * never a schema migration.
 */

// --- Fixed-point vocabulary (engine.spec §32) --------------------------------

/** Meter values are integers in 1/10 000 units: 10 000 ≡ the chat lane's 1.0. */
export const METER_FIXED_POINT_ONE = 10_000 as const;

export const meterFixedPointSchema = z.number().int().min(0).max(METER_FIXED_POINT_ONE);
/** Signed deltas (sources, rate adds) may exceed the range; clamping is kernel law. */
export const meterDeltaFixedPointSchema = z
  .number()
  .int()
  .min(-METER_FIXED_POINT_ONE)
  .max(METER_FIXED_POINT_ONE);
export const ratePerHourFixedPointSchema = z.number().int().min(-100_000).max(100_000);
/** Multipliers use the same scale: 10 000 ≡ ×1. Zero suspends the law outright. */
export const rateMultiplierFixedPointSchema = z.number().int().min(0).max(1_000_000);

export const bodyDerivationVersion = "body-v1" as const;
export const bodyRegistryVersions = [bodyDerivationVersion] as const;
export const bodyRegistryVersionSchema = z.enum(bodyRegistryVersions);
export type BodyRegistryVersion = z.infer<typeof bodyRegistryVersionSchema>;

// --- Meter registry (engine.spec §25.2; ruling 15) ---------------------------

/** The chat taxonomy's meter classes (chat-meter-economy.spec §The meter taxonomy). */
export const bodyMeterClasses = ["reserve", "load", "valence", "rate", "phase"] as const;
export const bodyMeterClassSchema = z.enum(bodyMeterClasses);

/**
 * Analytic drift laws. Both are closed-form and monotone between modifier
 * boundaries, so threshold times are exactly solvable against the kernel's
 * own integration function — the scheduled second and the evaluated value can
 * never disagree.
 */
export const bodyDriftLawSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z
    .object({
      kind: z.literal("linear"),
      /** Absolute approach speed toward the target; direction derives from position. */
      ratePerHourFixedPoint: z.number().int().min(0).max(100_000),
      target: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("fixed"), valueFixedPoint: meterFixedPointSchema }).strict(),
        z.object({ kind: z.literal("baseline") }).strict(),
      ]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("proportional_decay"),
      /** Bounded at ~31 years so remainder × 2^20 stays inside safe integers. */
      halfLifeSeconds: z.number().int().positive().max(1_000_000_000),
      target: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("fixed"), valueFixedPoint: meterFixedPointSchema }).strict(),
        z.object({ kind: z.literal("baseline") }).strict(),
      ]),
    })
    .strict(),
]);
export type BodyDriftLaw = z.infer<typeof bodyDriftLawSchema>;

export const bodyThresholdDirections = ["falling", "rising"] as const;
export const bodyThresholdDirectionSchema = z.enum(bodyThresholdDirections);

/** Condition vocabulary v1. E5.2's parity work consumes asleep/afterglow/collapsed. */
export const bodyConditionKeys = [
  "asleep",
  "collapsed",
  "afterglow",
  "groggy",
  "wired",
  "ill",
] as const;
export const bodyConditionKeySchema = z.enum(bodyConditionKeys);
export type BodyConditionKey = z.infer<typeof bodyConditionKeySchema>;

export const bodyThresholdDefinitionSchema = z
  .object({
    key: z.string().min(1).max(64),
    boundaryFixedPoint: meterFixedPointSchema,
    direction: bodyThresholdDirectionSchema,
    outcome: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("event_only") }).strict(),
      z
        .object({
          kind: z.literal("condition_onset"),
          conditionKey: bodyConditionKeySchema,
          /** Absent means the condition holds until explicitly ended. */
          durationSeconds: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
        })
        .strict(),
    ]),
    /** Noticeable outcomes capture co-located witnesses at commit (§20). */
    noticeable: z.boolean(),
  })
  .strict();
export type BodyThresholdDefinition = z.infer<typeof bodyThresholdDefinitionSchema>;

export const bodyMeterDefinitionSchema = z
  .object({
    key: z.string().min(1).max(64),
    class: bodyMeterClassSchema,
    driftLaw: bodyDriftLawSchema,
    initialFixedPoint: meterFixedPointSchema,
    /** Registry default; a meter row may carry a per-actor baseline override. */
    baselineFixedPoint: meterFixedPointSchema,
    thresholds: z.array(bodyThresholdDefinitionSchema).max(16),
  })
  .strict()
  .refine(
    (definition) =>
      new Set(definition.thresholds.map((threshold) => threshold.key)).size ===
      definition.thresholds.length,
    { message: "Threshold keys must be unique per meter", path: ["thresholds"] },
  );
export type BodyMeterDefinition = z.infer<typeof bodyMeterDefinitionSchema>;

/**
 * Ruling 15 v1 registry. Semantics port from chat-meter-economy.spec: energy
 * is a reserve with proportional decay (τ ≈ 16h ⇒ half-life = 16h·ln2 ≈
 * 39 925s) restored by sleep sources; hygiene is clock-keyed linear drain;
 * arousal is a load meter decaying toward its per-actor baseline. The
 * bidirectional energy READ, circadian pressure, and rhythm self-care land in
 * E5.2 — this registry is the substrate they project from. Rates here are
 * the port's starting points; E5.2's parity pass retunes them in place.
 */
export const bodyMeterRegistryV1: readonly BodyMeterDefinition[] = [
  bodyMeterDefinitionSchema.parse({
    key: "energy",
    class: "reserve",
    driftLaw: {
      kind: "proportional_decay",
      halfLifeSeconds: 39_925,
      target: { kind: "fixed", valueFixedPoint: 0 },
    },
    initialFixedPoint: 9_000,
    baselineFixedPoint: 0,
    thresholds: [
      {
        key: "depleted",
        boundaryFixedPoint: 500,
        direction: "falling",
        outcome: { kind: "event_only" },
        noticeable: true,
      },
    ],
  }),
  bodyMeterDefinitionSchema.parse({
    key: "hygiene",
    class: "rate",
    driftLaw: {
      kind: "linear",
      ratePerHourFixedPoint: 150,
      target: { kind: "fixed", valueFixedPoint: 0 },
    },
    initialFixedPoint: 9_000,
    baselineFixedPoint: 0,
    thresholds: [
      {
        key: "grimy",
        boundaryFixedPoint: 2_500,
        direction: "falling",
        outcome: { kind: "event_only" },
        noticeable: false,
      },
    ],
  }),
  bodyMeterDefinitionSchema.parse({
    key: "arousal",
    class: "load",
    driftLaw: {
      kind: "linear",
      ratePerHourFixedPoint: 2_000,
      target: { kind: "baseline" },
    },
    initialFixedPoint: 0,
    baselineFixedPoint: 0,
    thresholds: [],
  }),
];

export const bodyMeterRegistryByVersion: Record<BodyRegistryVersion, readonly BodyMeterDefinition[]> =
  {
    [bodyDerivationVersion]: bodyMeterRegistryV1,
  };

// --- Substrate state ---------------------------------------------------------

export const bodyMeterStateSchema = z
  .object({
    actorId: worldCharacterIdSchema,
    meterKey: z.string().min(1).max(64),
    valueFixedPoint: meterFixedPointSchema,
    /** Per-actor override of the registry baseline (e.g. libido-shifted arousal). */
    baselineFixedPoint: meterFixedPointSchema,
    /** The last MATERIAL write. Queries integrate from here and never persist. */
    lastIntegratedAtStorySecond: storySecondSchema,
    registryVersion: bodyRegistryVersionSchema,
  })
  .strict();
export type BodyMeterState = z.infer<typeof bodyMeterStateSchema>;

export const bodyConditionStatuses = ["active", "ended"] as const;
export const bodyConditionStatusSchema = z.enum(bodyConditionStatuses);
export const bodyConditionEndBases = ["expired", "cleared"] as const;
export const bodyConditionEndBasisSchema = z.enum(bodyConditionEndBases);

export const bodyConditionSchema = z
  .object({
    id: bodyConditionIdSchema,
    actorId: worldCharacterIdSchema,
    key: bodyConditionKeySchema,
    onsetAtStorySecond: storySecondSchema,
    expiresAtStorySecond: storySecondSchema.optional(),
    status: bodyConditionStatusSchema,
    endBasis: bodyConditionEndBasisSchema.optional(),
    endedAtStorySecond: storySecondSchema.optional(),
    sourceEventId: eventIdSchema,
  })
  .strict()
  .refine(
    (condition) =>
      (condition.status === "ended") === (condition.endBasis !== undefined) &&
      (condition.status === "ended") === (condition.endedAtStorySecond !== undefined),
    {
      message: "End basis and ended second are present exactly when the condition has ended",
      path: ["endBasis"],
    },
  );
export type BodyCondition = z.infer<typeof bodyConditionSchema>;

/**
 * The one §25.3 modifier contract. `rate_add` is legal only on linear-law
 * meters (kernel-validated) so every integration piece stays closed-form and
 * monotone; scaling a decay law uses `rate_multiplier`, which divides its
 * half-life. Modifier validity boundaries are integration boundaries — expiry
 * needs no trigger because the piecewise solver already sees `validUntil`.
 */
export const bodyModifierOperationSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("rate_multiplier"), multiplierFixedPoint: rateMultiplierFixedPointSchema })
    .strict(),
  z
    .object({ kind: z.literal("rate_add"), ratePerHourFixedPoint: ratePerHourFixedPointSchema })
    .strict(),
  z.object({ kind: z.literal("suspend") }).strict(),
]);
export type BodyModifierOperation = z.infer<typeof bodyModifierOperationSchema>;

export const bodyModifierVisibilities = ["obvious", "private"] as const;
export const bodyModifierVisibilitySchema = z.enum(bodyModifierVisibilities);

export const bodyModifierSchema = z
  .object({
    id: bodyModifierIdSchema,
    actorId: worldCharacterIdSchema,
    meterKey: z.string().min(1).max(64),
    operation: bodyModifierOperationSchema,
    /** Within one stacking group only the highest-priority live modifier applies. */
    stackingGroup: z.string().min(1).max(64),
    priority: z.number().int().min(0).max(9_999),
    validFromStorySecond: storySecondSchema,
    validUntilStorySecond: storySecondSchema.optional(),
    visibility: bodyModifierVisibilitySchema,
    /** Set when a condition owns this modifier; ending the condition retires it. */
    conditionId: bodyConditionIdSchema.optional(),
    sourceEventId: eventIdSchema,
  })
  .strict()
  .refine(
    (modifier) =>
      modifier.validUntilStorySecond === undefined ||
      modifier.validUntilStorySecond > modifier.validFromStorySecond,
    { message: "Modifier validity interval is empty", path: ["validUntilStorySecond"] },
  );
export type BodyModifier = z.infer<typeof bodyModifierSchema>;

/** A command-payload modifier request; identity and validity anchor at commit. */
export const bodyModifierSpecSchema = z
  .object({
    meterKey: z.string().min(1).max(64),
    operation: bodyModifierOperationSchema,
    stackingGroup: z.string().min(1).max(64),
    priority: z.number().int().min(0).max(9_999).default(0),
    /** Seconds after commit; absent means open-ended (or the owning condition's life). */
    durationSeconds: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    visibility: bodyModifierVisibilitySchema.default("private"),
  })
  .strict();
export type BodyModifierSpec = z.infer<typeof bodyModifierSpecSchema>;

// --- Rhythm rows (engine.spec §25.5; ruling 15 — E5.2) -----------------------

/**
 * Authored branch-scoped rhythm windows — the character's own daily life as
 * data (ported from the chat lane's `profile.schedule`). `sleep` anchors the
 * circadian pressure curve; `wash` rows are window-crossing self-care (§25.5:
 * a skip credits only the rows it actually crossed, never a blanket restore).
 * `meal` joins as a data edit when satiation ports (chat-body-needs).
 */
export const bodyRhythmKinds = ["sleep", "wash"] as const;
export const bodyRhythmKindSchema = z.enum(bodyRhythmKinds);
export type BodyRhythmKind = z.infer<typeof bodyRhythmKindSchema>;

export const minuteOfDaySchema = z.number().int().min(0).max(1_439);

export const bodyRhythmRowSchema = z
  .object({
    actorId: worldCharacterIdSchema,
    kind: bodyRhythmKindSchema,
    /** Window in minutes-of-day; end < start wraps midnight (23:00 → 07:00). */
    startMinuteOfDay: minuteOfDaySchema,
    endMinuteOfDay: minuteOfDaySchema,
  })
  .strict();
export type BodyRhythmRow = z.infer<typeof bodyRhythmRowSchema>;

/** Story second 0 is midnight; minute-of-day derives by day wraparound. */
export const SECONDS_PER_DAY = 86_400 as const;

export const DEFAULT_SLEEP_WINDOW = {
  startMinuteOfDay: 1_380,
  endMinuteOfDay: 420,
} as const;

/** Chat parity: restore +0.09/h onto the proportional tank, capped at 0.95. */
export const ENERGY_SLEEP_RESTORE_PER_HOUR_FIXED_POINT = 900 as const;
export const ENERGY_SLEEP_RESTORE_CAP_FIXED_POINT = 9_500 as const;
/** Chat registry: a wash sets hygiene to 0.95. */
export const HYGIENE_WASH_SET_FIXED_POINT = 9_500 as const;

/**
 * The v1 circadian pressure curve (ruling 15; chat-meter-economy.spec OQ1),
 * every knob a versioned value documented for post-build tuning. Anchors are
 * piecewise-linear in minutes relative to the actor's own wake (W) and
 * bedtime (B): a post-waking inertia bump decaying to the day floor, the
 * afternoon dip, an evening low, the ramp into bedtime (the ZERO definition:
 * at B, pressure ≈ the reserve a normal day leaves, so read = 0 IS bedtime),
 * the ~B+5h trough peak, then the second-wind fall back to W. Pressure keeps
 * climbing past a missed night via the escalation rate (per hour awake
 * beyond the normal waking span), which is what makes the −1 floor land at
 * ~40h awake with no hardcoded hour. Values reproduce the spec's verified
 * 7am-wake / 11pm-bed table.
 */
export const circadianCurveV1 = {
  version: "circadian-v1",
  wakeInertiaFixedPoint: 3_100,
  dayFloorFixedPoint: 500,
  afternoonDipFixedPoint: 1_500,
  eveningLowFixedPoint: 800,
  rampFixedPoint: 2_000,
  bedtimeFixedPoint: 3_500,
  troughPeakFixedPoint: 8_900,
  /** Minutes after wake for the day anchors: floor, dip, evening low. */
  dayFloorOffsetMinutes: 240,
  afternoonDipOffsetMinutes: 480,
  eveningLowOffsetMinutes: 660,
  /** Minutes before bed for the ramp anchor; after bed for the trough peak. */
  rampLeadMinutes: 120,
  troughOffsetMinutes: 300,
  escalationPerHourFixedPoint: 312,
} as const;

/** Which meter a rhythm kind services, and how (the §25.4 coupling as data). */
export const rhythmSelfCareEffects: Partial<
  Record<BodyRhythmKind, { meterKey: string; operation: BodySourceOperation }>
> = {
  wash: { meterKey: "hygiene", operation: { kind: "set", valueFixedPoint: HYGIENE_WASH_SET_FIXED_POINT } },
};

/**
 * An absolute-second set/add the integration folds as a boundary — how
 * rhythm self-care enters the kernel without a per-day tick or trigger:
 * crossings are deterministic clock points, so queries fold them purely and
 * only material writes persist their consequences.
 */
export interface ScheduledBodyAdjustment {
  atStorySecond: number;
  operation: BodySourceOperation;
}

// --- Read vocabulary (engine.spec §25.1 layer 3; ruling 15 — E5.2) -----------

/**
 * Read-owned band vocabulary. Energy joins mood as a meter with NO registry
 * thresholds (OQ1): the bands live in the read layer, never as numbers
 * stapled to behavior instructions.
 */
export const energyReadBands = [
  "bright",
  "steady",
  "winding_down",
  "dragging",
  "wrecked",
  "collapsing",
] as const;
export const energyReadBandSchema = z.enum(energyReadBands);
export type EnergyReadBand = z.infer<typeof energyReadBandSchema>;

/**
 * The intimacy pulse (OQ2): arousal graded to what the body is doing —
 * pulse, breath, skin, focus — with no directive about diction, plus the
 * afterglow phase the climax coupling installs.
 */
export const intimacyPhases = [
  "quiescent",
  "kindled",
  "flushed",
  "wound_tight",
  "cresting",
  "afterglow",
] as const;
export const intimacyPhaseSchema = z.enum(intimacyPhases);
export type IntimacyPhase = z.infer<typeof intimacyPhaseSchema>;

/**
 * The closed registry of witness-visible body signs — facts a witness could
 * perceive at conversational range, never mood instructions. The phrasing IS
 * the feature: narrators receive these keys, not meters. Contact- and
 * exposure-gated signs (swelling, wetness) are deliberately absent until the
 * G5.2 wear/exposure model and the G5.3 consent ledger exist to gate them —
 * the vocabulary having no such member is what makes leaking it impossible.
 */
export const visibleBodySigns = [
  "visible_fatigue",
  "visible_exhaustion",
  "flushed_skin",
  "quickened_breath",
  "taut_attention",
  "afterglow_softness",
] as const;
export const visibleBodySignSchema = z.enum(visibleBodySigns);
export type VisibleBodySign = z.infer<typeof visibleBodySignSchema>;

/** Chat parity: afterglow follows climax, self-expiring (a tunable knob). */
export const AFTERGLOW_DURATION_SECONDS = 1_800 as const;
/** §25.4 exertion coupling: hygiene drains at half the energy cost. */
export const EXERTION_HYGIENE_FRACTION_FIXED_POINT = 5_000 as const;

// --- Source vocabulary (engine.spec §25.1 layer 2) ---------------------------

export const bodySourceKinds = [
  "meal",
  "drink",
  "sleep_credit",
  "wash",
  "exertion",
  "climax",
  "adjustment",
] as const;
export const bodySourceKindSchema = z.enum(bodySourceKinds);
export type BodySourceKind = z.infer<typeof bodySourceKindSchema>;

export const bodySourceOperationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("add"), deltaFixedPoint: meterDeltaFixedPointSchema }).strict(),
  z.object({ kind: z.literal("set"), valueFixedPoint: meterFixedPointSchema }).strict(),
  /** The climax reset (OQ2): land on the meter's per-actor baseline, whatever it is. */
  z.object({ kind: z.literal("reset_to_baseline") }).strict(),
]);
export type BodySourceOperation = z.infer<typeof bodySourceOperationSchema>;

// --- Captured derivation (engine.spec §6.4) ----------------------------------

const observerActorIdsSchema = createStableStringSetSchema(
  worldCharacterIdSchema,
  "Observer actor IDs",
);

/** What the integration knew when it wrote: replay re-derives from exactly this. */
const integrationDerivationSchema = z
  .object({
    fromValueFixedPoint: meterFixedPointSchema,
    fromStorySecond: storySecondSchema,
    activeModifierIds: createStableStringSetSchema(bodyModifierIdSchema, "Active modifier IDs"),
    registryVersion: bodyRegistryVersionSchema,
  })
  .strict();

// --- Commands ----------------------------------------------------------------

const initializeActorBodyPayloadSchema = z
  .object({
    actorId: worldCharacterIdSchema,
    registryVersion: bodyRegistryVersionSchema,
    /** Per-actor baseline overrides by meter key (e.g. libido-shifted arousal). */
    baselineOverrides: z.record(z.string().min(1).max(64), meterFixedPointSchema).default({}),
  })
  .strict();

export const initializeActorBodyCommandSchema = createCommandEnvelopeSchema(
  "initialize_actor_body",
  1,
  initializeActorBodyPayloadSchema,
);

export const initializeActorBodyRejectionCodes = [
  "invalid_command",
  "duplicate_command_id",
  "branch_mismatch",
  "actor_not_found",
  "body_already_initialized",
  "unknown_meter_key",
  "unauthorized_principal",
] as const;
export const initializeActorBodyRejectionCodeSchema = z.enum(initializeActorBodyRejectionCodes);
export const initializeActorBodyCommandResultSchema = createCommandResultSchema(
  initializeActorBodyRejectionCodeSchema,
);

const applyBodySourcePayloadSchema = z
  .object({
    actorId: worldCharacterIdSchema,
    meterKey: z.string().min(1).max(64),
    sourceKind: bodySourceKindSchema,
    operation: bodySourceOperationSchema,
  })
  .strict();

export const applyBodySourceCommandSchema = createCommandEnvelopeSchema(
  "apply_body_source",
  1,
  applyBodySourcePayloadSchema,
);

export const applyBodySourceRejectionCodes = [
  "invalid_command",
  "duplicate_command_id",
  "branch_mismatch",
  "body_not_initialized",
  "unknown_meter_key",
  "unauthorized_actor",
] as const;
export const applyBodySourceRejectionCodeSchema = z.enum(applyBodySourceRejectionCodes);
export const applyBodySourceCommandResultSchema = createCommandResultSchema(
  applyBodySourceRejectionCodeSchema,
);

const applyBodyModifierPayloadSchema = z
  .object({
    actorId: worldCharacterIdSchema,
    modifier: bodyModifierSpecSchema,
  })
  .strict();

export const applyBodyModifierCommandSchema = createCommandEnvelopeSchema(
  "apply_body_modifier",
  1,
  applyBodyModifierPayloadSchema,
);

export const applyBodyModifierRejectionCodes = [
  "invalid_command",
  "duplicate_command_id",
  "branch_mismatch",
  "body_not_initialized",
  "unknown_meter_key",
  "rate_add_on_nonlinear_law",
  "unauthorized_actor",
] as const;
export const applyBodyModifierRejectionCodeSchema = z.enum(applyBodyModifierRejectionCodes);
export const applyBodyModifierCommandResultSchema = createCommandResultSchema(
  applyBodyModifierRejectionCodeSchema,
);

const applyBodyConditionPayloadSchema = z
  .object({
    actorId: worldCharacterIdSchema,
    conditionKey: bodyConditionKeySchema,
    durationSeconds: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    /** Owned modifiers; their validity is clamped to the condition's lifetime. */
    modifiers: z.array(bodyModifierSpecSchema).max(8).default([]),
    /** Trusted capture set — the acting store resolves noticeability (§20). */
    observerActorIds: observerActorIdsSchema.default([]),
  })
  .strict();

export const applyBodyConditionCommandSchema = createCommandEnvelopeSchema(
  "apply_body_condition",
  1,
  applyBodyConditionPayloadSchema,
);

export const applyBodyConditionRejectionCodes = [
  "invalid_command",
  "duplicate_command_id",
  "branch_mismatch",
  "body_not_initialized",
  "unknown_meter_key",
  "rate_add_on_nonlinear_law",
  "condition_already_active",
  "unauthorized_actor",
] as const;
export const applyBodyConditionRejectionCodeSchema = z.enum(applyBodyConditionRejectionCodes);
export const applyBodyConditionCommandResultSchema = createCommandResultSchema(
  applyBodyConditionRejectionCodeSchema,
);

const endBodyConditionPayloadSchema = z
  .object({
    actorId: worldCharacterIdSchema,
    conditionId: bodyConditionIdSchema,
    basis: bodyConditionEndBasisSchema,
  })
  .strict();

export const endBodyConditionCommandSchema = createCommandEnvelopeSchema(
  "end_body_condition",
  1,
  endBodyConditionPayloadSchema,
);

export const endBodyConditionRejectionCodes = [
  "invalid_command",
  "duplicate_command_id",
  "branch_mismatch",
  "condition_not_found",
  "condition_not_active",
  "expiry_not_due",
  "unauthorized_actor",
] as const;
export const endBodyConditionRejectionCodeSchema = z.enum(endBodyConditionRejectionCodes);
export const endBodyConditionCommandResultSchema = createCommandResultSchema(
  endBodyConditionRejectionCodeSchema,
);

const resolveBodyThresholdPayloadSchema = z
  .object({
    actorId: worldCharacterIdSchema,
    meterKey: z.string().min(1).max(64),
    thresholdKey: z.string().min(1).max(64),
    /** Versions the trigger's uniqueness key: each re-arm is a distinct alarm. */
    armedAtSequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

/** Dispatched by the threshold trigger; system-only, re-validated at fire time. */
export const resolveBodyThresholdCommandSchema = createCommandEnvelopeSchema(
  "resolve_body_threshold",
  1,
  resolveBodyThresholdPayloadSchema,
);

export const resolveBodyThresholdRejectionCodes = [
  "invalid_command",
  "duplicate_command_id",
  "branch_mismatch",
  "body_not_initialized",
  "unknown_meter_key",
  "unknown_threshold_key",
  "threshold_stale",
  "unauthorized_principal",
] as const;
export const resolveBodyThresholdRejectionCodeSchema = z.enum(resolveBodyThresholdRejectionCodes);
export const resolveBodyThresholdCommandResultSchema = createCommandResultSchema(
  resolveBodyThresholdRejectionCodeSchema,
);

// --- Body event family (engine.spec §9.2) ------------------------------------

const bodyInitializedPayloadSchema = z
  .object({
    actorId: worldCharacterIdSchema,
    registryVersion: bodyRegistryVersionSchema,
    meters: z
      .array(
        z
          .object({
            meterKey: z.string().min(1).max(64),
            valueFixedPoint: meterFixedPointSchema,
            baselineFixedPoint: meterFixedPointSchema,
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

export const bodyInitializedEventSchema = createEventEnvelopeSchema(
  "body_initialized",
  1,
  bodyInitializedPayloadSchema,
);

const bodySourceAppliedPayloadSchema = z
  .object({
    actorId: worldCharacterIdSchema,
    meterKey: z.string().min(1).max(64),
    sourceKind: bodySourceKindSchema,
    operation: bodySourceOperationSchema,
    valueAfterFixedPoint: meterFixedPointSchema,
    derived: integrationDerivationSchema,
  })
  .strict();

export const bodySourceAppliedEventSchema = createEventEnvelopeSchema(
  "body_source_applied",
  1,
  bodySourceAppliedPayloadSchema,
);

const bodyModifierAppliedPayloadSchema = z
  .object({
    actorId: worldCharacterIdSchema,
    modifierId: bodyModifierIdSchema,
    meterKey: z.string().min(1).max(64),
    operation: bodyModifierOperationSchema,
    stackingGroup: z.string().min(1).max(64),
    priority: z.number().int().min(0).max(9_999),
    validFromStorySecond: storySecondSchema,
    validUntilStorySecond: storySecondSchema.optional(),
    visibility: bodyModifierVisibilitySchema,
    conditionId: bodyConditionIdSchema.optional(),
    /** The meter's integrated value at the boundary this modifier creates. */
    valueAtApplyFixedPoint: meterFixedPointSchema,
    derived: integrationDerivationSchema,
  })
  .strict();

export const bodyModifierAppliedEventSchema = createEventEnvelopeSchema(
  "body_modifier_applied",
  1,
  bodyModifierAppliedPayloadSchema,
);

const bodyConditionAppliedPayloadSchema = z
  .object({
    actorId: worldCharacterIdSchema,
    conditionId: bodyConditionIdSchema,
    conditionKey: bodyConditionKeySchema,
    onsetAtStorySecond: storySecondSchema,
    expiresAtStorySecond: storySecondSchema.optional(),
    observerActorIds: observerActorIdsSchema,
  })
  .strict();

export const bodyConditionAppliedEventSchema = createEventEnvelopeSchema(
  "body_condition_applied",
  1,
  bodyConditionAppliedPayloadSchema,
);

const bodyConditionEndedPayloadSchema = z
  .object({
    actorId: worldCharacterIdSchema,
    conditionId: bodyConditionIdSchema,
    conditionKey: bodyConditionKeySchema,
    basis: bodyConditionEndBasisSchema,
    endedAtStorySecond: storySecondSchema,
    /**
     * Modifiers this ending retired (their validity closes here). Each names
     * its meter so replay can retire that meter's pending threshold alarm.
     */
    retiredModifiers: z
      .array(
        z
          .object({ modifierId: bodyModifierIdSchema, meterKey: z.string().min(1).max(64) })
          .strict(),
      )
      .max(8),
  })
  .strict();

export const bodyConditionEndedEventSchema = createEventEnvelopeSchema(
  "body_condition_ended",
  1,
  bodyConditionEndedPayloadSchema,
);

const bodyThresholdCrossedPayloadSchema = z
  .object({
    actorId: worldCharacterIdSchema,
    meterKey: z.string().min(1).max(64),
    thresholdKey: z.string().min(1).max(64),
    boundaryFixedPoint: meterFixedPointSchema,
    direction: bodyThresholdDirectionSchema,
    valueAtCrossingFixedPoint: meterFixedPointSchema,
    observerActorIds: observerActorIdsSchema,
    derived: integrationDerivationSchema,
  })
  .strict();

export const bodyThresholdCrossedEventSchema = createEventEnvelopeSchema(
  "body_threshold_crossed",
  1,
  bodyThresholdCrossedPayloadSchema,
);

// --- Bodies projection --------------------------------------------------------

export const bodiesProjectionSchema = z
  .object({
    branchId: z.string().min(1),
    headSequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    version: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    storySecond: storySecondSchema,
    meters: z.array(bodyMeterStateSchema),
    conditions: z.array(bodyConditionSchema),
    modifiers: z.array(bodyModifierSchema),
  })
  .strict();
export type BodiesProjection = z.infer<typeof bodiesProjectionSchema>;

// --- Types --------------------------------------------------------------------

export type InitializeActorBodyCommand = z.infer<typeof initializeActorBodyCommandSchema>;
export type InitializeActorBodyRejectionCode = z.infer<typeof initializeActorBodyRejectionCodeSchema>;
export type InitializeActorBodyCommandResult = z.infer<typeof initializeActorBodyCommandResultSchema>;
export type ApplyBodySourceCommand = z.infer<typeof applyBodySourceCommandSchema>;
export type ApplyBodySourceRejectionCode = z.infer<typeof applyBodySourceRejectionCodeSchema>;
export type ApplyBodySourceCommandResult = z.infer<typeof applyBodySourceCommandResultSchema>;
export type ApplyBodyModifierCommand = z.infer<typeof applyBodyModifierCommandSchema>;
export type ApplyBodyModifierRejectionCode = z.infer<typeof applyBodyModifierRejectionCodeSchema>;
export type ApplyBodyModifierCommandResult = z.infer<typeof applyBodyModifierCommandResultSchema>;
export type ApplyBodyConditionCommand = z.infer<typeof applyBodyConditionCommandSchema>;
export type ApplyBodyConditionRejectionCode = z.infer<typeof applyBodyConditionRejectionCodeSchema>;
export type ApplyBodyConditionCommandResult = z.infer<typeof applyBodyConditionCommandResultSchema>;
export type EndBodyConditionCommand = z.infer<typeof endBodyConditionCommandSchema>;
export type EndBodyConditionRejectionCode = z.infer<typeof endBodyConditionRejectionCodeSchema>;
export type EndBodyConditionCommandResult = z.infer<typeof endBodyConditionCommandResultSchema>;
export type ResolveBodyThresholdCommand = z.infer<typeof resolveBodyThresholdCommandSchema>;
export type ResolveBodyThresholdRejectionCode = z.infer<typeof resolveBodyThresholdRejectionCodeSchema>;
export type ResolveBodyThresholdCommandResult = z.infer<typeof resolveBodyThresholdCommandResultSchema>;
export type BodyInitializedEvent = z.infer<typeof bodyInitializedEventSchema>;
export type BodySourceAppliedEvent = z.infer<typeof bodySourceAppliedEventSchema>;
export type BodyModifierAppliedEvent = z.infer<typeof bodyModifierAppliedEventSchema>;
export type BodyConditionAppliedEvent = z.infer<typeof bodyConditionAppliedEventSchema>;
export type BodyConditionEndedEvent = z.infer<typeof bodyConditionEndedEventSchema>;
export type BodyThresholdCrossedEvent = z.infer<typeof bodyThresholdCrossedEventSchema>;
