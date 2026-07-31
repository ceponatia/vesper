import { z } from "zod";
import { diag, type DiagnosticSink } from "../../diagnostics";
import { parseOr } from "@/lib/parse";
import { affordanceSubjectIdSchema, type AffordanceSubjectId } from "../core";
import { parseContactLifecycleState } from "../contact";
import { SCENE_STATE_INVALID } from "./diagnostics";
import { sceneFactSchema, sceneSupportIdSchema } from "./provenance";
import {
  SCENE_MAX_PARTICIPANTS,
  SCENE_MAX_RELATIONS,
  SCENE_MAX_SUPPORT_RELATIONS,
  SCENE_MAX_SUPPORTS,
  SCENE_STATE_VERSION,
  emptySceneState,
  sceneStateOf,
  type SceneFacingRelation,
  type SceneParticipant,
  type SceneProximityRelation,
  type SceneState,
  type SceneSupportAnchor,
  type SceneSupportRelation,
  type SceneSupportSurface,
} from "./state";
import {
  sceneBodyZoneSchema,
  sceneBodyZones,
  sceneControlModeSchema,
  sceneFacingSchema,
  sceneHeightRungSchema,
  scenePostureSchema,
  sceneProximityBandSchema,
  sceneSupportKindSchema,
  sceneSupportRoleSchema,
} from "./vocabulary";

/**
 * The persisted scene shape and its healing rules
 * (romantic-contact-affordances.spec.scene.md §"Snapshot law").
 *
 * **The state IS the snapshot.** It is plain readonly data in a canonical
 * order, so capturing a scene is storing the value and restoring one is
 * `parseSceneState` on the same bytes — there is no second shape that could
 * drift from the first, which is the failure mode a separate capture type
 * invites. Replaying the same intents from a restored snapshot reproduces the
 * identical state, because every function that touches a scene is pure and the
 * ordering is canonical.
 *
 * ## Why an unreadable fact is DROPPED
 *
 * The contact core drops a corrupt contact because an absent contact means
 * "nothing is touching", which can never buy a claim. A scene is the same
 * shape of thing: an absent participant, posture, or support relation makes
 * every read about it answer `unresolved`, and `unresolved` is the answer that
 * cannot be spent. A quarantine marker would only be a way for unreadable data
 * to keep occupying a body.
 *
 * So: item-lenient, drop the unreadable, report every drop, and never fail the
 * whole scene over one bad row. The two exceptions are a blob that is not a
 * scene at all and a version this build cannot read — both degrade to the empty
 * scene, which claims nothing about anybody.
 *
 * ## Referential integrity
 *
 * A relation is only as real as the things it relates. A proximity or facing
 * entry naming a participant that did not survive is dropped; so is a support
 * relation whose anchor is not in the scene. A participant that loses its
 * support this way KEEPS its other facts and simply has an unknown elevation —
 * dropping the whole body over one dangling anchor would throw away good facts
 * to punish a bad one.
 */

// ---------------------------------------------------------------------------
// Boundary schemas
// ---------------------------------------------------------------------------

const supportAnchorSchema: z.ZodType<SceneSupportAnchor> = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("surface"), supportId: sceneSupportIdSchema }),
  z.object({ kind: z.literal("participant"), subjectId: affordanceSubjectIdSchema }),
]);

const supportRelationSchema: z.ZodType<SceneSupportRelation> = z.object({
  role: sceneSupportRoleSchema,
  anchor: supportAnchorSchema,
  loadZones: z.array(sceneBodyZoneSchema).min(1).max(sceneBodyZones.length).readonly(),
});

/** Strict throughout — no `.catch()`, no defaults. Every field is either identity or a physical claim, and repairing either is inventing it. */
export const sceneParticipantSchema: z.ZodType<SceneParticipant> = z.object({
  subjectId: affordanceSubjectIdSchema,
  control: sceneFactSchema(sceneControlModeSchema).optional(),
  posture: sceneFactSchema(scenePostureSchema).optional(),
  support: z.array(sceneFactSchema(supportRelationSchema)).max(SCENE_MAX_SUPPORT_RELATIONS).readonly(),
});

export const sceneSupportSurfaceSchema: z.ZodType<SceneSupportSurface> = z.object({
  supportId: sceneSupportIdSchema,
  kind: sceneSupportKindSchema,
  height: sceneFactSchema(sceneHeightRungSchema),
});

export const sceneProximityRelationSchema: z.ZodType<SceneProximityRelation> = z.object({
  subjectId: affordanceSubjectIdSchema,
  otherId: affordanceSubjectIdSchema,
  band: sceneFactSchema(sceneProximityBandSchema),
});

