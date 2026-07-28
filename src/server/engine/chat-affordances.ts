import {
  affordancePerceptionView,
  affordanceSubjectId,
  attributeRegistry,
  bodySurfaceWetnessAt,
  bodySurfaceWetnessEntry,
  conditionAttributeOverlays,
  deriveAffordanceRead,
  emptyAffordanceCueState,
  hairAffordanceDomain,
  HAIR_DOMAIN_ID,
  HAIR_LOCATION_ID,
  precipitationActive,
  resolveAttributes,
  resolvedAttributeSnapshot,
  resolveWardrobeVisibility,
  windForceOf,
  type ActiveCondition,
  type AffordanceCueState,
  type AffordanceExposure,
  type AffordanceRead,
  type AttributeValue,
  type BodySurfaceState,
  type BodySurfaceWetnessCause,
  type ChatEnvironment,
  type DiagnosticSink,
  type HairCausalEvent,
  type HairEventKind,
  type HairLanePayload,
  type WornItemInput,
} from "@/contracts";

/**
 * The CHAT LANE's affordance adapter (body-attribute-affordances slice 4).
 *
 * The one place chat-lane state becomes the lane-neutral affordance payload. It
 * exists so the shared calculation forks nowhere: a successor adapter will
 * normalize its own reads into the same `HairLanePayload` and perception view,
 * and every number in `contracts/affordances` stays lane-agnostic.
 *
 * ## The adapter result law, as this lane can actually answer it
 *
 * | input | chat-lane owner | status |
 * | --- | --- | --- |
 * | `hair.arrangement` | canonical attributes + narrative/condition overlays | supported |
 * | `wetness` | `ChatState.bodySurface` (extraction-owned, lazily dried) | supported |
 * | `coveredFraction` | worn coverage of the `hair` body location | supported, or **unavailable** with no wardrobe read |
 * | `wind` | `ChatScenario.environment` (extraction-owned) | supported — including "still air", which is a real answer |
 * | `events` | the wetness entry's own cause + active precipitation | supported, rain/immersion/splash ONLY |
 * | `motion` | — | **unavailable** (no body-motion owner) |
 * | `contacts` | — | **unavailable** (no typed contact owner) |
 * | `contamination` | — | **unavailable** (no owner) |
 *
 * The two `unavailable`s are the audit's rulings, not oversights, and they are
 * load-bearing: `contacts` is a REQUIRED dependency of
 * `hair.strands_adhere_to_skin`, so the core suppresses that phenomenon with
 * `affordance.input.unavailable` before its resolver can read an empty list as
 * "nothing is touching". Reach never invents contact. Likewise no impulse event
 * is ever synthesized, so `hair.sheds_droplets` stays production-silent.
 *
 * ## Why this is a pure function
 *
 * It takes committed state and a clock and returns a read — no IO, no `Date`, no
 * registry lookup that could change under it. That is what makes the retake
 * guarantee work (architecture spec §"Recompute and capture"): `affordanceCues`
 * rides `pre_exchange_scenario` and `bodySurface` rides `pre_exchange_state`, so
 * a rolled-back exchange rebuilds a byte-identical read and byte-identical next
 * cues. There is no hysteresis and no hidden latch anywhere in the path.
 *
 * **Not wired into the prompt or the pipeline.** Slice 5 does that behind its
 * flag; this slice ships the seam and its proof.
 */

// ---------------------------------------------------------------------------
// Calibration
// ---------------------------------------------------------------------------

/**
 * Coverage of the `hair` location → `coveredFraction`, in affordance units.
 *
 * The wardrobe model is per-location and boolean-ish (a garment covers `hair` or
 * it does not), so this is the honest coarse translation rather than a fake
 * geometric fraction. `0.9` and not `1.0` for an opaque cover because a hat or
 * hood essentially never captures every strand — ends hang out, which is exactly
 * the case the hair domain's ends-only wind read exists for.
 */
const HAIR_COVERED_OPAQUE = 9_000;
const HAIR_COVERED_SHEER = 5_000;

/**
 * How long a recorded wetness cause stays citable as a CURRENT causal event, in
 * story minutes. An hour: long enough that "she came in out of the rain" is still
 * the reason her hair is doing that, short enough that a morning soaking cannot
 * still be raining by evening. Beyond it the hair is simply wet and says nothing
 * about why — which is the hair domain's own rule for the rain tag.
 */
export const CHAT_AFFORDANCE_EVENT_FRESHNESS_MINUTES = 60;

