import { z } from "zod";
import type { SceneProximityBand } from "../affordances/scene/vocabulary";
import {
  chatAffectionateTargetLocationIdSchema,
  chatContactGestureSchema,
  type ChatAffectionateTargetLocationId,
  type ChatContactGesture,
} from "./chat-contact-vocabulary";

/**
 * The NPC reply-scene decision contract
 * (romantic-contact-affordances.spec.actor-control.md §"Compact digest and
 * stable references" / §"Closed decision schema").
 *
 * One structured classifier call per persisted assistant reply reads the reply
 * plus a compact roster digest and may propose AT MOST one movement and one
 * contact start/update. This module owns the pure halves of that exchange:
 *
 * - the DIGEST the call reads — local references only (`player`, `npc_0`…,
 *   `contact_0`…), assigned deterministically and carrying **no database
 *   subject IDs**, so the model can never learn or echo a durable identifier;
 * - the deterministic canonical serialization the server hashes into the
 *   decision envelope's `digest_hash` (hashing itself is server-side — this
 *   module only guarantees two equal digests canonicalize identically);
 * - the CLOSED output schema, whose ref enums are built FROM a digest so a
 *   ref outside that reply's roster is not merely unresolvable later, it is
 *   unparseable now;
 * - the slot-independent parse: the outer result has two raw nullable slots
 *   parsed separately, because one malformed slot must not erase a valid
 *   sibling — and no slot uses `.catch(null)`, because "absent" and
 *   "malformed" are DIFFERENT trace outcomes and a catch would launder the
 *   second into the first.
 *
 * Tier 2 has no `end` case anywhere in this file. The frozen deterministic
 * floor (`chat-contact-reply.ts`) is the only producer of contact endings.
 */

// ---------------------------------------------------------------------------
// References
// ---------------------------------------------------------------------------

/**
 * The chat-lane roster cap. The digest's `npc_0`…`npc_3` ref family is derived
 * from the actual roster THROUGH this constant — nothing else in this module
 * (or its consumers) may hard-code the number 4, so a future cap change is one
 * edit here plus the lane's own enforcement.
 */
export const NPC_SCENE_ROSTER_CAP = 4;

/** The chat player's fixed digest ref. */
export const NPC_SCENE_PLAYER_REF = "player";

/**
 * Digest-local references. Template types close the FORM (`npc_2`, never a
 * name or a database id); the per-digest schema builder below closes the
 * MEMBERSHIP (only the refs this digest actually assigned parse).
 */
export type NpcRef = `npc_${number}`;
export type ContactRef = `contact_${number}`;
export type ParticipantRef = typeof NPC_SCENE_PLAYER_REF | NpcRef;

/** The ref for the roster member at `index` (stable roster order). */
export function npcRefAt(index: number): NpcRef {
  return `npc_${index}`;
}

/** The ref for the active contact at `index` (stable-contact-id order). */
export function contactRefAt(index: number): ContactRef {
  return `contact_${index}`;
}

/**
 * A deterministic rank for canonical pair ordering: the player first, then the
 * roster in ref order. Used so a proximity pair is stored exactly once, in
 * exactly one orientation, whatever order the caller handed the facts in.
 */
function participantRefRank(ref: ParticipantRef): number {
  return ref === NPC_SCENE_PLAYER_REF ? -1 : Number(ref.slice("npc_".length));
}

// ---------------------------------------------------------------------------
// Digest
// ---------------------------------------------------------------------------

/** Pre-settle presence — kept in the digest so an arrival narrated THIS reply can still be classified. */
export const npcSceneDigestPresences = ["present", "away"] as const;
export type NpcSceneDigestPresence = (typeof npcSceneDigestPresences)[number];

/** One roster member, as the classifier sees them: a local ref and prose-side identity only. */
export interface NpcSceneDigestNpc {
  readonly ref: NpcRef;
  readonly name: string;
  readonly aliases: readonly string[];
  readonly presence: NpcSceneDigestPresence;
}

/**
 * One roster-resolvable active contact. Local refs and canonical surface ids
 * only — the resolver still re-checks the post-settle contact by its durable
 * `contactId` at commit time; a digest handle is never authority.
 */
