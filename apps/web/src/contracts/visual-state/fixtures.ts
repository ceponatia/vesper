import { APPEARANCE_FIXTURE_SUBJECT_ID } from "../appearance-features";
import {
  CONTACT_ACTION_SCOPE,
  composeContactMaterial,
  contactEventRef,
  contactPairKey,
  deriveContactId,
  emptyContactLifecycleState,
  type CommittedContactRead,
  type ContactActionKind,
  type ContactBodySurfaceRef,
  type ContactLifecycleState,
  type ContactMotionBand,
  type ContactSurfaceRef,
} from "../affordances/contact";
import { affordanceEvidence, affordanceSubjectId, toUnitInterval } from "../affordances/core";
import {
  sceneEventRef,
  sceneFact,
  sceneProvenance,
  sceneStateOf,
  sceneSupportId,
  type SceneFacing,
  type SceneFact,
  type ScenePosture,
  type SceneProximityBand,
  type SceneState,
  type SceneSupportRelation,
} from "../affordances/scene";
import { clothingCategoryById } from "../items/clothing-categories";
import { garmentBlueprintForSeed } from "../items/garment-store";
import {
  emptyGarmentPresentationState,
  pristineGarmentConditionState,
  type GarmentChangeStamp,
  type GarmentConditionState,
  type GarmentInstanceState,
  type GarmentLocus,
  type GarmentPresentationState,
} from "../items/garment-instance";
import type { GarmentMaterialProfileId } from "../items/garment-material";
import { emptyBodySurfaceState, setBodySurfaceWetness, type BodySurfaceState } from "../state/body-surface";
import { realizeBody, type RealizedBody } from "../species";
import { visualStateFeatureKey, type VisualStateFeature } from "./feature";
import { VISUAL_STATE_APPEARANCE_ATTRIBUTE_KIND_ID } from "./kinds";
import type { VisualStateLocusRef } from "./locus";
import { applyPresentationOperations, emptyCharacterPresentationState, type CharacterPresentationState, type PresentationOperation } from "./presentation";
import type { VisualStateAttentionPriors } from "./priors";
import type { VisualStateRelationship } from "./relationships";
import type { VisualStateSourceRef } from "./sources";
import type { VisualStateGarmentInput } from "./wardrobe";
import type { VisualStateLayer, VisualStateStability } from "./vocabulary";

/**
 * Feature builders for the contract's own tests.
 *
 * Fixtures live WITH the contracts they exercise (the code-organization ruling),
 * and this file deliberately builds only what the APPEARANCE fixtures cannot:
 * hand-shaped candidates for the validation and ordering paths. Real projected
 * bodies come from `appearance-features/fixtures.ts` — a crooked nose, shoulder
 * freckles, a missing left ring finger — so both halves of the seam are judged
 * against the same truth.
 */

export const VISUAL_STATE_FIXTURE_SUBJECT_ID = APPEARANCE_FIXTURE_SUBJECT_ID;

const FIXTURE_PRIORS: VisualStateAttentionPriors = {
  baseUniqueness: toUnitInterval(5_000),
  baseImportance: toUnitInterval(4_000),
  minimumDetailTier: 2,
  repeatFamily: "fixture",
};

export interface VisualStateFeatureFixtureOptions {
  readonly subjectId?: string;
  readonly kindId?: string;
  readonly layer?: VisualStateLayer;
  readonly locus?: VisualStateLocusRef;
  readonly aspect?: string;
  /** Overrides the derived key — for the "key disagrees with its locus" case. */
  readonly key?: string;
  readonly value?: unknown;
  readonly truthFingerprint?: string;
  readonly semanticTags?: readonly string[];
  readonly stability?: VisualStateStability;
  readonly relationships?: readonly VisualStateRelationship[];
  readonly priors?: VisualStateAttentionPriors;
  readonly sourceRef?: VisualStateSourceRef;
}

/**
 * One hand-built candidate. The key is derived from the subject and locus unless
 * the caller overrides it, so a fixture cannot accidentally test a mismatched
 * key while meaning to test something else.
 */