export const sceneFacingRelationSchema: z.ZodType<SceneFacingRelation> = z.object({
  subjectId: affordanceSubjectIdSchema,
  towardId: affordanceSubjectIdSchema,
  facing: sceneFactSchema(sceneFacingSchema),
});

const rawSceneStateSchema = z.object({
  version: z.number().int().catch(SCENE_STATE_VERSION),
  participants: z.array(z.unknown()).catch([]).default([]),
  supports: z.array(z.unknown()).catch([]).default([]),
  proximity: z.array(z.unknown()).catch([]).default([]),
  facing: z.array(z.unknown()).catch([]).default([]),
  contacts: z.unknown().optional(),
});

// ---------------------------------------------------------------------------
// Healing
// ---------------------------------------------------------------------------

/** Per-item parse over a bounded slice. Everything that does not survive is counted, never repaired. */
function readEntries<TEntry>(
  raw: readonly unknown[],
  schema: z.ZodType<TEntry>,
  limit: number,
): { entries: TEntry[]; dropped: number } {
  const entries: TEntry[] = [];
  let dropped = raw.length > limit ? raw.length - limit : 0;
  for (const item of raw.slice(0, limit)) {
    const parsed = schema.safeParse(item);
    if (parsed.success) entries.push(parsed.data);
    else dropped += 1;
  }
  return { entries, dropped };
}

/**
 * Restore stored scene state, dropping what cannot be read.
 *
 * A blob that is not a scene degrades to the empty scene — nobody placed, which
 * is the answer that can never be wrong in a harmful direction. A future
 * `version` degrades the same way rather than being read optimistically: a
 * newer writer may have meant something this reader would misinterpret, and a
 * missing placement is always safer than a misread one.
 */
export function parseSceneState(raw: unknown, sink?: DiagnosticSink): SceneState {
  const fallback = { version: SCENE_STATE_VERSION, participants: [], supports: [], proximity: [], facing: [] };
  const outer = parseOr(rawSceneStateSchema, raw, fallback, sink);
  if (outer.version !== SCENE_STATE_VERSION) {
    sink?.push(
      diag("warn", SCENE_STATE_INVALID, "stored scene state is a version this build cannot read", {
        context: { version: outer.version, expected: SCENE_STATE_VERSION },
      }),
    );
    return emptySceneState();
  }

  const participants = readEntries(outer.participants, sceneParticipantSchema, SCENE_MAX_PARTICIPANTS);
  const supports = readEntries(outer.supports, sceneSupportSurfaceSchema, SCENE_MAX_SUPPORTS);
  const proximity = readEntries(outer.proximity, sceneProximityRelationSchema, SCENE_MAX_RELATIONS);
  const facing = readEntries(outer.facing, sceneFacingRelationSchema, SCENE_MAX_RELATIONS);

  const placed = new Set<AffordanceSubjectId>(participants.entries.map((entry) => entry.subjectId));
  const surfaces = new Set(supports.entries.map((entry) => entry.supportId));

  let dangling = 0;
  const healedParticipants = participants.entries.map((participant) => {
    const support = participant.support.filter((fact) =>
      fact.value.anchor.kind === "surface"
        ? surfaces.has(fact.value.anchor.supportId)
        : placed.has(fact.value.anchor.subjectId),
    );
    if (support.length === participant.support.length) return participant;
    dangling += participant.support.length - support.length;
    return { ...participant, support };
  });
  const healedProximity = proximity.entries.filter(
    (entry) => placed.has(entry.subjectId) && placed.has(entry.otherId),
  );
  const healedFacing = facing.entries.filter((entry) => placed.has(entry.subjectId) && placed.has(entry.towardId));
  dangling += proximity.entries.length - healedProximity.length + (facing.entries.length - healedFacing.length);

  const dropped = participants.dropped + supports.dropped + proximity.dropped + facing.dropped;
  if (dropped > 0 || dangling > 0) {
    sink?.push(
      diag("error", SCENE_STATE_INVALID, "stored scene facts were unreadable or dangling and were dropped", {
        context: { dropped, dangling },
      }),
    );
  }

  return sceneStateOf({
    participants: healedParticipants,
    supports: supports.entries,
    proximity: healedProximity,
    facing: healedFacing,
    // The contact projection heals under its OWN rules. This module never
    // second-guesses them: the contact core is the authority on what is
    // touching, including on what a corrupt contact row means.
    contacts: parseContactLifecycleState(outer.contacts, sink),
  });
}
