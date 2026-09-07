import { attributeRegistry } from "@/contracts/attributes";
import { resolveAttributes, type AttributeValue } from "@/contracts/attributes/value";
import { isIntimateAttributeCategory } from "@/contracts/body/locations";
import { conditionAttributeOverlays } from "@/contracts/conditions/overlays";
import { deriveMoodDescriptor, splitStateCues } from "@/contracts/meters/registry";
import { currentScenePlace, isEmptyChatSceneMemory, type ChatSceneMemory } from "@/contracts/turns/chat-scene-memory";
import type { SupportingCast } from "@/contracts/turns/chat-supporting-cast";
import { planOthersLabel, type SalientPlan } from "@/contracts/turns/chat-plans";
import type { SocialReactionCard } from "@/contracts/personality/cards";
import { stateDispositionOverlays } from "@/contracts/personality/modulation";
import { dispositionBands, effectiveTraitValue, traitPole, traitRegistry } from "@/contracts/personality/traits";
import { resolveTraits, type TraitValue } from "@/contracts/personality/traits/value";
import { driveWithheld } from "@/contracts/personality/drives";
import { composeRelationshipLaw, dispositionContrastLine, dispositionIdiomLine } from "@/contracts/relationships/law";
import { speciesIntimacyNote, type RealizedBody } from "@/contracts/species";
import { hasVoiceAnchors, type CharacterProfile, type VoiceAnchors } from "@/contracts/world/profile";
import type { VoiceExemplar } from "../../chat-voice";
import type { ChatFeelingState } from "../../chat-feeling";
import { fenceUntrusted } from "../untrusted";
import type { CharacterChatPromptInput } from "./types";
import { AFFORDANCE_CUE_BLOCK_HEADING, VISUAL_STATE_CONSTRAINT_BLOCK_HEADING, VISUAL_STATE_CUE_BLOCK_HEADING, attributePhrase, withholdHairAttributes } from "./sensory-sections";

/**
 * The composed "Relationship" block: `composeRelationshipLaw` renders the two
 * axes + authored texture (history → familiarity → regard → mask → corner →
 * the escalation gate, keyed to REGARD), and the disposition-contrast
 * line states the divergence when regard's sign disagrees with the authored
 * warmth lean. Lives in the cached stable prefix — it re-renders only on a band
 * change on either axis (or an authored-texture edit), which is cache-friendly.
 */
export function buildRelationshipSection(
  state: CharacterChatPromptInput["state"],
  characterName: string,
  playerName: string | undefined,
  traits: readonly TraitValue[],
  minor = false,
): string {
  const target = playerName ?? "the user";
  const law = composeRelationshipLaw({
    name: target,
    selfName: characterName,
    familiarity: state?.familiarity ?? 0,
    regard: state?.regard ?? 0,
    kind: state?.relationship?.kind,
    history: state?.relationship?.history,
    presented: state?.relationship?.presented,
    // Minor fence: no escalation-floor line — the
    // content framing already rules the territory wholly out of scope.
    omitEscalation: minor,
  });
  const warmth = effectiveTraitValue(traits, "temperament.warmth");
  const regard = state?.regard ?? 0;
  // The contrast line fires on sign disagreement; the idiom line fires at warm+ regard
  // so growing closeness keeps the authored manner.
  const extras = [
    dispositionContrastLine({ name: target, warmth, regard }),
    dispositionIdiomLine({ name: target, warmth, regard }),
  ]
    .filter(Boolean)
    .map((line) => `- ${line}`);
  return extras.length ? `${law}\n${extras.join("\n")}` : law;
}

/**
 * The player-persona blocks for the **stable prefix**, shared by the 1-on-1 and
 * ensemble builders so the two can never drift.
 *
 * Prefix-safe by construction: only the authored, turn-invariant parts live here. What
 * the player is WEARING and their intimate note both move with state, so they ride the
 * volatile tail instead (`buildPlayerStateLine` / `buildChatIntimateSection`) — a
 * cache-layout rule, and the same split the character's own bio-vs-outfit follows.
 *
 * Every part is author-written and therefore UNTRUSTED — each is fenced, exactly like the
 * character's own bio/voice. Emits [] with no persona, so a chat that resolved to a bare
 * account name builds the prompt it always did.
 */
