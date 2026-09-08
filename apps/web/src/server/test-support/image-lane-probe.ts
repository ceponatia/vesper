import { affordancePerceptionView } from "@/contracts";
import type { AttributeValue } from "@/contracts/attributes";
import { exposedRegions, type RegionExposure } from "@/contracts/items/visibility";
import type { CharacterProfile } from "@/contracts/world/profile";
import type { SceneVisualReference } from "@vesper/image-core";
import {
  applySceneCastVisual,
  type AvatarWardrobeItem,
  buildAvatarCut,
  buildAvatarProgram,
  buildCharacterSceneContext,
  buildVariantCut,
  type CharacterPromptProgramResult,
  resolveScenePlan,
  type SceneCastMember,
  type SceneRenderPlan,
  sceneSpecSchema,
  type SceneSubjectVisualSlice,
  type StandaloneLaneCutInput,
  type StandaloneSubjectCut,
  toWornInputs,
} from "@/server/images";
import type { VisualStateShadowInput } from "@/server/visual-state";
import { resolvedImageProfileFixture } from "./image-profile-fixture";
import { attr, makeProfile } from "./profile-fixtures";

/**
 * The shared fixture cast for the character-bearing image lanes' suites.
 *
 * One character — Nyx, a succubus — rendered by every lane, plus a second —
 * Ilsa, a faerie — for the cast ≥2 scene. The suites read each lane through
 * its PRODUCTION seams over these fixtures: the avatar cut and program are the
 * exact calls `generateAvatar` makes, the variant cut is `generateVariant`'s,
 * and the scene plan and cast realization go context → composer-spec resolve →
 * `applySceneCastVisual`, so no test can quietly assemble a different person
 * than production does.
 *
 * Every authored value is deliberately distinctive ("deep violet" hair, a
 * "spiraled" horn, a "gravelly" voice) and the two fixtures share none of them
 * in either direction, so a suite can ask whether a specific fact reached a
 * compiled prompt — and FOR WHOM — by looking for the word, without parsing the
 * prompt's structure. A two-subject prompt has no per-subject scope a reader
 * can slice; disjoint values answer the same question without a parser: if only
 * one character in the fixture has gossamer wings, "gossamer" in the prompt
 * means HER wings were stated. `voice.timbre` is the negative control:
 * `kind: "sensory"` never renders, so a lane that starts emitting "gravelly"
 * has grown a leak, not a feature.
 */

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
      base("hair.length", "shoulder_length"),
      base("eyes.color", "amber"),
      base("skin.tone", "bronze"),
      base("face.shape", "oval"),
      base("build.height", "tall"),
      base("build.frame", "slight"),
      base("build.weight_presentation", "slim"),
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

/** The fixture's subject id — the one id the assemblies, digests and rows all name. */
export const LANE_PROBE_SUBJECT_ID = "probe-character";

/** The second cast member's name; distinct from {@link LANE_PROBE_NAME} in every letter. */
export const LANE_PROBE_SECOND_NAME = "Ilsa";

/** The second cast member's subject id — their own committed cut, never the focal's. */
export const LANE_PROBE_SECOND_SUBJECT_ID = "probe-character-second";

/** The third cast member's name; shares no letter with either name above. */
export const LANE_PROBE_THIRD_NAME = "Tobrek";

/** The third cast member's subject id — their own committed cut. */
export const LANE_PROBE_THIRD_SUBJECT_ID = "probe-character-third";

/**
 * The SECOND fixture character, for the cast ≥2 scene lane.
 *
 * Every authored value is disjoint from {@link laneProbeProfile}'s (see the
 * module header), because that disjointness is the whole attribution
 * mechanism: a two-subject prompt has no per-subject scope a reader can slice,
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
 *   reveal must keep one subject's `imageReveal: "skin"` toenails while
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
    identityImageId: null,
    outfit: "a knee-length grey linen tunic",
    exposure: exposedRegions(toWornInputs(laneProbeSecondWardrobe())),
    ...over,
  };
}

/**
 * The dressed wardrobe: fully clothed, chest through feet, so every
 * `imageReveal: "skin"` fact is exposure-suppressed and a lane that describes
 * one anyway has grown a leak. The kimono's description carries the distinctive
 * garment word rather than its name, matching how the composer's wardrobe lines
 * prefer the description. The slippers exist for coverage — the avatar lane's
 * waist-up cut drops them from the outfit text while still reading their
 * coverage, which is the seam that makes the two derivable from one wardrobe.
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

/** The degradation flags a standalone cut takes beside its wardrobe. */
export type LaneProbeCutDegrade = Pick<StandaloneLaneCutInput, "wardrobeUnavailable" | "coverageUnreliable">;

