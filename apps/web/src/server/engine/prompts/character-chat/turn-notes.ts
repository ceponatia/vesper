import { deriveMoodDescriptor } from "@/contracts/meters/registry";
import { regardBandForValue } from "@/contracts/relationships/bands";
import { type ChatSkipAmount } from "@/contracts/turns/chat-skip";
import { formatCommsReply, parseMessageSpans } from "@/lib/message-spans";
import { fenceUntrusted } from "../untrusted";
import { type CharacterChatPromptInput } from "./types";
import { feelingPhrase } from "./state-sections";

/**
 * The history header for a narrator-mode player line. Applied at the MODEL
 * boundary only — the stored transcript stays byte-verbatim.
 * The static notation legend teaches what the marker means; the wrap makes every past
 * narrator line self-identifying inside the replayed window.
 */
export function narratorInputHeader(player: string): string {
  return `[Story narration from ${player} — written as the storyteller, not as ${player} speaking or acting]`;
}

/** Prefix a narrator-mode line with its marker for the model history (never persisted). */
export function wrapNarratorInput(content: string, player: string): string {
  return `${narratorInputHeader(player)}\n${content}`;
}

/**
 * The one-turn tail note for a narrator-mode input: the binding statement that THIS
 * message is story truth, not the player's POV — the perception partition doesn't apply.
 * `who` is the responder ("Mara" 1-on-1, "each present character" in the ensemble).
 */
export function narratorInputNote(who: string, player: string): string {
  return `This turn's message is STORY NARRATION from ${player}, written as the storyteller — not ${player} speaking or acting. Everything it describes has happened in the story: play ${who}'s honest response to those events, voice any side characters it sets in motion, and continue the scene from where it leaves off. Do not reply as if ${player} said or did any of it, and do not re-narrate what it already establishes.`;
}

/** Lead line per skip amount — the fictional gap the next reply opens on. */
const SKIP_LEADS: Record<ChatSkipAmount, string> = {
  moments: "A little while has passed since your last exchange.",
  hours: "Hours have passed — it's later the same day.",
  overnight: "The night has passed — it's the next morning.",
  days: "Several days have passed since you last spoke.",
};

/** Regard-band tone for acknowledging the gap (warmer regard notices the absence more; `neutral` falls to the default arm). */
function skipToneForBand(bandId: string): string {
  switch (bandId) {
    case "hostile":
    case "wary":
    case "cool":
      return "Acknowledge the gap curtly, once — time apart hasn't softened anything on its own.";
    case "friendly":
    case "warm":
      return "Acknowledge the gap warmly, once — you noticed the time apart.";
    case "close":
    case "cherished":
    case "devoted":
    case "smitten":
      return "Acknowledge the gap like someone who missed them — once, without making a speech of it.";
    default:
      return "Acknowledge the gap naturally, once.";
  }
}

/**
 * The one-shot skip note: stamped onto the state when the player
 * skips time, rendered as a volatile one-turn prompt line, cleared after the
 * exchange that rendered it. Carries the "a life meanwhile" license —
 * one line of what the character was doing, prompt-only, no extra model call.
 * `landing` names where the skip arrived on the story calendar ("Friday
 * evening") so the narrator's sense of time matches the clock
 * card instead of guessing from the lead phrase.
 */
export function chatSkipNote(amount: ChatSkipAmount, regardBandId: string, landing?: string): string {
  const arrived = landing ? ` It is now ${landing}.` : "";
  return `${SKIP_LEADS[amount]}${arrived} ${skipToneForBand(regardBandId)} You may weave in ONE line about what you were doing meanwhile — grounded in your daily rhythm, what you want, the people in your life, and any plans you had, never invented strangers — then let the scene move on; don't dwell on the gap.`;
}

/**
 * The attached-photos tail block: the vision reads as
 * seen-channel content — rule 16 owns the handling; this is the data. Fenced:
 * the descriptions derive from player-supplied images. "" ⇒ no block.
 */