export function buildPlayerSections(player: CharacterChatPromptInput["player"], playerName: string): string[] {
  if (!player) return [];
  const bio = player.persona?.trim();
  const voice = player.voice?.trim();
  return [
    bio ? `About ${playerName} (the person you're speaking with):\n${fenceUntrusted("the person you're speaking with", bio)}` : "",
    voice ? `How ${playerName}'s voice sounds (you describe it; you never write their lines):\n${fenceUntrusted("player voice", voice)}` : "",
  ].filter(Boolean);
}

/**
 * What the player has on right now — volatile, so it rides the tail beside the character's
 * own wearing-line rather than the cached prefix. It is STATE, not prose: computed from
 * their worn items, so it is the truth even when the narration has drifted.
 */
export function buildPlayerStateLine(player: CharacterChatPromptInput["player"], playerName: string): string {
  const wearing = player?.wearing?.trim();
  if (!wearing) return "";
  return `What ${playerName} is wearing right now (authoritative — this is what they have on, whatever the story has said):\n${fenceUntrusted("player wardrobe", wearing)}`;
}

/**
 * A character's merged intimate note: the species/heritage archetype
 * (`speciesIntimacyNote` — heritage REPLACES species) **appended** with their own
 * `profile.intimacy` (both may be empty). The merge semantics are the session lane's,
 * ruled by the owner 2026-07-13. "" when neither exists.
 */
export function characterIntimateNote(profile: CharacterProfile): string {
  const archetype = speciesIntimacyNote(profile.speciesId, profile.heritageId);
  const own = (profile.intimacy ?? "").trim();
  return [archetype, own].filter(Boolean).join(" ");
}

/**
 * The **exposure-earned intimate disposition block** — the chat lane's port of the session
 * lane's `buildIntimateDispositionBlock` (`engine/scene.ts`). Before it existed
 * `profile.intimacy` and the species archetype were authored, forge-generated, editable —
 * and silently unread in this lane.
 *
 * Two kinds of note, both surfaced only once `chatSceneIsIntimate` opens the gate:
 *
 * - **each character's** — how they are as a lover. In an ensemble the gate is per-member,
 *   so only those the scene actually turned intimate with contribute (one couple in the
 *   room does not hand everyone present an intimate disposition).
 * - **the player's** — their persona's `intimacy`, which carries the INVERSE semantics:
 *   what they *respond to*, not how they behave. Hence its own wording; it is not the same
 *   sentence with a different subject. Rendered ONCE, however many characters qualified.
 *
 * Volatile by nature (the gate flips with coverage/arousal), so it lives in the tail —
 * putting it in the cached prefix would bust the cache on every flip. Callers apply the
 * minor fence by omitting that character's entry.
 */
export function buildChatIntimateSection(args: {
  /** One entry per character whose gate opened AND who has a note. `label` is subject+verb ("you are" / "Mira is"). */
  characters: readonly { label: string; note: string }[];
  /** The player's note — rendered when at least one character's gate opened. */
  playerNote?: string;
  playerName: string;
}): string {
  const lines = [
    ...args.characters.map((c) => `- How ${c.label} as a lover:\n${fenceUntrusted("intimate disposition", c.note)}`),
    args.playerNote
      ? `- What ${args.playerName} responds to — play toward it:\n${fenceUntrusted("player intimate preferences", args.playerNote)}`
      : "",
  ].filter(Boolean);
  if (!lines.length) return "";
  return [
    "Intimate disposition (this scene has earned it — it applies now, and would read as nothing in an ordinary moment):",
    ...lines,
  ].join("\n");
}

/**
 * The drives block: the character's motive force as
 * prompt LAW. Wording per secrecy tier + gate (owner rulings): a withheld secret
 * carries the full-but-SCOPED lie license; a gate-cleared secret invites the
 * reveal as a big beat; guarded never volunteers. Resolved drives drop out.
 */
