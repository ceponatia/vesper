import {
  compileGarmentProfile,
  deriveGarmentEffectiveCoverage,
  deriveGarmentMechanics,
  garmentBlueprintFor,
  garmentConditionAtPart,
  garmentContactsFromFit,
  garmentInstanceById,
  garmentPartMaterialProfile,
  garmentRegionId,
  garmentRegionState,
  integrateGarmentCondition,
  precipitationActive,
  wornGarmentInstances,
  GARMENT_ROOT_PART_ID,
  type AffordanceExposure,
  type ChatEnvironment,
  type ChatGarmentStore,
  type EffectiveCoverageRead,
  type GarmentCausalEvent,
  type GarmentLanePayload,
  type GarmentRegionInput,
  type GarmentRegionStateRead,
  type WornItemInput,
  type WornVisibility,
} from "@/contracts";

/**
 * The chat lane's GARMENT affordance payload (body-attribute-affordances slice
 * 6). Sibling of `chat-affordances.ts`, which owns the hair half and the read
 * itself; this module owns exactly one job — turning wardrobe truth into the
 * lane-neutral `GarmentLanePayload`.
 *
 * ## Where each field actually comes from
 *
 * | payload field | chat-lane owner | status |
 * | --- | --- | --- |
 * | `regions` | the garment store's worn instances + their blueprint snapshots, joined to the resolved wardrobe's presentation-aware coverage rows | supported |
 * | `state.saturation` | `GarmentConditionState`, integrated to the story clock (never persisted by a read) | supported |
 * | `state.visibility` | the resolved wardrobe's `partVisibility` — one occlusion pass, not a second model | supported |
 * | `regions[].fit` | — | **omitted**: the wardrobe has no fit owner (see below) |
 * | `contacts` | the establishment law, over recorded fits only | **unavailable** while no fit is recorded |
 * | `events` | active precipitation | supported (rain only) |
 * | `focus` | — | **omitted** ⇒ the closed default, so no intimate cue can fire |
 *
 * ## The fit gap, stated honestly
 *
 * `GarmentRegionStructuralProfile.fit` is the input the ruled establishment law
 * turns on: a **fitted** or **tight** worn garment establishes ordinary contact
 * from wardrobe truth alone. Nothing in the clothing system records fit today —
 * not the item definition, not the blueprint, not the instance — so every region
 * compiles as the conservative `unknown`, `garmentContactsFromFit` establishes
 * nothing, and this adapter OMITS the `contacts` key entirely. The core then
 * suppresses `garment.wet_cling` with `affordance.input.unavailable`, exactly as
 * it suppresses `hair.strands_adhere_to_skin`.
 *
 * That is deliberate and self-repairing: the moment the wardrobe records a fit,
 * `recordedFit` below starts returning it, contacts start being established, and
 * cling starts firing — with no change to this file's logic and none at all to
 * the domain.
 *
 * ## Why this is a pure function
 *
 * Committed state plus a clock in, a payload and a derived coverage read out. No
 * IO, no `Date`, no write-back — `integrateGarmentCondition` is analytic and its
 * result is deliberately discarded, so building a prompt can never dry a
 * garment. That purity is what makes the retake guarantee work: the store rides
 * `pre_exchange_scenario`, so a rolled-back exchange rebuilds a byte-identical
 * payload, read, and capture.
 */

export interface ChatGarmentAffordanceInput {
  /** The conversation's garment store, as of the committed cut. */
  readonly store: ChatGarmentStore;
  /** `garmentActorForCharacter(id)` or `GARMENT_PLAYER_ACTOR`. */
  readonly actorId: string;
  /**
   * The SAME coverage rows `resolveChatWardrobe` produced this turn. Passing
   * them rather than re-deriving coverage is what keeps the affordance read, the
   * exposure gate, and the occlusion verdict on one truth.
   */
  readonly worn: readonly WornItemInput[];
  /** The resolved wardrobe's `partVisibility`; absent ⇒ nothing is assumed buried. */
  readonly visibility?: Readonly<Record<string, WornVisibility>>;
  readonly environment: ChatEnvironment;
  /** The story clock this read is taken at (`ChatScenario.clockMinutes`). */
  readonly clockMinutes: number;
}

