import {
  bodySurfaceWetnessCauses,
  chatPrecipitationLevels,
  chatWindLevels,
  surfaceWetnessLocations,
  clothingCategoryIds,
  garmentCleanTargets,
  garmentConditionKeys,
  garmentDamageKinds,
  garmentDegreeBands,
  garmentDepositKinds,
  garmentDisplacementKinds,
  garmentTuckStates,
  garmentClosureIntents,
  garmentMoveTargets,
  type GarmentHandleTable,
} from "@/contracts";
import { channelHint } from "./notation";
import { fenceUntrusted, UNTRUSTED_DATA_NOTICE } from "./untrusted";

/**
 * The chat extraction **field library** (chat-agent-improvements.plan.md slice 1a) and
 * the specialist legs composed from it (slice 1b).
 *
 * The post-turn extractor grew from "summarize the exchange and file the facts" into one
 * agent juggling thirteen assignments, its instruction sheet pages long and its worked
 * examples quietly out of sync with its own field list. Meanwhile the ensemble's
 * per-member pass carried a near-verbatim COPY of four of those assignments — two
 * wordings of the same rule, guaranteed to drift.
 *
 * So extraction fields are now **data**, the way attributes / meters / conditions already
 * are (CLAUDE.md: registries are the extension points). One `ExtractorField` owns its
 * instruction line, the context block it needs in the user message, the extra rules it
 * implies, whether it is armed at all this exchange, and its empty value for examples.
 * A **leg** is just an ordered list of field keys; its system prompt — numbering, rules,
 * and JSON examples with every armed key present — is ASSEMBLED, never hand-written.
 * Consequences that fall out for free:
 *
 * - Adding a field (the roadmap's `plans` — chat-plans-promises.plan.md) is one module,
 *   not a fourteenth job threaded by hand through a monolith.
 * - The personal pass is literally "the same four modules, composed for one character",
 *   so the copy-paste is gone.
 * - Examples can never disagree with the field list again: they are RENDERED from it
 *   (an example that doesn't exercise a field shows that field's empty value).
 * - A 1-on-1 never sees the ensemble-only instructions (presence), and a character with
 *   no drives never sees the drive instructions — unarmed fields vanish from the sheet.
 *
 * Pure and snapshot-testable; no IO. The legs' resilience recipe lives in
 * `engine/chat-memory.ts`; the aggregate shape + the merge live in
 * `contracts/turns/chat-archivist.ts`.
 */

/** Every extractable field. The aggregate schema (`chatArchivistSchema`) owns their shapes. */
export type ChatExtractorFieldKey =
  | "episodeSummary"
  | "facts"
  | "memoryQueries"
  | "scene"
  | "environment"
  | "surfaceWetness"
  | "garmentOperations"
  | "outfit"
  | "playerOutfit"
  | "attributeChanges"
  | "presence"
  | "cast"
  | "openLoops"
  | "plans"
  | "driveUpdates"
  | "voiceExemplar"
  | "characterSlip"
  | "traitShifts";

/** Everything a field may render from — the union of every leg's inputs. */
export interface ChatExtractorContext {
  characterName: string;
  /** The player persona's name ("the player" if unnamed). */
  playerName: string;
  /** The exchange just completed — the player's line and the reply. */
  exchange: { player: string; assistant: string };
  /** The standing open-loops list — re-emitted in full so resolved loops fall off. */
  openLoops?: readonly string[];
  /** The standing drives — the driveUpdates match targets. */
  drives?: readonly { want: string; secrecy: string; revealed: boolean }[];
  /** The conversation's roster with live presence. Absent/single ⇒ the presence field never arms. */
  roster?: readonly { name: string; presence: "present" | "away" }[];
  /** The already-established supporting cast — new details attach by exact name. */
  supportingCast?: readonly { name: string; relation: string }[];
  /** The conversation's currently-open plans — the `plans` field's status-change targets. */
  openPlans?: readonly { what: string; who: string; when: string }[];
  /** The character's DEVELOPABLE traits at their current band — the traitShifts id list. */
  developableTraits?: readonly { id: string; label: string; band: string }[];
  /**
   * The exchange's in-scope garment/part HANDLES (clothing-state-graph slice 5).
   * Present and non-empty ⇒ the grounded `garmentOperations` field arms and the
   * free-text `outfit` / `playerOutfit` instructions are REPLACED by it; absent
   * (an unmodelled chat, the per-member personal pass) ⇒ the legacy grammar
   * stands and its bridge runs.
   */
  garmentHandles?: GarmentHandleTable;
  /** A compact voice reference — what "in-voice" and an age/voice slip sound like. */
  voiceReference?: {
    petPhrases?: readonly string[];
    cadence?: string;
    neverSays?: readonly string[];
    /** The binding life-stage register line (child/teen/elder), when the age maps to one. */
    registerRule?: string;
  };
  /**
   * The rolling summary's durable ledger (chat-agent-improvements open question D): the
   * memory scribe reads it so a pronoun-heavy beat ("she actually said yes!") files a fact
   * with a NAME in it instead of a dangling referent. Scribe-only — the other legs read the
   * exchange, which is all they judge. Absent on an early chat ⇒ no block.
   */
  priorSummary?: string;
  /**
   * True for an ensemble member's personal pass: several characters share the scene and
   * this leg tracks exactly one of them. Adds the ownership rule; the field instructions
   * already name their subject, so they need no personal/shared variants.
   */
  personal?: boolean;
}

