import {
  bodyLocationRegistry,
  SENSORY_NARRATOR_CUE_BUDGET,
  type GustatoryNarratorDigest,
  type GustatoryObservation,
  type OlfactoryNarratorDigest,
  type OlfactoryObservation,
  type SensoryLocus,
  type TactileNarratorDigest,
  type TactileObservation,
} from "@/contracts";
import { SIDED_SINGULAR_LABEL } from "./chat-visual-state-cues";

/**
 * THE NARRATOR PROJECTION for the nonvisual senses — the ONLY place a tactile,
 * olfactory, or gustatory fact becomes words. Everything upstream deals in
 * typed facts: the sense owners under `contracts/sensory` decide perception
 * and selection, their digests carry structured observations, and nothing
 * before this module is prose.
 *
 * The door is default-off: `chat-pipeline.ts` decides whether to call this,
 * and `chatSensoryCuesEnabled()` (`CHAT_SENSORY_CUES`, `prompts/constants.ts`)
 * is that decision's switch. No producer emits nonvisual phenomena yet, so
 * today nothing calls it outside tests — the door ships ahead of its first
 * producer so that producer lands behind an already-deployed default-off
 * switch, the same order the pressure-mark commit leg shipped in.
 *
 * ## What it may say
 *
 * Verbless noun phrases in the contact relation's register ("faintly warm to
 * the touch at your shoulder"), built only from the observation's own
 * committed semantic tags, band, and locus. The last semantic tag is the value
 * (the honest-floor precedent from `chat-affordance-cues.ts`); an observation
 * with no usable tag says nothing. Only "your" or the digest character's
 * possessive may name a participant — an un-nameable participant, or an object
 * locus whose only name is an id, yields silence, never an id in prose.
 *
 * Pure: no IO, no clock, no flag reads.
 */

export interface ChatSensorySubject {
  /** The character these lines are about. */
  readonly characterName: string;
  /** Their possessive form ("Mara's"). Blank falls back to the name. */
  readonly possessive: string;
  /** The sensory subject id the digest files this character under. */
  readonly subjectId?: string;
  /** The player viewpoint's subject id — the one participant "your" may name. */
  readonly playerSubjectId?: string;
}

export interface ChatSensoryDigests {
  readonly tactile?: TactileNarratorDigest;
  readonly olfactory?: OlfactoryNarratorDigest;
  readonly gustatory?: GustatoryNarratorDigest;
}

export interface ChatSensoryRenderInput {
  readonly digests: ChatSensoryDigests;
  readonly subject: ChatSensorySubject;
}

/** `wet_clay` → "wet clay". */
function humanize(token: string): string {
  return token.replaceAll("_", " ").replaceAll(".", " ").trim();
}

function collapse(phrase: string): string {
  return phrase.replace(/\s+/gu, " ").trim();
}

function subjectPossessive(subject: ChatSensorySubject): string {
  const possessive = subject.possessive.trim();
  if (possessive.length > 0) return possessive;
  const named = subject.characterName.trim();
  return named.length > 0 ? `${named}'s` : "";
}

/**
 * How the narrator may name one participant: "your" for the player viewpoint,
 * the possessive for the digest's own character, and NOTHING for anyone else —
 * a roster member's subject id is an id, and naming an id in prose is worse
 * than silence.
 */
function ownerPhrase(subjectId: string, subject: ChatSensorySubject): string | undefined {
  if (subject.playerSubjectId !== undefined && subjectId === subject.playerSubjectId) return "your";
  if (subject.subjectId !== undefined && subjectId === subject.subjectId) {
    const possessive = subjectPossessive(subject);
    return possessive.length > 0 ? possessive : undefined;
  }
  return undefined;
}

/**
 * A sensory locus as the clause names it, or `undefined` when nothing honest
 * can: an object locus carries only ids, and an un-nameable body owner is
 * silence by the rule above.
 */