export function buildDrivesSection(
  state: NonNullable<CharacterChatPromptInput["state"]>,
  player: string,
  confidence = 0,
): string {
  const drives = (state.drives ?? []).filter((d) => !d.resolved);
  if (!drives.length) return "";
  const axes = { regard: state.regard, familiarity: state.familiarity ?? 0 };
  const lines = drives.map((d) => {
    const why = d.why.trim() ? ` — ${d.why.trim()}` : "";
    const progress = d.progress.trim() ? ` Lately: ${d.progress.trim()}.` : "";
    if (d.secrecy === "secret" && !d.revealed && driveWithheld(d, axes)) {
      return `- A SECRET: you want ${d.want}${why}.${progress} ${player} must not learn this yet — steer around it, deflect, change the subject, and when cornered you may lie outright, inventing whatever cover story protects it. The lying is for THIS secret only; in everything else you are as honest as you ever are.`;
    }
    if (d.secrecy === "secret" && !d.revealed) {
      return `- A secret you could finally share: you want ${d.want}${why}.${progress} Telling ${player} has started to feel possible — when a moment genuinely invites it, letting this out is a big beat. Don't force it; let it land.`;
    }
    if (d.secrecy === "guarded") {
      return `- You want ${d.want}${why}.${progress} You don't volunteer this — it comes out only if ${player} genuinely asks or earns it.`;
    }
    return `- You want ${d.want}${why}.${progress}${d.secrecy === "secret" ? " (now in the open between you.)" : ""}`;
  });
  // Confidence colors HOW wants surface — a bold character states them plainly,
  // a timid one circles and hedges even a secret they've decided to share.
  const posture =
    traitPole(confidence) === "high"
      ? " You state what you want plainly — desire, and even a hard admission, come out direct and unhedged."
      : traitPole(confidence) === "low"
        ? " Wanting makes you hesitant — you circle what you want, hedge, half take it back; even a secret you've decided to share comes out haltingly, not as a bold declaration."
        : "";
  return `What you want (your own motive force — let it steer what you pursue, offer, and withhold; never recite this list):${posture}\n${lines.join("\n")}`;
}

/** Cap on surfaced social-card framing lines, so a big card set can't flood the prompt. */
const CARD_FRAMING_CAP = 4;

/**
 * The persistent feeling as a prose clause: strength
 * adverb from intensity, label as the adjective it already is, cause attached.
 * "" when there is no standing feeling — both consumers then render as before.
 */
export function feelingPhrase(feeling: ChatFeelingState | undefined): string {
  const current = feeling?.current;
  if (!current) return "";
  const strength = current.intensity >= 0.7 ? "deeply" : current.intensity >= 0.4 ? "still" : "faintly — it's fading —";
  const cause = current.cause.trim();
  return `${strength} ${current.label}${cause ? ` about ${cause}` : ""}`;
}

/**
 * The "Current state" block: **standing
 * coloring** (mood phrase, unchanged meter bands, stage warmth, condition hints, mindNote,
 * outfit) the narrator should let bias its tone, plus at most ONE **foregrounded** "just
 * shifted" beat for a meter band that changed this turn (so e.g. tipping into drunk is marked
 * once, then rides as coloring). The change-gate (`splitStateCues`) diffs current bands
 * against `state.surfacedCues` (last turn's). "" when nothing is notable ⇒ no block.
 */