/**
 * The avatar lane's PRODUCTION cut over the probe fixture — the exact call
 * `generateAvatar` makes, minus the database around it, so a test can never
 * quietly assemble a different avatar than production does.
 */
export function laneProbeAvatarCut(
  wardrobe: ReadonlyArray<AvatarWardrobeItem>,
  profile: CharacterProfile = laneProbeProfile(),
  degrade: LaneProbeCutDegrade = {},
): StandaloneSubjectCut {
  return buildAvatarCut({
    characterId: LANE_PROBE_SUBJECT_ID,
    profile,
    wardrobe,
    readToken: "lane-probe-token",
    ...degrade,
  });
}

/**
 * The variant/edit lane's PRODUCTION cut over the same fixture — the exact
 * call `generateVariant` makes, minus the database around it. It takes the
 * DRESSED wardrobe by default because the lane loads one: no garment name
 * reaches the prompt (the reference image shows the clothes), but coverage
 * drives the camera's perception, so a probe built on a bare body would
 * exercise a selection production never runs.
 */
export function laneProbeVariantCut(
  wardrobe: ReadonlyArray<AvatarWardrobeItem> = laneProbeWardrobe(),
  profile: CharacterProfile = laneProbeProfile(),
): StandaloneSubjectCut {
  return buildVariantCut({
    characterId: LANE_PROBE_SUBJECT_ID,
    profile,
    wardrobe,
    readToken: "lane-probe-token",
  });
}

/** The bound 2512 portrait row every avatar probe compiles through. */
export const LANE_PROBE_PORTRAIT_PROFILE = {
  slug: "qwen/qwen-image-2512",
  task: "portrait",
  key: "portrait-standard",
} as const;

/**
 * The avatar lane's PRODUCTION prompt program over the probe fixture — the
 * cut above compiled through the exact call `generateAvatar` makes, minus the
 * database and the model picker around it. The one way a test reads what a
 * portrait would actually send.
 */
export function laneProbeAvatarProgram(
  options: { readonly profile?: CharacterProfile; readonly wardrobe?: ReadonlyArray<AvatarWardrobeItem> } & LaneProbeCutDegrade = {},
): CharacterPromptProgramResult {
  const { profile = laneProbeProfile(), wardrobe = [], ...degrade } = options;
  return buildAvatarProgram({
    characterId: LANE_PROBE_SUBJECT_ID,
    characterName: LANE_PROBE_NAME,
    revision: "2026-08-30T00:00:00.000Z",
    extraRevisions: [],
    cut: laneProbeAvatarCut(wardrobe, profile, degrade),
    profile: resolvedImageProfileFixture(LANE_PROBE_PORTRAIT_PROFILE),
  });
}

/** The probe subject as one scene cast member, dressed unless overridden. */
export function laneProbeCastMember(over: Partial<SceneCastMember> = {}): SceneCastMember {
  return {
    characterId: LANE_PROBE_SUBJECT_ID,
    name: LANE_PROBE_NAME,
    profile: laneProbeProfile(),
    identityImageId: null,
    outfit: "a floor-length wine-red silk kimono",
    exposure: laneProbeDressedExposure(),
    ...over,
  };
}

/**
 * The THIRD fixture as one scene cast member.
 *
 * It reuses the second's authored sheet and wardrobe under its own subject id
 * and name, deliberately: a cast of three is read by the suites that ask who a
 * render COMPILES — cast integrity, not appearance — and a third disjoint
 * character sheet would be a second appearance fixture nothing reads.
 */
export function laneProbeThirdCastMember(over: Partial<SceneCastMember> = {}): SceneCastMember {
  return {
    ...laneProbeSecondCastMember(),
    characterId: LANE_PROBE_THIRD_SUBJECT_ID,
    name: LANE_PROBE_THIRD_NAME,
    ...over,
  };
}

/** One subject the cast production draws, paired with the committed cut it draws them from. */
export interface LaneProbeCastSubject {
  readonly member: SceneCastMember;
  readonly shadow: Omit<VisualStateShadowInput, "sink" | "camera">;
}

/**
 * The two-subject cast the cast ≥2 scene suites read the lane through: the
 * focal, then the bystander, each with their OWN committed cut. Built here so
 * no two suites can assemble two different "same" casts.
 */
export function laneProbeCastSubjects(options: { readonly size?: 2 | 3 } = {}): LaneProbeCastSubject[] {
  return [
    { member: laneProbeCastMember(), shadow: laneProbeShadowInput() },
    { member: laneProbeSecondCastMember(), shadow: laneProbeSecondShadowInput() },
    ...(options.size === 3 ? [{ member: laneProbeThirdCastMember(), shadow: laneProbeThirdShadowInput() }] : []),
  ];
}

