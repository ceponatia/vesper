import { z } from "zod";
import { diag, type DiagnosticSink } from "../../diagnostics";
import { parseOr } from "@/lib/parse";
import { affordanceSubjectIdSchema, type AffordanceSubjectId } from "../core";
import { contactParticipantIds, parseContactLifecycleState, type ContactLifecycleState } from "../contact";
import { SCENE_STATE_CONTRADICTORY, SCENE_STATE_INVALID } from "./diagnostics";
import { sceneFactSchema, sceneSupportIdSchema } from "./provenance";
import {
  SCENE_MAX_PARTICIPANTS,
  SCENE_MAX_RELATIONS,
  SCENE_MAX_SUPPORT_RELATIONS,
  SCENE_MAX_SUPPORTS,
  SCENE_STATE_VERSION,
  emptySceneState,
  sceneFacingKey,
  scenePairKey,
  sceneStateOf,
  sceneSupportAnchorKey,
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
 * The persisted scene shape and its healing rules.
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
 * ## Why `version` is read as `unknown`
 *
 * A `.catch(CURRENT)` on the version takes a malformed one — a string, a null, a
 * missing key, a fraction — and hands back the number this build happens to
 * write, so a blob nobody wrote for this release is then read as though somebody
 * had, and every placement in it is trusted. The version is the claim that the
 * rest of the bytes MEAN what this reader thinks they mean; repairing it is
 * repairing the only thing that could have told us otherwise. It is read as
 * `unknown` and must equal `SCENE_STATE_VERSION` exactly. (The contact core made
 * the same correction on the same grounds — `contact/state.ts`.)
 *
 * ## Referential integrity
 *
 * A relation is only as real as the things it relates. A proximity or facing
 * entry naming a participant that did not survive is dropped; so is a support
 * relation whose anchor is not in the scene. A participant that loses a support
 * relation this way KEEPS its other facts — and keeps the support SET, with its
 * provenance, minus that relation — and simply has an unknown elevation;
 * dropping the whole body over one dangling anchor would throw away good facts
 * to punish a bad one.
 *
 * The housed contact projection is held to the same rule. It heals under the
 * contact core's own parser, which knows nothing about who is in this scene, so
 * a contact can come back perfectly well-formed while the body it names was just
 * dropped as unreadable — an active touch on a participant that is not here.
 * After restoration, any contact whose BODY participants did not all survive is
 * dropped. A contact with an object target needs only its source body, because
 * that is all it names.
 *
 * ## Why a CONTRADICTION drops every claimant
 *
 * Two stored participants with one subject id, two proximity entries for one
 * pair, two relations anchored to one thing: the blob claims a body is in two
 * states at once. Keeping "the last one" would be this module choosing which
 * writer to believe on the strength of array position, which is not evidence of
 * anything — a stored array's order is an accident of whatever produced it.
 * **An absent fact is honest; a chosen one is invented**, so every claimant of a
 * contradicted key goes and the reads about it answer `unresolved`.
 *
 * `sceneStateOf` keeps last-write-wins because there the last entry is the one
 * the caller just wrote — real ordering information, and how `withScene*`
 * expresses replacement. The boundary is the part that must never pick, which is
 * why the drop happens here, before construction.
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

/** The support SET, as one value. Its fact wrapper is what carries the provenance of a clearing. */
const supportSetSchema = z.array(supportRelationSchema).max(SCENE_MAX_SUPPORT_RELATIONS).readonly();

/**
 * Strict throughout — no `.catch()`, no defaults. Every field is either identity
 * or a physical claim, and repairing either is inventing it.
 *
 * The refinement refuses a body that supports ITSELF, which is not degraded data
 * but a record that could never be true. It takes the whole participant with it,
 * exactly as a corrupt posture does: a record making an impossible claim has
 * nothing in it this module is willing to vouch for. (`sceneStateOf` is gentler
 * with a programmatic caller — it drops the relation and keeps the body — because
 * there the surrounding facts came from code that is not under suspicion.)
 */
export const sceneParticipantSchema: z.ZodType<SceneParticipant> = z
  .object({
    subjectId: affordanceSubjectIdSchema,
    control: sceneFactSchema(sceneControlModeSchema).optional(),
    posture: sceneFactSchema(scenePostureSchema).optional(),
    support: sceneFactSchema(supportSetSchema).optional(),
  })
  .refine(
    (participant) =>
      (participant.support?.value ?? []).every(
        (relation) => relation.anchor.kind !== "participant" || relation.anchor.subjectId !== participant.subjectId,
      ),
    { message: "a body cannot support itself" },
  );

export const sceneSupportSurfaceSchema: z.ZodType<SceneSupportSurface> = z.object({
  supportId: sceneSupportIdSchema,
  kind: sceneSupportKindSchema,
  height: sceneFactSchema(sceneHeightRungSchema),
});

/** A pair, never a body and itself: "she is close to herself" is a distance nothing can be. */
export const sceneProximityRelationSchema: z.ZodType<SceneProximityRelation> = z
  .object({
    subjectId: affordanceSubjectIdSchema,
    otherId: affordanceSubjectIdSchema,
    band: sceneFactSchema(sceneProximityBandSchema),
  })
  .refine((relation) => relation.subjectId !== relation.otherId, { message: "a body cannot be near itself" });

export const sceneFacingRelationSchema: z.ZodType<SceneFacingRelation> = z
  .object({
    subjectId: affordanceSubjectIdSchema,
    towardId: affordanceSubjectIdSchema,
    facing: sceneFactSchema(sceneFacingSchema),
  })
  .refine((relation) => relation.subjectId !== relation.towardId, { message: "a body cannot face itself" });

/**
 * `version` is `unknown` ON PURPOSE — see the header. Everything else may be
 * absent; nothing may be repaired.
 *
 * `.optional()` is what makes a blob with NO version key reach the version check
 * as `undefined` and be refused there, with the diagnostic that names the
 * problem. Without it the whole object fails to parse and the failure is
 * reported as a generic boundary error — the same empty scene in the end, but a
 * diagnostic that does not say which field was missing.
 */
const rawSceneStateSchema = z.object({
  version: z.unknown().optional(),
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

/** Every entry whose key another entry also claims goes — all of them, never the first or the last. */
function withoutContradictions<TEntry>(
  entries: readonly TEntry[],
  keyOf: (entry: TEntry) => string,
): { entries: TEntry[]; contradicted: number } {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const key = keyOf(entry);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const kept = entries.filter((entry) => counts.get(keyOf(entry)) === 1);
  return { entries: kept, contradicted: entries.length - kept.length };
}

/**
 * Contradictions INSIDE one participant's support set.
 *
 * Two relations on one anchor say two things about one attachment. Two
 * `borne_by` relations say the body has two base heights, which is the same
 * contradiction the reach read refuses to resolve — so rather than store it and
 * rely on every reader to catch it, both claimants go and the body's elevation
 * becomes honestly unknown.
 */
function withoutContradictorySupport(relations: readonly SceneSupportRelation[]): {
  relations: readonly SceneSupportRelation[];
  contradicted: number;
} {
  const byAnchor = withoutContradictions(relations, (relation) => sceneSupportAnchorKey(relation.anchor));
  const borne = byAnchor.entries.filter((relation) => relation.role === "borne_by");
  if (borne.length <= 1) return { relations: byAnchor.entries, contradicted: byAnchor.contradicted };
  return {
    relations: byAnchor.entries.filter((relation) => relation.role !== "borne_by"),
    contradicted: byAnchor.contradicted + borne.length,
  };
}

/**
 * Contacts whose bodies are all still in the scene.
 *
 * `contactParticipantIds` is the contact core's own extraction rather than a
 * second reading of `source`/`target` here — the core owns what a contact is,
 * including which of its two ends belong to characters, and a local copy of that
 * knowledge would be the thing that quietly disagrees when a surface kind is
 * added.
 */
function housedContacts(
  projection: ContactLifecycleState,
  placed: ReadonlySet<AffordanceSubjectId>,
): { projection: ContactLifecycleState; orphaned: number } {
  const kept = projection.contacts.filter((contact) =>
    contactParticipantIds(contact.source, contact.target).every((id) => placed.has(id)),
  );
  if (kept.length === projection.contacts.length) return { projection, orphaned: 0 };
  return { projection: { ...projection, contacts: kept }, orphaned: projection.contacts.length - kept.length };
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
      diag("warn", SCENE_STATE_INVALID, "stored scene state carries no version this build can read", {
        context: { version: outer.version, expected: SCENE_STATE_VERSION },
      }),
    );
    return emptySceneState();
  }

  const participants = readEntries(outer.participants, sceneParticipantSchema, SCENE_MAX_PARTICIPANTS);
  const supports = readEntries(outer.supports, sceneSupportSurfaceSchema, SCENE_MAX_SUPPORTS);
  const proximity = readEntries(outer.proximity, sceneProximityRelationSchema, SCENE_MAX_RELATIONS);
  const facing = readEntries(outer.facing, sceneFacingRelationSchema, SCENE_MAX_RELATIONS);

  // --- Contradictions, before anything is allowed to depend on them ------
  const soleParticipants = withoutContradictions(participants.entries, (entry) => entry.subjectId);
  const soleSupports = withoutContradictions(supports.entries, (entry) => entry.supportId);
  const soleProximity = withoutContradictions(proximity.entries, (entry) =>
    scenePairKey(entry.subjectId, entry.otherId),
  );
  const soleFacing = withoutContradictions(facing.entries, (entry) => sceneFacingKey(entry.subjectId, entry.towardId));

  const placed = new Set<AffordanceSubjectId>(soleParticipants.entries.map((entry) => entry.subjectId));
  const surfaces = new Set(soleSupports.entries.map((entry) => entry.supportId));

  let dangling = 0;
  let contradicted =
    soleParticipants.contradicted + soleSupports.contradicted + soleProximity.contradicted + soleFacing.contradicted;
  const healedParticipants = soleParticipants.entries.map((participant) => {
    const stated = participant.support;
    if (stated === undefined) return participant;
    const sole = withoutContradictorySupport(stated.value);
    contradicted += sole.contradicted;
    // The SET survives the loss of any relation in it — that is the point of
    // storing it as one fact. A body that loses its anchors keeps a stated,
    // timestamped, now-empty support set rather than reverting to "nobody said".
    const relations = sole.relations.filter((relation) =>
      relation.anchor.kind === "surface"
        ? surfaces.has(relation.anchor.supportId)
        : placed.has(relation.anchor.subjectId),
    );
    dangling += sole.relations.length - relations.length;
    if (relations.length === stated.value.length) return participant;
    return { ...participant, support: { value: relations, provenance: stated.provenance } };
  });
  const healedProximity = soleProximity.entries.filter(
    (entry) => placed.has(entry.subjectId) && placed.has(entry.otherId),
  );
  const healedFacing = soleFacing.entries.filter((entry) => placed.has(entry.subjectId) && placed.has(entry.towardId));
  dangling += soleProximity.entries.length - healedProximity.length + (soleFacing.entries.length - healedFacing.length);

  // The contact projection heals under its OWN rules — the contact core is the
  // authority on what a corrupt contact row means. What it cannot know is who is
  // in THIS scene, so the referential check is ours and runs after it.
  const housed = housedContacts(parseContactLifecycleState(outer.contacts, sink), placed);
  dangling += housed.orphaned;

  const dropped = participants.dropped + supports.dropped + proximity.dropped + facing.dropped;
  if (dropped > 0 || dangling > 0) {
    sink?.push(
      diag("error", SCENE_STATE_INVALID, "stored scene facts were unreadable or dangling and were dropped", {
        context: { dropped, dangling, orphanedContacts: housed.orphaned },
      }),
    );
  }
  if (contradicted > 0) {
    sink?.push(
      diag("error", SCENE_STATE_CONTRADICTORY, "stored scene facts claimed one key twice, so every claimant went", {
        context: { contradicted },
      }),
    );
  }

  return sceneStateOf({
    participants: healedParticipants,
    supports: soleSupports.entries,
    proximity: healedProximity,
    facing: healedFacing,
    contacts: housed.projection,
  });
}