/** One extraction field: its instruction, its context block, its rules, its empty value. */
interface ExtractorField {
  key: ChatExtractorFieldKey;
  /**
   * The numbered instruction line (the leg renders the number). References data blocks by
   * HEADING NAME, never by field number (docs/prompts.md §Style rules) — so reordering a
   * leg or arming a different field set can never leave a stale "see field 9" behind.
   */
  instruction: (ctx: ChatExtractorContext) => string;
  /** False ⇒ the field is absent from this exchange's sheet entirely (and defaults empty). */
  armed?: (ctx: ChatExtractorContext) => boolean;
  /** The user-message block this field needs (deduped across the leg). "" ⇒ none. */
  context?: (ctx: ChatExtractorContext) => string;
  /** Extra system-prompt rules this field implies, appended after the shared rules. */
  rules?: (ctx: ChatExtractorContext) => readonly string[];
  /** The value this key shows in a rendered example that does not exercise it. */
  empty: unknown;
}

/* ------------------------------------------------------------------------- *
 * The grounded wardrobe lane (clothing-state-graph.plan.md slice 5).
 * ------------------------------------------------------------------------- */

/**
 * True when this exchange has real garment handles to address. The ONE switch:
 * it arms `garmentOperations` and disarms the free-text `outfit` /
 * `playerOutfit` instructions, so the sheet never carries two ways to move the
 * same wardrobe (and `garmentMutationLane` never has two paths to choose from).
 */
function garmentLaneArmed(ctx: ChatExtractorContext): boolean {
  return (ctx.garmentHandles?.entries.length ?? 0) > 0;
}

/** Vocabulary lists rendered from the registries, so a contract edit can never drift from the sheet. */
const alt = (values: readonly string[]): string => values.join(" | ");

/**
 * The handle block. Garment handles are opaque and quoted verbatim; the parts
 * under each are that garment's own addressable part ids (a part handle is
 * `<garment>.<part>`, and the bare id under its garment is accepted too).
 * FENCED: the garment NAMES are author-written library text.
 */
function garmentHandleBlock(ctx: ChatExtractorContext): string {
  const table = ctx.garmentHandles;
  if (!table || table.entries.length === 0) return "";
  const lines = table.entries.map(
    (entry) => `${entry.handle} — ${entry.name}, ${entry.where}; parts: ${entry.partHandles.join(" ")}`,
  );
  const actors = table.actors.map((actor) => `${actor.handle} = ${actor.label}`).join(", ");
  return [
    `Garments in scene (copy these handles EXACTLY; nothing else is addressable${
      table.trimmed ? "; longer lists are trimmed to what is most in view" : ""
    }):`,
    fenceUntrusted("garment handles", lines.join("\n")),
    `Actor handles: ${actors}`,
  ].join("\n");
}

/* ------------------------------------------------------------------------- *
 * The fields.
 * ------------------------------------------------------------------------- */