export function buildStateSection(state: NonNullable<CharacterChatPromptInput["state"]>): string {
  const { foreground, standing } = splitStateCues(state.meters, state.surfacedCues ?? {});
  const lines: string[] = [];
  const mood = deriveMoodDescriptor(state.meters);
  // The persistent feeling composes with the meter descriptor (ruled):
  // baseline weather + the front passing through — never a replacement.
  const feeling = feelingPhrase(state.feeling);
  if (mood && feeling) lines.push(`- You are feeling ${mood} right now — and ${feeling}.`);
  else if (mood) lines.push(`- You are feeling ${mood} right now.`);
  else if (feeling) lines.push(`- Underneath everything, ${feeling}.`);
  for (const cue of standing) lines.push(`- ${cue.hint}`);
  // (The old per-stage warmth steer moved into the prefix's Relationship-law block.)
  for (const condition of state.conditions) if (condition.promptHint) lines.push(`- ${condition.promptHint}`);
  const mindNote = state.mindNote?.trim();
  if (mindNote) lines.push(`- On your mind: ${mindNote}`);
  const loops = (state.openLoops ?? []).map((l) => l.trim()).filter(Boolean);
  if (loops.length) {
    lines.push(
      `- Unfinished business between you: ${loops.join("; ")}. Let it tug at you when there's an opening — never recite the list.`,
    );
  }
  const outfit = state.outfit?.trim();
  if (outfit) {
    lines.push(
      `- You're wearing ${outfit}${state.outfitExposed ? ", and more exposed than usual — what it bares is there to be seen" : ""}. Let it show: when movement or the player's attention makes it noticeable, give their eye what it would catch.`,
    );
  }

  const blocks: string[] = [];
  if (lines.length) {
    blocks.push(`Your current state (let this color how you speak and react — never recite it):\n${lines.join("\n")}`);
  }
  if (foreground) {
    blocks.push(
      `Right now this is shifting: ${foreground.hint} Mark it once, in action, as it changes — then let it ride; don't restate it on later turns.`,
    );
  }
  // The wardrobe digest + cue block (`CHAT_GARMENT_CUES`).
  // AUTHORITY then ATTENTION, in that order and deliberately separate: the digest is a
  // state guard the narrator may never contradict, the cues are the one or two details
  // that earned a mention this turn. Both absent when the flag is off, which is what
  // keeps this section byte-identical to today.
  const digest = state.garmentDigest?.trim();
  if (digest) blocks.push(digest);
  const garmentCues = (state.garmentCues ?? []).map((cue) => cue.trim()).filter(Boolean);
  if (garmentCues.length) {
    blocks.push(
      `Worth noticing about the clothes this turn (weave at most one into the beat, in action — never a head-to-toe inventory, never restated once said):\n${garmentCues
        .map((cue) => `- ${cue}`)
        .join("\n")}`,
    );
  }
  // The affordance cue block (`CHAT_AFFORDANCE_CUES`),
  // AFTER the garment blocks: clothes are the nearer, more actionable read, and a body
  // cue that follows them lands as an added detail rather than competing for the same
  // slot. Attention only — there is deliberately no affordance digest, because the
  // underlying appearance is already authoritative in the Attributes section. Absent
  // when the flag is off, which is what keeps this section byte-identical to today.
  const affordanceCues = (state.affordanceCues ?? []).map((cue) => cue.trim()).filter(Boolean);
  if (affordanceCues.length) {
    // The heading is shared with `chatSensoryAllowanceLine`'s carve-out, which
    // names this block when the turn's allowance is `none` (owner ruling
    // 2026-07-28) — one constant, so the two can never drift apart.
    blocks.push(
      `${AFFORDANCE_CUE_BLOCK_HEADING} (weave at most one into the beat, in action — never a physics report, never restated once said):\n${affordanceCues
        .map((cue) => `- ${cue}`)
        .join("\n")}`,
    );
  }
  // The visual-state pair (slice 7, the per-chat narration switch), LAST in the
  // section and in this order: the constraint block is a fence and the cue block
  // is an offer, so the offer reads against a fence that is already standing.
  //
  // The constraint block deliberately carries no "weave one in" invitation. It
  // is the only block in this section that is not an attention cue, and giving
  // it one would turn a wardrobe inventory into something the narrator feels
  // obliged to recite — the exact failure the affordance-cue trial found.
  const visualConstraints = (state.visualConstraints ?? []).map((line) => line.trim()).filter(Boolean);
  if (visualConstraints.length) {
    blocks.push(
      `${VISUAL_STATE_CONSTRAINT_BLOCK_HEADING} (facts already committed — say nothing that conflicts with them; there is no obligation to mention any of them):\n${visualConstraints
        .map((line) => `- ${line}`)
        .join("\n")}`,
    );
  }
  const visualCues = (state.visualCues ?? []).map((cue) => cue.trim()).filter(Boolean);
  if (visualCues.length) {
    // The heading is shared with `chatSensoryAllowanceLine`'s carve-out on the
    // same one-constant rule the affordance block follows.
    blocks.push(
      `${VISUAL_STATE_CUE_BLOCK_HEADING} (weave at most one into the beat, in action — never an inventory, never restated once said; the clause after the dash is why it is live, not something to say):\n${visualCues
        .map((cue) => `- ${cue}`)
        .join("\n")}`,
    );
  }
  return blocks.join("\n\n");
}