export interface NpcSceneDigestContact {
  readonly ref: ContactRef;
  /** Who started the contact — the only actor an `update` may name. */
  readonly actorRef: ParticipantRef;
  readonly actionKind: string;
  readonly sourceRef: ParticipantRef;
  readonly sourceLocationId: string;
  readonly targetRef: ParticipantRef;
  readonly targetLocationId: string;
}

/** One current pair proximity fact, canonically oriented (`aRef` ranks before `bRef`). */
export interface NpcSceneDigestProximity {
  readonly aRef: ParticipantRef;
  readonly bRef: ParticipantRef;
  readonly band: SceneProximityBand;
}

/** The whole compact digest — everything the one classifier call may read about the scene. */
export interface NpcSceneDigest {
  readonly npcs: readonly NpcSceneDigestNpc[];
  readonly contacts: readonly NpcSceneDigestContact[];
  readonly proximity: readonly NpcSceneDigestProximity[];
}

/** Builder inputs. Subject and contact ids come IN here and never leave: they map to refs. */
export interface NpcSceneRosterMemberInput {
  readonly subjectId: string;
  readonly name: string;
  readonly aliases: readonly string[];
  readonly presence: NpcSceneDigestPresence;
}

export interface NpcSceneContactInput {
  /** The durable contact id — the SORT KEY for stable `contact_N` assignment. */
  readonly contactId: string;
  readonly actorSubjectId: string;
  readonly actionKind: string;
  readonly sourceSubjectId: string;
  readonly sourceLocationId: string;
  readonly targetSubjectId: string;
  readonly targetLocationId: string;
}

export interface NpcSceneProximityInput {
  readonly aSubjectId: string;
  readonly bSubjectId: string;
  readonly band: SceneProximityBand;
}

export interface NpcSceneDigestInput {
  readonly playerSubjectId: string;
  /** In STABLE ROSTER ORDER — the order is the ref assignment. */
  readonly roster: readonly NpcSceneRosterMemberInput[];
  readonly contacts: readonly NpcSceneContactInput[];
  readonly proximity: readonly NpcSceneProximityInput[];
}

/**
 * The ref↔id handles the digest deliberately does not carry. The server keeps
 * these beside the digest for resolution and envelope storage; the model never
 * sees them.
 */
export interface NpcSceneDigestHandles {
  readonly refBySubjectId: ReadonlyMap<string, ParticipantRef>;
  readonly subjectIdByRef: ReadonlyMap<ParticipantRef, string>;
  readonly contactIdByRef: ReadonlyMap<ContactRef, string>;
  readonly refByContactId: ReadonlyMap<string, ContactRef>;
}

export interface NpcSceneDigestBuild {
  readonly digest: NpcSceneDigest;
  readonly handles: NpcSceneDigestHandles;
  /** Roster members beyond the cap (or duplicating a subject id) — named so the caller can trace the omission. */
  readonly droppedRosterSubjectIds: readonly string[];
  /** Contacts whose participants are not roster-resolvable — the digest exposes only resolvable ones. */
  readonly droppedContactIds: readonly string[];
}

/**
 * Assemble the digest and its handles. Deterministic and total: the same input
 * always produces the same refs (roster order for `npc_N`, durable-contact-id
 * order for `contact_N`), and nothing here throws — an over-cap roster member
 * or an unresolvable contact is DROPPED AND NAMED, never guessed at.
 */