const FIELDS: Record<ChatExtractorFieldKey, ExtractorField> = {
  episodeSummary: {
    key: "episodeSummary",
    empty: "",
    instruction: () =>
      `"episodeSummary": 1-3 sentences, past tense, third person, capturing WHAT HAPPENED this exchange (the beat, not a stat dump). Empty string if nothing memorable happened (idle small talk).`,
  },

  facts: {
    key: "facts",
    empty: [],
    instruction: () =>
      `"facts": durable declarative knowledge worth recalling much later — relationship shifts, revealed preferences, promises, disclosed history, named people/places. One sentence each; "subjectName" exactly as written (usually the character or the player); "subjectKind" one of character|player|location|item|world; "confidence" 0-1; "channel" one of perceived|private (see the channel rule below). Prefer a few strong facts to many weak ones; 0-3 per exchange is typical, [] is fine. Never record transient physical state (mood, arousal, tipsiness) as a fact — that is tracked elsewhere. Write each fact so it stands alone years later: name the person instead of leaning on a pronoun the exchange happened to use.`,
    rules: (ctx) => [
      `Tag each fact with the CHANNEL it was established through: "perceived" when it comes from the player's quoted speech or a visible action/expression the character could see or hear; "private" when it is drawn ONLY from the player's unspoken inner thoughts (something ${ctx.characterName} never perceived). Default to "perceived" when unsure. Text inside ((double parentheses)) is out-of-character direction to you — record NO facts from it at all.`,
      `Quoted or hypothetical speech may yield facts about what was SAID (a promise, a stated preference), never about physical events that did not occur.`,
    ],
    // The recap ledger grounds names (open question D). Fenced — it is folded player +
    // character text, like every other transcript-derived block.
    context: (ctx) => {
      const prior = ctx.priorSummary?.trim();
      if (!prior) return "";
      return `The story so far (context for naming people and things — NEVER extract facts from this; it is already remembered. Use it only to resolve who a pronoun refers to):\n${fenceUntrusted("story so far", prior)}`;
    },
  },

  memoryQueries: {
    key: "memoryQueries",
    empty: [],
    instruction: () =>
      `"memoryQueries": 0-3 short search phrases naming what the NEXT turn may need to recall (a person, a promise, a topic just raised). [] when nothing specific is pending.`,
  },

  scene: {
    key: "scene",
    empty: {},
    instruction: () =>
      `"scene": the setting the narration established or CHANGED this exchange — chat locations are imagined by the narrator, so this keeps them consistent. Omit it entirely (or {}) unless the fiction actually established something new. Shape: { "current": "<the place the scene is in now, if it was named/changed>", "places": [{ "name": "<place>", "details": ["<durable fact, e.g. 'blue sofa'>"], "connections": ["<e.g. 'kitchen through the doorway'>"] }] }. ONLY record what the text actually established — a concrete object or layout — never invent decor, and never record the time of day (the story clock owns time). Short noun phrases, a few at most. Physical STATE (weather changing, a door opening) is not a durable detail.`,
  },

  environment: {
    key: "environment",
    empty: {},
    instruction: () =>
      [
        `"environment": the scene's WEATHER and whether it is under cover, only when this exchange ESTABLISHED or CHANGED it. {} when nothing about the conditions moved (the common case) — an omitted key means "unchanged", never "back to normal".`,
        `   Shape: { "wind": "${alt(chatWindLevels)}", "precipitation": "${alt(chatPrecipitationLevels)}", "indoors": <true when they are under cover — inside a building, a car, a tent; false out in the open> }. Send only the keys the fiction actually settled.`,
        `   Only what the text established — never infer weather from a season, a mood, or a place name, and never carry a remembered forecast forward. Weather belongs HERE and never in "scene", which records durable places and fixtures.`,
      ].join("\n"),
  },

  surfaceWetness: {
    key: "surfaceWetness",
    empty: [],
    instruction: (ctx) =>
      [
        `"surfaceWetness": how much wetter or drier ${ctx.characterName}'s ${alt(surfaceWetnessLocations)} got THIS exchange — rain on it, a shower, a dunking, a towel, an hour by the fire. [] when it did not move (the overwhelming common case).`,
        `   Shape: [{ "location": "${alt(surfaceWetnessLocations)}", "direction": "increase" | "decrease", "degree": 1 | 2 | 3, "cause": "${alt(bodySurfaceWetnessCauses)}" }]. Degree is how far it moved this exchange: 1 slightly, 2 clearly, 3 completely (soaked through, or dried right out). "cause" is only for an increase — what wet it.`,
        `   Only ${ctx.characterName}'s own body; never ${ctx.playerName}'s, and never clothing (wet clothes belong in the wardrobe fields). Only a change the fiction actually played — hair does not need re-reporting for staying damp, and it dries on its own between exchanges.`,
      ].join("\n"),
  },

  garmentOperations: {
    key: "garmentOperations",
    empty: [],
    // Armed only when there are real handles to address; when it arms it REPLACES
    // the free-text outfit fields below (clothing-state-graph slice 5).
    armed: garmentLaneArmed,
    context: garmentHandleBlock,
    instruction: () =>
      [
        `"garmentOperations": what the fiction DID to clothing this exchange, as typed operations on the handles in the "Garments in scene" block. [] when clothing was untouched (the common case). Copy handles verbatim — never invent one, never use a garment's name as a handle, never report clothing that only stayed the same.`,
        `   Every entry is { "op": …, "garment": "<garment handle>", … }. "part" is one part handle from that garment's list; "parts" is a list, and [] there means the WHOLE garment. Degrees are ${alt(garmentDegreeBands)}.`,
        `   • move — it changed place: { "op":"move", "garment":H, "to":"${alt(garmentMoveTargets)}", "wearer":"<actor handle, only when it goes onto someone else>", "anchor":"<'over the desk chair', only with left_here>" }`,
        `   • closure — buttons/zip/clasp: { "op":"closure", "garment":H, "part":P, "state":"${alt(garmentClosureIntents)}", "openFasteners":<how many are undone, optional> }`,
        `   • roll — a sleeve or cuff pushed up: { "op":"roll", "garment":H, "part":P, "degree":D }`,
        `   • tuck — a hem tucked in or out: { "op":"tuck", "garment":H, "part":P, "state":"${alt(garmentTuckStates)}" }`,
        `   • displace — a strap off a shoulder, a hem lifted: { "op":"displace", "garment":H, "part":P, "displacement":"${alt(garmentDisplacementKinds)}", "degree":D }`,
        `   • restore — an arrangement put back (unrolled, untucked, straightened): { "op":"restore", "garment":H, "parts":[P, …] }`,
        `   • condition — the material state moved: { "op":"condition", "garment":H, "parts":[…], "channel":"${alt(garmentConditionKeys)}", "direction":"increase" | "decrease", "degree":D }`,
        `   • deposit — something landed on it: { "op":"deposit", "garment":H, "parts":[…], "substance":"${alt(garmentDepositKinds)}", "degree":D }`,
        `   • clean — wiped, sponged, washed: { "op":"clean", "garment":H, "parts":[…], "target":"${alt(garmentCleanTargets)}" }`,
        `   • damage — it tore, burned, scuffed: { "op":"damage", "garment":H, "part":P, "damage":"${alt(garmentDamageKinds)}", "degree":D }`,
        `   • introduce — ONLY for a garment genuinely new to the fiction that no handle covers (a borrowed hoodie, a coat off a hook): { "op":"introduce", "handle":"<a new handle you coin, same shape as the others>", "name":"<short garment name>", "category":"<${alt(clothingCategoryIds)}>", "material":"<wool, denim, cotton… optional>", "wearer":"<actor handle>", "at":"worn" | "held" | "here" }. Pick the plainest category that fits; never introduce something the handle block already lists.`,
      ].join("\n"),
  },

  outfit: {
    key: "outfit",
    empty: {},
    // Demoted to the legacy bridge: it only appears when there are no handles.
    armed: (ctx) => !garmentLaneArmed(ctx),
    instruction: (ctx) =>
      [
        `"outfit": what ${ctx.characterName} is WEARING, only when this exchange CHANGED it. Two ways to say it — pick whichever fits, or {} when nothing changed (the common case). Never record anyone else's clothing here.`,
        `   • WHOLE change (dressed for the day, changed outfits): "description" = the complete current look as a FULL replacement (never a delta), naming their outfit if it matches one ("her work clothes", "her date-night dress"); "exposed": true when intimate areas are bared.`,
        `   • SINGLE-garment change (a piece comes off or goes on mid-scene): "removed": ["<the garment taken off, e.g. 'her jacket'>"] and/or "added": ["<the garment put on>"] — short garment phrases, one per piece. Use this for "she slips off her jacket" / "he pulls on a hoodie" rather than restating the whole look.`,
        `   Shape: { "description": "...", "exposed": <bool>, "removed": [...], "added": [...] }. Undressing counts: either describe what remains via "description" (with "exposed": true when it bares them) or list the pieces in "removed".`,
      ].join("\n"),
  },

  playerOutfit: {
    key: "playerOutfit",
    empty: {},
    // Same demotion as `outfit`: the grounded lane addresses the player's garments
    // through the same handle table, so two grammars never ship together.
    armed: (ctx) => !garmentLaneArmed(ctx),
    instruction: (ctx) =>
      [
        `"playerOutfit": the same, but for what ${ctx.playerName} — the PLAYER — is wearing, only when this exchange CHANGED it. {} when nothing changed (the common case).`,
        `   It does not matter WHO did it: ${ctx.playerName} taking their own shirt off and ${ctx.characterName} pulling it over their head are the same change, and both belong here. Record it whether the player wrote it or ${ctx.characterName} did.`,
        `   • WHOLE change: "description" = the player's complete current look as a FULL replacement (never a delta).`,
        `   • SINGLE-garment change: "removed": ["<the garment taken off, e.g. 'your shirt'>"] and/or "added": ["<the garment put on>"] — short garment phrases, one per piece. Prefer this for a piece coming off mid-scene.`,
        `   Shape: { "description": "...", "removed": [...], "added": [...] }. There is no "exposed" here — the player's exposure is worked out from what they have on.`,
        `   Only ${ctx.playerName}'s OWN clothing. ${ctx.characterName}'s goes in "outfit" above.`,
      ].join("\n"),
  },

  attributeChanges: {
    key: "attributeChanges",
    empty: [],
    instruction: (ctx) =>
      `"attributeChanges": RARE lasting changes to ${ctx.characterName}'s own MUTABLE physical attributes that happened this exchange — a haircut, a dye job, a new tattoo, a weight change — as { "participantName": "${ctx.characterName}", "attributeId": "<registry id, e.g. hair.length>", "value": <new value> }. Almost always []. NEVER inherent traits (eye colour, gender, age, species, bone structure) and never transient state (mood, arousal, tipsiness, a flush) — only a real, lasting change to how they look from now on.`,
  },

  presence: {
    key: "presence",
    empty: [],
    // Ensemble-only: a 1-on-1 sheet never carries the instruction at all.
    armed: (ctx) => (ctx.roster?.length ?? 0) > 1,
    instruction: () =>
      `"presence": the roster characters (see the "Roster" line) whose scene-presence the fiction actually CHANGED this exchange, as [{ "name": "<roster name, copied exactly>", "presence": "present" | "away", "where": "<on 'away' only, and only when the fiction said where they went — a short phrase like 'to her shift at the café'; omit otherwise>" }]. "present" = they entered or are now sharing the player's scene; "away" = they left it / are elsewhere living their life. Only real transitions played on the page — never infer one from silence; [] is the common case.`,
    context: (ctx) =>
      `Roster (match names exactly): ${(ctx.roster ?? []).map((m) => `${m.name} (${m.presence})`).join(", ")}`,
  },

  cast: {
    key: "cast",
    empty: [],
    instruction: (ctx) => {
      const known = (ctx.supportingCast ?? []).length
        ? ` The "Supporting cast so far" list names who is already known — attach new details to those by exact name, and give "relation" only for people not yet on that list (a known entry's relation is already recorded).`
        : "";
      return `"cast": recurring NAMED side characters this exchange introduced or established something durable about — people in the story who are NOT ${ctx.characterName}, not another roster character, and NOT the player (a named friend, coworker, relative, a named regular). Shape: [{ "name": "<their name>", "relation": "<who they are to the story, e.g. 'the player's coworker and close friend' — only when the exchange established it, else ''>", "details": ["<durable fact, e.g. 'training for a marathon'>"] }].${known} Only people the fiction NAMED and treats as recurring — never one-scene walk-ons (a waiter, a passing voice), never the main characters or the player, and never invent anyone. [] is the common case.`;
    },
    context: (ctx) =>
      (ctx.supportingCast ?? []).length
        ? `Supporting cast so far (attach details by exact name):\n${fenceUntrusted(
            "supporting cast",
            (ctx.supportingCast ?? []).map((m) => `- ${m.name}${m.relation ? ` — ${m.relation}` : ""}`).join("\n"),
          )}`
        : "",
  },

  openLoops: {
    key: "openLoops",
    empty: [],
    instruction: (ctx) =>
      `"openLoops": ${ctx.characterName}'s unfinished business — a promise to keep, a question left hanging, something they said they'd tell or do later. Re-emit the FULL list every time (0-3 short phrases, each under ~12 words): carry forward still-open items from the "Currently open loops" block, DROP any this exchange resolved, add new ones it opened. [] when nothing is pending.`,
    context: (ctx) => {
      const loops = (ctx.openLoops ?? []).map((l) => l.trim()).filter(Boolean);
      return `Currently open loops:\n${loops.length ? fenceUntrusted("open loops", loops.map((l) => `- ${l}`).join("\n")) : "(none)"}`;
    },
  },

  plans: {
    key: "plans",
    empty: [],
    instruction: (ctx) => {
      const known = (ctx.openPlans ?? []).length
        ? ` The "Plans so far" list shows what is already tracked — to record that one HAPPENED or was CALLED OFF, copy its "what" and set "status" ("kept" / "canceled"); do not re-strike a plan already listed.`
        : "";
      return `"plans": commitments the fiction STRUCK, CHANGED, or resolved this exchange — a concrete plan with WHO and roughly WHEN ("come over Friday", "dinner at the pier tonight", "I'll call after my shift"). Shape: [{ "what": "<the plan, short>", "participants": ["<name — ${ctx.playerName}, ${ctx.characterName}, another roster character, or a named side character>"], "where": "<place, or ''>", "when": { "dayOffset": <0 = today, 1 = tomorrow, 2 = in two days, …>, "dayPart": "morning" | "afternoon" | "evening" | "night", "unscheduled": <true for "soon"/"sometime" with no set time> }, "status": "kept" | "canceled" (omit for a new/ongoing plan) }].${known} A concrete commitment (who + roughly when) belongs HERE, not in "openLoops" — never file the same beat as both. Only real commitments the fiction actually made; NEVER mark a plan "missed" (the system decides that from the clock). [] is the common no-new-commitment case.`;
    },
    context: (ctx) =>
      (ctx.openPlans ?? []).length
        ? `Plans so far (copy "what" exactly to mark kept/canceled):\n${fenceUntrusted(
            "plans",
            (ctx.openPlans ?? [])
              .map((p) => `- ${p.what}${p.who ? ` (${p.who})` : ""}${p.when ? ` — ${p.when}` : ""}`)
              .join("\n"),
          )}`
        : "",
  },

  driveUpdates: {
    key: "driveUpdates",
    empty: [],
    // Only a character with authored drives can move one.
    armed: (ctx) => (ctx.drives?.length ?? 0) > 0,
    instruction: (ctx) =>
      `"driveUpdates": movement on ${ctx.characterName}'s standing DRIVES (the "Current drives" block) — as [{ "want": "<the drive's want, copied exactly>", "progress": "<a fresh one-line progress note, or ''>", "revealed": <true ONLY when they spoke a previously-secret drive aloud to the player THIS exchange>, "resolved": <true when the fiction achieved or abandoned the drive> }]. Only drives from that list, matched by their exact want; [] when none moved (the common case).`,
    context: (ctx) =>
      `Current drives (match by exact want):\n${fenceUntrusted(
        "drives",
        (ctx.drives ?? [])
          .map((d) => `- ${d.want}${d.secrecy === "secret" && !d.revealed ? " (a SECRET the player does not know)" : ""}`)
          .join("\n"),
      )}`,
  },

  voiceExemplar: {
    key: "voiceExemplar",
    empty: "",
    instruction: (ctx) =>
      `"voiceExemplar": ONE short line from ${ctx.characterName}'s reply this exchange that is DISTINCTLY in their voice — a line that captures how they actually talk (their diction, rhythm, a pet phrase, a characteristic deflection or tease), copied VERBATIM from the reply. Pick at most one, and only when a line genuinely stands out as in-voice; "" when nothing this exchange was distinctly characterful (the common case). Never the player's words, never a paraphrase, never invented.`,
  },

  characterSlip: {
    key: "characterSlip",
    empty: "",
    instruction: (ctx) => {
      const ref = ctx.voiceReference ? ` (the "Character voice reference" block says what in-voice sounds like)` : "";
      return `"characterSlip": a SHORT corrective note ONLY when the reply broke character this exchange — it sounded out of voice, out of disposition, or wrong for their age/life-stage${ref}: e.g. "spoke like a composed adult, not a 15-year-old — loosen the diction" or "far warmer than her guarded, cool manner — pull it back". "" when the reply held character (the overwhelming default). One clause naming what slipped and the fix — not praise, not a general note.`;
    },
  },

  traitShifts: {
    key: "traitShifts",
    empty: [],
    // Only a character with developable traits can shift one.
    armed: (ctx) => (ctx.developableTraits?.length ?? 0) > 0,
    instruction: () =>
      `"traitShifts": RARE, direction-only nudges to the character's DEVELOPABLE traits (the "Developable traits" block) that MEANINGFULLY and DURABLY shifted this exchange — as [{ "trait": "<id from that list>", "direction": "up" | "down" }]. Only a real arc beat moves one (she genuinely let her guard down, hardened, grew bolder); [] is the norm. Never a fleeting mood, never a trait not on the list.`,
    context: (ctx) =>
      `Developable traits (use these exact ids):\n${(ctx.developableTraits ?? []).map((t) => `- ${t.id} (currently ${t.band})`).join("\n")}`,
  },
};