/**
 * Soft "what you care about / won't stand for" framing for the chat's active
 * social cards: the card's theme only — **never** its mechanical `severity`, which the post-turn
 * pulse owns. Lets the narrator avoid contradicting a taboo/rule it can't otherwise see,
 * without pre-playing the reaction. Fenced (cards can be library-cloned ⇒ untrusted). "" when
 * there are no cards.
 */
export function buildSocialFramingSection(cards: readonly SocialReactionCard[]): string {
  if (!cards.length) return "";
  const lines = cards.slice(0, CARD_FRAMING_CAP).map((card) => {
    const lead = card.kind === "taboo" ? "Won't stand for" : "Holds to";
    const desc = card.description.trim();
    return `- ${lead}: ${card.label}${desc ? ` — ${desc}` : ""}`;
  });
  return `What you care about (your own values — let them shape how you take what's said and done; react in character, never recite):\n${fenceUntrusted("values", lines.join("\n"))}`;
}

/**
 * The one-line voice re-anchor: a compact restatement of the
 * voice anchors that rides the volatile tail beside the mood pin, where models heed it
 * most — so voice stays consistent even as a long history dominates attention. "" when
 * nothing is authored.
 */
export function buildVoiceReanchorLine(anchors: VoiceAnchors): string {
  if (!hasVoiceAnchors(anchors)) return "";
  const parts: string[] = [];
  if (anchors.cadence.trim()) parts.push(anchors.cadence.trim());
  if (anchors.petPhrases.length) parts.push(`phrases like ${anchors.petPhrases.slice(0, 3).join(", ")}`);
  if (anchors.neverSays.length) parts.push(`never ${anchors.neverSays.slice(0, 3).join(", ")}`);
  if (!parts.length) return "";
  return `Voice check: sound like yourself this turn — ${parts.join("; ")}.`;
}

/**
 * The "How you sound" voice-exemplar ring block: a few recent
 * distinctly in-voice lines the character actually said, kept past the events-only summary
 * horizon so voice survives a long chat. Volatile (the ring accretes each exchange).
 * Distinct from the authored micro-exemplars — these are grown in-chat. Fenced (prior
 * character text). "" when the ring is empty.
 */
export function buildVoiceRingSection(exemplars: readonly VoiceExemplar[]): string {
  const lines = exemplars.map((e) => e.line.trim()).filter(Boolean);
  if (!lines.length) return "";
  return `How you sound (recent lines in your own voice from this conversation — match the register and rhythm, never quote them back):\n${fenceUntrusted("voice ring", lines.map((l) => `- ${l}`).join("\n"))}`;
}

/**
 * The one-turn character-consistency corrective: last
 * exchange's archivist slip note, rendered near generation so the next reply pulls the
 * voice/disposition/age register back. Degrades to no line on an absent/empty note (the
 * common case); the slip is fenced (model-written text). "" when the reply held character.
 */
export function buildSlipCorrectionLine(slip: string | undefined): string {
  const note = slip?.trim();
  if (!note) return "";
  return `Voice correction — your last reply slipped out of character; fix it this turn without overcorrecting:\n${fenceUntrusted("voice correction", note)}`;
}

/**
 * The RAG recall block: the character's retrieved
 * facts + older episodes for this turn. Placed beneath the rolling-summary recap — the
 * summary carries the recent horizon, this reaches past it. Fenced like the recap (both
 * derive from prior player/character text, so an injection smuggled into a remembered line
 * reads as recalled context, not authority). "" when nothing was retrieved.
 */
