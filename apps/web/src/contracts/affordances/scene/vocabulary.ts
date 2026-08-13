import { z } from "zod";

/**
 * The scene/body-relations vocabularies
 * (romantic-contact-affordances.spec.scene.md §"Vocabularies").
 *
 * Every one of them is a small CLOSED set, and every one of them is DATA: a
 * const array, an enum built from it, and — where a relation needs one — a
 * lookup table keyed by the same members. Growing a vocabulary is an edit in
 * this file plus a row in each table that keys on it, exactly the way the
 * attribute, meter, and body-location registries grow. Nothing here is a
 * schema migration and nothing here is a continuous quantity.
 *
 * Coarse ON PURPOSE. The owner's ruling for this slice is that the scene owner
 * must be able to answer "can this hand reach that shoulder" without pretending
 * to be a physics engine, so positions are rungs on a ladder rather than
 * coordinates, distance is four bands rather than metres, and orientation is
 * three answers rather than an angle. A vocabulary that cannot express a
 * distinction is the honest way to say the system does not model it — the
 * alternative is a continuous field nobody can source.
 */

// ---------------------------------------------------------------------------
// Posture
// ---------------------------------------------------------------------------

/**
 * How a body is configured, and nothing else.
 *
 * `leaning` is deliberately NOT here: leaning is a statement about what carries
 * the weight, which is a support relation, and a body can lean in any of these
 * five configurations. Folding it in would make "standing, leaning on the wall"
 * unrepresentable without a sixth posture that means two things at once.
 */
export const scenePostures = ["standing", "sitting", "kneeling", "crouching", "lying"] as const;
export const scenePostureSchema = z.enum(scenePostures);
export type ScenePosture = z.infer<typeof scenePostureSchema>;

// ---------------------------------------------------------------------------
// Facing and proximity
// ---------------------------------------------------------------------------

/**
 * How one participant is oriented toward another. Directional: A may face
 * toward B while B faces away from A, so this is stored per ORDERED pair.
 *
 * Three answers rather than an angle, and no `unknown` member — an orientation
 * nobody stated is an ABSENT fact, not a fourth value. The difference matters:
 * an absent fact makes a read that depends on it answer `unresolved`, while an
 * `unknown` enum member would quietly travel through the tables below as if it
 * were a stance.
 */
export const sceneFacings = ["toward", "side_on", "away"] as const;
export const sceneFacingSchema = z.enum(sceneFacings);
export type SceneFacing = z.infer<typeof sceneFacingSchema>;

/**
 * How far apart two participants are, in the only terms a contact decision
 * needs. Symmetric, so it is stored once per UNORDERED pair.
 *
 * The bands are defined by what it takes to cross them, not by distance:
 *
 * - `touching` — already in physical contact, or close enough that nothing has
 *   to move for surfaces to meet.
 * - `close` — within arm's length without moving the feet.
 * - `near` — one small reposition away (a lean, a shift, a step).
 * - `distant` — the scene has to cross the space first.
 */
export const sceneProximityBands = ["touching", "close", "near", "distant"] as const;
export const sceneProximityBandSchema = z.enum(sceneProximityBands);
export type SceneProximityBand = z.infer<typeof sceneProximityBandSchema>;

// ---------------------------------------------------------------------------
// Height
// ---------------------------------------------------------------------------

/**
 * The height ladder — six named rungs, ordered ground-up.
 *
 * A rung is an ABSOLUTE height above the floor of the scene, named after where
 * it falls on a standing adult. It is the only spatial axis this module has:
 * there is no left/right, no depth, no distance in units. That is enough for
 * the question the owner asked it to answer (can this surface meet that one)
 * and deliberately not enough to place anything on a map.
 */
export const sceneHeightRungs = ["ground", "knee", "hip", "chest", "head", "overhead"] as const;
export const sceneHeightRungSchema = z.enum(sceneHeightRungs);
export type SceneHeightRung = z.infer<typeof sceneHeightRungSchema>;