function locusPhrase(locus: SensoryLocus, subject: ChatSensorySubject): string | undefined {
  if (locus.kind !== "body") return undefined;
  const owner = ownerPhrase(locus.subjectId, subject);
  if (owner === undefined) return undefined;
  const { locationId, side, detail } = locus;
  const sided = side === "left" || side === "right";
  const label = (
    detail !== undefined
      ? humanize(detail)
      : ((sided ? SIDED_SINGULAR_LABEL[locationId] : undefined) ??
        bodyLocationRegistry.byId(locationId)?.label ??
        humanize(locationId))
  ).toLowerCase();
  return collapse(`${owner} ${sided ? `${side} ${label}` : label}`);
}

/** The last semantic tag is the value — the honest floor. No tag, no clause. */
function quality(semanticTags: readonly string[]): string | undefined {
  const tag = semanticTags.at(-1);
  return tag === undefined || tag.trim().length === 0 ? undefined : humanize(tag);
}

const TOUCH_BAND_PREFIX: Readonly<Record<string, string>> = {
  subtle: "faintly ",
  clear: "",
  strong: "unmistakably ",
};

const SOURCE_BAND_PREFIX: Readonly<Record<string, string>> = {
  subtle: "faint ",
  clear: "",
  strong: "strong ",
};

/** One selected tactile cue → one verbless clause, or `undefined` for silence. */
export function renderChatTactileCue(cue: TactileObservation, subject: ChatSensorySubject): string | undefined {
  const felt = quality(cue.semanticTags);
  const place = locusPhrase(cue.surface, subject);
  if (felt === undefined || place === undefined) return undefined;
  return collapse(`${TOUCH_BAND_PREFIX[cue.intensityBand] ?? ""}${felt} to the touch at ${place}`);
}

/** One selected olfactory cue → one verbless clause, or `undefined` for silence. */
export function renderChatOlfactoryCue(cue: OlfactoryObservation, subject: ChatSensorySubject): string | undefined {
  const scent = quality(cue.semanticTags);
  const place = locusPhrase(cue.source, subject);
  if (scent === undefined || place === undefined) return undefined;
  return collapse(`a ${SOURCE_BAND_PREFIX[cue.intensityBand] ?? ""}${scent} scent from ${place}`);
}

/** One selected gustatory cue → one verbless clause, or `undefined` for silence. */
export function renderChatGustatoryCue(cue: GustatoryObservation, subject: ChatSensorySubject): string | undefined {
  const taste = quality(cue.semanticTags);
  const place = locusPhrase(cue.tastedSurface, subject);
  if (taste === undefined || place === undefined) return undefined;
  return collapse(`a ${SOURCE_BAND_PREFIX[cue.intensityBand] ?? ""}${taste} taste from ${place}`);
}

/**
 * The digests' lines, in the routing law's own sense order — touch first (the
 * participant's own sensation), then smell, then taste. Empty clauses drop,
 * duplicates drop, and the block as a whole keeps the same strict budget one
 * sense's digest does: the restraint is per PROMPT, and three senses at two
 * cues each would be the recitation the affordance-cue trial punished. A
 * calibration default, not product law.
 */
export function renderChatSensoryLines(input: ChatSensoryRenderInput): readonly string[] {
  const { digests, subject } = input;
  const lines: string[] = [];
  const seen = new Set<string>();
  const keep = (line: string | undefined): void => {
    if (line === undefined || line.length === 0) return;
    const normalized = line.toLowerCase();
    if (seen.has(normalized)) return;
    seen.add(normalized);
    lines.push(line);
  };
  for (const cue of digests.tactile?.selected ?? []) keep(renderChatTactileCue(cue, subject));
  for (const cue of digests.olfactory?.selected ?? []) keep(renderChatOlfactoryCue(cue, subject));
  for (const cue of digests.gustatory?.selected ?? []) keep(renderChatGustatoryCue(cue, subject));
  return lines.slice(0, SENSORY_NARRATOR_CUE_BUDGET);
}
