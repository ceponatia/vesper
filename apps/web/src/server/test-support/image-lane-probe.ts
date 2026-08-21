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
  resolveScenePlan,
  type SceneCastMember,
  type SceneRenderPlan,
  sceneSpecSchema,
  toWornInputs,
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
 * `voice.timbre` is the negative control: `kind: "sensory"` never renders, so a
 * lane that starts emitting "gravelly" has grown a leak, not a feature.
 */
export const VISUAL_FACT_PROBES: readonly VisualFactProbe[] = [
  { key: "gender", bucket: "identity", mandatory: true, tokens: ["female"] },
  { key: "ethnicity", bucket: "identity", mandatory: true, tokens: ["Latina"] },
  { key: "species", bucket: "morphology", mandatory: true, tokens: ["succubus"] },
  { key: "hairColor", bucket: "identity", mandatory: true, tokens: ["deep violet"] },
  { key: "eyeColor", bucket: "identity", mandatory: true, tokens: ["amber"] },
  { key: "skinTone", bucket: "identity", mandatory: true, tokens: ["bronze"] },
  /**
   * A recognition-catalog DISTINCTIVE mark (`nose.shape: "crooked"`), authored
   * only by {@link laneProbeMarkedProfile} — the base fixture leaves it unset, so
   * every pre-existing frozen matrix is untouched. It exists to catch the
   * duplication seam the digest cutover opened: a cataloged distinctive value
   * can reach a lane through BOTH the digest's mark clause and the route-owned
   * residual attribute sheet, and only one of them may phrase it.
   */
  { key: "noseShape", bucket: "identity", mandatory: false, tokens: ["crooked"] },
  { key: "horns", bucket: "morphology", mandatory: true, tokens: ["spiraled"] },
  { key: "wings", bucket: "morphology", mandatory: true, tokens: ["membranous"] },
  { key: "tail", bucket: "morphology", mandatory: true, tokens: ["spaded"] },
  { key: "apparentAge", bucket: "apparentAge", mandatory: true, tokens: ["late twenties"] },
  { key: "garment", bucket: "wardrobe", mandatory: true, tokens: ["kimono"] },
  { key: "bareTorso", bucket: "exposure", mandatory: true, tokens: ["topless", "fully nude"] },
  { key: "legBuild", bucket: "lowerBody", mandatory: false, tokens: ["athletic"] },
  { key: "toenails", bucket: "lowerBody", mandatory: false, tokens: ["painted"] },
  { key: "bustSize", bucket: "intimate", mandatory: false, tokens: ["ample"] },
  { key: "nipples", bucket: "intimate", mandatory: false, tokens: ["puffy"] },
  { key: "voiceTimbre", bucket: "nonvisual", mandatory: false, tokens: ["gravelly"] },
];

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
  const context = buildCharacterSceneContext({
    cast: [member],
    room: "a lamplit study, rain on the window",
    recentChat: [`${LANE_PROBE_NAME} settles into the chair by the window.`],
  });
  return resolveScenePlan(
    sceneSpecSchema.parse({
      focalCharacter: LANE_PROBE_NAME,
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
export function observeVisualFacts(prompt: string): VisualFactObservation {
  const text = prompt.replace(/\s+/gu, " ").toLowerCase();
  const out: Record<string, number> = {};
  for (const probe of VISUAL_FACT_PROBES) {
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
 */
export function presentVisualFacts(prompt: string): string[] {
  const observed = observeVisualFacts(prompt);
  return VISUAL_FACT_PROBES.filter((probe) => (observed[probe.key] ?? 0) > 0).map((probe) => probe.key);
}

/**
 * The probe keys stated MORE THAN ONCE. Duplication is its own migration failure
 * mode (spec.prompts: "fail on lost, duplicated, newly exposed … facts"), because
 * two builders that both describe a person read as emphasis to an image model and
 * spend budget twice.
 */
export function duplicatedVisualFacts(prompt: string): string[] {
  const observed = observeVisualFacts(prompt);
  return VISUAL_FACT_PROBES.filter((probe) => (observed[probe.key] ?? 0) > 1).map((probe) => probe.key);
}
