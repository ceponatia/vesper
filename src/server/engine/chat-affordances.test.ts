import { describe, expect, it } from "vitest";
import {
  affordancePerceptionView,
  affordanceSubjectId,
  AFFORDANCE_INPUT_INVALID,
  AFFORDANCE_INPUT_UNAVAILABLE,
  AFFORDANCE_PERCEPTION_HIDDEN,
  bodySurfaceStateSchema,
  deriveAffordanceRead,
  emptyBodySurfaceState,
  emptyChatEnvironment,
  hairAffordanceDomain,
  hairAttributeFixture,
  HAIR_DOMAIN_ID,
  resolvedAttributeSnapshot,
  setBodySurfaceWetness,
  BODY_SURFACE_UNIT_ONE,
  type AttributeValue,
  type BodySurfaceState,
  type ChatEnvironment,
  type WornItemInput,
} from "@/contracts";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import {
  buildChatAffordanceRead,
  CHAT_AFFORDANCE_EVENT_FRESHNESS_MINUTES,
  type ChatAffordanceReadInput,
} from "./chat-affordances";

/**
 * The chat lane's affordance adapter (body-attribute-affordances slice 4).
 *
 * These are the adapter-law tests: what this lane can answer, what it refuses to
 * answer, and the determinism the retake guarantee rests on. The physics itself
 * is proved by the domain's own fixtures — nothing here re-asserts a band.
 */

const HAIR = "hair";

/** Dense, coarse, shoulder-length, loose — hair with something to say when it gets wet. */
const ATTRIBUTES: AttributeValue[] = hairAttributeFixture({
  length: "shoulder_length",
  density: "dense",
  strandThickness: "thick",
  texture: "wavy",
  condition: "healthy",
  arrangement: "loose",
});

/** A bare head: the wardrobe was READ, and it covers nothing. */
const BARE: WornItemInput[] = [];

function hat(opacity: "opaque" | "sheer"): WornItemInput[] {
  return [{ instanceId: "hat", garmentId: "hat", name: "a wool hat", coverage: [HAIR], layer: 2, opacity }];
}

function soaked(atMinutes = 0, cause: "rain" | "immersion" | "splash" | "other" = "rain"): BodySurfaceState {
  return setBodySurfaceWetness(emptyBodySurfaceState(), {
    locationId: HAIR,
    level: BODY_SURFACE_UNIT_ONE,
    atMinutes,
    cause,
  });
}

const OUTDOORS_GALE: ChatEnvironment = {
  wind: "gusting",
  precipitation: "none",
  indoors: false,
  updatedAtMinutes: 0,
};

function read(over: Partial<ChatAffordanceReadInput> = {}) {
  return buildChatAffordanceRead({
    subjectId: "chr_wren",
    attributes: ATTRIBUTES,
    wardrobe: { worn: BARE },
    bodySurface: emptyBodySurfaceState(),
    environment: emptyChatEnvironment(),
    clockMinutes: 0,
    ...over,
  });
}

const ids = (list: readonly { id: string }[]): string[] => list.map((entry) => entry.id);
const suppression = (result: ReturnType<typeof read>, phenomenonId: string) =>
  result.read.suppressed.find((entry) => entry.phenomenonId === phenomenonId);

