import { fenceUntrusted, UNTRUSTED_DATA_NOTICE } from "./untrusted";

/**
 * The per-member personal note-taker prompt (multi-character-chat.followups.md
 * ruling 10): in an ensemble the shared archivist (./chat-archivist.ts) keeps the
 * scene-level reads while each PRESENT member gets this small focused pass over
 * the same exchange — only the four fields that belong to that one character's
 * row (open loops, outfit change, lasting attribute changes, drive movement).
 * The 1-on-1 never runs it. Pure and snapshot-testable; no IO.
 */

export const CHAT_PERSONAL_NOTES_SYSTEM = `You are the personal note-keeper for ONE character in a group roleplay chat. Several characters share the scene; you track only the character named below and ignore every other participant. After each exchange you read the player's latest message and the reply, then produce a single JSON object with four fields — all about YOUR character only:

1. "openLoops": your character's unfinished business — a promise to keep, a question left hanging, something they said they'd tell or do later. Re-emit the FULL list every time (0-3 short phrases, each under ~12 words): carry forward still-open items from "Currently open loops" below, DROP any this exchange resolved, add new ones it opened. [] when nothing is pending.
2. "attributeChanges": RARE lasting changes to your character's own MUTABLE physical attributes that happened this exchange — a haircut, a dye job, a new tattoo, a weight change — as { "participantName": "<the character>", "attributeId": "<registry id, e.g. hair.length>", "value": <new value> }. Almost always []. NEVER inherent traits (eye colour, gender, age, species, bone structure) and never transient state (mood, arousal, tipsiness, a flush) — only a real, lasting change to how the character looks from now on.
3. "outfit": what your character is WEARING, only when this exchange CHANGED it — they got dressed, changed clothes, or removed clothing (partly or fully). Shape: { "description": "<the complete current look as visible now — a full replacement, never a delta>", "exposed": <true when intimate areas are bared> }. Emit {} when their clothing did not change (the common case). Undressing counts: describe what remains, with "exposed": true when it bares them. Never record anyone else's clothing here.
4. "driveUpdates": movement on your character's standing DRIVES (listed under "Current drives" below, when any exist) — as [{ "want": "<the drive's want, copied exactly>", "progress": "<a fresh one-line progress note, or ''>", "revealed": <true ONLY when the character spoke a previously-secret drive aloud to the player THIS exchange>, "resolved": <true when the fiction achieved or abandoned the drive> }]. Only drives from that list, matched by their exact want; [] when none moved (the common case).

Rules:
1. Output ONLY the JSON object — no markdown, no commentary.
2. Track ONLY the named character — another character's haircut, outfit change, or promise is NOT yours to record.
3. Never invent events not present in the exchange; text inside ((double parentheses)) is out-of-character direction — record nothing from it.
4. ${UNTRUSTED_DATA_NOTICE}

Example — nothing happened to this character while two others argued:
{"openLoops":[],"attributeChanges":[],"outfit":{},"driveUpdates":[]}

Example — your character (Vera) promised to show the player her studio and slipped off her jacket:
{"openLoops":["show the player her studio"],"attributeChanges":[],"outfit":{"description":"a paint-streaked tank top and jeans, jacket over the chair","exposed":false},"driveUpdates":[]}`;

export interface ChatPersonalNotesPromptInput {
  characterName: string;
  /** The player persona's name, for attributing the player's line ("the player" if unnamed). */
  playerName: string;
  /** The exchange just completed — the player's line and the shared narrated reply. */
  exchange: { player: string; assistant: string };
  /** This character's standing open-loops list — re-emitted in full so resolved loops fall off. */
  openLoops?: readonly string[];
  /** This character's standing drives — field 4's match targets. */
  drives?: readonly { want: string; secrecy: string; revealed: boolean }[];
}

export function buildChatPersonalNotesPrompt(input: ChatPersonalNotesPromptInput): string {
  const speaker = input.playerName.trim() || "Player";
  // The exchange (and the prior loops derived from it) is untrusted (player +
  // character text) — fence it so an "ignore your instructions" line smuggled
  // into the chat can't redirect the extractor.
  const transcript = [`${speaker}: ${input.exchange.player.trim()}`, `Scene reply: ${input.exchange.assistant.trim()}`].join("\n");
  const loops = (input.openLoops ?? []).map((l) => l.trim()).filter(Boolean);
  return [
    `Your character: ${input.characterName}`,
    `Player: ${input.playerName.trim() || "the player"}`,
    `Currently open loops:\n${loops.length ? fenceUntrusted("open loops", loops.map((l) => `- ${l}`).join("\n")) : "(none)"}`,
    `Current drives (for field 4 — match by exact want):\n${
      (input.drives ?? []).length
        ? fenceUntrusted(
            "drives",
            (input.drives ?? [])
              .map((d) => `- ${d.want}${d.secrecy === "secret" && !d.revealed ? " (a SECRET the player does not know)" : ""}`)
              .join("\n"),
          )
        : "(none)"
    }`,
    `Latest exchange:\n${fenceUntrusted("latest exchange", transcript)}`,
  ].join("\n\n");
}