/**
 * The scene plan a lane renders for a cast of N, the first member focal, built
 * through the production seams — context → composer-spec resolve. Each
 * member's committed cut is realized against it afterwards
 * (`applySceneCastVisual`), once the plan's camera exists.
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
 * carries rides the optional lane, so a full per-location view would change
 * nothing a suite reads.
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

/** The THIRD cast member's camera-less shadow input — their own subject id and scope. */
export function laneProbeThirdShadowInput(
  profile: CharacterProfile = laneProbeSecondProfile(),
): Omit<VisualStateShadowInput, "sink" | "camera"> {
  return {
    ...laneProbeShadowInput(profile),
    subjectId: LANE_PROBE_THIRD_SUBJECT_ID,
    scope: { kind: "chat", memoryGroupId: "probe-group-third" },
  };
}

/** The stored image id of the probe subject's generated identity anchor. */
export const LANE_PROBE_IMAGE_ID = "img-probe-nyx";
/** The stored image id of the second probe subject's generated identity anchor. */
export const LANE_PROBE_SECOND_IMAGE_ID = "img-probe-ilsa";
/** The stored image id of the third probe subject's generated identity anchor. */
export const LANE_PROBE_THIRD_IMAGE_ID = "img-probe-tobrek";

/** A multi-person chat scene as `renderResolvedScene` receives it from the queue. */
export interface LaneProbeCastSceneRender {
  /** The resolved plan — the scene's decisions, with a setting, a light and each person's action. */
  readonly plan: SceneRenderPlan;
  /** Each member's own committed cut, realized under that plan's camera — what the program compiles from. */
  readonly cast: readonly SceneSubjectVisualSlice[];
  /** One generated identity reference per member, in cast order, each naming its subject. */
  readonly references: SceneVisualReference[];
  readonly referenceBuffers: Map<string, Buffer>;
}

/**
 * The two-subject cast, realized and referenced the way the scene queue hands it
 * to the render: the plan with a setting, a light and a resolved action for each
 * person, the committed cut behind every member, and one identity reference per
 * member bound to the subject it depicts. The one shape an end-to-end scene
 * render test compiles a real program over — populated, so a prompt that
 * dropped a scene decision or a person would read wrong rather than empty.
 *
 * `bareFocal` undresses Nyx — every region bare — so a route's intimate reveal
 * has something to state, while Ilsa stays dressed so the covered half of the
 * same gate sits in the same prompt.
 *
 * `size: 3` adds Tobrek behind them, for the suites that need a cast where a
 * member can go missing from the MIDDLE: a two-person render only ever loses an
 * end, so a check that happened to compare list lengths, or to trust cast order,
 * would pass a two-person case and fail a real ensemble.
 */
export function laneProbeCastSceneRender(
  options: { readonly bareFocal?: boolean; readonly size?: 2 | 3 } = {},
): LaneProbeCastSceneRender {
  const members = laneProbeCastSubjects(options.size === undefined ? {} : { size: options.size }).map((subject, index) =>
    options.bareFocal === true && index === 0
      ? { ...subject, member: { ...subject.member, outfit: "", exposure: laneProbeBareExposure() } }
      : subject,
  );
  const plan = laneProbeCastScenePlan(members.map((subject) => subject.member));
  const built = applySceneCastVisual({ plan, members });
  if (built.refusal !== null) throw new Error(`the probe cast refused to realize: ${built.refusal}`);
  const reference = (
    name: string,
    entityId: string,
    imageId: string,
    role: "focal" | "other",
  ): SceneVisualReference => ({
    kind: "character",
    name,
    entityId,
    role,
    allowForIntimate: true,
    imageId,
    source: "generated",
  });
  const references = [
    reference(LANE_PROBE_NAME, LANE_PROBE_SUBJECT_ID, LANE_PROBE_IMAGE_ID, "focal"),
    reference(LANE_PROBE_SECOND_NAME, LANE_PROBE_SECOND_SUBJECT_ID, LANE_PROBE_SECOND_IMAGE_ID, "other"),
  ];
  const referenceBuffers = new Map<string, Buffer>([
    [LANE_PROBE_IMAGE_ID, Buffer.from("nyx")],
    [LANE_PROBE_SECOND_IMAGE_ID, Buffer.from("ilsa")],
  ]);
  if (options.size === 3) {
    references.push(reference(LANE_PROBE_THIRD_NAME, LANE_PROBE_THIRD_SUBJECT_ID, LANE_PROBE_THIRD_IMAGE_ID, "other"));
    referenceBuffers.set(LANE_PROBE_THIRD_IMAGE_ID, Buffer.from("tobrek"));
  }
  return { plan, cast: built.visuals, references, referenceBuffers };
}