export function buildNpcSceneDigest(input: NpcSceneDigestInput): NpcSceneDigestBuild {
  const refBySubjectId = new Map<string, ParticipantRef>();
  const subjectIdByRef = new Map<ParticipantRef, string>();
  refBySubjectId.set(input.playerSubjectId, NPC_SCENE_PLAYER_REF);
  subjectIdByRef.set(NPC_SCENE_PLAYER_REF, input.playerSubjectId);

  const npcs: NpcSceneDigestNpc[] = [];
  const droppedRosterSubjectIds: string[] = [];
  for (const member of input.roster) {
    if (npcs.length >= NPC_SCENE_ROSTER_CAP || refBySubjectId.has(member.subjectId)) {
      droppedRosterSubjectIds.push(member.subjectId);
      continue;
    }
    const ref = npcRefAt(npcs.length);
    refBySubjectId.set(member.subjectId, ref);
    subjectIdByRef.set(ref, member.subjectId);
    npcs.push({ ref, name: member.name, aliases: [...member.aliases], presence: member.presence });
  }

  // Stable-contact-id order is the ref assignment; codepoint comparison so the
  // ordering never depends on locale.
  const sortedContacts = [...input.contacts].sort((left, right) =>
    left.contactId < right.contactId ? -1 : left.contactId > right.contactId ? 1 : 0,
  );
  const contacts: NpcSceneDigestContact[] = [];
  const contactIdByRef = new Map<ContactRef, string>();
  const refByContactId = new Map<string, ContactRef>();
  const droppedContactIds: string[] = [];
  for (const contact of sortedContacts) {
    const actorRef = refBySubjectId.get(contact.actorSubjectId);
    const sourceRef = refBySubjectId.get(contact.sourceSubjectId);
    const targetRef = refBySubjectId.get(contact.targetSubjectId);
    if (actorRef === undefined || sourceRef === undefined || targetRef === undefined || refByContactId.has(contact.contactId)) {
      droppedContactIds.push(contact.contactId);
      continue;
    }
    const ref = contactRefAt(contacts.length);
    contactIdByRef.set(ref, contact.contactId);
    refByContactId.set(contact.contactId, ref);
    contacts.push({
      ref,
      actorRef,
      actionKind: contact.actionKind,
      sourceRef,
      sourceLocationId: contact.sourceLocationId,
      targetRef,
      targetLocationId: contact.targetLocationId,
    });
  }

  const proximity: NpcSceneDigestProximity[] = [];
  const seenPairs = new Set<string>();
  for (const fact of input.proximity) {
    const left = refBySubjectId.get(fact.aSubjectId);
    const right = refBySubjectId.get(fact.bSubjectId);
    if (left === undefined || right === undefined || left === right) continue;
    const [aRef, bRef] = participantRefRank(left) <= participantRefRank(right) ? [left, right] : [right, left];
    const key = `${aRef}|${bRef}`;
    if (seenPairs.has(key)) continue;
    seenPairs.add(key);
    proximity.push({ aRef, bRef, band: fact.band });
  }
  proximity.sort(
    (left, right) =>
      participantRefRank(left.aRef) - participantRefRank(right.aRef) ||
      participantRefRank(left.bRef) - participantRefRank(right.bRef),
  );

  return {
    digest: { npcs, contacts, proximity },
    handles: { refBySubjectId, subjectIdByRef, contactIdByRef, refByContactId },
    droppedRosterSubjectIds,
    droppedContactIds,
  };
}

/**
 * The deterministic canonical serialization the envelope's `digest_hash` is
 * computed over (hashing is server-side; this module only owns the bytes).
 *
 * Field order is FIXED here rather than inherited from object key order, and
 * every list is re-sorted into its canonical order before serialization, so
 * two semantically identical digests — however assembled — canonicalize to the
 * same string. The `v1` prefix versions the byte layout itself: a future field
 * addition bumps it rather than silently re-hashing old digests differently.
 */
export function canonicalNpcSceneDigestString(digest: NpcSceneDigest): string {
  const npcs = [...digest.npcs]
    .sort((left, right) => participantRefRank(left.ref) - participantRefRank(right.ref))
    .map((npc) => ({ ref: npc.ref, name: npc.name, aliases: [...npc.aliases], presence: npc.presence }));
  const contactRank = (ref: ContactRef): number => Number(ref.slice("contact_".length));
  const contacts = [...digest.contacts]
    .sort((left, right) => contactRank(left.ref) - contactRank(right.ref))
    .map((contact) => ({
      ref: contact.ref,
      actorRef: contact.actorRef,
      actionKind: contact.actionKind,
      sourceRef: contact.sourceRef,
      sourceLocationId: contact.sourceLocationId,
      targetRef: contact.targetRef,
      targetLocationId: contact.targetLocationId,
    }));
  const proximity = [...digest.proximity]
    .sort(
      (left, right) =>
        participantRefRank(left.aRef) - participantRefRank(right.aRef) ||
        participantRefRank(left.bRef) - participantRefRank(right.bRef),
    )
    .map((fact) => ({ aRef: fact.aRef, bRef: fact.bRef, band: fact.band }));
  return `npc_scene_digest_v1:${JSON.stringify({ npcs, contacts, proximity })}`;
}

