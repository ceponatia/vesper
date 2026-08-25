import { affordancePerceptionView } from "@/contracts";
import type { AttributeValue } from "@/contracts/attributes";
import { exposedRegions, type RegionExposure } from "@/contracts/items/visibility";
import type { CharacterProfile } from "@/contracts/world/profile";
import {
  type AvatarSegmentAssembly,
  type AvatarStyle,
  type AvatarWardrobeItem,
  buildAvatarSegments,
  buildCharacterSceneContext,
  buildVariantSegments,
  resolveScenePlan,
  type SceneCastMember,
  type SceneRenderPlan,
  sceneSpecSchema,
  toWornInputs,
  type VariantKind,
  type VariantSegmentAssembly,
} from "@/server/images";
import type { VisualStateShadowInput } from "@/server/visual-state";
import { attr, makeProfile } from "./profile-fixtures";

/**
 * The pre-migration probe for the character-bearing image lanes
 * (image-lane-consolidation.plan.md Stage 1, spec.prompts §"Characterization and
 * comparison").
 *
 * The consolidation moves every lane off its own appearance builder and onto one
 * visual digest. The failure it must not cause is a **lost, duplicated, or newly
 * exposed character fact** — an age sentence that stops being emitted, a covered
 * region that starts being described, an identity anchor that lands twice.
 *
 * A snapshot of the prompt STRING cannot catch that, because the migration's
 * whole point is to change the wording: every rewrite would fail the snapshot and
 * the only available fix is to re-bless it, which is no guardrail at all. So the
 * probe watches FACTS instead of phrasing. Each fixture attribute carries a
 * deliberately distinctive value ("deep violet" hair, a "spiraled" horn, a
 * "gravelly" voice), and a probe asks only whether that value's word reached the
 * compiled prompt and how many times. Any reasonable wording of the same fact
 * keeps the word; dropping the fact removes it. That is exactly the comparison
 * the spec asks for — normalize intentional wording changes, fail on a changed
 * fact set.
 *
 * The fixture is one character across every lane on purpose: the plan exists
 * because the same person is described differently depending on which route
 * rendered them, and a per-lane fixture would hide that. The frozen matrix lives
 * in `server/images/lane-characterization.test.ts`.
 */

/** Which digest bucket a probed fact belongs to (spec.prompts §"Segment mapping"). */
export type VisualFactBucket =
  | "identity"
  | "morphology"
  | "apparentAge"
  | "wardrobe"
  | "exposure"
  | "lowerBody"
  | "intimate"
  | "nonvisual";

/** One character fact and the words that prove it reached a prompt. */
export interface VisualFactProbe {
  /** Stable key used in the frozen per-lane matrices. */
  key: string;
  bucket: VisualFactBucket;
  /**
   * Mandatory for every character-bearing lane once the consolidation lands
   * (plan §"Mandatory facts do not compete with salience"). NOT an assertion
   * about today — several lanes are missing mandatory facts right now, and
   * recording that gap is the point of the freeze.
   */
  mandatory: boolean;
  /**
   * Words any wording of this fact must contain, matched case-insensitively — a
   * lane that capitalizes a clause's first word ("Fully nude, no clothing.")
   * states the same fact as one that does not. A probe matches when ANY token
   * appears; the count is the total across tokens, so a fact stated twice reads
   * as 2 whichever synonym each site chose.
   */
  tokens: readonly string[];
}