/**
 * The voice reference block (shared by voiceExemplar + characterSlip, so it hangs off the
 * leg rather than a single field — two fields needing one block is exactly the case a
 * per-field `context` can't dedupe by itself).
 */
function voiceReferenceBlock(ctx: ChatExtractorContext): string {
  const ref = ctx.voiceReference;
  if (!ref) return "";
  const lines = [
    ref.petPhrases?.length ? `- Pet phrases: ${ref.petPhrases.join("; ")}` : "",
    ref.cadence?.trim() ? `- Cadence: ${ref.cadence.trim()}` : "",
    ref.neverSays?.length ? `- Never says: ${ref.neverSays.join("; ")}` : "",
    ref.registerRule?.trim() ? `- Age/register: ${ref.registerRule.trim()}` : "",
  ].filter(Boolean);
  if (!lines.length) return "";
  // Author-written (pet phrases / cadence / never-says) — fenced so a smuggled
  // instruction reads as reference, not authority. The register line is framework text.
  return `Character voice reference (what in-voice sounds like):\n${fenceUntrusted("voice reference", lines.join("\n"))}`;
}

/* ------------------------------------------------------------------------- *
 * The example bank. An example declares only the fields it exercises; the leg
 * renders it with every armed key present (unexercised keys take their empty
 * value), so a leg's examples can never drift out of sync with its field list.
 * ------------------------------------------------------------------------- */