export function buildMemorySection(memory: NonNullable<CharacterChatPromptInput["memory"]>): string {
  const facts = memory.facts.map((f) => f.trim()).filter(Boolean);
  const episodes = memory.episodes.map((e) => e.trim()).filter(Boolean);
  if (!facts.length && !episodes.length) return "";
  const lines: string[] = [];
  if (facts.length) {
    lines.push("What you know (established between you — treat as true; draw on it only when the moment calls for it):");
    for (const fact of facts) lines.push(`- ${fact}`);
  }
  if (episodes.length) {
    if (lines.length) lines.push("");
    lines.push("Earlier moments you remember (from before the recent exchanges):");
    for (const episode of episodes) lines.push(`- ${episode}`);
  }
  return `Your memory (things established earlier in your history together):\n${fenceUntrusted("memory", lines.join("\n"))}`;
}

/**
 * The compact "Scene" block (chat scene memory): the narrator-imagined setting kept
 * consistent across turns — the current place + its established details and the current
 * place's connections — followed by a directive line that flips on whether
 * the scene just changed. Unchanged ⇒ "do not re-establish"; just changed ⇒ "establish the
 * new scene once, then leave it alone". "" when the memory is empty AND nothing changed
 * (byte-identical to the pre-scene-memory tail). Volatile tail (it accretes), never the prefix.
 */
export function buildSceneSection(memory: ChatSceneMemory, changed: boolean): string {
  if (isEmptyChatSceneMemory(memory) && !changed) return "";
  const place = currentScenePlace(memory);
  const here = memory.current ?? place?.name;
  const lines: string[] = [];
  if (here) {
    const details = place && place.details.length ? ` — ${place.details.join("; ")}` : "";
    lines.push(`- Here: ${here}${details}`);
  }
  // The background sketch: fixed-feature reference
  // for this place — authority for what's physically here, never prose to recite.
  if (place?.sketch) lines.push(`- Setting (fixed reference): ${place.sketch}`);
  if (place && place.connections.length) lines.push(`- Nearby: ${place.connections.join("; ")}`);
  const directive = changed
    ? "This scene just changed — establish the new setting in one or two paragraphs (sight plus one other sense), then leave it alone."
    : "Do not re-establish the setting; at most one fresh accent that earns its place.";
  return [
    "Scene (the setting established so far — keep it consistent, never re-describe what hasn't changed):",
    ...lines,
    directive,
  ].join("\n");
}

/**
 * The compact "Supporting cast" block: recurring named
 * side characters the story established, plus the license that makes them playable —
 * the carve-out from rule 3's incidental-person discipline. One line per member; ""
 * when the cast is empty (byte-identical to the pre-cast tail). Volatile tail (it
 * accretes), never the prefix. `selfName` is the speaking character 1-on-1 and null
 * in the ensemble frame (where tag law already covers the roster collectively).
 */
export function buildSupportingCastSection(cast: SupportingCast, selfName: string | null, player: string): string {
  if (!cast.length) return "";
  const lines = cast.map((m) => {
    const texture = [
      m.relation,
      m.details.length ? m.details.join("; ") : "",
      m.voice ? `voice: ${m.voice}` : "",
      m.whereabouts ? `usually: ${m.whereabouts}` : "",
    ]
      .filter(Boolean)
      .join(" · ");
    return `- ${m.name}${texture ? ` — ${texture}` : ""}`;
  });
  const tagClause = selfName
    ? `in prose with plain attribution (their name in the sentence: Jo leans in, "That's not the whole story." — never a [bracketed] tag, which belongs to ${selfName} alone, and never a bare quoted paragraph)`
    : `in prose with plain attribution (their name in the sentence: Jo leans in, "That's not the whole story." — never a [bracketed] tag, which belongs to the main cast, and never a bare quoted paragraph)`;
  return [
    "Supporting cast (recurring side characters in this story — keep them consistent with what's established):",
    ...lines,
    `These people are real in this story: when a beat plausibly includes one — they're present, reachable by text or call, or the scene visits them — you may write their dialogue and small actions ${tagClause}, and give them initiative true to who they are: they can speak up, disagree, text, drop by, or carry their own thread. They stay supporting: never let one take over a scene, never contradict what ${player} has written for them, and never use one to speak or act FOR ${player}.`,
  ].join("\n");
}