/**
 * One row of the probe table: the fact, the FIRST fixture's wording for it, and
 * the SECOND fixture's.
 *
 * The second column is what makes a two-subject prompt readable
 * (image-lane-consolidation Stage 4, the cast ≥2 scene). `observeVisualFacts`
 * counts tokens across the whole compiled prompt and has no way to scope a
 * count to one person's clause — the prompt interleaves per-subject detail
 * lines with lane-owned framing, and slicing it by subject label would be a
 * parser that drifts the moment the transport rewords a heading. Disjoint
 * VALUES answer the same question without a parser: if only one character in
 * the fixture has gossamer wings, then "gossamer" appearing means the prompt
 * stated THAT character's wings, and appearing twice means it stated them
 * twice. So every second-column token is chosen to share no substring with any
 * first-column token, in either direction ("male" is not usable beside
 * "female", because `indexOf` finds the first inside the second).
 *
 * `null` means the second fixture authors no value for that fact, and the
 * second probe list simply omits the row: a token that can never match is not a
 * weaker assertion, it is no assertion at all, and leaving one in the list would
 * read as coverage.
 */
interface VisualFactProbeSpec extends VisualFactProbe {
  readonly secondTokens: readonly string[] | null;
}

/**
 * `voice.timbre` is the negative control: `kind: "sensory"` never renders, so a
 * lane that starts emitting "gravelly" has grown a leak, not a feature.
 */
const VISUAL_FACT_PROBE_TABLE: readonly VisualFactProbeSpec[] = [
  { key: "gender", bucket: "identity", mandatory: true, tokens: ["female"], secondTokens: ["androgynous"] },
  /**
   * The second fixture authors no heritage, and the reason is the legacy
   * builder it is compared against: `characterAppearanceSummary` excerpts each
   * person's line at 200 characters, and the bystander's longer gender value spends
   * more of that budget than the focal's. One more cell would put the fixture on
   * the cap's edge, where an unrelated wording change silently truncates a
   * DIFFERENT fact and re-blesses itself as a delta.
   */
  { key: "ethnicity", bucket: "identity", mandatory: true, tokens: ["Latina"], secondTokens: null },
  { key: "species", bucket: "morphology", mandatory: true, tokens: ["succubus"], secondTokens: ["faerie"] },
  { key: "hairColor", bucket: "identity", mandatory: true, tokens: ["deep violet"], secondTokens: ["dyed teal"] },
  { key: "eyeColor", bucket: "identity", mandatory: true, tokens: ["amber"], secondTokens: ["emerald"] },
  { key: "skinTone", bucket: "identity", mandatory: true, tokens: ["bronze"], secondTokens: ["ashen"] },
  /**
   * A recognition-catalog DISTINCTIVE mark (`nose.shape: "crooked"`), authored
   * only by {@link laneProbeMarkedProfile} — the base fixture leaves it unset, so
   * every pre-existing frozen matrix is untouched. It exists to catch the
   * duplication seam the digest cutover opened: a cataloged distinctive value
   * can reach a lane through BOTH the digest's mark clause and the route-owned
   * residual attribute sheet, and only one of them may phrase it. The second
   * fixture carries no mark: the seam is a property of the projection road, not
   * of the cast size, and one marked subject already exercises it.
   */
  { key: "noseShape", bucket: "identity", mandatory: false, tokens: ["crooked"], secondTokens: null },
  { key: "horns", bucket: "morphology", mandatory: true, tokens: ["spiraled"], secondTokens: ["antlered"] },
  { key: "wings", bucket: "morphology", mandatory: true, tokens: ["membranous"], secondTokens: ["gossamer"] },
  { key: "tail", bucket: "morphology", mandatory: true, tokens: ["spaded"], secondTokens: ["fox"] },
  { key: "apparentAge", bucket: "apparentAge", mandatory: true, tokens: ["late twenties"], secondTokens: ["forties"] },
  { key: "garment", bucket: "wardrobe", mandatory: true, tokens: ["kimono"], secondTokens: ["tunic"] },
  /**
   * The one fact that CANNOT be attributed per subject: exposure wording is
   * lane-owned (`formatExposure` says "topless" for anybody), so a second column
   * here would count the first fixture's clause as the second fixture's. Both
   * cast members are dressed for exactly that reason — a bare bystander would
   * need a fact set this probe cannot read.
   */
  { key: "bareTorso", bucket: "exposure", mandatory: true, tokens: ["topless", "fully nude"], secondTokens: null },
  { key: "legBuild", bucket: "lowerBody", mandatory: false, tokens: ["athletic"], secondTokens: ["toned"] },
  { key: "toenails", bucket: "lowerBody", mandatory: false, tokens: ["painted"], secondTokens: ["chipped"] },
  { key: "bustSize", bucket: "intimate", mandatory: false, tokens: ["ample"], secondTokens: ["petite"] },
  { key: "nipples", bucket: "intimate", mandatory: false, tokens: ["puffy"], secondTokens: ["inverted"] },
  { key: "voiceTimbre", bucket: "nonvisual", mandatory: false, tokens: ["gravelly"], secondTokens: ["reedy"] },
];