/** Rung → its position on the ladder. Spelled out rather than derived from array order, so a reordering of the vocabulary cannot silently re-rank the world. */
export const SCENE_HEIGHT_RUNG_INDEX: Readonly<Record<SceneHeightRung, number>> = {
  ground: 0,
  knee: 1,
  hip: 2,
  chest: 3,
  head: 4,
  overhead: 5,
};

/** The top of the ladder. Sums clamp here rather than running off the end. */
export const SCENE_MAX_RUNG_INDEX = 5;

// ---------------------------------------------------------------------------
// Body zones
// ---------------------------------------------------------------------------

/**
 * The coarse body zones this module reasons about — and every id is a ROOT of
 * the shared `bodyLocationRegistry` tree.
 *
 * That is what keeps a second anatomy out of the repo. `sceneBodyZoneOf` walks
 * a body-location id up its ancestors until it lands on a member of this list,
 * so `foot_arch` → `sole` → `feet` → `legs` and `shoulders` → `torso` without
 * this file listing either. Adding a finer zone (splitting `feet` out of
 * `legs`, say) is a data edit: add the id here, add its rung to the posture
 * table below, add its span to the reach table — and every location under it
 * re-homes itself.
 *
 * A location whose ancestors contain no member of this list has NO zone, and a
 * read about it answers `unresolved`. There is no catch-all zone, because a
 * catch-all zone is a guessed height.
 */
export const sceneBodyZones = ["head", "torso", "arms", "pelvis", "legs"] as const;
export const sceneBodyZoneSchema = z.enum(sceneBodyZones);
export type SceneBodyZone = z.infer<typeof sceneBodyZoneSchema>;

/**
 * Where each zone sits, in rungs ABOVE THE SURFACE THE BODY IS ON, per posture.
 *
 * Relative rather than absolute so elevation composes: a woman sitting on a
 * table has the table's rung added to every row of the `sitting` column, which
 * is the whole of what "surface height changes what you can reach" means here.
 *
 * The numbers are a zone's CENTRE, not its extent — a standing person's `legs`
 * span the floor to the hip and are recorded at the knee. The slack that costs
 * is paid back by the reach span below, which is what actually decides whether
 * two rungs can meet.
 */
export const SCENE_POSTURE_ZONE_RUNG: Readonly<Record<ScenePosture, Readonly<Record<SceneBodyZone, number>>>> = {
  standing: { legs: 1, pelvis: 2, torso: 3, arms: 2, head: 4 },
  sitting: { legs: 0, pelvis: 0, torso: 1, arms: 0, head: 2 },
  kneeling: { legs: 0, pelvis: 1, torso: 2, arms: 1, head: 3 },
  crouching: { legs: 0, pelvis: 1, torso: 1, arms: 1, head: 2 },
  lying: { legs: 0, pelvis: 0, torso: 0, arms: 0, head: 0 },
};

/**
 * How many rungs a zone can cross to make contact WITHOUT the body changing
 * posture — an arm swings, a leg lifts a little, a head tilts, a torso does not
 * go anywhere on its own.
 *
 * One rung beyond the span is reachable "after adjustment" (the contact core's
 * own `within_reach_after_adjustment`, which its resolver turns into a visible
 * reposition unless a minimal adjustment was proposed). Two rungs beyond is out
 * of reach, and the scene says so rather than letting a narrator decide.
 */
export const SCENE_ZONE_REACH_SPAN: Readonly<Record<SceneBodyZone, number>> = {
  arms: 2,
  legs: 1,
  head: 1,
  torso: 0,
  pelvis: 0,
};

// ---------------------------------------------------------------------------
// Support
// ---------------------------------------------------------------------------

/**
 * What a support relation DOES, from the supported participant's side.
 *
 * - `borne_by` — the anchor carries this participant's weight. This is the one
 *   that sets their base rung; a participant with none has an unknown
 *   elevation, and a participant with two has an ambiguous one.
 * - `leaning_on` — some weight on the anchor, base elsewhere.
 * - `held_by` — another participant carries them.
 * - `bearing` — the mirror: THIS participant carries the anchor participant.
 */