describe("what the lane can answer", () => {
  it("wetness reaches the read — wet hair clumps observably", () => {
    const dry = read();
    expect(ids(dry.read.observations)).not.toContain("hair.wet_clumping");
    expect(suppression(dry, "hair.wet_clumping")?.code).toBe("insufficient_wetness");

    const wet = read({ bodySurface: soaked() });
    expect(ids(wet.read.observations)).toContain("hair.wet_clumping");
    const clumping = wet.read.observations.find((o) => o.id === "hair.wet_clumping");
    expect(clumping?.sourceLocationId).toBe(HAIR);
    // The rain provenance is present because the surface entry RECORDED a cause,
    // not because anything read the narration.
    expect(clumping?.semanticTags).toContain("recent_rain");
  });

  it("cites the recorded cause BY NAME — and `other` stays silent about why", () => {
    // Round-R2 change (trial log): every cause the state recorded reaches the
    // read as its own tag, because a wet read that named nothing let the
    // narrator supply the loudest cause in the scene (the storm at the window).
    const causeTags = (cause: "rain" | "immersion" | "splash" | "other"): string[] =>
      (
        read({ bodySurface: soaked(0, cause) }).read.observations.find((o) => o.id === "hair.wet_clumping")
          ?.semanticTags ?? []
      ).filter((tag) => tag.startsWith("recent_"));
    expect(causeTags("rain")).toEqual(["recent_rain"]);
    expect(causeTags("immersion")).toEqual(["recent_immersion"]);
    expect(causeTags("splash")).toEqual(["recent_splash"]);
    // `other` means "the fiction wet her and did not say how" — an unmapped
    // cause commits no event, so the read carries no provenance at all.
    expect(causeTags("other")).toEqual([]);
  });

  it("a cause older than the freshness window stops being cited", () => {
    const stale = read({
      bodySurface: soaked(0),
      clockMinutes: CHAT_AFFORDANCE_EVENT_FRESHNESS_MINUTES + 1,
      // Keep it soaked so the phenomenon still fires: only the CAUSE should age out.
      environment: emptyChatEnvironment(),
    });
    const clumping = stale.read.observations.find((o) => o.id === "hair.wet_clumping");
    expect(clumping?.semanticTags ?? []).not.toContain("recent_rain");
  });

  it("active precipitation is its own standing rain exposure", () => {
    const rained = read({
      bodySurface: setBodySurfaceWetness(emptyBodySurfaceState(), { locationId: HAIR, level: 9_000, atMinutes: 0 }),
      environment: { wind: "breeze", precipitation: "rain", indoors: false, updatedAtMinutes: 0 },
    });
    const clumping = rained.read.observations.find((o) => o.id === "hair.wet_clumping");
    expect(clumping?.semanticTags).toContain("recent_rain");
  });

  it("wind reaches the read outdoors, and indoors is silence rather than a guess", () => {
    const outside = read({ environment: OUTDOORS_GALE });
    expect(ids(outside.read.observations)).toContain("hair.wind_or_motion_response");

    const inside = read({ environment: { ...OUTDOORS_GALE, indoors: true } });
    expect(ids(inside.read.observations)).not.toContain("hair.wind_or_motion_response");
    // The environment ANSWERED (still air) — this is a domain suppression, not an
    // "input unavailable": the lane owns weather, and the answer was no wind.
    expect(suppression(inside, "hair.wind_or_motion_response")?.code).toBe("no_current_force");
  });

  it("materializes the registry's declared arrangement default when the axis is unset", () => {
    const unset = ATTRIBUTES.filter((value) => value.id !== "hair.arrangement");
    const result = read({ attributes: unset, environment: OUTDOORS_GALE });
    // Without the default the whole domain would report unavailable; with it the
    // hair reads as loose (which is what the attribute declares) and moves.
    expect(ids(result.read.observations)).toContain("hair.wind_or_motion_response");
  });
});

describe("standing rain holds the soaking rather than drying it", () => {
  const DOWNPOUR: ChatEnvironment = { wind: "none", precipitation: "downpour", indoors: false, updatedAtMinutes: 0 };

  it("hair does not dry out while the rain is still landing on it", () => {
    // Four story hours: enough to dry a saturated head out completely.
    const dry = read({ bodySurface: soaked(0), environment: emptyChatEnvironment(), clockMinutes: 4 * 60 });
    expect(ids(dry.read.observations)).not.toContain("hair.wet_clumping");
    expect(suppression(dry, "hair.wet_clumping")?.code).toBe("insufficient_wetness");

    const rained = read({ bodySurface: soaked(0), environment: DOWNPOUR, clockMinutes: 4 * 60 });
    expect(ids(rained.read.observations)).toContain("hair.wet_clumping");
  });

  it("under cover the same weather dries exactly as before", () => {
    const inside = read({
      bodySurface: soaked(0),
      environment: { ...DOWNPOUR, indoors: true },
      clockMinutes: 4 * 60,
    });
    expect(ids(inside.read.observations)).not.toContain("hair.wet_clumping");
  });
});