function probeOf(spec: VisualFactProbeSpec, tokens: readonly string[]): VisualFactProbe {
  return { key: spec.key, bucket: spec.bucket, mandatory: spec.mandatory, tokens };
}

/** The probe set for the first fixture ({@link laneProbeProfile}) — every lane's default. */
export const VISUAL_FACT_PROBES: readonly VisualFactProbe[] = VISUAL_FACT_PROBE_TABLE.map((spec) =>
  probeOf(spec, spec.tokens),
);

/**
 * The same facts read off the SECOND fixture ({@link laneProbeSecondProfile}),
 * for the cast ≥2 scene. Same keys in the same order, so a per-subject fact set
 * and a delta over it are directly comparable with the first fixture's — minus
 * the rows the second fixture authors nothing for.
 */
export const SECOND_SUBJECT_VISUAL_FACT_PROBES: readonly VisualFactProbe[] = VISUAL_FACT_PROBE_TABLE.flatMap((spec) =>
  spec.secondTokens === null ? [] : [probeOf(spec, spec.secondTokens)],
);

const PROBES_BY_KEY = new Map(VISUAL_FACT_PROBES.map((probe) => [probe.key, probe]));

/** The probe for a key, or `undefined` for an unknown one. */
export function visualFactProbe(key: string): VisualFactProbe | undefined {
  return PROBES_BY_KEY.get(key);
}

/**
 * The fixture character every lane renders: a succubus, so species morphology
 * (horns/wings/tail) is live rather than a human's empty set, with intimate
 * regions present so exposure gating has something to gate. `voice.timbre` is
 * authored precisely so its absence is a tested outcome.
 */
export function laneProbeProfile(overrides: Partial<CharacterProfile> = {}): CharacterProfile {
  const base = (id: AttributeValue["id"], value: AttributeValue["value"]): AttributeValue =>
    attr(id, value, "base");
  return makeProfile({
    bio: "A daemonkin broker who deals in favors.",
    personality: "Unhurried, amused, entirely unbothered.",
    age: "134",
    speciesId: "succubus",
    intimateRegions: ["breasts", "vulva"],
    attributes: [
      base("identity.apparent_age", "late_twenties"),
      base("identity.gender", "female"),
      base("identity.heritage", "Latina"),
      base("hair.color", "deep_violet"),
      base("eyes.color", "amber"),
      base("skin.tone", "bronze"),
      base("horns.shape", "spiraled"),
      base("wings.type", "membranous"),
      base("tail.type", "spaded"),
      base("legs.build", "athletic"),
      base("feet.nails", "painted"),
      base("breasts.size", "ample"),
      base("breasts.nipples", "puffy"),
      base("voice.timbre", "gravelly"),
    ],
    ...overrides,
  });
}

/** The fixture's name — one place, since it appears in name-bound prompt sentences. */
export const LANE_PROBE_NAME = "Nyx";

/** The fixture's subject id — the one id the assemblies, digests and captures all name. */
export const LANE_PROBE_SUBJECT_ID = "probe-character";