/**
 * The compact "Plans" block: the commitments NEAR this turn,
 * each with a directive by state — anticipation before, the event when due, the fallout when
 * just missed. Only the salient plans render (the pipeline derived them against the story
 * clock); at most a couple far-upcoming plans ride along as "on the horizon". "" when nothing
 * is near — a standing list is never dumped every turn. Volatile tail (it accretes / comes
 * due), never the prefix.
 */
export function buildPlansSection(salient: readonly SalientPlan[], player: string): string {
  const near = salient.filter((s) => s.salience !== "upcoming");
  const upcoming = salient.filter((s) => s.salience === "upcoming").slice(0, 2);
  if (!near.length && !upcoming.length) return "";
  const line = (s: SalientPlan): string => {
    const others = planOthersLabel(s.plan, player);
    const who = others ? ` ${others}` : "";
    const where = s.plan.where ? ` at ${s.plan.where}` : "";
    const when = s.whenLabel;
    const tag =
      s.salience === "dueNow"
        ? "HAPPENING NOW"
        : s.salience === "imminent"
          ? `coming up — ${when}`
          : s.salience === "justMissed"
            ? "JUST MISSED"
            : when;
    return `- ${s.plan.what}${who}${where} — ${tag}`;
  };
  const directives: string[] = [];
  if (near.some((s) => s.salience === "dueNow")) {
    directives.push(
      "A plan's time has arrived: let it happen in the fiction — meet it, be there, do the thing, or show honestly why it can't.",
    );
  }
  if (near.some((s) => s.salience === "imminent")) {
    directives.push(
      "A plan is coming up soon: it can pull at the character — anticipation, a reminder, wanting to firm it up — without forcing the scene there yet.",
    );
  }
  if (near.some((s) => s.salience === "justMissed")) {
    directives.push(
      `A plan was just missed — it did not happen when it should have. Let the fallout land honestly for the character, true to how much it mattered and to their regard for ${player} (a quiet hurt, open disappointment, or a pointed question). Never pretend it still happened.`,
    );
  }
  return [
    "Plans (commitments in play — honor the character's memory of them):",
    ...near.map(line),
    ...(upcoming.length
      ? [`On the horizon: ${upcoming.map((s) => `${s.plan.what} (${s.whenLabel})`).join("; ")}.`]
      : []),
    ...directives,
  ].join("\n");
}

/**
 * The ensemble arrival/exit license: a due/imminent
 * plan is the fiction's OWN reason to move a character into or out of the scene — the one
 * principled exception to the presence law's don't-teleport guard. A plan involving an AWAY
 * roster member licenses their narrated ARRIVAL (the plan is why they show up); a plan
 * happening now that does NOT involve the player, involving a PRESENT member, licenses their
 * EXIT ("her shift starts"). "" when no plan pulls anyone. Ensemble-only.
 */
export function buildPlanPresenceLicense(
  salient: readonly SalientPlan[],
  presentNames: readonly string[],
  awayNames: readonly string[],
  player: string,
): string {
  const norm = (s: string): string => s.trim().toLowerCase();
  const playerKeys = new Set([norm(player), "you", "the player", "player", "me"]);
  const present = new Set(presentNames.map(norm));
  const away = new Set(awayNames.map(norm));
  const lines: string[] = [];
  for (const s of salient) {
    if (s.salience !== "dueNow" && s.salience !== "imminent") continue;
    const involvesPlayer = s.plan.participants.some((p) => playerKeys.has(norm(p)));
    for (const who of s.plan.participants.filter((p) => away.has(norm(p)))) {
      lines.push(
        `${who} is away, but has a plan ${s.salience === "dueNow" ? "happening now" : "coming up"} — "${s.plan.what}". That plan is reason enough for ${who} to arrive: you MAY bring ${who} into the scene with their arrival narrated (the ONE exception to not moving an away character in uninvited).`,
      );
    }
    if (!involvesPlayer && s.salience === "dueNow") {
      for (const who of s.plan.participants.filter((p) => present.has(norm(p)))) {
        lines.push(`${who} has a commitment of their own right now — "${s.plan.what}" — so ${who} may step out of the scene for it if it fits.`);
      }
    }
  }
  if (!lines.length) return "";
  return ["Plans in motion (the fiction's own commitments pull people into or out of the scene):", ...lines.map((l) => `- ${l}`)].join("\n");
}

