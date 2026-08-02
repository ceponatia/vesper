import {
  chatAffectionateTargetLocationIds,
  chatContactGestures,
  type NpcSceneDigest,
} from "@/contracts";
import { AGENT_NARRATION_CAP } from "./constants";
import { fenceUntrusted, UNTRUSTED_DATA_NOTICE } from "./untrusted";

/**
 * The NPC reply-scene decision classifier prompt
 * (romantic-contact-affordances.spec.actor-control.md §"Authority model" /
 * §"Closed decision schema"). One structured call per persisted assistant
 * reply reads the reply plus the compact roster digest and may propose AT MOST
 * one movement (approach/depart) and one contact start/update — never an end
 * (the frozen deterministic floor owns endings), never authority (deterministic
 * validation, resolution, and persistence decide whether anything lands).
 *
 * The digest speaks ONLY in local refs (`player`, `npc_0`…, `contact_0`…): it
 * carries no database subject ids by construction (`buildNpcSceneDigest`), so
 * nothing this module renders can leak or echo a durable identifier — the
 * colocated test pins that. Pure and snapshot-testable like the rest of
 * `prompts/`; no IO.
 *
 * The closed schema is described HERE in full rather than relying on
 * `generateChecked`'s rendered JSON Schema: the per-digest ref schemas are
 * `z.custom` closures a JSON-Schema serialization cannot express, so the
 * transport schema the call parses with is deliberately loose and the
 * slot-independent contract parser (`parseNpcSceneDecisionOutput`) is the one
 * judge of shape. The gesture and target-location vocabularies below are
 * DERIVED from the one shared chat-contact vocabulary, never restated.
 */

const GESTURES = chatContactGestures.join(" | ");
const TARGET_LOCATIONS = chatAffectionateTargetLocationIds.join(" | ");

export const CHAT_NPC_SCENE_DECISION_SYSTEM = `You are the scene-action classifier for a private roleplay chat. You are given a compact digest of who is in the scene and one assistant reply. Decide whether the reply's NARRATION states that a non-player character COMPLETED a physical movement or an affectionate hand contact this beat.

Output exactly one JSON object, nothing else:

{ "version": 1, "movement": <movement proposal or null>, "contact": <contact proposal or null> }

A movement proposal is ONE of:
  { "kind": "approach", "actorRef": "<npc_N>", "counterpartRef": "player" | "<npc_N>", "band": "touching" | "close", "facing": "toward" | null, "evidence": "<verbatim quote>" }
  { "kind": "depart", "actorRef": "<npc_N>", "counterpartRef": "player" | "<npc_N>", "band": "near" | "distant", "evidence": "<verbatim quote>" }

A contact proposal is ONE of:
  { "kind": "start", "actorRef": "<npc_N>", "targetRef": "player" | "<npc_N>", "gesture": ${GESTURES}, "targetLocationId": ${TARGET_LOCATIONS}, "evidence": "<verbatim quote>" }
  { "kind": "update", "actorRef": "<npc_N>", "contactRef": "<contact_N>", "gesture": ${GESTURES}, "evidence": "<verbatim quote>" }

Rules:
1. "movement": null, "contact": null — PROPOSING NOTHING is the expected, common answer. Most replies move nobody and touch nothing. When in doubt, propose nothing.
2. At most ONE movement and ONE contact proposal per reply, even if the reply contains more. Each proposal names its acting NPC by roster ref ("actorRef"); only refs listed in the digest are valid.
3. "evidence" must be a VERBATIM quote copied character-for-character from the reply's narration — the exact sentence or clause stating the completed action. Never paraphrase, never quote dialogue or thoughts.
4. Completed actions only. Intentions, attempts, hedges, negations, questions, commands, conditionals, and future tense are NOT actions ("she wants to step closer", "she almost takes your hand" — propose nothing).
5. Never propose an ending. A character pulling away, withdrawing a hand, or leaving is handled elsewhere — do not encode it as a proposal.
6. "approach" is completed nearer whole-body movement toward the counterpart; "touching" only for explicit physical adjacency ("right beside", "flush against") — ordinary "beside"/"closer" is "close". "facing": "toward" only when the prose separately states the actor turns to face or faces the counterpart.
7. "depart" is completed whole-body movement away: a small reposition ("steps back") is "near"; walking away or crossing the room is "distant".
8. "start" is a completed affectionate hand touch by the actor's own hand on the target's ${TARGET_LOCATIONS.replaceAll(" | ", "/")}. Romantic, intimate, or forceful touches are NOT proposals — propose nothing for them.
9. "update" changes the gesture of an ACTIVE contact listed in the digest, and only one the same NPC started with their own hand ("contactRef" from the digest's contact list).
10. ${UNTRUSTED_DATA_NOTICE}`;

export interface ChatNpcSceneDecisionPromptInput {
  readonly digest: NpcSceneDigest;
  /** The COMPLETED assistant reply, exactly as persisted. */
  readonly reply: string;
}

/** One roster line: `- npc_0: "Wren" (aliases: Wrennie) — present`. */
function rosterLine(npc: NpcSceneDigest["npcs"][number]): string {
  const aliases = npc.aliases.filter((alias) => alias.trim().length > 0);
  const aliasNote = aliases.length > 0 ? ` (aliases: ${aliases.join(", ")})` : "";
  return `- ${npc.ref}: "${npc.name}"${aliasNote} — ${npc.presence}`;
}

/** One active-contact line, refs and canonical surface ids only. */
function contactLine(contact: NpcSceneDigest["contacts"][number]): string {
  return `- ${contact.ref}: ${contact.actorRef}'s ${contact.sourceLocationId} on ${contact.targetRef}'s ${contact.targetLocationId} (${contact.actionKind}, started by ${contact.actorRef})`;
}

/** One pair proximity line: `- npc_0 <-> player: close`. */
function proximityLine(fact: NpcSceneDigest["proximity"][number]): string {
  return `- ${fact.aRef} <-> ${fact.bRef}: ${fact.band}`;
}

export function buildChatNpcSceneDecisionPrompt(input: ChatNpcSceneDecisionPromptInput): string {
  const { digest } = input;
  const roster = digest.npcs.map(rosterLine).join("\n");
  const contacts = digest.contacts.map(contactLine).join("\n");
  const proximity = digest.proximity.map(proximityLine).join("\n");
  return [
    `Roster (the player is always "player"; presence is as of the previous beat — a listed away member may have arrived in this reply):\n${roster || "- (no non-player characters)"}`,
    `Active contacts:\n${contacts || "- (none)"}`,
    `Current proximity:\n${proximity || "- (none established)"}`,
    `Assistant reply to classify (only its narration can state an action):\n${fenceUntrusted("assistant reply", input.reply.slice(0, AGENT_NARRATION_CAP))}`,
  ].join("\n\n");
}
