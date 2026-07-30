import {
  affordancePerceptionView,
  affordanceSubjectId,
  AFFORDANCE_INPUT_INVALID,
  attributeRegistry,
  bodySurfaceWetnessAt,
  bodySurfaceWetnessEntry,
  conditionAttributeOverlays,
  deriveAffordanceRead,
  diag,
  emptyAffordanceCueState,
  garmentAffordanceDomain,
  GARMENT_DOMAIN_ID,
  hairAffordanceDomain,
  hairArrangementOf,
  hairWetnessBand,
  hairWettingEventKinds,
  HAIR_DOMAIN_ID,
  HAIR_LOCATION_ID,
  isInvalidSurfaceEntry,
  precipitationActive,
  resolveAttributes,
  resolvedAttributeSnapshot,
  resolveWardrobeVisibility,
  surfaceDryingSuspended,
  windForceOf,
  type ActiveCondition,
  type AffordanceCueState,
  type AffordanceExposure,
  type AffordancePerceptionView,
  type AffordanceRead,
  type AffordanceStoryTime,
  type AffordanceSubjectId,
  type AttributeValue,
  type BodySurfaceState,
  type BodySurfaceWetnessCause,
  type ChatEnvironment,
  type ChatGarmentStore,
  type DiagnosticSink,
  type EffectiveCoverageRead,
  type HairArrangement,
  type HairCausalEvent,
  type HairEventKind,
  type HairLanePayload,
  type HairWetnessBand,
  type HairWettingEventKind,
  type RegisteredAffordanceDomain,
  type ResolvedAttributeSnapshot,
  type WornItemInput,
  type WornVisibility,
} from "@/contracts";
import { buildChatGarmentAffordance } from "./chat-garment-affordances";