/** The second cast member's name; distinct from {@link LANE_PROBE_NAME} in every letter. */
export const LANE_PROBE_SECOND_NAME = "Ilsa";

/** The second cast member's subject id — their own committed cut, never the focal's. */
export const LANE_PROBE_SECOND_SUBJECT_ID = "probe-character-second";

/**
 * The SECOND fixture character, for the cast ≥2 scene lane.
 *
 * Every probed value is disjoint from {@link laneProbeProfile}'s (see the probe
 * table's second column), because that disjointness is the whole attribution
 * mechanism: a two-subject prompt has no per-subject scope a counter can read,
 * so the only way to prove "this fact was stated for HER" is that nobody else
 * in the fixture could have produced the word.
 *
 * The rest of the design is chosen so the bystander exercises the seams a clone
 * of the focal would hide:
 *
 * - a DIFFERENT species with its own feature groups — faerie, with horns and a
 *   tail switched on through the per-character `bodyFeatures` override the
 *   species contract exists for. Same three morphology anchors as the focal,
 *   none of the same words, so "reference count does not change character
 *   wording" is testable as a fact set rather than asserted in a comment, and a
 *   production that handed `others` the focal's digest would state the focal's
 *   morphology twice and the bystander's not at all.
 * - a body whose coverage DISAGREES with the focal's: this wardrobe leaves the
 *   feet bare where the focal's slippers cover them, so the coverage-aware
 *   residue must keep one subject's `imageReveal: "skin"` toenails while
 *   dropping the other's — one prompt, both directions of the gate.
 * - an androgynous-born-male presentation with breasts configured — a
 *   transitioned body the gender attribute explicitly documents as authorable,
 *   and the reason the covered-intimate-skin invariant means something for a
 *   subject who is not the focal.
 */
export function laneProbeSecondProfile(overrides: Partial<CharacterProfile> = {}): CharacterProfile {
  const base = (id: AttributeValue["id"], value: AttributeValue["value"]): AttributeValue =>
    attr(id, value, "base");
  return makeProfile({
    bio: "A fae courier who runs the long roads.",
    personality: "Brisk, dry, never still for long.",
    age: "88",
    speciesId: "faerie",
    // The species defaults to wings alone; horns and a tail are this character's
    // own additive override, which is exactly what `bodyFeatures` is for.
    bodyFeatures: ["wings", "horns", "tail"],
    intimateRegions: ["breasts"],
    attributes: [
      base("identity.apparent_age", "forties"),
      base("identity.gender", "androgynous_born_male"),
      base("hair.color", "dyed_teal"),
      base("eyes.color", "emerald"),
      base("skin.tone", "ashen"),
      base("horns.shape", "antlered"),
      base("wings.type", "gossamer"),
      base("tail.type", "fox"),
      base("legs.build", "toned"),
      base("feet.nails", "chipped"),
      base("breasts.size", "petite"),
      base("breasts.nipples", "inverted"),
      base("voice.timbre", "reedy"),
    ],
    ...overrides,
  });
}

/**
 * The second fixture's wardrobe: torso through thighs covered, FEET BARE. The
 * bare feet are the point — the focal's slippers cover those, so one prompt
 * carries a covered `imageReveal: "skin"` fact for one person and the same
 * fact's uncovered twin for the other.
 */
export function laneProbeSecondWardrobe(): AvatarWardrobeItem[] {
  return [
    {
      name: "linen tunic",
      description: "a knee-length grey linen tunic",
      appearance: "faded at the hems",
      coverage: ["chest", "groin", "hips", "buttocks", "thighs"],
      layer: 1,
      opacity: "opaque",
    },
  ];
}

/** The second fixture as one scene cast member, dressed unless overridden. */
export function laneProbeSecondCastMember(over: Partial<SceneCastMember> = {}): SceneCastMember {
  return {
    characterId: LANE_PROBE_SECOND_SUBJECT_ID,
    name: LANE_PROBE_SECOND_NAME,
    profile: laneProbeSecondProfile(),
    avatarImageId: null,
    outfit: "a knee-length grey linen tunic",
    exposure: exposedRegions(toWornInputs(laneProbeSecondWardrobe())),
    ...over,
  };
}