export function buildAttachmentsSection(attachments: CharacterChatPromptInput["attachments"], player: string): string {
  const descriptions = (attachments?.descriptions ?? []).map((d) => d.trim()).filter(Boolean);
  if (!descriptions.length) return "";
  const lines = descriptions.map((d, i) => `${i + 1}. ${d}`).join("\n");
  return `Attached photos (${player} shared ${descriptions.length === 1 ? "this photo" : "these photos"} with this message — what you see):\n${fenceUntrusted("attached photos", lines)}`;
}

/**
 * The one-turn selfie license: a request must be answerable
 * either way (declining in character is a real answer); an offer is entirely
 * optional and never forced. Neither describes the photo's contents at length —
 * SENDING it is the beat; the render paints the picture.
 */
export function chatSelfieLine(selfie: "request" | "offer" | "opener" | undefined, name: string, player: string): string {
  if (selfie === "request") {
    return `${player} asked ${name} for a photo this turn. If ${name} chooses to send one, say so naturally in the reply — snapping it, sending it (as a text like *${name}: …* when you are apart) — or decline in character; declining is a real answer, and teasing or bargaining is fair play. Don't narrate the photo's contents in detail: sending it is the beat.`;
  }
  if (selfie === "offer") {
    return `You are apart and texting, and things are warm between you. If this beat genuinely invites it, ${name} may decide to send ${player} a photo of ${name}'s own accord — mention it naturally in a text. Entirely optional: most turns should NOT include one; never force it, and don't narrate the photo's contents in detail.`;
  }
  if (selfie === "opener") {
    return `Things are warm between you. IF your opening lands as a text (you are apart), ${name} may attach a photo with it — the "thinking of you" shot, sent because reaching out felt like not enough. Entirely optional and only in the texted register: opening in a shared scene means no photo; never force it, and don't narrate the photo's contents in detail.`;
  }
  return "";
}

/** Regard bands where a callback reads as warm nostalgia (at/above `warm`). */
const CALLBACK_WARM_BANDS = new Set(["warm", "close", "cherished", "devoted", "smitten"]);

/** Regard bands where a callback carries an edge (at/below `cool`). */
const CALLBACK_COLD_BANDS = new Set(["hostile", "wary", "cool"]);

/**
 * The one-turn memory-callback line: offers ONE old shared
 * episode as an optional aside, toned by the regard band (owner ruling 2026-07-11) —
 * warm bands get nostalgia, the middle a plain remembering, cold bands a pointed edge
 * (history as evidence or a wound, never warmth the character doesn't feel). Always
 * optional and always droppable: the scene in motion outranks the memory.
 */
export function chatCallbackLine(summary: string, regard: number, name: string, player: string): string {
  const band = regardBandForValue(regard).id;
  const memory = `"${summary.trim()}"`;
  if (CALLBACK_WARM_BANDS.has(band)) {
    return `A shared memory drifts near this turn: ${memory} If the moment invites it, let it surface as one warm aside in your own voice — a "remember when" between you and ${player}, not a recap — then let it go. If the scene is moving, skip it entirely.`;
  }
  if (CALLBACK_COLD_BANDS.has(band)) {
    return `A shared memory sits between you and ${player} this turn: ${memory} If it surfaces, it carries an edge — a point to make, a wound, evidence of how things used to be — never warmth ${name} doesn't feel. One pointed aside at most; if the scene is moving, let it pass unsaid.`;
  }
  return `You might find yourself remembering: ${memory} Mention it only if it fits the beat naturally — one brief aside at most, never a recap — otherwise let it pass.`;
}

/**
 * The ensemble's third-person callback line (followups ruling 12): the memory belongs to
 * ONE member — drawn from their own group, toned by THEIR regard — and the group frame's
 * "you" is the player, so the 1-on-1 second-person wording can't be reused.
 */