/**
 * Wetness causes → the hair domain's committed causal events.
 *
 * `other` maps to nothing on purpose: it means "the fiction wet her and did not
 * say how", and turning that into `splash` would be the invention the audit's
 * adapter law forbids. Note that every mapped kind is a RAIN-class event —
 * `hairImpulseEventKinds` is unreachable from this lane, which is why droplet
 * shedding stays silent in production.
 */
const HAIR_EVENT_FOR_CAUSE: Readonly<Record<BodySurfaceWetnessCause, HairEventKind | undefined>> = {
  rain: "rain_exposure",
  immersion: "immersion",
  splash: "splash",
  other: undefined,
};

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/**
 * The subject's worn coverage rows — the SAME shape `resolveWardrobeVisibility`
 * and `exposedRegions` consume (`toWornInputs(items)` in the images lane
 * produces it). Passing the rows rather than a precomputed fraction keeps the
 * wardrobe's own vocabulary the source of both coverage and perception here.
 *
 * ABSENT means the lane could not read this actor's wardrobe at all, which is
 * different from an empty list ("read it; they are wearing nothing"). Absent
 * fails closed: coverage is unavailable, so the hair domain reports unavailable
 * and every hair phenomenon stays silent.
 */
export interface ChatAffordanceWardrobe {
  readonly worn: readonly WornItemInput[];
}

export interface ChatAffordanceReadInput {
  /** The chat-lane character id whose body this read is about. */
  readonly subjectId: string;
  /** The character's authored attributes — the base `resolveAttributes` resolves over. */
  readonly attributes: readonly AttributeValue[];
  /** Persisted narrative overlays (`ChatState.attributeOverlays`). */
  readonly attributeOverlays?: readonly AttributeValue[];
  /** Active conditions; their `attributeEffects` overlay on top, exactly as the prompt builder does. */
  readonly conditions?: readonly ActiveCondition[];
  readonly wardrobe?: ChatAffordanceWardrobe;
  readonly bodySurface: BodySurfaceState;
  readonly environment: ChatEnvironment;
  /** The story clock this read is taken at (`ChatScenario.clockMinutes`). */
  readonly clockMinutes: number;
  /** The cue memory this cut starts from — restored with the scenario on a retake. */
  readonly previousCues?: AffordanceCueState;
  readonly sink?: DiagnosticSink;
}

