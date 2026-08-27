import { describe, expect, it } from "vitest";
import {
  buildNpcSceneDigest,
  canonicalNpcSceneDigestString,
  contactRefAt,
  npcRefAt,
  npcSceneDecisionSchemas,
  parseNpcSceneDecisionOutput,
  NPC_SCENE_EVIDENCE_MAX_CHARS,
  NPC_SCENE_PLAYER_REF,
  NPC_SCENE_ROSTER_CAP,
  type NpcSceneDigest,
  type NpcSceneDigestInput,
} from "./npc-scene-decision";

/**
 * The compact digest, its stable references, and the closed decision schema.
 *
 * The load-bearing claims: refs are deterministic and database-id-free, the
 * canonical string is order-independent, the per-digest schemas admit ONLY
 * that digest's refs, unknown keys make a slot malformed, one malformed slot
 * never erases its valid sibling, and tier 2 has no `end` case.
 */

const PLAYER_ID = "player-subject-9f";
const MARA_ID = "char-mara-3a";
const SABRINA_ID = "char-sabrina-7c";

function rosterMember(subjectId: string, name: string, aliases: string[] = []) {
  return { subjectId, name, aliases, presence: "present" as const };
}

function digestInput(overrides: Partial<NpcSceneDigestInput> = {}): NpcSceneDigestInput {
  return {
    playerSubjectId: PLAYER_ID,
    roster: [rosterMember(MARA_ID, "Mara Vex"), rosterMember(SABRINA_ID, "Sabrina")],
    contacts: [
      {
        contactId: "contact-b",
        actorSubjectId: MARA_ID,
        actionKind: "affectionate",
        sourceSubjectId: MARA_ID,
        sourceLocationId: "hands",
        targetSubjectId: PLAYER_ID,
        targetLocationId: "hands",
      },
      {
        contactId: "contact-a",
        actorSubjectId: SABRINA_ID,
        actionKind: "affectionate",
        sourceSubjectId: SABRINA_ID,
        sourceLocationId: "hands",
        targetSubjectId: PLAYER_ID,
        targetLocationId: "shoulders",
      },
    ],
    proximity: [
      { aSubjectId: MARA_ID, bSubjectId: PLAYER_ID, band: "close" },
      { aSubjectId: SABRINA_ID, bSubjectId: MARA_ID, band: "near" },
    ],
    ...overrides,
  };
}

function builtDigest(): NpcSceneDigest {
  return buildNpcSceneDigest(digestInput()).digest;
}

/** A well-formed movement slot for the fixture digest. */
function approachSlot() {
  return {
    kind: "approach",
    actorRef: "npc_0",
    counterpartRef: "player",
    band: "close",
    facing: null,
    evidence: "Mara steps closer to you.",
  };
}

/** A well-formed contact slot for the fixture digest. */
function startSlot() {
  return {
    kind: "start",
    actorRef: "npc_1",
    targetRef: "player",
    gesture: "rest",
    targetLocationId: "shoulders",
    evidence: "Sabrina rests her hand on your shoulder.",
  };
}