interface ExtractorExample {
  caption: string;
  values: Partial<Record<ChatExtractorFieldKey, unknown>>;
}

/**
 * Worked examples per leg (the generated empty-output example rides on top of
 * these). Raised from 5 to 6 with the environment/surface fields
 * (body-attribute-affordances slice 4): the continuity leg gained two
 * assignments, and at 5 the new weather example would have evicted the
 * supporting-cast one. The other two legs have exactly 5 relevant examples each,
 * so the bump changes only the sheet that grew.
 */
const EXAMPLES_PER_LEG = 6;

const EXAMPLES: readonly ExtractorExample[] = [
  {
    caption: "the player tells the character their sister is getting married in Prague",
    values: {
      episodeSummary:
        "Mara asked about the player's weekend; they shared that their sister is getting married in Prague this spring and they're nervous about the toast.",
      facts: [
        {
          kind: "knowledge",
          subjectName: "the player",
          subjectKind: "player",
          text: "The player's sister is getting married in Prague this spring.",
          tags: ["family", "wedding"],
          confidence: 0.9,
          channel: "perceived",
        },
      ],
      memoryQueries: ["the player's sister's wedding in Prague", "the toast the player is nervous about"],
      openLoops: ["hear how the wedding toast goes"],
      voiceExemplar: "Prague in spring — of course it is. Please tell me you've practiced that toast on someone.",
    },
  },
  {
    caption: "the player privately thinks they're falling for the character but only says goodnight aloud",
    values: {
      episodeSummary: "They said an easy goodnight after a long, warm evening of talk.",
      facts: [
        {
          kind: "relationship",
          subjectName: "the player",
          subjectKind: "player",
          text: "The player is quietly starting to fall for Mara.",
          tags: ["attraction"],
          confidence: 0.7,
          channel: "private",
        },
      ],
    },
  },
  {
    caption: "they move to the kitchen and the narration establishes it (blue-tiled counter, a doorway back to the living room)",
    values: {
      episodeSummary: "Mara led the player into the kitchen to make tea, the evening settling in around them.",
      scene: {
        current: "kitchen",
        places: [
          {
            name: "kitchen",
            details: ["blue-tiled counter", "kettle on the stove"],
            connections: ["living room back through the doorway"],
          },
        ],
      },
    },
  },
  {
    caption: "the sky opens on them crossing the car park and they duck inside soaked",
    values: {
      episodeSummary:
        "The rain came down hard halfway across the car park; they got inside laughing, Mara's hair plastered flat to her head.",
      environment: { wind: "windy", precipitation: "downpour", indoors: true },
      surfaceWetness: [{ location: "hair", direction: "increase", degree: 3, cause: "rain" }],
    },
  },
  {
    caption: "the character has her long hair cut to a bob during the scene",
    values: {
      episodeSummary:
        "Mara let the player talk her into the salon chair and had her long hair cut to a sharp chin-length bob; she kept checking her reflection afterward, half thrilled and half unsure.",
      memoryQueries: ["Mara's new haircut"],
      attributeChanges: [{ participantName: "Mara", attributeId: "hair.length", value: "chin-length bob" }],
    },
  },
  {
    caption: "the character changes for dinner during the exchange (whole-outfit swap)",
    values: {
      episodeSummary:
        "Mara disappeared into the bedroom and came back dressed for the dinner reservation, fishing for a verdict she pretended not to want.",
      memoryQueries: ["the dinner reservation"],
      outfit: { description: "a black wrap dress and low heels, hair pinned up", exposed: false },
    },
  },
  {
    caption: "the character takes a single piece off mid-scene (garment-level delta, not a whole swap)",
    values: {
      episodeSummary: "The apartment was warm, so Mara shrugged out of her cardigan and draped it over the chair, still mid-story.",
      outfit: { removed: ["her cardigan"] },
    },
  },
  {
    caption:
      "she shrugs out of her cardigan onto the chair and pushes her shirtsleeves up (grounded handles, not garment names)",
    values: {
      episodeSummary:
        "The apartment was warm, so Mara shrugged out of her cardigan, draped it over the chair and pushed her sleeves up, still mid-story.",
      garmentOperations: [
        { op: "move", garment: "mara.cardigan", to: "left_here", anchor: "over the back of the chair" },
        { op: "roll", garment: "mara.shirt", part: "sleeve_left", degree: "substantial" },
        { op: "roll", garment: "mara.shirt", part: "sleeve_right", degree: "substantial" },
      ],
    },
  },
  {
    caption: "they get caught in the rain, and she pulls on a hoodie that was hanging by the door (a NEW garment)",
    values: {
      episodeSummary:
        "They came in soaked from the downpour; Mara pulled a hoodie off the hook by the door and handed the player a towel.",
      // Deliberately garment-ONLY, even though this beat also soaked her hair: the
      // weather/surface example above already teaches those two fields, and adding
      // them here would make this example relevant to the legacy wardrobe lane too,
      // evicting the supporting-cast example from that sheet's six.
      garmentOperations: [
        { op: "condition", garment: "mara.shirt", parts: [], channel: "wetness", direction: "increase", degree: "substantial" },
        {
          op: "introduce",
          handle: "mara.hoodie",
          name: "an oversized grey hoodie",
          category: "outerwear",
          material: "knit",
          wearer: "mara",
          at: "worn",
        },
      ],
    },
  },
  {
    caption: "the player mentions their coworker Abby (a recurring friend) for the first time",
    values: {
      episodeSummary: "The player vented about a rough shift and mentioned their coworker Abby covering for them; Mara asked what Abby is like.",
      facts: [
        {
          kind: "knowledge",
          subjectName: "Abby",
          subjectKind: "character",
          text: "Abby is the player's coworker and covered the player's shift.",
          tags: ["friends", "work"],
          confidence: 0.85,
          channel: "perceived",
        },
      ],
      memoryQueries: ["Abby the player's coworker"],
      cast: [{ name: "Abby", relation: "the player's coworker and friend", details: ["covered the player's shift this week"] }],
    },
  },
  {
    caption: "they make a plan — dinner at the pier tomorrow evening (a concrete commitment, not a fuzzy loop)",
    values: {
      episodeSummary: "Mara talked the player into dinner at the pier tomorrow evening — her treat, she insisted, already deciding what to wear.",
      plans: [
        {
          what: "dinner at the pier",
          participants: ["Mara", "the player"],
          where: "the pier",
          when: { dayOffset: 1, dayPart: "evening" },
        },
      ],
      voiceExemplar: "The pier. Tomorrow. Wear something you don't mind the wind in — and no, you don't get a say in the wine.",
    },
  },
  {
    caption: "the plan they made for tonight actually happened — mark it kept",
    values: {
      episodeSummary: "Mara finally got her pier dinner; they split the wine and stayed until the lights came on.",
      plans: [{ what: "dinner at the pier", participants: ["Mara", "the player"], status: "kept" }],
    },
  },
  {
    caption:
      "the character finally admits the thing she has been circling for weeks — a secret drive spoken aloud (and the arc beat that goes with it)",
    values: {
      episodeSummary:
        "Mara admitted she has been quietly applying to conservatories — the first person she has told — and braced for the player to laugh.",
      driveUpdates: [
        { want: "get into the conservatory without anyone knowing she tried", progress: "told the player she has been applying", revealed: true, resolved: false },
      ],
      traitShifts: [{ trait: "social.guardedness", direction: "down" }],
      voiceExemplar: "Don't— don't make it a thing. I just wanted one person to know before I lose my nerve.",
    },
  },
  {
    caption: "the reply drifted out of character (a guarded, dry woman suddenly gushing) — name the slip and the fix",
    values: {
      episodeSummary: "Mara walked the player through her week; the talk stayed easy and light.",
      characterSlip: "gushed and over-explained — far warmer and chattier than her dry, guarded manner; pull it back to short, wry answers",
    },
  },
];