/**
 * The CHAT LANE's affordance adapter (body-attribute-affordances slices 4 and 6).
 *
 * The one place chat-lane state becomes the lane-neutral affordance payload. It
 * exists so the shared calculation forks nowhere: a successor adapter will
 * normalize its own reads into the same `HairLanePayload` and perception view,
 * and every number in `contracts/affordances` stays lane-agnostic.
 *
 * Two domains ride it now — hair (slice 4) and garment (slice 6). The garment
 * half's wardrobe normalization lives in the sibling
 * `chat-garment-affordances.ts`; this file owns the read, the perception view,
 * and the capture, so the two domains cannot end up with two different ideas of
 * which cut they are reading.
 *
 * ## The adapter result law, as this lane can actually answer it
 *
 * | input | chat-lane owner | status |
 * | --- | --- | --- |
 * | `hair.arrangement` | canonical attributes + narrative/condition overlays | supported |
 * | `wetness` | `ChatState.bodySurface` (extraction-owned, lazily dried, held under standing rain) | supported, or **invalid** on a quarantined entry |
 * | `coveredFraction` | worn coverage of the `hair` body location | supported, or **unavailable** with no wardrobe read |
 * | `wind` | `ChatScenario.environment` (extraction-owned) | supported — including "still air", which is a real answer |
 * | `events` | the wetness entry's own cause + active precipitation | supported, rain/immersion/splash ONLY |
 * | `motion` | — | **unavailable** (no body-motion owner) |
 * | `contacts` | — | **unavailable** (no typed contact owner) |
 * | `contamination` | — | **unavailable** (no owner) |
 *
 * The GARMENT domain's own table lives in `chat-garment-affordances.ts`. Its one
 * production silence is the same shape as hair adhesion's: no lane owns garment
 * fit or pose, so no garment/body contact can be established, `contacts` is
 * reported unavailable, and `garment.wet_cling` is suppressed by the core before
 * its resolver runs.
 *
 * `wetness` is the one input with a live **invalid** path: a corrupt
 * `body_surface` entry is quarantined by the state owner rather than healed to
 * "dry", so this adapter reports it invalid, files `affordance.input.invalid`,
 * and the domain — for which wetness is structural — falls entirely silent.
 * Conservative silence, never a convenient default.
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
 * and the garment store both ride `pre_exchange_scenario` and `bodySurface`
 * rides `pre_exchange_state`, so a rolled-back exchange rebuilds a byte-identical
 * read, byte-identical next cues, and a byte-identical captured coverage read.
 * There is no hysteresis and no hidden latch anywhere in the path.
 *
 * ## Who reads this, and under which flag
 *
 * | Consumer | Flag | What it takes |
 * | --- | --- | --- |
 * | Cue projection (`chat-affordance-cues.ts`, closed experiment) | `CHAT_AFFORDANCE_CUES` | `read.cues` → clauses, plus the `nextCues` write |
 * | Narrator physical guidance (`chat-physical-guidance.ts`) | `CHAT_PHYSICAL_CONSTRAINTS` | `read.constraints` + `committed` + the perception view |
 * | Recognizable features (`chat-recognition-adapter.ts`) | `CHAT_RECOGNITION_CUES` | the perception view only |
 *
 * The pipeline builds this read when ANY of the three needs it and hands the one
 * result to each — one cut, three consumers. Only the cue path may spend or persist
 * cue memory: `nextCues` is threaded to the finalizer under `CHAT_AFFORDANCE_CUES`
 * alone, so one experiment can never write another's state and make both
 * uninterpretable. With all three flags off nothing here is called at all.
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
  /**
   * The resolved wardrobe's `partVisibility` — the SAME occlusion pass the
   * coverage rows came from, so the garment domain never re-derives who is
   * buried under whom.
   */
  readonly partVisibility?: Readonly<Record<string, WornVisibility>>;
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
  /**
   * The conversation's garment store + this subject's actor handle. Present ⇒
   * the garment domain runs off real wardrobe truth; absent (or an actor with no
   * instances) ⇒ it is not run at all, because an unmodelled wardrobe is
   * UNKNOWN, never empty.
   */
  readonly garments?: ChatGarmentStore;
  readonly garmentActorId?: string;
  readonly bodySurface: BodySurfaceState;
  readonly environment: ChatEnvironment;
  /** The story clock this read is taken at (`ChatScenario.clockMinutes`). */
  readonly clockMinutes: number;
  /** The cue memory this cut starts from — restored with the scenario on a retake. */
  readonly previousCues?: AffordanceCueState;
  readonly sink?: DiagnosticSink;
}

/**
 * The committed physical facts this read was taken over, in the hair domain's own
 * vocabulary (narrator-physical-guidance slice 2).
 *
 * Handed back rather than re-derived by the guidance adapter, for the same reason
 * `attributes` is: a fence built from a second reading of the same state could
 * disagree with the read it accompanies, and "the narrator was told the hair is
 * braided while the cue said it was loose" is worse than either alone.
 *
 * `available` is the adapter result law, projected: `false` means this lane could
 * not answer for that owner, which licenses an UNSUPPORTED-claim fence and never a
 * substituted value. A `null` value with `available: true` is a different and
 * narrower statement — the owner answered, and the answer maps to no claim code
 * (an unidentified style, an unrecorded cause).
 */
export interface ChatCommittedHairState {
  readonly wetnessBand: HairWetnessBand | null;
  /**
   * The single committed wetting kind, or `null` when there is none — or more than
   * one. Two live causes (a bath, then rain on the walk home) are ambiguous, and an
   * ambiguous provenance must produce silence rather than a coin toss.
   */
  readonly wetnessCause: HairWettingEventKind | null;
  readonly arrangement: HairArrangement | null;
  readonly coveredFraction: number | null;
  readonly available: {
    readonly wetness: boolean;
    readonly arrangement: boolean;
    readonly coverage: boolean;
  };
}