export interface ChatGarmentAffordanceRead {
  readonly payload: GarmentLanePayload;
  /**
   * The staged `EffectiveCoverageRead` for this cut — captured with the
   * presentation cut by the caller, never recomputed by a later consumer.
   */
  readonly coverage: EffectiveCoverageRead;
  /**
   * Perception exposure for the body locations a worn garment is the OUTERMOST
   * cover of. A garment observation is about the garment's own surface, and its
   * surface is exactly what an observer's eye reaches there.
   */
  readonly exposure: Readonly<Record<string, AffordanceExposure>>;
}

/** The part id a coverage row addresses — `garmentId:partId`, or the root for a whole-garment row. */
function partIdOf(row: WornItemInput): string {
  return row.instanceId === row.garmentId ? GARMENT_ROOT_PART_ID : row.instanceId.slice(row.garmentId.length + 1);
}

/**
 * The fit the WARDROBE records for a garment part, or `undefined` when it
 * records none.
 *
 * It takes no arguments, and that IS the current answer: no item definition, no
 * blueprint node, and no instance field in the clothing system carries fit, so
 * there is nothing to look it up from. Returning `undefined` rather than a
 * guessed `loose` is what separates "the wardrobe answered and this garment does
 * not touch the body" from "nobody owns this question" — `contacts` is supplied
 * in the first case and omitted in the second, and those are two different
 * silences with two different diagnostics.
 *
 * When the wardrobe grows the field, this function grows the arguments it needs
 * to read it and nothing else in this file (or in the domain) changes.
 */
function recordedFit(): string | undefined {
  return undefined;
}

/**
 * Build one actor's garment payload and the coverage read derived from it, or
 * `null` when this actor has no worn garment instances at all.
 *
 * `null` is the honest answer to an UNMODELLED wardrobe, and the caller must
 * treat it as "do not run the garment domain" rather than as "wearing nothing":
 * a legacy chat on the free-text path knows nothing about what is on this body,
 * and a read that assumed bare skin there would be spectacularly wrong.
 */
export function buildChatGarmentAffordance(input: ChatGarmentAffordanceInput): ChatGarmentAffordanceRead | null {
  const atMinutes = Math.max(0, Math.trunc(input.clockMinutes));
  if (wornGarmentInstances(input.store, input.actorId).length === 0) return null;

  // Integrate each instance ONCE, lazily, to the story clock. The result is used
  // and dropped — reading a garment must never dry it (the §25.2 law).
  const conditions = new Map<string, ReturnType<typeof integrateGarmentCondition>>();
  const regions: GarmentRegionInput[] = [];
  const state: GarmentRegionStateRead[] = [];

  for (const row of input.worn) {
    const instance = garmentInstanceById(input.store, row.garmentId);
    // A row with no instance came from the legacy definition-id path; it has no
    // material and no condition, so there is nothing this domain can say about it.
    if (!instance) continue;
    const blueprint = garmentBlueprintFor(input.store, instance);
    const condition =
      conditions.get(instance.id) ?? integrateGarmentCondition(instance.condition, blueprint, atMinutes);
    conditions.set(instance.id, condition);

    const partId = partIdOf(row);
    const fit = recordedFit();
    regions.push({
      garmentId: row.garmentId,
      partId,
      coveredBodyLocations: [...row.coverage],
      materialClass: garmentPartMaterialProfile(blueprint, partId).id,
      ...(fit === undefined ? {} : { fit }),
      ...(row.opacity === "sheer" ? { sheer: true } : {}),
    });
    state.push(
      garmentRegionState({
        regionId: garmentRegionId(row.garmentId, partId),
        saturation: garmentConditionAtPart(condition, partId).wetness,
        visibility: input.visibility?.[row.instanceId] ?? "visible",
      }),
    );
  }

  if (regions.length === 0) return null;

  // The same pure stages the domain runs, so the captured coverage read and the
  // read the narrator sees cannot disagree — they are one computation.
  const compiled = compileGarmentProfile(regions);
  const profile = compiled.profile;
  const coverage = profile
    ? deriveGarmentEffectiveCoverage({
        frame: { profile, mechanics: deriveGarmentMechanics({ profile, state }) },
        atMinutes,
      })
    : { atMinutes, entries: [] };

  // Contacts are supplied only when the WARDROBE could answer the fit question
  // for at least one region. All-unknown ⇒ omit the key ⇒ the core suppresses
  // wet cling as unavailable, which is the correct claim: nobody owns contact.
  const fitRecorded = regions.some((region) => region.fit !== undefined);
  const contacts = profile && fitRecorded ? garmentContactsFromFit(profile) : undefined;

  return {
    payload: {
      regions,
      state,
      ...(contacts === undefined ? {} : { contacts }),
      events: garmentEvents(input.environment, atMinutes),
      // `focus` is deliberately omitted: the chat lane has no narrative-focus or
      // consent owner for this policy yet, and the domain's closed default is
      // the strictest reading — no intimate garment cue can fire.
    },
    coverage,
    exposure: garmentExposure(input.worn, input.visibility),
  };
}