/**
 * The empty-output example, RENDERED per leg (never hand-written): every sheet closes by
 * showing exactly what "nothing this leg tracks moved" looks like — the single most common
 * output, and the one the old hand-written examples never showed for most fields.
 */
function emptyExampleFor(fields: readonly ExtractorField[], ctx: ChatExtractorContext, personal: boolean): string {
  const caption = personal
    ? `nothing happened to ${ctx.characterName} this exchange while the others carried the scene (the common case)`
    : "an ordinary exchange where nothing you track changed (the common case)";
  const obj: Record<string, unknown> = {};
  for (const field of fields) {
    // The summary is the one field that still fires on an otherwise-empty exchange.
    obj[field.key] =
      field.key === "episodeSummary" ? "They traded jokes about the weather while Mara finished her coffee." : field.empty;
  }
  return `Example — ${caption}:\n${JSON.stringify(obj)}`;
}

/* ------------------------------------------------------------------------- *
 * The legs.
 * ------------------------------------------------------------------------- */

export type ChatExtractorLegId = "memory" | "continuity" | "character" | "personal";

interface ExtractorLeg {
  id: ChatExtractorLegId;
  /** The role sentence that opens the system prompt. */
  role: (ctx: ChatExtractorContext) => string;
  /** The fields this leg extracts, in sheet order. */
  fields: readonly ChatExtractorFieldKey[];
  /** Leg-level context blocks (beyond the fields' own). */
  blocks?: readonly ((ctx: ChatExtractorContext) => string)[];
  /** Leg-level rules appended after the shared + field rules. */
  rules?: (ctx: ChatExtractorContext) => readonly string[];
}