/**
 * The base fixture plus one recognition-catalog distinctive mark
 * (`nose.shape: "crooked"`, the catalog's canonical attribute example). Used by
 * the duplication pin: the mark can reach a prompt through the digest AND the
 * residual sheet, and the `noseShape` probe counts how many of them spoke.
 */
export function laneProbeMarkedProfile(): CharacterProfile {
  const base = laneProbeProfile();
  return { ...base, attributes: [...base.attributes, attr("nose.shape", "crooked", "base")] };
}

/**
 * The dressed wardrobe: fully clothed, chest through feet, so every
 * `imageReveal: "skin"` probe is exposure-suppressed and a lane that describes
 * one anyway has grown a leak. The kimono's description carries the `garment`
 * token rather than its name, matching how `formatGarment` prefers the
 * description. The slippers exist for coverage — the avatar lane's waist-up cut
 * drops them from the outfit text while still reading their coverage, which is
 * the seam that makes the two derivable from one wardrobe.
 */
export function laneProbeWardrobe(): AvatarWardrobeItem[] {
  return [
    {
      name: "silk kimono",
      description: "a floor-length wine-red silk kimono",
      appearance: "embroidered with pale cranes",
      coverage: ["chest", "groin", "hips", "buttocks", "thighs"],
      layer: 1,
      opacity: "opaque",
    },
    {
      name: "slippers",
      description: "flat black slippers",
      coverage: ["feet"],
      layer: 1,
      opacity: "opaque",
    },
  ];
}

/**
 * Coverage state for the dressed fixture — derived through the same
 * `toWornInputs` seam the avatar lane uses, so the fixture cannot claim a
 * coverage the production reader would not compute.
 */
export function laneProbeDressedExposure(): RegionExposure {
  return exposedRegions(toWornInputs(laneProbeWardrobe()));
}

/** Coverage state with nothing worn — every region bare. */
export function laneProbeBareExposure(): RegionExposure {
  return exposedRegions([]);
}

/**
 * The avatar lane's PRODUCTION Stage 3 assembly over the probe fixture — the
 * exact call `generateAvatar` makes, minus the database around it. One builder,
 * consumed by both the lane characterization freeze and the legacy-vs-digest
 * cutover comparison, so the two suites can never quietly assemble the "same"
 * avatar differently.
 */
export function laneProbeAvatarSegments(
  wardrobe: ReadonlyArray<AvatarWardrobeItem>,
  style: AvatarStyle = "realistic",
  profile: CharacterProfile = laneProbeProfile(),
): AvatarSegmentAssembly {
  return buildAvatarSegments({
    characterId: LANE_PROBE_SUBJECT_ID,
    name: LANE_PROBE_NAME,
    profile,
    style,
    wardrobe,
    readToken: "lane-probe-token",
  });
}

/**
 * The variant/edit lane's PRODUCTION Stage 4 assembly over the same fixture —
 * the exact call `generateVariant` makes, minus the database around it. It
 * takes the DRESSED wardrobe by default because the lane now loads one: no
 * garment name reaches the prompt (the reference image shows the clothes), but
 * coverage drives the camera's perception, so a probe built on a bare body
 * would exercise a selection production never runs.
 */
export function laneProbeVariantSegments(
  kind: VariantKind,
  instruction: string,
  wardrobe: ReadonlyArray<AvatarWardrobeItem> = laneProbeWardrobe(),
  profile: CharacterProfile = laneProbeProfile(),
): VariantSegmentAssembly {
  return buildVariantSegments({
    characterId: LANE_PROBE_SUBJECT_ID,
    name: LANE_PROBE_NAME,
    profile,
    kind,
    instruction,
    wardrobe,
    readToken: "lane-probe-token",
  });
}