export interface ChatGarmentCoverageCutInput {
  readonly store: ChatGarmentStore;
  readonly actorId: string;
  /**
   * The resolved wardrobe's coverage rows and occlusion verdicts —
   * `ResolvedChatWardrobe.worn` / `.partVisibility`. `worn` absent means the
   * wardrobe could not be read at all (the free-text / legacy path), and the
   * answer is `null`, never an empty read.
   */
  readonly worn?: readonly WornItemInput[];
  readonly visibility?: Readonly<Record<string, WornVisibility>>;
  readonly environment: ChatEnvironment;
  readonly clockMinutes: number;
}

/**
 * The CURRENT exchange's effective-coverage read for one actor, or `null` when
 * this cut cannot model their wardrobe into coverage.
 *
 * This is the contact leg's answer to the settle race: the persisted capture in
 * `ChatGarmentStore.coverage` lands at the PREVIOUS exchange's settle, so a
 * rapid follow-up turn read "no capture yet" for a body whose wardrobe this very
 * turn had already resolved. The material question must be answered from the
 * cut the turn is standing in, so this derives it from the same inputs —
 * the same store, the same resolved rows, the same clock — through the same
 * pure garment stages `buildChatGarmentAffordance` runs. Nothing else is run to
 * get it: no cue selection, no hair domain, no perception view.
 *
 * `null` means "this cut could not model the wardrobe" — the free-text path,
 * legacy worn ids with no materialized instances, or a degraded item load — and
 * the caller's dressed-check turns that into `unavailable`, never bare skin. An
 * empty read (`entries: []`) is the OTHER answer: derivation ran and nothing
 * covers anything.
 */
export function chatGarmentCoverageForCut(input: ChatGarmentCoverageCutInput): EffectiveCoverageRead | null {
  if (input.worn === undefined) return null;
  const read = buildChatGarmentAffordance({
    store: input.store,
    actorId: input.actorId,
    worn: input.worn,
    ...(input.visibility === undefined ? {} : { visibility: input.visibility }),
    environment: input.environment,
    clockMinutes: input.clockMinutes,
  });
  return read?.coverage ?? null;
}

/**
 * The causal events this lane can honestly commit for a garment.
 *
 * Active precipitation only. The garment condition vector records a wetness
 * LEVEL but no cause (unlike `bodySurface`, whose entries carry one), so a wet
 * shirt indoors reads wet and says nothing about why — which is the same rule
 * the hair domain applies, for the same reason: an invented cause is a lie the
 * narrator will repeat.
 */
function garmentEvents(environment: ChatEnvironment, atMinutes: number): GarmentCausalEvent[] {
  if (!precipitationActive(environment)) return [];
  return [{ kind: "rain_exposure", atStoryTime: Math.max(0, Math.min(atMinutes, environment.updatedAtMinutes)) }];
}

/**
 * Body locations a worn garment currently reaches, as observer exposure.
 *
 * A garment observation is about the garment's own SURFACE, and wherever a
 * garment is not buried its surface is what the eye reaches — so a covered
 * location reads `visible` here. Nothing is re-derived: the buried verdict is
 * the wardrobe resolver's own, handed in.
 *
 * Locations no garment reaches are simply absent, and the core's perception view
 * fails them closed. That is correct rather than lossy: bare skin is the BODY's
 * exposure question, and this domain has no standing to answer it.
 */
function garmentExposure(
  worn: readonly WornItemInput[],
  visibility: Readonly<Record<string, WornVisibility>> | undefined,
): Record<string, AffordanceExposure> {
  const exposure: Record<string, AffordanceExposure> = {};
  for (const row of worn) {
    if (visibility?.[row.instanceId] === "hidden") continue;
    for (const locationId of row.coverage) exposure[locationId] = "visible";
  }
  return exposure;
}