describe("a quarantined surface entry is invalid, never 'dry'", () => {
  const corrupt = bodySurfaceStateSchema.parse({ wetness: { [HAIR]: { level: "soaked", updatedAtMinutes: 3 } } });

  it("suppresses the whole hair domain and files affordance.input.invalid", () => {
    const sink = new DiagnosticCollector();
    const result = read({ bodySurface: corrupt, environment: OUTDOORS_GALE, sink });

    // The failure mode this replaced: a corrupt level read as 0, and DRY hair is
    // MORE mobile than wet hair — so the corruption bought a wind-motion cue.
    expect(result.read.observations).toEqual([]);
    expect(suppression(result, "hair.wind_or_motion_response")?.code).toBe(AFFORDANCE_INPUT_INVALID);
    const filed = sink.items.find(
      (d) => d.code === AFFORDANCE_INPUT_INVALID && d.path === "character_chat_state.body_surface",
    );
    expect(filed?.severity).toBe("warn");
    expect(filed?.context).toMatchObject({ locationId: HAIR });
  });

  it("a valid sibling location is untouched by its neighbour's corruption", () => {
    const mixed = bodySurfaceStateSchema.parse({
      wetness: { chest: 41, [HAIR]: { level: BODY_SURFACE_UNIT_ONE, updatedAtMinutes: 0, cause: "rain" } },
    });
    const result = read({ bodySurface: mixed });
    expect(ids(result.read.observations)).toContain("hair.wet_clumping");
  });
});

describe("what the lane refuses to answer", () => {
  it("contacts are unavailable, so adhesion is suppressed by the CORE before its resolver runs", () => {
    const result = read({ bodySurface: soaked() });
    const suppressed = suppression(result, "hair.strands_adhere_to_skin");
    // The core's dotted code, not the domain's `no_asserted_contact` — proof that
    // the resolver never saw an empty contact list to misread as "nothing touching".
    expect(suppressed?.code).toBe(AFFORDANCE_INPUT_UNAVAILABLE);
    expect(suppressed?.detail).toContain("contacts");
  });

  it("never synthesizes an impulse, so droplet shedding stays production-silent", () => {
    const result = read({ bodySurface: soaked(), environment: OUTDOORS_GALE });
    expect(ids(result.read.observations)).not.toContain("hair.sheds_droplets");
    // `events` IS supported (rain/immersion/splash) — the silence is the domain
    // finding no committed impulse among them, which is the honest reading.
    expect(suppression(result, "hair.sheds_droplets")?.code).toBe("no_current_impulse");
  });

  it("an absent wardrobe read fails closed — unknown coverage silences the domain", () => {
    const sink = new DiagnosticCollector();
    const result = buildChatAffordanceRead({
      subjectId: "chr_wren",
      attributes: ATTRIBUTES,
      bodySurface: soaked(),
      environment: OUTDOORS_GALE,
      clockMinutes: 0,
      sink,
    });
    expect(result.read.observations).toEqual([]);
    expect(result.read.suppressed.every((entry) => entry.code === AFFORDANCE_INPUT_UNAVAILABLE)).toBe(true);
    expect(sink.items.map((d) => d.code)).toContain(AFFORDANCE_INPUT_UNAVAILABLE);
  });
});