export function visualStateFeatureFixture(
  options: VisualStateFeatureFixtureOptions = {},
): VisualStateFeature {
  const subjectId = options.subjectId ?? VISUAL_STATE_FIXTURE_SUBJECT_ID;
  const locus: VisualStateLocusRef = options.locus ?? { kind: "body", locus: { bodyLocationId: "nose" } };
  const aspect = options.aspect ?? "shape";
  const fingerprint = options.truthFingerprint ?? '"crooked"';
  return {
    version: 1,
    key: options.key ?? visualStateFeatureKey(subjectId, locus, aspect),
    subjectId,
    kindId: options.kindId ?? VISUAL_STATE_APPEARANCE_ATTRIBUTE_KIND_ID,
    layer: options.layer ?? "identity",
    locus,
    sourceRef: options.sourceRef ?? { kind: "appearance", ref: { kind: "attribute", attributeId: "nose.shape" } },
    value: options.value ?? fingerprint,
    truthFingerprint: fingerprint,
    semanticTags: options.semanticTags ?? ["nose", "crooked"],
    stability: options.stability ?? "inherent",
    relationships: options.relationships ?? [],
    priors: options.priors ?? FIXTURE_PRIORS,
    evidence: [affordanceEvidence("adapter", "visual_state.fixture")],
  };
}

// ---------------------------------------------------------------------------
// VS-5 — a non-human body, through `realizeBody`
// ---------------------------------------------------------------------------

/**
 * The audit's non-human case. `succubus` is the one catalog species that
 * defaults to all three feature groups, so one fixture covers wings, horns and
 * a tail; overriding `bodyFeatures` is how a per-character body narrows it.
 *
 * Built through `realizeBody` rather than by hand on purpose — that composition
 * (body plan → species → heritage → per-character config) is the truth the
 * adapter must read, and a hand-built set would let the fixture drift from it.
 */
export function visualStateNonHumanBody(bodyFeatures?: readonly string[]): RealizedBody {
  return realizeBody({ speciesId: "succubus", ...(bodyFeatures === undefined ? {} : { bodyFeatures }) });
}

/** An ordinary human body: no feature groups at all. */
export function visualStateHumanBody(): RealizedBody {
  return realizeBody({});
}

// ---------------------------------------------------------------------------
// VS-6 / VS-8 — garments, worn and left behind
// ---------------------------------------------------------------------------

/** The actor handle the garment fixtures wear things on. */
export const VISUAL_STATE_FIXTURE_ACTOR = "c:visual_state_fixture";

export interface VisualStateGarmentFixtureOptions {
  readonly id?: string;
  readonly name?: string;
  readonly categoryId?: string;
  readonly subtypeId?: string;
  /** Defaults to the category's own coverage — the same fallback the mint path takes. */
  readonly coverage?: readonly string[];
  readonly locus?: GarmentLocus;
  readonly layer?: number;
  readonly atMinutes?: number;
  // Slice-3 additions, all defaulting to the pristine values above them.
  /** The blueprint's material, threaded through the seed path (VS-7 wet-material effects). */
  readonly materialProfileId?: GarmentMaterialProfileId;
  /** Non-neutral arrangement — a rolled cuff, an open closure (VS-6). */
  readonly presentation?: GarmentPresentationState;
  /** Non-pristine material state — wetness, deposits, damage (VS-7). */
  readonly condition?: GarmentConditionState;
  /** The instance's coarse novelty stamp, when a test asserts change stamps. */
  readonly lastChange?: GarmentChangeStamp;
}

/**
 * One garment as the wardrobe adapter takes it: an instance, its blueprint, and
 * the two facts the instance cannot carry (the library category and layer).
 *
 * The blueprint comes from the real template path, so the fixture's coverage is
 * whatever the category and definition actually produce rather than a set the
 * test asserted into existence.
 */