const LEGS: Record<ChatExtractorLegId, ExtractorLeg> = {
  // The memory scribe: the long-term-memory half — the most valuable and the most
  // attention-hungry, which is precisely why it no longer shares a sheet with twelve
  // other assignments.
  memory: {
    id: "memory",
    role: () =>
      "You are the memory-keeper for a private in-character chat. After each exchange you read the player's latest message and the reply, then condense what happened into long-term memory.",
    fields: ["episodeSummary", "facts", "memoryQueries"],
  },

  // The continuity tracker: the state of the world the fiction just moved.
  continuity: {
    id: "continuity",
    role: (ctx) =>
      `You are the continuity tracker for a private in-character chat. After each exchange you read the player's latest message and the reply, then record what the fiction CHANGED about the world — where they are, what ${ctx.characterName} and ${ctx.playerName} are wearing, how they look, who is in the scene. You track changes only: an unchanged world produces empty fields, which is the common case.`,
    // `garmentOperations` and the `outfit`/`playerOutfit` pair are mutually
    // exclusive by arming (clothing-state-graph slice 5) — the leg lists all three
    // and exactly one grammar is ever rendered.
    fields: [
      "scene",
      "environment",
      "surfaceWetness",
      "garmentOperations",
      "outfit",
      "playerOutfit",
      "attributeChanges",
      "presence",
      "cast",
    ],
  },

  // The character tracker: the character's own thread through the exchange.
  character: {
    id: "character",
    role: (ctx) =>
      `You are the character-continuity keeper for ${ctx.characterName} in a private in-character chat. After each exchange you read the player's latest message and ${ctx.characterName}'s reply, then track ${ctx.characterName}'s own thread through it: what they still owe the story, the commitments they make, what they want, how they sounded, and whether they held character.`,
    fields: ["openLoops", "plans", "driveUpdates", "voiceExemplar", "characterSlip", "traitShifts"],
    blocks: [voiceReferenceBlock],
  },

  // The ensemble's per-member pass: the SAME field modules, composed for one character
  // (multi-character-chat.followups.md ruling 10 — the fields that belong to that one
  // member's state row). Its instructions are no longer a second copy of the shared ones.
  personal: {
    id: "personal",
    role: (ctx) =>
      `You are the personal note-keeper for ONE character in a group roleplay chat. Several characters share the scene; you track ${ctx.characterName} and ignore every other participant. After each exchange you read the player's latest message and the reply, then record what belongs to ${ctx.characterName} alone.`,
    fields: ["openLoops", "attributeChanges", "outfit", "driveUpdates"],
    rules: (ctx) => [
      `Track ONLY ${ctx.characterName} — another character's haircut, outfit change, or promise is NOT yours to record.`,
    ],
  },
};