describe("buildNpcSceneDigest", () => {
  it("assigns npc refs in stable roster order and contact refs in stable-contact-id order", () => {
    const { digest, handles } = buildNpcSceneDigest(digestInput());
    expect(digest.npcs.map((npc) => npc.ref)).toEqual([npcRefAt(0), npcRefAt(1)]);
    expect(digest.npcs.map((npc) => npc.name)).toEqual(["Mara Vex", "Sabrina"]);
    // "contact-a" sorts before "contact-b", so Sabrina's contact takes contact_0
    // even though it was listed second.
    expect(digest.contacts.map((contact) => contact.ref)).toEqual([contactRefAt(0), contactRefAt(1)]);
    expect(digest.contacts[0]?.actorRef).toBe("npc_1");
    expect(digest.contacts[1]?.actorRef).toBe("npc_0");
    expect(handles.contactIdByRef.get(contactRefAt(0))).toBe("contact-a");
    expect(handles.refBySubjectId.get(PLAYER_ID)).toBe(NPC_SCENE_PLAYER_REF);
    expect(handles.subjectIdByRef.get(npcRefAt(0))).toBe(MARA_ID);
  });

  it("carries no database subject or contact ids anywhere in the digest", () => {
    const serialized = canonicalNpcSceneDigestString(builtDigest());
    for (const id of [PLAYER_ID, MARA_ID, SABRINA_ID, "contact-a", "contact-b"]) {
      expect(serialized).not.toContain(id);
    }
  });

  it("caps the roster through the cap constant and names what it dropped", () => {
    const roster = Array.from({ length: NPC_SCENE_ROSTER_CAP + 2 }, (_, index) =>
      rosterMember(`char-${index}`, `Npc ${index}`),
    );
    const { digest, droppedRosterSubjectIds } = buildNpcSceneDigest(digestInput({ roster, contacts: [], proximity: [] }));
    expect(digest.npcs).toHaveLength(NPC_SCENE_ROSTER_CAP);
    expect(digest.npcs.map((npc) => npc.ref)).toEqual(
      Array.from({ length: NPC_SCENE_ROSTER_CAP }, (_, index) => npcRefAt(index)),
    );
    expect(droppedRosterSubjectIds).toEqual([`char-${NPC_SCENE_ROSTER_CAP}`, `char-${NPC_SCENE_ROSTER_CAP + 1}`]);
  });

  it("drops (and names) contacts whose participants are not roster-resolvable", () => {
    const { digest, droppedContactIds } = buildNpcSceneDigest(
      digestInput({
        contacts: [
          {
            contactId: "contact-ghost",
            actorSubjectId: "char-ghost",
            actionKind: "affectionate",
            sourceSubjectId: "char-ghost",
            sourceLocationId: "hands",
            targetSubjectId: PLAYER_ID,
            targetLocationId: "hands",
          },
        ],
      }),
    );
    expect(digest.contacts).toHaveLength(0);
    expect(droppedContactIds).toEqual(["contact-ghost"]);
  });

  it("keeps away roster members in the digest with their presence", () => {
    const { digest } = buildNpcSceneDigest(
      digestInput({ roster: [rosterMember(MARA_ID, "Mara Vex"), { ...rosterMember(SABRINA_ID, "Sabrina"), presence: "away" }] }),
    );
    expect(digest.npcs[1]?.presence).toBe("away");
  });
});

describe("canonicalNpcSceneDigestString", () => {
  it("is deterministic across input list order", () => {
    const base = buildNpcSceneDigest(digestInput()).digest;
    const shuffled = buildNpcSceneDigest(
      digestInput({
        contacts: [...digestInput().contacts].reverse(),
        proximity: [...digestInput().proximity].reverse(),
      }),
    ).digest;
    expect(canonicalNpcSceneDigestString(shuffled)).toBe(canonicalNpcSceneDigestString(base));
  });

  it("changes when the digest actually differs", () => {
    const base = canonicalNpcSceneDigestString(builtDigest());
    const other = buildNpcSceneDigest(digestInput({ proximity: [] })).digest;
    expect(canonicalNpcSceneDigestString(other)).not.toBe(base);
  });
});