/**
 * The volatile disinhibition block (a cache-layout tail): high
 * intoxication/arousal lowers inhibition, guardedness, and composure at render time
 * only (source "condition" overlays; authored sliders are never written, and the
 * shift recedes as the meters drift back). Computed against the STAGE-COLORED base
 * (the prefix's Disposition block), rendering ONLY the band lines the
 * shift actually changed as overrides — sober ⇒ "" ⇒ the tail is unchanged.
 */
export function buildDisinhibitionSection(
  baseTraits: readonly TraitValue[],
  meters: Record<string, number>,
  baseEveryday: readonly string[],
  baseIntimate: readonly string[],
): string {
  const overlays = stateDispositionOverlays(baseTraits, meters);
  if (!overlays.length) return "";
  const shiftedTraits = resolveTraits(baseTraits, overlays);
  const baseLines = new Set([...baseEveryday, ...baseIntimate]);
  const changed = [
    ...dispositionBands(traitRegistry, shiftedTraits, { intimateOnly: false }),
    ...dispositionBands(traitRegistry, shiftedTraits, { intimateOnly: true }),
  ].filter((line) => !baseLines.has(line));
  if (!changed.length) return "";
  return [
    "Right now your state is loosening you (transient — while it lasts, these REPLACE the matching Disposition lines above; it recedes as you sober and settle):",
    ...changed.map((line) => `- ${line}`),
  ].join("\n");
}

/**
 * The volatile transient-appearance block (a cache-layout tail): active conditions'
 * `attributeEffects` (a "disheveled"/"unwashed" condition shifting grooming/scent/hair)
 * rendered as overrides of the prefix's Attributes/Sensory lines instead of being baked
 * into them, so a condition starting or expiring never busts the cached prefix. Same
 * guards as the prefix loop (registry-known, applicable, never intimate sensory);
 * `conditionAttributeOverlays` already drops inherent attributes. No conditions ⇒ "".
 */
export function buildTransientAppearanceSection(
  input: CharacterChatPromptInput,
  stableResolved: readonly AttributeValue[],
  realizedBody: RealizedBody,
): string {
  const conditionOverlays = conditionAttributeOverlays(input.state?.conditions ?? []);
  if (!conditionOverlays.length) return "";
  // Same withholding as the prefix's stable resolve: a condition shifting covered hair
  // has nothing visible to override.
  const fullResolved = withholdHairAttributes(
    resolveAttributes(input.profile.attributes, [...(input.state?.attributeOverlays ?? []), ...conditionOverlays]),
    input.state?.hairOcclusion,
  );
  const stableById = new Map(stableResolved.map((v) => [v.id, v]));
  const lines: string[] = [];
  for (const value of fullResolved) {
    if (value.id === "identity.apparent_age") continue;
    const def = attributeRegistry.byId(value.id);
    if (!def) continue;
    if (def.excludeFromPrompts) continue;
    if (def.kind === "sensory" && isIntimateAttributeCategory(def.category)) continue; // intimate scent/taste never surfaces in chat
    if (!realizedBody.isAttributeApplicable(def)) continue;
    const stable = stableById.get(value.id);
    if (stable && stable.value === value.value) continue; // unchanged by the condition
    const phrase = attributePhrase(def, value.value);
    if (!phrase) continue;
    lines.push(`- ${phrase}`);
  }
  if (!lines.length) return "";
  return [
    "While your current condition lasts (transient — these override the matching Attribute/Sensory lines above):",
    ...lines,
  ].join("\n");
}