export const sceneSupportRoles = ["borne_by", "leaning_on", "held_by", "bearing"] as const;
export const sceneSupportRoleSchema = z.enum(sceneSupportRoles);
export type SceneSupportRole = z.infer<typeof sceneSupportRoleSchema>;

/**
 * What kind of thing a support surface is. Carried for evidence and for the
 * lane's own rendering; the reach calculation reads only the surface's `height`
 * fact, so a scene that invents a new kind of furniture does not change any
 * answer here.
 */
export const sceneSupportKinds = ["ground", "seat", "bed", "table", "wall", "prop"] as const;
export const sceneSupportKindSchema = z.enum(sceneSupportKinds);
export type SceneSupportKind = z.infer<typeof sceneSupportKindSchema>;

// ---------------------------------------------------------------------------
// Control and provenance
// ---------------------------------------------------------------------------

/**
 * Who is allowed to author a participant's voluntary movement. Two values, and
 * no third: a body whose control nobody stated has an ABSENT control fact, and
 * an intent to move it resolves `unresolved` rather than defaulting either way.
 */
export const sceneControlModes = ["player_controlled", "npc_controlled"] as const;
export const sceneControlModeSchema = z.enum(sceneControlModes);
export type SceneControlMode = z.infer<typeof sceneControlModeSchema>;

/**
 * Where a movement intent came from.
 *
 * There is no `narration` origin, and there never will be. Narrator prose is
 * the thing this module exists to stop being physical authority: a sentence
 * describing a movement is evidence that a movement was DESCRIBED, and the lane
 * that produced it must decide, on the NPC/simulation side, whether it also
 * happened. A `narration` member here would be a hole straight through the
 * actor-control law, so the law is enforced by the vocabulary rather than by a
 * check somebody could forget.
 */
export const sceneIntentOrigins = ["player", "npc", "simulation"] as const;
export const sceneIntentOriginSchema = z.enum(sceneIntentOrigins);
export type SceneIntentOrigin = z.infer<typeof sceneIntentOriginSchema>;

/**
 * **The actor-control law, as data** (owner ruling, 2026-07-30 —
 * romantic-contact-affordances.audit.md §"Owner decisions needed" 2): player
 * input commits only player-controlled movement, and NPC movement must
 * originate NPC/simulation-side.
 *
 * A table rather than an `if`, so the rule can be read, tested, and extended
 * (an explicit player-agency grant would be a third column, not a new branch)
 * without anybody re-deriving what the owner decided.
 */
export const SCENE_CONTROL_ORIGINS: Readonly<Record<SceneControlMode, readonly SceneIntentOrigin[]>> = {
  player_controlled: ["player"],
  npc_controlled: ["npc", "simulation"],
};

/**
 * Where an authoritative scene fact came from.
 *
 * `scene_default` is a stated default — a scene template declaring that
 * everyone starts standing on the floor — and it is a WEAKER label, not a
 * licence to invent: this module never mints one. A fact nobody stated is
 * absent, and absence produces `unresolved`, never a default. The two are
 * different answers and the vocabulary keeps them different.
 *
 * As with `sceneIntentOrigins`, there is no prose source.
 */
export const sceneProvenanceSources = [
  "authored",
  "player_intent",
  "npc_decision",
  "simulation",
  "scene_default",
] as const;
export const sceneProvenanceSourceSchema = z.enum(sceneProvenanceSources);
export type SceneProvenanceSource = z.infer<typeof sceneProvenanceSourceSchema>;

/** Intent origin → the provenance an applied intent stamps. The two `authored`-side sources have no origin, by design: only authored state can carry them. */
export const SCENE_ORIGIN_PROVENANCE: Readonly<Record<SceneIntentOrigin, SceneProvenanceSource>> = {
  player: "player_intent",
  npc: "npc_decision",
  simulation: "simulation",
};