/** The probe subject as one scene cast member, dressed unless overridden. */
export function laneProbeCastMember(over: Partial<SceneCastMember> = {}): SceneCastMember {
  return {
    characterId: LANE_PROBE_SUBJECT_ID,
    name: LANE_PROBE_NAME,
    profile: laneProbeProfile(),
    avatarImageId: null,
    outfit: "a floor-length wine-red silk kimono",
    exposure: laneProbeDressedExposure(),
    ...over,
  };
}

/**
 * The scene plan a lane renders, built through the production seams — context →
 * composer-spec resolve — and stopped THERE: this is the legacy
 * `presentCharacter`-field plan, before the cast-1 digest patch
 * (`applySceneSubjectVisual`) the render job applies once the committed camera
 * exists. The characterization freeze applies the patch on top; the cutover
 * comparison renders both sides of it.
 */
export function laneProbeScenePlan(member: SceneCastMember = laneProbeCastMember()): SceneRenderPlan {
  return laneProbeCastScenePlan([member]);
}

/** One subject the cast production draws, paired with the committed cut it draws them from. */
export interface LaneProbeCastSubject {
  readonly member: SceneCastMember;
  readonly shadow: Omit<VisualStateShadowInput, "sink" | "camera">;
}

/**
 * The two-subject cast every Stage 4 cast ≥2 assertion reads the lane through:
 * the focal, then the bystander, each with their OWN committed cut. Built here
 * so the comparison suite and the cross-lane invariants can never assemble two
 * different "same" casts.
 */
export function laneProbeCastSubjects(): LaneProbeCastSubject[] {
  return [
    { member: laneProbeCastMember(), shadow: laneProbeShadowInput() },
    { member: laneProbeSecondCastMember(), shadow: laneProbeSecondShadowInput() },
  ];
}

/**
 * The same plan for a cast of N, the first member focal — the shape the cast ≥2
 * cutover comparison reads the lane through. `laneProbeScenePlan` is the
 * one-member spelling of this call, exactly as `applySceneSubjectVisual` is the
 * one-subject spelling of `applySceneCastVisual`.
 */
export function laneProbeCastScenePlan(cast: readonly SceneCastMember[]): SceneRenderPlan {
  const focal = cast[0]?.name ?? LANE_PROBE_NAME;
  const context = buildCharacterSceneContext({
    cast: [...cast],
    room: "a lamplit study, rain on the window",
    recentChat: [`${focal} settles into the chair by the window.`],
  });
  return resolveScenePlan(
    sceneSpecSchema.parse({
      focalCharacter: focal,
      pose: "settling into the chair",
      setting: "a lamplit study",
    }),
    context,
  );
}

/**
 * The probe subject's committed cut as a camera-less shadow input — the same
 * shape the scene queue hands the render through `chatVisualStateShadowInput`.
 * Built literally here because the probe has no chat to load: attributes and
 * species realization are the owners the fixture actually authors, the
 * sight-only perception view is the sim lane's own honest floor, and every
 * absent owner (wardrobe store, body surface, scene relations) is the recorded
 * lane-unavailable degradation, not a shortcut — nothing the fixture's digest
 * carries rides the optional lane, so a full per-location view would change no
 * frozen cell.
 */