// ---------------------------------------------------------------------------
// Closed decision schema
// ---------------------------------------------------------------------------

/** The one free-text field: a verbatim quote from the reply. Nonblank, bounded. */
export const NPC_SCENE_EVIDENCE_MAX_CHARS = 480;

/** Evidence is a plain bounded string; every other field is a closed enum or ref. */
export type EvidenceQuote = string;

const evidenceQuoteSchema = z
  .string()
  .max(NPC_SCENE_EVIDENCE_MAX_CHARS)
  .refine((value) => value.trim().length > 0, { message: "evidence must be a nonblank quote" });

export interface NpcApproachCandidate {
  readonly kind: "approach";
  readonly actorRef: NpcRef;
  readonly counterpartRef: ParticipantRef;
  readonly band: "touching" | "close";
  readonly facing: "toward" | null;
  readonly evidence: EvidenceQuote;
}

export interface NpcDepartCandidate {
  readonly kind: "depart";
  readonly actorRef: NpcRef;
  readonly counterpartRef: ParticipantRef;
  readonly band: "near" | "distant";
  readonly evidence: EvidenceQuote;
}

export type NpcMovementCandidate = NpcApproachCandidate | NpcDepartCandidate;

export interface NpcContactStartCandidate {
  readonly kind: "start";
  readonly actorRef: NpcRef;
  readonly targetRef: ParticipantRef;
  readonly gesture: ChatContactGesture;
  readonly targetLocationId: ChatAffectionateTargetLocationId;
  readonly evidence: EvidenceQuote;
}

export interface NpcContactUpdateCandidate {
  readonly kind: "update";
  readonly actorRef: NpcRef;
  readonly contactRef: ContactRef;
  readonly gesture: ChatContactGesture;
  readonly evidence: EvidenceQuote;
}

/** NO `end` case: the frozen deterministic floor owns endings, and this union must never grow one. */
export type NpcContactCandidate = NpcContactStartCandidate | NpcContactUpdateCandidate;

export interface NpcSceneDecisionOutputV1 {
  readonly version: 1;
  readonly movement: NpcMovementCandidate | null;
  readonly contact: NpcContactCandidate | null;
}

/**
 * A closed ref enum over exactly the refs one digest assigned. `z.custom` so
 * the parsed type keeps the template-literal ref form; an empty member list
 * (a rosterless digest, a contactless scene) parses NOTHING, which is correct:
 * a candidate needing a ref no digest granted has no lawful spelling.
 */
function closedRefSchema<T extends string>(members: readonly T[], label: string): z.ZodType<T> {
  const set = new Set<string>(members);
  return z.custom<T>((value) => typeof value === "string" && set.has(value), {
    message: `${label} must be one of this digest's refs`,
  });
}

export interface NpcSceneDecisionSchemas {
  readonly movement: z.ZodType<NpcMovementCandidate>;
  readonly contact: z.ZodType<NpcContactCandidate>;
}

/**
 * Build the per-digest candidate schemas. All objects are STRICT: an unknown
 * key is not decoration, it is a shape this contract never agreed to, and the
 * slot carrying it is malformed.
 */
export function npcSceneDecisionSchemas(digest: NpcSceneDigest): NpcSceneDecisionSchemas {
  const npcRefs = digest.npcs.map((npc) => npc.ref);
  const participantRefs: readonly ParticipantRef[] = [NPC_SCENE_PLAYER_REF, ...npcRefs];
  const contactRefs = digest.contacts.map((contact) => contact.ref);
  const actorRef = closedRefSchema<NpcRef>(npcRefs, "actorRef");
  const participantRef = closedRefSchema<ParticipantRef>(participantRefs, "participant ref");
  const contactRef = closedRefSchema<ContactRef>(contactRefs, "contactRef");

  const approach = z
    .object({
      kind: z.literal("approach"),
      actorRef,
      counterpartRef: participantRef,
      band: z.enum(["touching", "close"]),
      facing: z.union([z.literal("toward"), z.null()]),
      evidence: evidenceQuoteSchema,
    })
    .strict();
  const depart = z
    .object({
      kind: z.literal("depart"),
      actorRef,
      counterpartRef: participantRef,
      band: z.enum(["near", "distant"]),
      evidence: evidenceQuoteSchema,
    })
    .strict();
  const start = z
    .object({
      kind: z.literal("start"),
      actorRef,
      targetRef: participantRef,
      gesture: chatContactGestureSchema,
      targetLocationId: chatAffectionateTargetLocationIdSchema,
      evidence: evidenceQuoteSchema,
    })
    .strict();
  const update = z
    .object({
      kind: z.literal("update"),
      actorRef,
      contactRef,
      gesture: chatContactGestureSchema,
      evidence: evidenceQuoteSchema,
    })
    .strict();

  return {
    movement: z.discriminatedUnion("kind", [approach, depart]),
    contact: z.discriminatedUnion("kind", [start, update]),
  };
}