export function visualStateGarmentFixture(
  options: VisualStateGarmentFixtureOptions = {},
): VisualStateGarmentInput {
  const categoryId = options.categoryId ?? "top";
  const coverage = options.coverage ?? clothingCategoryById(categoryId)?.coverage ?? [];
  const definitionId = `def_${categoryId}`;
  const blueprint = garmentBlueprintForSeed({
    definitionId,
    name: categoryId,
    categoryId,
    coverage,
    ...(options.materialProfileId === undefined ? {} : { materialProfileId: options.materialProfileId }),
  });
  const instance: GarmentInstanceState = {
    id: options.id ?? `g_${categoryId}`,
    blueprintHash: `h_${categoryId}`,
    definitionId,
    name: options.name ?? categoryId,
    locus: options.locus ?? { kind: "worn", actorId: VISUAL_STATE_FIXTURE_ACTOR },
    presentation: options.presentation ?? emptyGarmentPresentationState(),
    condition: options.condition ?? pristineGarmentConditionState(),
    lastChange: options.lastChange ?? { kind: "mint", atMinutes: options.atMinutes ?? 0 },
  };
  return {
    instance,
    blueprint,
    categoryId,
    ...(options.subtypeId === undefined ? {} : { subtypeId: options.subtypeId }),
    ...(options.layer === undefined ? {} : { layer: options.layer }),
  };
}

// ---------------------------------------------------------------------------
// Non-item presentation
// ---------------------------------------------------------------------------

/**
 * A presentation state built the only way one can legitimately exist: by running
 * typed operations through the reducer. A hand-built state would be able to hold
 * an entry no operation could ever produce.
 */
export function visualStatePresentationFixture(
  operations: readonly PresentationOperation[],
): CharacterPresentationState {
  return applyPresentationOperations(emptyCharacterPresentationState(), operations);
}

/** The worked case: hair loosely worn, natural makeup on the face. */
export function visualStateGroomedPresentation(
  subjectId: string = VISUAL_STATE_FIXTURE_SUBJECT_ID,
): CharacterPresentationState {
  return visualStatePresentationFixture([
    {
      kind: "apply",
      entryId: "pres_hair",
      subjectId,
      kindId: "presentation.hairstyle",
      locus: { kind: "body", locus: { bodyLocationId: "hair" } },
      value: { arrangement: "loose" },
      atMinutes: 10,
    },
    {
      kind: "apply",
      entryId: "pres_makeup",
      subjectId,
      kindId: "presentation.makeup",
      locus: { kind: "body", locus: { bodyLocationId: "face" } },
      value: { style: "natural" },
      atMinutes: 10,
    },
  ]);
}

// ---------------------------------------------------------------------------
// VS-9 — wet hair, through the body-surface owner's own write path
// ---------------------------------------------------------------------------

/**
 * The audit's wet-hair case: `BodySurfaceState` with the hair location wet,
 * written through `setBodySurfaceWetness` rather than by literal — the write
 * path clamps and stamps exactly as a committed proposal would, so the fixture
 * cannot hold a level no proposal could produce.
 */
export function visualStateWetHairSurface(
  options: { level?: number; atMinutes?: number; cause?: "rain" | "immersion" | "splash" | "other" } = {},
): BodySurfaceState {
  return setBodySurfaceWetness(emptyBodySurfaceState(), {
    locationId: "hair",
    level: options.level ?? 6_000,
    atMinutes: options.atMinutes ?? 0,
    ...(options.cause === undefined ? {} : { cause: options.cause }),
  });
}
// VS-10 — scene relations and committed contact
// ---------------------------------------------------------------------------

/**
 * The audit's VS-10 case: two participants with posture, facing, proximity and
 * a support relation, all carrying provenance — plus the contact-lifecycle
 * additions slice 4 reads (an occupied hand, a committed motion).
 *
 * Built through `sceneStateOf` rather than by hand, so canonical ordering,
 * symmetry and freezing are the real owner's, and the projection is judged
 * against a state the scene module could actually produce.
 */

export const VISUAL_STATE_SCENE_PLAYER = affordanceSubjectId("vs_scene_player");
export const VISUAL_STATE_SCENE_NPC = affordanceSubjectId("vs_scene_npc");
export const VISUAL_STATE_SCENE_FLOOR = sceneSupportId("vs_scene_floor");
export const VISUAL_STATE_SCENE_BED = sceneSupportId("vs_scene_bed");