export interface ChatAffordanceReadResult {
  readonly read: AffordanceRead;
  /** The cue memory to persist onto `ChatScenario.affordanceCues` beside this cut. */
  readonly nextCues: AffordanceCueState;
  /**
   * The resolved attributes this read was taken over — handed back so CUE
   * PROJECTION (`chat-affordance-cues.ts`) can reach stable appearance the
   * mechanics deliberately never see (`hair.color`), without resolving overlays
   * a second time and risking a cue that disagrees with the read it decorates.
   */
  readonly attributes: ResolvedAttributeSnapshot;
  /**
   * The staged effective-coverage read for this cut, or `null` when this actor's
   * wardrobe is unmodelled.
   *
   * The owner ruling is that this is CAPTURED with the presentation cut rather
   * than reconstructed later, so the caller persists it onto the garment store
   * (`ChatGarmentStore.coverage`) — the same JSONB value, the same rollback
   * anchor, as the garments it describes.
   */
  readonly coverage: EffectiveCoverageRead | null;
  /**
   * The garment names this read spoke about, keyed by instance id — cue
   * projection needs them to say "her jacket" rather than "the fabric over her
   * shoulders", and the observation itself carries only a body location and tags.
   */
  readonly garmentNames: Readonly<Record<string, string>>;
  /** The committed physical facts behind this read (see `ChatCommittedHairState`). */
  readonly committed: ChatCommittedHairState;
  /**
   * Exactly what was handed to the staged runner.
   *
   * The read-only developer preview (architecture spec §Resolved) re-traces the
   * SAME request through each domain's `trace(...)` to show the staged
   * calculation. Handing the request back rather than rebuilding it there is
   * what stops the preview explaining a read that differs from the real one.
   */
  readonly request: {
    readonly subjectId: AffordanceSubjectId;
    readonly storyTime: AffordanceStoryTime;
    readonly attributes: ResolvedAttributeSnapshot;
    readonly payloads: Readonly<Record<string, unknown>>;
    readonly perception: AffordancePerceptionView;
    readonly domains: readonly RegisteredAffordanceDomain[];
  };
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
 * The payload this adapter builds. `HairLanePayload` documents the SUPPORTED
 * shape; this widens `wetness` to `number | null` because the adapter must also
 * be able to say "present, and not readable" — the payload is the only channel it
 * has for the adapter result law's `invalid`.
 */
type HairPayloadDraft = Partial<Omit<HairLanePayload, "wetness">> & { readonly wetness: number | null };

/**
 * Coverage of, and visibility at, the `hair` location.
 *
 * Both fall out of ONE pass of the shared wardrobe resolver — no second occlusion
 * model, no re-expansion of coverage ids. `visibleAt` names the locations a row
 * is the OUTERMOST cover of, so the row that lists `hair` there is the thing an
 * observer's eye actually reaches, and its opacity decides how much of the
 * location an observer can still read.
 *
 * **Opaque headwear is `hinted`, not `hidden`** (owner ruling, review finding 5).
 * The two layers were contradicting each other: mechanics already models a hood
 * as PARTIAL coverage (`HAIR_COVERED_OPAQUE` is 0.9 precisely because ends and
 * fringe hang out), and then perception threw away everything that partial
 * coverage let through — every hair observation, not just the ones coverage
 * damps. So the division of labour is now clean: coverage constrains WHAT can
 * move, and perception states only what an eye can reach. An ordinary hat, cap,
 * or hood leaves part of the location visible, and `hinted` says exactly that —
 * which is why a soaking under a hood can now be described.
 *
 * Note what this does NOT unlock on its own: at `HAIR_COVERED_OPAQUE` the
 * mechanics still gate the ends-only wind response shut (`covered`), because
 * 0.9 leaves too little free area to clear its floor — the hair domain's own
 * worked case sits at 0.6. That is a CALIBRATION question about this constant,
 * not a perception one, and it is deliberately left alone here.
 *
 * Genuinely TOTAL concealment — a wrapped headscarf, a veil, hair tucked
 * entirely inside a hood — is a real state and it should read `hidden`. It needs
 * a finer coverage signal than the wardrobe's per-location boolean can give
 * (fullness, or a garment flag), so no headwear returns `hidden` until that
 * signal exists; guessing which hats are total from opacity alone is what
 * produced this bug.
 */
function readHairCoverage(wardrobe: ChatAffordanceWardrobe): HairCoverageRead {
  const worn = [...wardrobe.worn];
  const views = resolveWardrobeVisibility(worn);
  const outermost = views.find((view) => view.visibleAt.includes(HAIR_LOCATION_ID));
  const row = outermost ? worn.find((item) => item.instanceId === outermost.instanceId) : undefined;
  if (row === undefined) return { coveredFraction: 0, exposure: "visible" };
  return row.opacity === "sheer"
    ? { coveredFraction: HAIR_COVERED_SHEER, exposure: "hinted" }
    : { coveredFraction: HAIR_COVERED_OPAQUE, exposure: "hinted" };
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
  const stored = bodySurfaceWetnessEntry(input.bodySurface, HAIR_LOCATION_ID);
  // A quarantined entry has no readable cause OR stamp — its provenance died with
  // its level, and inventing either would be the invention this whole layer refuses.
  const entry = stored !== undefined && !isInvalidSurfaceEntry(stored) ? stored : undefined;
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

/**
 * The one committed wetting kind among this cut's events, or `null`.
 *
 * Read off the events the adapter already built rather than off the stored entry,
 * so the provenance a premise fence compares against is exactly the provenance the
 * domain may cite — including standing rain, which is a real wetting event nobody
 * recorded on the surface row. More than one kind is ambiguous and returns `null`:
 * with a bath AND rain both live, "the storm soaked your hair" is not a claim this
 * lane can call wrong.
 */
function committedWettingCause(events: readonly HairCausalEvent[]): HairWettingEventKind | null {
  const wetting = hairWettingEventKinds.filter((kind) => events.some((event) => event.kind === kind));
  return wetting.length === 1 ? (wetting[0] ?? null) : null;
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

/**
 * Build one subject's affordance read for the current committed cut.
 *
 * Only the domains this lane can actually feed are run. Handing the default
 * registry every domain would emit an `affordance.input.unavailable` warning per
 * unfed domain per exchange — degradation telemetry for a decision nobody made.
 * Adding a domain here is meant to be a deliberate act: you add it when you have
 * built its payload. Hair always runs; garment runs when this actor's wardrobe
 * is actually modelled as instances.
 */
export function buildChatAffordanceRead(input: ChatAffordanceReadInput): ChatAffordanceReadResult {
  const storyTime = Math.max(0, Math.trunc(input.clockMinutes));
  const coverage = input.wardrobe ? readHairCoverage(input.wardrobe) : undefined;

  // The garment half (slice 6). `null` ⇒ unmodelled wardrobe ⇒ the domain is not
  // run and nothing is captured — an unknown wardrobe, never an empty one.
  const garment =
    input.wardrobe && input.garments && input.garmentActorId
      ? buildChatGarmentAffordance({
          store: input.garments,
          actorId: input.garmentActorId,
          worn: input.wardrobe.worn,
          ...(input.wardrobe.partVisibility === undefined ? {} : { visibility: input.wardrobe.partVisibility }),
          environment: input.environment,
          clockMinutes: storyTime,
        })
      : null;

  // Standing outdoor rain HOLDS the committed soaking rather than drying it
  // forward (`surfaceDryingSuspended` is the one shared definition, so this read
  // and the finalize fold's integration can never disagree).
  const wetness = bodySurfaceWetnessAt(input.bodySurface, HAIR_LOCATION_ID, storyTime, {
    suspendDrying: surfaceDryingSuspended(input.environment),
  });
  if (wetness.status === "invalid") {
    input.sink?.push(
      diag("warn", AFFORDANCE_INPUT_INVALID, `Stored wetness for "${HAIR_LOCATION_ID}" is quarantined — hair domain suppressed`, {
        path: "character_chat_state.body_surface",
        context: { locationId: HAIR_LOCATION_ID, subjectId: input.subjectId },
      }),
    );
  }

  // `Partial` because `coveredFraction` is genuinely omissible here: absent ⇒ the
  // domain reads it `unavailable` ⇒ the whole hair read is unavailable. That IS
  // the audit's "unknown coverage fails closed" — guessing "uncovered" would let
  // hidden hair stream in the wind.
  //
  // `wetness: null` is the other half of that law and the reason this draft type
  // widens the field: a quarantined surface entry is PRESENT-and-unreadable, which
  // the domain's `readInput` classifies `invalid` (an omitted key would say
  // `unavailable`, a weaker and less true claim). Wetness is structural to the
  // hair domain, so either way the whole domain falls conservatively silent — but
  // only `invalid` says the state row is broken.
  const events = hairEvents(input);
  const payload: HairPayloadDraft = {
    wetness: wetness.status === "known" ? wetness.level : null,
    ...(coverage === undefined ? {} : { coveredFraction: coverage.coveredFraction }),
    // Still air is an ANSWER, not an absence: the environment owner can say "no
    // wind", which is a different claim from "this lane has no weather".
    wind: { force: windForceOf(input.environment) },
    events,
    // `motion`, `contacts` and `contamination` are deliberately absent — no owner.
  };

  const attributes = resolvedAttributeSnapshot(resolveSubjectAttributes(input));
  const arrangement = hairArrangementOf(attributes);
  // Derived from the SAME values the payload above carries — one reading of the cut,
  // two consumers (the staged domain run, and the narrator-guidance detector).
  const committed: ChatCommittedHairState = {
    wetnessBand: wetness.status === "known" ? hairWetnessBand(wetness.level) : null,
    wetnessCause: committedWettingCause(events),
    arrangement,
    coveredFraction: coverage?.coveredFraction ?? null,
    available: {
      wetness: wetness.status === "known",
      arrangement: arrangement !== null,
      coverage: coverage !== undefined,
    },
  };
  const request = {
    subjectId: affordanceSubjectId(input.subjectId),
    storyTime,
    attributes,
    perception: affordancePerceptionView({
      exposure: {
        // The garment domain speaks about the surface of what is worn, so the
        // wardrobe answers for every location it reaches.
        ...(garment?.exposure ?? {}),
        // Hair LAST, deliberately: a hat both covers `hair` and is a garment, and
        // the hair adapter's own verdict is the careful one (partial coverage
        // reads `hinted`, never `visible`). Unlisted locations still read
        // `unknown` and fail closed.
        [HAIR_LOCATION_ID]: coverage?.exposure ?? "unknown",
      },
      // The chat lane's observer is the player, present in the scene; sight is the
      // one channel it can positively assert.
      channels: { sight: "available" },
    }),
    domains: garment ? [hairAffordanceDomain, garmentAffordanceDomain] : [hairAffordanceDomain],
    payloads: {
      [HAIR_DOMAIN_ID]: payload as unknown,
      ...(garment === null ? {} : { [GARMENT_DOMAIN_ID]: garment.payload as unknown }),
    },
  };
  const read = deriveAffordanceRead({
    ...request,
    previousCues: input.previousCues ?? emptyAffordanceCueState(),
    ...(input.sink === undefined ? {} : { sink: input.sink }),
  });

  return {
    read,
    nextCues: read.nextCues,
    attributes,
    coverage: garment?.coverage ?? null,
    garmentNames: garmentNamesOf(input),
    committed,
    request,
  };
}

/**
 * Instance id → display name for the garments this read could speak about.
 *
 * Taken from the coverage ROWS rather than the store, so a name only ever
 * appears for a garment the read actually saw — and it is the same name the
 * wardrobe digest uses, because both come from the resolved wardrobe items.
 */
function garmentNamesOf(input: ChatAffordanceReadInput): Record<string, string> {
  const names: Record<string, string> = {};
  for (const row of input.wardrobe?.worn ?? []) names[row.garmentId] = row.name;
  return names;
}