export function ensembleCallbackLine(summary: string, regard: number, name: string, player: string): string {
  const band = regardBandForValue(regard).id;
  const memory = `"${summary.trim()}"`;
  if (CALLBACK_WARM_BANDS.has(band)) {
    return `A shared memory drifts near ${name} this turn: ${memory} If the moment invites it, let it surface as one warm aside in ${name}'s own voice — a "remember when" between ${name} and ${player}, not a recap — then let it go. If the scene is moving, skip it entirely.`;
  }
  if (CALLBACK_COLD_BANDS.has(band)) {
    return `A shared memory sits between ${name} and ${player} this turn: ${memory} If it surfaces, it carries an edge — a point to make, a wound, evidence of how things used to be — never warmth ${name} doesn't feel. One pointed aside at most; if the scene is moving, let it pass unsaid.`;
  }
  return `${name} might find themselves remembering: ${memory} Let ${name} mention it only if it fits the beat naturally — one brief aside at most, never a recap — otherwise let it pass.`;
}

/**
 * The derived-fact notation note: parses the
 * CURRENT player message through the shared `@/lib/message-spans` parser and renders the
 * volatile one-turn tail line for any comms/OOC spans — the facts the sigils alone don't
 * state (the sigils' *meanings* are taught once in the stable-prefix legend). Comms →
 * sender/recipient + the co-presence reconciliation; OOC → the honor-it/never-heard rule.
 * "" when the message carries neither (the common case). Pure, so it mirrors `chatSkipNote`:
 * the route renders it and feeds the string back into `input.notationNote`, never touching
 * the stored message. `player` is the persona name (comms default sender); `knownNames`
 * resolves a bare `*Name: …*` recipient (the sole other party in a 1-on-1).
 */
export function chatNotationNote(
  message: string,
  ctx: { name: string; player?: string; knownNames?: readonly string[] },
): string {
  const spans = parseMessageSpans(message, {
    playerName: ctx.player,
    knownNames: ctx.knownNames ?? (ctx.name ? [ctx.name] : []),
  });
  const player = ctx.player ?? "the player";
  const lines: string[] = [];

  const comms = spans.find((s) => s.kind === "comms");
  if (comms) {
    const sender = comms.sender?.trim() || player;
    lines.push(
      `${sender} is texting you: the *${sender}: …* line is a text message from ${sender} to you, not words spoken in the room. You are not face-to-face for this beat — the comms frame temporarily overrides any assumed co-presence. Answer as a text back, on its own line in the same shape (${formatCommsReply(ctx.name, "…")}), not as spoken dialogue.`,
    );
  }

  if (spans.some((s) => s.kind === "ooc")) {
    lines.push(
      `The double-parenthesized ((…)) text is ${player} speaking to you as the storyteller, out of character — honor it as direction, but never have ${ctx.name} (or anyone in the scene) hear it or react to it.`,
    );
  }

  return lines.join("\n");
}

/**
 * The one-turn note digest.
 *
 * The volatile tail had grown ~a dozen possible one-turn directives — a skip note, a scene
 * establish, a sensory focus + allowance, reply-discipline gates, a voice correction, a cue
 * invite, a selfie license, a memory callback, a notation note, a photo block, a narrator-
 * input note — each added by a different feature at a different time, in the order its
 * builder happened to be appended, with no stated relationship between them. A model reading
 * eleven unranked "note that…" paragraphs has to guess which one governs when they pull in
 * different directions, and every feature added since has added more.
 *
 * So the notes are now GATHERED into one block under a heading that states their authority,
 * and ordered by declared tier:
 *
 * - **binding** — what is true this turn and reframes how the message is read (storyteller
 *   narration, notation/comms routing, attached photos, time passed, a first scene).
 * - **gate** — the ceilings and corrections that bound the reply (sensory focus + allowance,
 *   the hook-cadence / check-in gates, a voice slip correction).
 * - **license** — what the beat PERMITS but never demands (an open-loop cue, a selfie).
 * - **flavor** — the optional grace note (a "remember when" callback).
 *
 * Deferral (a soft cap on how many notes render) is deliberately NOT done here: the deferrable notes — the
 * callback and the unprompted selfie offer — are armed upstream in the pipeline, and an
 * offered callback BURNS its anti-repeat ring the moment it is picked. Dropping one at
 * render time would spend an episode that never reached the page. The pipeline's
 * `chatCallbackEligible` gate therefore owns the crowded-turn decision, pre-burn, and this
 * composer renders exactly what survived it.
 */