/** The visual subject ids the fixture map files the two participants under. */
export const VISUAL_STATE_SCENE_PLAYER_SUBJECT = "vs_player";
export const VISUAL_STATE_SCENE_NPC_SUBJECT = "vs_npc";

/** Deliberately distinct from the scene-side ids, so a test that sees a scene id where a visual id belongs fails loudly. */
export function visualStateSceneSubjects(): ReadonlyMap<string, string> {
  return new Map([
    [VISUAL_STATE_SCENE_PLAYER as string, VISUAL_STATE_SCENE_PLAYER_SUBJECT],
    [VISUAL_STATE_SCENE_NPC as string, VISUAL_STATE_SCENE_NPC_SUBJECT],
  ]);
}

function sceneFixtureFact<TValue>(value: TValue, storyTime = 100): SceneFact<TValue> {
  return sceneFact(
    value,
    sceneProvenance({
      source: "authored",
      ref: sceneEventRef("vs_scene_event"),
      storyTime,
      evidence: [affordanceEvidence("state", "vs_scene.authored")],
    }),
  );
}

const PLAYER_SUPPORT: readonly SceneSupportRelation[] = [
  { role: "borne_by", anchor: { kind: "surface", supportId: VISUAL_STATE_SCENE_FLOOR }, loadZones: ["legs"] },
];

const NPC_SUPPORT: readonly SceneSupportRelation[] = [
  {
    role: "borne_by",
    anchor: { kind: "surface", supportId: VISUAL_STATE_SCENE_BED },
    loadZones: ["pelvis", "legs"],
  },
];

export interface VisualStateSceneFixtureOptions {
  /** `null` means nobody stated it — the scene's own load-bearing absence. */
  readonly playerPosture?: ScenePosture | null;
  readonly npcPosture?: ScenePosture | null;
  readonly npcSupport?: readonly SceneSupportRelation[] | null;
  readonly proximity?: SceneProximityBand | null;
  readonly playerFacing?: SceneFacing | null;
  readonly npcFacing?: SceneFacing | null;
  readonly contacts?: ContactLifecycleState;
  readonly atMinutes?: number;
}

/**
 * The default scene: the player standing on the floor, the NPC sitting on the
 * bed, an arm's length apart, facing each other, nothing touching.
 */
export function visualStateSceneFixture(options: VisualStateSceneFixtureOptions = {}): SceneState {
  const at = options.atMinutes ?? 100;
  const playerPosture = options.playerPosture === undefined ? "standing" : options.playerPosture;
  const npcPosture = options.npcPosture === undefined ? "sitting" : options.npcPosture;
  const npcSupport = options.npcSupport === undefined ? NPC_SUPPORT : options.npcSupport;
  const proximity = options.proximity === undefined ? "close" : options.proximity;
  const playerFacing = options.playerFacing === undefined ? "toward" : options.playerFacing;
  const npcFacing = options.npcFacing === undefined ? "toward" : options.npcFacing;
  return sceneStateOf({
    participants: [
      {
        subjectId: VISUAL_STATE_SCENE_PLAYER,
        control: sceneFixtureFact("player_controlled", at),
        ...(playerPosture === null ? {} : { posture: sceneFixtureFact(playerPosture, at) }),
        support: sceneFixtureFact(PLAYER_SUPPORT, at),
      },
      {
        subjectId: VISUAL_STATE_SCENE_NPC,
        control: sceneFixtureFact("npc_controlled", at),
        ...(npcPosture === null ? {} : { posture: sceneFixtureFact(npcPosture, at) }),
        ...(npcSupport === null ? {} : { support: sceneFixtureFact(npcSupport, at) }),
      },
    ],
    supports: [
      { supportId: VISUAL_STATE_SCENE_FLOOR, kind: "ground", height: sceneFixtureFact("ground", at) },
      { supportId: VISUAL_STATE_SCENE_BED, kind: "bed", height: sceneFixtureFact("knee", at) },
    ],
    proximity:
      proximity === null
        ? []
        : [
            {
              subjectId: VISUAL_STATE_SCENE_PLAYER,
              otherId: VISUAL_STATE_SCENE_NPC,
              band: sceneFixtureFact(proximity, at),
            },
          ],
    facing: [
      ...(playerFacing === null
        ? []
        : [
            {
              subjectId: VISUAL_STATE_SCENE_PLAYER,
              towardId: VISUAL_STATE_SCENE_NPC,
              facing: sceneFixtureFact(playerFacing, at),
            },
          ]),
      ...(npcFacing === null
        ? []
        : [
            {
              subjectId: VISUAL_STATE_SCENE_NPC,
              towardId: VISUAL_STATE_SCENE_PLAYER,
              facing: sceneFixtureFact(npcFacing, at),
            },
          ]),
    ],
    ...(options.contacts === undefined ? {} : { contacts: options.contacts }),
  });
}