export function laneProbeShadowInput(
  profile: CharacterProfile = laneProbeProfile(),
): Omit<VisualStateShadowInput, "sink" | "camera"> {
  return {
    lane: "character_chat",
    scope: { kind: "chat", memoryGroupId: "probe-group" },
    cutId: "lane-probe-cut",
    atMinutes: 0,
    subjectId: LANE_PROBE_SUBJECT_ID,
    attributes: profile.attributes,
    realize: {
      ...(profile.speciesId === undefined ? {} : { speciesId: profile.speciesId }),
      ...(profile.heritageId === undefined ? {} : { heritageId: profile.heritageId }),
      ...(profile.bodyPlanId === undefined ? {} : { bodyPlanId: profile.bodyPlanId }),
      ...(profile.intimateRegions === undefined ? {} : { intimateRegions: profile.intimateRegions }),
      ...(profile.bodyFeatures === undefined ? {} : { bodyFeatures: profile.bodyFeatures }),
    },
    perception: affordancePerceptionView({ exposure: {}, channels: { sight: "available" } }),
    observerId: "probe-owner",
    observer: { kind: "player_viewpoint", viewpointId: "probe-owner" },
  };
}

/**
 * The SECOND cast member's camera-less shadow input. Their own subject id and
 * their own memory-group scope — chat scopes a memory group per participant, so
 * two people in one render never share one — while `cutId` and the clock stay
 * the focal's, because the queue mints ONE cut id per scene for the whole cast.
 */
export function laneProbeSecondShadowInput(
  profile: CharacterProfile = laneProbeSecondProfile(),
): Omit<VisualStateShadowInput, "sink" | "camera"> {
  return {
    ...laneProbeShadowInput(profile),
    subjectId: LANE_PROBE_SECOND_SUBJECT_ID,
    scope: { kind: "chat", memoryGroupId: "probe-group-second" },
  };
}

/** How many times each probed fact appears in a compiled prompt. */
export type VisualFactObservation = Readonly<Record<string, number>>;

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return count;
    count += 1;
    from = at + needle.length;
  }
}

/**
 * Count every probed fact in a compiled prompt. Whitespace is collapsed and case
 * folded first, so neither a line break between a token's two words nor a
 * clause-initial capital reads as the fact's absence.
 */
export function observeVisualFacts(
  prompt: string,
  probes: readonly VisualFactProbe[] = VISUAL_FACT_PROBES,
): VisualFactObservation {
  const text = prompt.replace(/\s+/gu, " ").toLowerCase();
  const out: Record<string, number> = {};
  for (const probe of probes) {
    out[probe.key] = probe.tokens.reduce(
      (total, token) => total + countOccurrences(text, token.toLowerCase()),
      0,
    );
  }
  return out;
}

/**
 * The probe keys present at least once, in probe order — the readable form the
 * frozen matrices assert against. Order is the declaration order of
 * `VISUAL_FACT_PROBES`, never the order the prompt happens to state them, so a
 * pure reordering of a prompt is not a test failure.
 *
 * `probes` selects WHOSE facts are read: the default first fixture's, or
 * {@link SECOND_SUBJECT_VISUAL_FACT_PROBES} for the second cast member. Because
 * the two token columns are disjoint, reading one subject's list off a
 * two-subject prompt reports that subject's facts and nobody else's.
 */
export function presentVisualFacts(
  prompt: string,
  probes: readonly VisualFactProbe[] = VISUAL_FACT_PROBES,
): string[] {
  const observed = observeVisualFacts(prompt, probes);
  return probes.filter((probe) => (observed[probe.key] ?? 0) > 0).map((probe) => probe.key);
}

/**
 * The probe keys stated MORE THAN ONCE. Duplication is its own migration failure
 * mode (spec.prompts: "fail on lost, duplicated, newly exposed … facts"), because
 * two builders that both describe a person read as emphasis to an image model and
 * spend budget twice.
 *
 * In a cast of two this is also how "the bystander was described with the
 * FOCAL's digest" fails: the focal's own tokens would land twice and the
 * bystander's not at all.
 */
export function duplicatedVisualFacts(
  prompt: string,
  probes: readonly VisualFactProbe[] = VISUAL_FACT_PROBES,
): string[] {
  const observed = observeVisualFacts(prompt, probes);
  return probes.filter((probe) => (observed[probe.key] ?? 0) > 1).map((probe) => probe.key);
}