describe("perception uses the wardrobe's own vocabulary", () => {
  it("opaque headwear only HINTS — a hood leaves ends and fringe readable", () => {
    // Review finding 5: mechanics already model a hood as PARTIAL coverage
    // (`coveredFraction` 0.9), and perception used to throw away everything that
    // partial coverage let through — which made the hair spec's fourth worked
    // case unreachable in production. `hinted` states the truth instead.
    const result = read({ bodySurface: soaked(), wardrobe: { worn: hat("opaque") } });
    expect(ids(result.read.observations)).toContain("hair.wet_clumping");
  });

  it("coverage, not perception, is what constrains motion under that hood", () => {
    const bare = read({ environment: OUTDOORS_GALE });
    expect(
      bare.read.observations.find((o) => o.id === "hair.wind_or_motion_response")?.semanticTags,
    ).toContain("whole_hair");

    // The hood silences the MOVEMENT for a physical reason the domain names —
    // `covered`, from `coveredFraction` — and no longer for the perception reason
    // that used to hide everything about the location at once. Which layer says
    // no is the whole point: the mechanics are entitled to, perception was not.
    const hooded = read({ environment: OUTDOORS_GALE, wardrobe: { worn: hat("opaque") } });
    expect(suppression(hooded, "hair.wind_or_motion_response")?.code).toBe("covered");
    expect(suppression(hooded, "hair.wind_or_motion_response")?.code).not.toBe(AFFORDANCE_PERCEPTION_HIDDEN);
  });

  it("a sheer covering only HINTS, so the read still surfaces", () => {
    const result = read({ bodySurface: soaked(), wardrobe: { worn: hat("sheer") } });
    expect(ids(result.read.observations)).toContain("hair.wet_clumping");
  });

  it("a bare head is visible", () => {
    const result = read({ bodySurface: soaked() });
    expect(ids(result.read.observations)).toContain("hair.wet_clumping");
  });

  it("a HIDDEN exposure still suppresses — the gate is intact, no chat garment sets it", () => {
    // Nothing this lane can wear produces `hidden` today (genuinely total
    // concealment needs a finer coverage signal than the wardrobe's per-location
    // boolean), so the gate is proved by constructing the view directly.
    const hidden = deriveAffordanceRead({
      subjectId: affordanceSubjectId("chr_wren"),
      storyTime: 0,
      attributes: resolvedAttributeSnapshot(ATTRIBUTES),
      perception: affordancePerceptionView({ exposure: { [HAIR]: "hidden" }, channels: { sight: "available" } }),
      domains: [hairAffordanceDomain],
      payloads: {
        [HAIR_DOMAIN_ID]: { wetness: BODY_SURFACE_UNIT_ONE, coveredFraction: 9_000, wind: { force: 0 }, events: [] },
      },
    });
    expect(hidden.observations).toEqual([]);
    expect(hidden.suppressed.find((entry) => entry.phenomenonId === "hair.wet_clumping")?.code).toBe(
      AFFORDANCE_PERCEPTION_HIDDEN,
    );
  });
});

describe("determinism — the capture mechanism", () => {
  it("the same committed cut produces the identical read AND the identical next cues", () => {
    const input: Partial<ChatAffordanceReadInput> = {
      bodySurface: soaked(4),
      environment: OUTDOORS_GALE,
      clockMinutes: 30,
    };
    const first = read(input);
    const second = read(input);
    expect(JSON.stringify(second.read)).toBe(JSON.stringify(first.read));
    expect(second.nextCues).toEqual(first.nextCues);
  });

  it("replaying with the captured cue memory offers nothing new — the repeat gate", () => {
    const input: Partial<ChatAffordanceReadInput> = {
      bodySurface: soaked(4),
      environment: OUTDOORS_GALE,
      clockMinutes: 30,
    };
    const first = read(input);
    expect(first.read.cues.length).toBeGreaterThan(0);
    const again = read({ ...input, previousCues: first.nextCues });
    expect(again.read.cues).toEqual([]);
    // …and the memory is stable, so a third identical cut still says nothing.
    expect(again.nextCues.bands).toEqual(first.nextCues.bands);
  });

  it("reading does not mutate the state it was handed", () => {
    const surface = soaked(4);
    const before = JSON.stringify(surface);
    read({ bodySurface: surface, environment: OUTDOORS_GALE, clockMinutes: 90 });
    expect(JSON.stringify(surface)).toBe(before);
  });
});