// ---------------------------------------------------------------------------
// Slot-independent parse
// ---------------------------------------------------------------------------

/** How many issue lines a malformed slot may record, and how long each may be. */
const SLOT_ISSUE_CAP = 8;
const SLOT_ISSUE_MAX_CHARS = 160;

/**
 * One slot's parse outcome. THREE states on purpose: `absent` (the model
 * proposed nothing — null or missing) and `malformed` (it proposed something
 * this contract refuses) are different durable trace outcomes, which is why no
 * slot schema uses `.catch(null)` — a catch would record a refusal as a
 * shrug.
 */
export type NpcSceneSlot<T> =
  | { readonly status: "absent" }
  | { readonly status: "malformed"; readonly issues: readonly string[] }
  | { readonly status: "parsed"; readonly candidate: T };

export type NpcSceneDecisionParse =
  | { readonly status: "malformed_envelope"; readonly issues: readonly string[] }
  | {
      readonly status: "parsed";
      readonly movement: NpcSceneSlot<NpcMovementCandidate>;
      readonly contact: NpcSceneSlot<NpcContactCandidate>;
    };

/** The outer envelope: version-pinned, slots carried RAW (and optional — a missing slot is `absent`, not an envelope failure) so each parses independently. */
const decisionEnvelopeSchema = z
  .object({
    version: z.literal(1),
    movement: z.unknown().optional(),
    contact: z.unknown().optional(),
  })
  .strict();

function boundedIssues(error: z.ZodError): readonly string[] {
  return error.issues.slice(0, SLOT_ISSUE_CAP).map((issue) => {
    const path =
      issue.path.length === 0
        ? "(root)"
        : issue.path.map((part) => (typeof part === "symbol" ? "(symbol)" : String(part))).join(".");
    return `${path}: ${issue.message}`.slice(0, SLOT_ISSUE_MAX_CHARS);
  });
}

function parseSlot<T>(schema: z.ZodType<T>, value: unknown): NpcSceneSlot<T> {
  if (value === null || value === undefined) return { status: "absent" };
  const parsed = schema.safeParse(value);
  if (parsed.success) return { status: "parsed", candidate: parsed.data };
  return { status: "malformed", issues: boundedIssues(parsed.error) };
}

/**
 * Parse one classifier output against one digest. Total — a boundary parser in
 * the `parseOr` spirit (docs/resilience.md §1): every failure is a value, never
 * an exception, and the failure NAMES what failed:
 *
 * - not JSON / not an object / wrong version / unknown outer keys →
 *   `malformed_envelope` (there are no slots to save);
 * - each slot then parses INDEPENDENTLY, so "a hallucinated contact beside a
 *   valid movement" degrades to exactly the valid movement.
 */
export function parseNpcSceneDecisionOutput(digest: NpcSceneDigest, raw: unknown): NpcSceneDecisionParse {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return { status: "malformed_envelope", issues: ["(root): output is not valid JSON"] };
    }
  }
  const envelope = decisionEnvelopeSchema.safeParse(value);
  if (!envelope.success) {
    return { status: "malformed_envelope", issues: boundedIssues(envelope.error) };
  }
  const schemas = npcSceneDecisionSchemas(digest);
  return {
    status: "parsed",
    movement: parseSlot(schemas.movement, envelope.data.movement),
    contact: parseSlot(schemas.contact, envelope.data.contact),
  };
}