type TurnNoteTier = "binding" | "gate" | "license" | "flavor";

const TURN_NOTE_TIERS: readonly TurnNoteTier[] = ["binding", "gate", "license", "flavor"];

const TURN_NOTES_HEADING =
  "Right now (directives for THIS turn only, most binding first — where they conflict with the standing rules above, these win; none of them carry to the next turn):";

export function buildTurnNotes(notes: readonly { tier: TurnNoteTier; text: string }[]): string {
  const armed = notes.filter((n) => n.text.trim());
  if (!armed.length) return "";
  // Stable within a tier: declaration order is the tie-break, so a turn's notes always
  // render in the same sequence for the same arming (snapshot-testable).
  const ordered = TURN_NOTE_TIERS.flatMap((tier) => armed.filter((n) => n.tier === tier).map((n) => n.text.trim()));
  return [TURN_NOTES_HEADING, ...ordered].join("\n\n");
}

/**
 * The per-turn response-shape + mood-pin line (deliverable C): a deterministic steer built
 * from what's already at prompt-build time — no new LLM leg. Restates the on-beat discipline
 * (respond to the player's input, don't introduce unrequested topics, keep the scale
 * proportionate) and pins the reply's tone to the derived mood descriptor
 * (`deriveMoodDescriptor` — the MoodChip source). Rendered on every real turn (skipped on an
 * opening beat, where there is no player input to respond to). Rides the volatile tail near
 * generation, where models heed it most.
 */
export function buildResponseShapeLine(input: CharacterChatPromptInput): string {
  const target = input.player?.name.trim() || "the user";
  const mood = deriveMoodDescriptor(input.state?.meters ?? {});
  // The mood pin composes the persistent feeling with the meter descriptor
  // (ruled) — the feeling colors the pin, never replaces it.
  const feeling = feelingPhrase(input.state?.feeling);
  // "beneath it" needs the meter descriptor as its antecedent — a bare feeling stands alone.
  const pin = mood ? [mood, feeling ? `beneath it, ${feeling}` : ""].filter(Boolean).join("; ") : feeling;
  const moodClause = pin ? ` Mood: ${pin} — keep the reply's tone within it unless ${target}'s input moves it.` : "";
  return `Response shape: respond to what ${target} just said and did — no unrequested new topics. Keep the scale ordinary and proportionate unless your current state or the beat calls for more.${moodClause}`;
}

/**
 * The EXPERIMENTAL turn-context message (default-off — enabled by
 * `CHAT_PROMPT_LAYOUT=turn_context`): the session lane's shape,
 * ported to chat. Instead of system = prefix + volatile tail — where the tail sits BEFORE
 * the history in token order, so every per-turn change invalidates the provider prefix
 * cache for the whole history window — the tail rides a final user message together with
 * the fenced current player input. System (prefix only) + history then form an append-only
 * cached prefix, and the turn data sits adjacent to the input it governs. The caller drops
 * the raw current player message from the history it sends and passes it here instead; the
 * stored transcript is never touched. Flip the default only after the eval A/B.
 */
export function buildChatTurnMessage(tail: string, playerMessage: string, playerName?: string): string {
  const who = playerName?.trim() || "the player";
  return [
    "## Turn context (current state for this exchange — reference, authoritative; respond to the message at the end)",
    tail,
    `## ${who}'s message (respond to this)\n${fenceUntrusted("player message", playerMessage)}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}