export interface VisualStateContactFixtureOptions {
  readonly sourceLocationId?: string;
  readonly sourceSide?: "left" | "right" | "center";
  readonly targetLocationId?: string;
  /** A whole-target override — the object-surface case. Wins over `targetLocationId`. */
  readonly target?: ContactSurfaceRef;
  readonly actionKind?: ContactActionKind;
  /** `null` means the contact carries no motion read at all. */
  readonly motionBand?: ContactMotionBand | null;
  readonly pathDetailIds?: readonly string[];
  readonly startedAt?: number;
  readonly lastUpdatedAt?: number;
  readonly eventRef?: string;
}

/**
 * One committed contact as the store would hold it: player's fingers on the
 * NPC's shoulders, sliding. The identity fields are DERIVED the way the
 * lifecycle derives them (`contactPairKey`, `deriveContactId`), so the fixture
 * cannot drift from what `parseContactLifecycleState` would accept.
 */
export function visualStateContactFixture(
  options: VisualStateContactFixtureOptions = {},
): CommittedContactRead {
  const source: ContactBodySurfaceRef = {
    kind: "body",
    subjectId: VISUAL_STATE_SCENE_PLAYER,
    locationId: options.sourceLocationId ?? "fingers",
    ...(options.sourceSide === undefined ? {} : { side: options.sourceSide }),
  };
  const target: ContactSurfaceRef = options.target ?? {
    kind: "body",
    subjectId: VISUAL_STATE_SCENE_NPC,
    locationId: options.targetLocationId ?? "shoulders",
  };
  const pairKey = contactPairKey(source, target);
  const startedByEventRef = contactEventRef(options.eventRef ?? "vs_contact_event");
  const actionKind = options.actionKind ?? "affectionate";
  const startedAt = options.startedAt ?? 90;
  const motionBand = options.motionBand === undefined ? "sliding" : options.motionBand;
  return {
    phase: "active",
    contactId: deriveContactId({ pairKey, startedByEventRef }),
    pairKey,
    startedByEventRef,
    lastUpdatedByEventRef: startedByEventRef,
    startedAt,
    lastUpdatedAt: options.lastUpdatedAt ?? startedAt,
    actorId: VISUAL_STATE_SCENE_PLAYER,
    actionKind,
    source,
    target,
    ...(motionBand === null
      ? {}
      : {
          motion: {
            band: motionBand,
            ...(options.pathDetailIds === undefined ? {} : { pathDetailIds: options.pathDetailIds }),
            evidence: [affordanceEvidence("contact", "vs_contact_motion")],
          },
        }),
    materialBetween: [],
    transmission: composeContactMaterial([]),
    implicitAdjustments: [],
    actorControl: { status: "allowed", actorId: VISUAL_STATE_SCENE_PLAYER, evidence: [] },
    targetAgencies: [],
    policy: { status: "allowed", scopes: [CONTACT_ACTION_SCOPE[actionKind]], evidence: [] },
    evidence: [affordanceEvidence("contact", "vs_contact")],
  };
}

/** A lifecycle projection holding these contacts, in the store's own pair-key order. */
export function visualStateContactState(
  contacts: readonly CommittedContactRead[],
): ContactLifecycleState {
  return {
    ...emptyContactLifecycleState(),
    contacts: [...contacts].sort((left, right) =>
      left.pairKey < right.pairKey ? -1 : left.pairKey > right.pairKey ? 1 : 0,
    ),
  };
}