export interface ChatAffordanceReadResult {
  readonly read: AffordanceRead;
  /** The cue memory to persist onto `ChatScenario.affordanceCues` beside this cut. */
  readonly nextCues: AffordanceCueState;
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

/**
 * The character's attributes as the narrator sees them: authored base + persisted
 * narrative overlays + this moment's condition overlays. Identical composition to
 * `character-chat.ts`'s `fullResolved`, deliberately — an affordance read that
 * disagreed with the prompt about what the hair is doing would be worse than no
 * read at all.
 *
 * `hair.arrangement` is materialized from the REGISTRY's declared default when
 * unset. That is reading the authored default, not guessing: the attribute
 * declares `defaultValue: "loose"`, every character form renders it, and without
 * it the whole domain would report unavailable for every character authored
 * before the axis existed (which the Slice 0 ruling accepted for the FORM, not
 * for the read).
 */
function resolveSubjectAttributes(input: ChatAffordanceReadInput): AttributeValue[] {
  const resolved = resolveAttributes(input.attributes, [
    ...(input.attributeOverlays ?? []),
    ...conditionAttributeOverlays([...(input.conditions ?? [])]),
  ]);
  if (resolved.some((value) => value.id === "hair.arrangement")) return resolved;
  const fallback = attributeRegistry.byId("hair.arrangement")?.defaultValue;
  if (typeof fallback !== "string") return resolved;
  return [...resolved, { id: "hair.arrangement", value: fallback, source: "creation" }];
}

interface HairCoverageRead {
  readonly coveredFraction: number;
  readonly exposure: AffordanceExposure;
}

/**
 * Coverage of, and visibility at, the `hair` location.
 *
 * Both fall out of ONE pass of the shared wardrobe resolver — no second occlusion
 * model, no re-expansion of coverage ids. `visibleAt` names the locations a row
 * is the OUTERMOST cover of, so the row that lists `hair` there is the thing an
 * observer's eye actually reaches, and its opacity decides between `hidden` and
 * `hinted` in the wardrobe's own vocabulary.
 */
function readHairCoverage(wardrobe: ChatAffordanceWardrobe): HairCoverageRead {
  const worn = [...wardrobe.worn];
  const views = resolveWardrobeVisibility(worn);
  const outermost = views.find((view) => view.visibleAt.includes(HAIR_LOCATION_ID));
  const row = outermost ? worn.find((item) => item.instanceId === outermost.instanceId) : undefined;
  if (row === undefined) return { coveredFraction: 0, exposure: "visible" };
  return row.opacity === "sheer"
    ? { coveredFraction: HAIR_COVERED_SHEER, exposure: "hinted" }
    : { coveredFraction: HAIR_COVERED_OPAQUE, exposure: "hidden" };
}

/**
 * The causal events this lane can honestly commit, deduped by kind.
 *
 * Two sources, both grounded in state rather than in prose: the wetness entry's
 * OWN recorded cause while it is still fresh, and active precipitation (which is
 * a standing rain exposure by definition). Nothing else — in particular no
 * `gust`, even though the environment has a gusting band: a gust is an IMPULSE,
 * and an impulse would light up droplet shedding on the strength of a standing
 * weather level rather than a committed event. The environment read cannot tell
 * a gust that just hit from wind that has been blowing all afternoon, so this
 * lane declines to claim one.
 */
function hairEvents(input: ChatAffordanceReadInput): HairCausalEvent[] {
  const events: HairCausalEvent[] = [];
  const entry = bodySurfaceWetnessEntry(input.bodySurface, HAIR_LOCATION_ID);
  if (entry?.cause !== undefined && input.clockMinutes - entry.updatedAtMinutes <= CHAT_AFFORDANCE_EVENT_FRESHNESS_MINUTES) {
    const kind = HAIR_EVENT_FOR_CAUSE[entry.cause];
    if (kind !== undefined) events.push({ kind, atStoryTime: Math.max(0, entry.updatedAtMinutes) });
  }
  if (precipitationActive(input.environment)) {
    events.push({ kind: "rain_exposure", atStoryTime: Math.max(0, input.environment.updatedAtMinutes) });
  }
  const seen = new Set<HairEventKind>();
  return events.filter((event) => (seen.has(event.kind) ? false : (seen.add(event.kind), true)));
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

/**
 * Build one subject's affordance read for the current committed cut.
 *
 * Only the domains this lane can actually feed are run (`hair` today). Handing
 * the default registry every domain would emit an `affordance.input.unavailable`
 * warning per unfed domain per exchange — degradation telemetry for a decision
 * nobody made. Adding a domain here is meant to be a deliberate act: you add it
 * when you have built its payload.
 */
export function buildChatAffordanceRead(input: ChatAffordanceReadInput): ChatAffordanceReadResult {
  const storyTime = Math.max(0, Math.trunc(input.clockMinutes));
  const coverage = input.wardrobe ? readHairCoverage(input.wardrobe) : undefined;

  // `Partial` because `coveredFraction` is genuinely omissible here: absent ⇒ the
  // domain reads it `unavailable` ⇒ the whole hair read is unavailable. That IS
  // the audit's "unknown coverage fails closed" — guessing "uncovered" would let
  // hidden hair stream in the wind.
  const payload: Partial<HairLanePayload> = {
    wetness: bodySurfaceWetnessAt(input.bodySurface, HAIR_LOCATION_ID, storyTime),
    ...(coverage === undefined ? {} : { coveredFraction: coverage.coveredFraction }),
    // Still air is an ANSWER, not an absence: the environment owner can say "no
    // wind", which is a different claim from "this lane has no weather".
    wind: { force: windForceOf(input.environment) },
    events: hairEvents(input),
    // `motion`, `contacts` and `contamination` are deliberately absent — no owner.
  };

  const read = deriveAffordanceRead({
    subjectId: affordanceSubjectId(input.subjectId),
    storyTime,
    attributes: resolvedAttributeSnapshot(resolveSubjectAttributes(input)),
    perception: affordancePerceptionView({
      // Unlisted locations read `unknown` and fail closed, so naming only `hair`
      // is not a gap: it is the only location this lane can speak for.
      exposure: { [HAIR_LOCATION_ID]: coverage?.exposure ?? "unknown" },
      // The chat lane's observer is the player, present in the scene; sight is the
      // one channel it can positively assert.
      channels: { sight: "available" },
    }),
    domains: [hairAffordanceDomain],
    payloads: { [HAIR_DOMAIN_ID]: payload },
    previousCues: input.previousCues ?? emptyAffordanceCueState(),
    ...(input.sink === undefined ? {} : { sink: input.sink }),
  });

  return { read, nextCues: read.nextCues };
}