describe("the per-digest candidate schemas", () => {
  it("admit only this digest's refs — a ref outside the digest is unparseable", () => {
    const schemas = npcSceneDecisionSchemas(builtDigest());
    expect(schemas.movement.safeParse(approachSlot()).success).toBe(true);
    expect(schemas.movement.safeParse({ ...approachSlot(), actorRef: "npc_9" }).success).toBe(false);
    expect(schemas.movement.safeParse({ ...approachSlot(), counterpartRef: "mara" }).success).toBe(false);
    expect(schemas.contact.safeParse({ ...startSlot() }).success).toBe(true);
    expect(
      schemas.contact.safeParse({
        kind: "update",
        actorRef: "npc_1",
        contactRef: "contact_7",
        gesture: "squeeze",
        evidence: "x.",
      }).success,
    ).toBe(false);
  });

  it("has no end case — the frozen floor owns endings", () => {
    const schemas = npcSceneDecisionSchemas(builtDigest());
    expect(
      schemas.contact.safeParse({
        kind: "end",
        actorRef: "npc_0",
        contactRef: "contact_0",
        evidence: "Mara pulls away.",
      }).success,
    ).toBe(false);
  });

  it("rejects unknown keys, off-vocabulary gestures/locations, and oversized or blank evidence", () => {
    const schemas = npcSceneDecisionSchemas(builtDigest());
    expect(schemas.movement.safeParse({ ...approachSlot(), extra: true }).success).toBe(false);
    expect(schemas.contact.safeParse({ ...startSlot(), gesture: "stroke" }).success).toBe(false);
    expect(schemas.contact.safeParse({ ...startSlot(), targetLocationId: "thighs" }).success).toBe(false);
    expect(
      schemas.contact.safeParse({ ...startSlot(), evidence: "a".repeat(NPC_SCENE_EVIDENCE_MAX_CHARS + 1) }).success,
    ).toBe(false);
    expect(schemas.contact.safeParse({ ...startSlot(), evidence: "   " }).success).toBe(false);
  });
});

describe("parseNpcSceneDecisionOutput", () => {
  it("parses both slots independently from an object or a JSON string", () => {
    const digest = builtDigest();
    const raw = { version: 1, movement: approachSlot(), contact: startSlot() };
    for (const input of [raw, JSON.stringify(raw)]) {
      const parsed = parseNpcSceneDecisionOutput(digest, input);
      expect(parsed.status).toBe("parsed");
      if (parsed.status !== "parsed") continue;
      expect(parsed.movement.status).toBe("parsed");
      expect(parsed.contact.status).toBe("parsed");
    }
  });

  it("keeps a valid sibling when one slot is malformed — in both directions", () => {
    const digest = builtDigest();
    const badContact = parseNpcSceneDecisionOutput(digest, {
      version: 1,
      movement: approachSlot(),
      contact: { ...startSlot(), extra: true },
    });
    expect(badContact.status).toBe("parsed");
    if (badContact.status === "parsed") {
      expect(badContact.movement.status).toBe("parsed");
      expect(badContact.contact.status).toBe("malformed");
      if (badContact.contact.status === "malformed") {
        expect(badContact.contact.issues.length).toBeGreaterThan(0);
      }
    }
    const badMovement = parseNpcSceneDecisionOutput(digest, {
      version: 1,
      movement: { kind: "approach", actorRef: "npc_9" },
      contact: startSlot(),
    });
    expect(badMovement.status).toBe("parsed");
    if (badMovement.status === "parsed") {
      expect(badMovement.movement.status).toBe("malformed");
      expect(badMovement.contact.status).toBe("parsed");
    }
  });

  it("distinguishes absent from malformed — null and missing are absent, never caught into it", () => {
    const digest = builtDigest();
    const nulls = parseNpcSceneDecisionOutput(digest, { version: 1, movement: null, contact: null });
    expect(nulls.status).toBe("parsed");
    if (nulls.status === "parsed") {
      expect(nulls.movement.status).toBe("absent");
      expect(nulls.contact.status).toBe("absent");
    }
    const missing = parseNpcSceneDecisionOutput(digest, { version: 1 });
    expect(missing.status).toBe("parsed");
    if (missing.status === "parsed") {
      expect(missing.movement.status).toBe("absent");
      expect(missing.contact.status).toBe("absent");
    }
  });

  it("fails the whole envelope on non-JSON, a wrong version, or unknown outer keys", () => {
    const digest = builtDigest();
    expect(parseNpcSceneDecisionOutput(digest, "definitely { not json").status).toBe("malformed_envelope");
    expect(parseNpcSceneDecisionOutput(digest, { version: 2, movement: null, contact: null }).status).toBe(
      "malformed_envelope",
    );
    expect(
      parseNpcSceneDecisionOutput(digest, { version: 1, movement: null, contact: null, end: {} }).status,
    ).toBe("malformed_envelope");
    expect(parseNpcSceneDecisionOutput(digest, 42).status).toBe("malformed_envelope");
  });
});