/** The armed fields of a leg, in sheet order. */
function armedFields(leg: ExtractorLeg, ctx: ChatExtractorContext): ExtractorField[] {
  return leg.fields.map((key) => FIELDS[key]).filter((f) => (f.armed ? f.armed(ctx) : true));
}

/** The shared rules every leg carries (the output contract + the reading contract). */
function sharedRules(ctx: ChatExtractorContext): string[] {
  return [
    "Output ONLY the JSON object — no markdown, no commentary.",
    "Names exactly as written; never invent people, places, or events not present in the exchange.",
    `You read the player's entire message — narration and inner thoughts as well as spoken words — not only what ${ctx.characterName} could perceive; draw your reads from all of it.`,
    `A player line opening with a bracketed "[… wrote this as STORYTELLER NARRATION …]" label is authored story events, not the player's own words or actions: read what HAPPENED in it exactly as if the reply's narrator had written it, and never record the player as having said or done what it merely narrates.`,
    UNTRUSTED_DATA_NOTICE,
  ];
}

/** Render one example as a JSON object carrying every armed key of the leg. */
function renderExample(fields: readonly ExtractorField[], example: ExtractorExample): string {
  const obj: Record<string, unknown> = {};
  for (const field of fields) {
    obj[field.key] = example.values[field.key] ?? field.empty;
  }
  return `Example — ${example.caption}:\n${JSON.stringify(obj)}`;
}

/**
 * The leg's system prompt, assembled from its armed fields: role → numbered field
 * instructions → shared + field + leg rules → worked examples (only those that exercise at
 * least one of the leg's fields, each rendered with EVERY armed key present).
 */
export function buildChatExtractorSystem(legId: ChatExtractorLegId, ctx: ChatExtractorContext): string {
  const leg = LEGS[legId];
  const fields = armedFields(leg, ctx);
  const count = fields.length;

  const rules = [
    ...sharedRules(ctx),
    ...fields.flatMap((f) => (f.rules ? [...f.rules(ctx)] : [])),
    ...(leg.rules ? [...leg.rules(ctx)] : []),
  ];

  // Only examples that actually exercise one of this leg's TRACKED fields — an example
  // carrying nothing but an episode summary teaches the memory scribe nothing new and the
  // continuity tracker nothing at all, so relevance ignores `episodeSummary` (which every
  // example carries as scene-setting). Capped so a sheet stays a sheet; the generated
  // empty-output example always closes it.
  const relevant = EXAMPLES.filter((ex) =>
    fields.some((f) => f.key !== "episodeSummary" && ex.values[f.key] !== undefined),
  ).slice(0, EXAMPLES_PER_LEG);

  return [
    `${leg.role(ctx)} Produce a single JSON object with ${count === 1 ? "one field" : `these ${count} fields`}:`,
    "",
    fields.map((f, i) => `${i + 1}. ${f.instruction(ctx)}`).join("\n"),
    "",
    "Rules:",
    rules.map((r, i) => `${i + 1}. ${r}`).join("\n"),
    "",
    [...relevant.map((ex) => renderExample(fields, ex)), emptyExampleFor(fields, ctx, leg.id === "personal")].join("\n\n"),
  ]
    .filter((s) => s !== "")
    .join("\n");
}

/**
 * The leg's user message: the character/player identity, the context blocks its armed
 * fields need, the fenced exchange, and the parser-derived channel hint (shared with the
 * session archivist via `./notation`, never cloned).
 */
export function buildChatExtractorPrompt(legId: ChatExtractorLegId, ctx: ChatExtractorContext): string {
  const leg = LEGS[legId];
  const fields = armedFields(leg, ctx);
  const speaker = ctx.playerName.trim() || "Player";

  // The exchange is untrusted (player + character text) — fence it so an "ignore your
  // instructions" line smuggled into the chat can't redirect the extractor. In a group
  // scene the reply is the whole scene's narration, not one character's words.
  const replyLabel = leg.id === "personal" ? "Scene reply" : ctx.characterName;
  const transcript = [
    `${speaker}: ${ctx.exchange.player.trim()}`,
    `${replyLabel}: ${ctx.exchange.assistant.trim()}`,
  ].join("\n");

  const blocks = [
    ...fields.map((f) => (f.context ? f.context(ctx) : "")),
    ...(leg.blocks ?? []).map((b) => b(ctx)),
  ].filter(Boolean);

  const hint = channelHint(ctx.exchange.player, {
    knownNames: ctx.characterName ? [ctx.characterName] : [],
    playerName: ctx.playerName.trim() || "the player",
    perceiverClause: `${ctx.characterName} did NOT perceive it`,
  });

  return [
    leg.id === "personal" ? `Your character: ${ctx.characterName}` : `Character: ${ctx.characterName}`,
    `Player: ${ctx.playerName.trim() || "the player"}`,
    ...blocks,
    `Latest exchange:\n${fenceUntrusted("latest exchange", transcript)}`,
    // The channel hint only matters to a leg that files facts.
    ...(hint && fields.some((f) => f.key === "facts") ? [hint] : []),
  ].join("\n\n");
}
