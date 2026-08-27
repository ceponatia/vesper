import { MEANWHILE_MAX_DEVELOPMENTS, MEANWHILE_NOTE_MAX_CHARS } from "@/contracts";
import { fenceUntrusted } from "./untrusted";

/**
 * The meanwhile pass's prompt: ONE archivist-class
 * call over the whole ensemble at a qualifying time skip. The dossier is everything
 * the story already tracks — each member's rhythm, drives, whereabouts, the
 * relationship matrix, the supporting cast, and the open NPC↔NPC plans — fenced,
 * so proposals BUILD ON canon instead of contradicting it or minting strangers.
 */

export const CHAT_MEANWHILE_SYSTEM = [
  `You are the story's off-screen chronicler. Story time just skipped forward, and the cast kept living while the player was gone. Propose what happened OFF-SCREEN — small, concrete, believable developments in the characters' own lives.`,
  ``,
  `Reply with ONE JSON object: { "developments": [...], "whereabouts": [...], "note": "..." }.`,
  ``,
  `"developments": 1-${MEANWHILE_MAX_DEVELOPMENTS} entries, each { "about": ["<name>"] or ["<name>", "<name>"], "event": "<one concrete past-tense sentence>", "driveWant": "<exact want it progresses, if any>", "driveProgress": "<fresh progress note, when driveWant is set>", "castDetail": "<durable supporting-cast detail, if about includes one>", "planWhat": "<exact open plan it resolves, if any>", "planOutcome": "kept" | "missed" }. Omit unused optional fields.`,
  `- Ground every development in the dossier: a beat consistent with someone's daily rhythm ("closed the café alone Tuesday; the espresso machine died"), a step on a listed drive ("heard back about the commission"), a supporting-cast beat ("Mira started her new job"), two names = something they did TOGETHER (grounded in their listed relationship), or the outcome of a listed open plan.`,
  `- NEVER put the player in a development — this is what happened while the player was away, off-screen.`,
  `- Names must be copied exactly from the dossier. Never invent new people.`,
  `- A development may quietly progress a drive marked SECRET, but its "event" and the "note" must never state or expose the secret itself.`,
  `- Small and concrete beats life-changing drama. Match the size of the skipped time: a day is one small thing; several days can move something forward a real step.`,
  `- Nothing may contradict the dossier — it is established canon.`,
  ``,
  `"whereabouts": for each AWAY character, where they are right now as a short phrase, [{ "name": "<away name>", "where": "at her studio, finishing the commission" }]. [] when no one is away.`,
  ``,
  `"note": ONE compact line (max ${MEANWHILE_NOTE_MAX_CHARS} chars) summarizing the texture of what happened — the narrator sees only this line; the rest waits in memory. Never a list; never expose a secret.`,
].join("\n");

export interface ChatMeanwhilePromptInput {
  playerName: string;
  /** "Monday morning → Thursday evening (3 days)" — the gap on the story calendar. */
  gapLabel: string;
  /** One dossier block per roster member (pre-rendered lines). */
  members: readonly {
    name: string;
    presence: "present" | "away";
    whereabouts: string;
    rhythm: string;
    /** "want (open) — progress so far" lines; secrets marked SECRET. */
    drives: readonly string[];
  }[];
  /** "A ↔ B: kind — history" lines from the relationship matrix. */
  pairs: readonly string[];
  /** "Name (relation) — details; usually: whereabouts" lines. */
  cast: readonly string[];
  /** Open plans NOT involving the player whose time falls inside/behind the gap: "what — who — when". */
  openPlans: readonly string[];
}

/** The user message: the skip context + the fenced ensemble dossier. PURE. */
export function buildChatMeanwhilePrompt(input: ChatMeanwhilePromptInput): string {
  const memberBlocks = input.members.map((m) =>
    [
      `${m.name} (${m.presence}${m.whereabouts ? ` — last known: ${m.whereabouts}` : ""})`,
      m.rhythm ? `  rhythm: ${m.rhythm}` : "",
      ...m.drives.map((d) => `  drive: ${d}`),
    ]
      .filter(Boolean)
      .join("\n"),
  );
  const dossier = [
    `Cast:`,
    ...memberBlocks,
    input.pairs.length ? `Relationships between them:\n${input.pairs.map((p) => `- ${p}`).join("\n")}` : "",
    input.cast.length ? `Supporting cast (minor recurring people):\n${input.cast.map((c) => `- ${c}`).join("\n")}` : "",
    input.openPlans.length
      ? `Open plans among the cast (the player is NOT part of these — decide how each went if its time passed):\n${input.openPlans.map((p) => `- ${p}`).join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  return [
    `Story time skipped: ${input.gapLabel}. The player (${input.playerName}) was away; the cast kept living.`,
    fenceUntrusted("ensemble dossier", dossier),
    `Propose the off-screen developments now — JSON only.`,
  ].join("\n\n");
}
