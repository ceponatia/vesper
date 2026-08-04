import { z } from "zod";
import { hasChatEvidenceNegation } from "@/lib/chat-input-evidence";
import { parseMessageSpansWithOffsets } from "@/lib/message-spans";
import type { AffordanceSubjectId } from "../affordances/core";
import {
  CHAT_CONTACT_CONDITIONAL_RE,
  CHAT_CONTACT_RESTRAINT_RE,
  CHAT_CONTACT_ROMANTIC_TARGET_RE,
  CHAT_CONTACT_ROMANTIC_VERB_RE,
  CHAT_CONTACT_SENTENCE_SPLIT,
  CHAT_ROMANTIC_PERMISSION_CUE_RE,
  CHAT_ROMANTIC_PERMISSION_TOUCH_RE,
  normalizeTypographicQuotes,
} from "./chat-contact-vocabulary";
import {
  NPC_SCENE_EVIDENCE_MAX_CHARS,
  NPC_SCENE_PLAYER_REF,
  NPC_SCENE_ROSTER_CAP,
  npcRefAt,
  type NpcRef,
  type ParticipantRef,
} from "./npc-scene-decision";

/**
 * The NPC-side ROMANTIC-PERMISSION DECISION contract
 * (romantic-contact-affordances.spec.permission.md §"Grant, denial, absence,
 * and withdrawal", §"Authorship and developer controls", §"Chronology and
 * non-retroactivity"; plan rulings 4, 5, and 7; implementation-order step 3).
 *
 * One structured classifier call per qualifying committed assistant reply reads
 * the reply plus a compact digest — the roster as local refs and the CURRENT
 * standing grants (so the model knows what a withdrawal could even apply to) —
 * and may propose up to four permission decisions. This module owns every pure
 * half of that exchange, mirroring `npc-scene-decision.ts` at reduced scale:
 *
 * - the DIGEST (local `player`/`npc_N` refs only; the ref↔subject-id handles
 *   ride beside it for the server and never reach the model);
 * - the cheap deterministic TRIGGER that decides whether the call is spent at
 *   all (permission-shaped language near touch/romantic context; misses are
 *   the fail-closed direction — permission simply stays absent);
 * - the CLOSED output schema, whose ref enums are built per digest so an
 *   out-of-roster ref is unparseable, with absent-vs-malformed kept DISTINCT;
 * - the DETERMINISTIC VALIDATOR: every decision must ground a verbatim
 *   evidence quote in the reply's own dialogue or narration (absolute offset
 *   recorded — ruling 7's same-reply chronology anchor), be attributable to
 *   the granting NPC's OWN words or conduct (ruling 5: nobody authors
 *   permission for somebody else — a player echo can never ground a grant),
 *   and clear the structural vetoes; every drop carries a bounded typed
 *   reason.
 *
 * The validator enforces STRUCTURE conservatively; it is not a keyword
 * classifier. Whether words actually granted, denied, or withdrew stays the
 * model's semantic judgment — but anything structurally ambiguous (ungrounded,
 * multiply-located, unattributable, conditional-phrased grants…) is dropped,
 * because manufactured permission is the one failure this owner exists to
 * prevent (docs/resilience.md: the degraded direction is always "less is
 * granted").
 */

export const ROMANTIC_PERMISSION_DECISION_SCHEMA_VERSION = 1;

/** The most decisions one reply may commit. Extras drop with `over_cap`. */
export const ROMANTIC_PERMISSION_DECISION_CAP = 4;

/** The most raw items the envelope parser even looks at — beyond this the whole output is off the rails. */
const RAW_DECISION_BOUND = 8;

/** How many issue lines a malformed slot may record, and how long each may be. */
const ISSUE_CAP = 8;
const ISSUE_MAX_CHARS = 160;
/** Bounded drop detail (mirrors the scene leg's payload cap). */
const DROP_DETAIL_MAX = 160;

// ---------------------------------------------------------------------------
// Digest
// ---------------------------------------------------------------------------

/** One roster member, as the classifier sees them: a local ref and prose-side identity only. */
export interface RomanticPermissionDigestNpc {
  readonly ref: NpcRef;
  readonly name: string;
  readonly aliases: readonly string[];
}

/** One CURRENT standing grant, per direction — what a `withdrawn` could apply to. */
export interface RomanticPermissionDigestGrant {
  readonly permittedActorRef: ParticipantRef;
  readonly grantingTargetRef: NpcRef;
}

/** The whole compact digest — everything the one classifier call may read beyond the reply. */
export interface RomanticPermissionDigest {
  readonly npcs: readonly RomanticPermissionDigestNpc[];
  readonly standingGrants: readonly RomanticPermissionDigestGrant[];
}

export interface RomanticPermissionRosterMemberInput {
  readonly subjectId: AffordanceSubjectId;
  readonly name: string;
  readonly aliases: readonly string[];
}

export interface RomanticPermissionStandingGrantInput {
  readonly permittedActorId: AffordanceSubjectId;
  readonly grantingTargetId: AffordanceSubjectId;
}

export interface RomanticPermissionDigestInput {
  readonly playerSubjectId: AffordanceSubjectId;
  /** In STABLE ROSTER ORDER — the order is the `npc_N` ref assignment. */
  readonly roster: readonly RomanticPermissionRosterMemberInput[];
  /** The projection's CURRENT standing grants for the exact scope, any direction. */
  readonly standingGrants: readonly RomanticPermissionStandingGrantInput[];
}

/**
 * The ref↔id handles the digest deliberately does not carry — the server keeps
 * them beside the digest for event construction; the model never sees them.
 */
export interface RomanticPermissionDigestHandles {
  readonly refBySubjectId: ReadonlyMap<string, ParticipantRef>;
  readonly subjectIdByRef: ReadonlyMap<ParticipantRef, AffordanceSubjectId>;
}

export interface RomanticPermissionDigestBuild {
  readonly digest: RomanticPermissionDigest;
  readonly handles: RomanticPermissionDigestHandles;
  /** Roster members beyond the cap (or duplicating a subject id) — named so the caller can trace the omission. */
  readonly droppedRosterSubjectIds: readonly string[];
  /** Standing grants that could not map into digest refs (a participant off the roster). */
  readonly droppedGrantCount: number;
}

/**
 * Assemble the digest and its handles. Deterministic and total: the same input
 * always produces the same refs (roster order), and nothing throws — an
 * over-cap member or an unmappable grant is DROPPED AND COUNTED, never guessed
 * at. The roster cap is the scene leg's (`NPC_SCENE_ROSTER_CAP`) so the two
 * digests can never disagree about who is addressable.
 */
export function buildRomanticPermissionDigest(input: RomanticPermissionDigestInput): RomanticPermissionDigestBuild {
  const refBySubjectId = new Map<string, ParticipantRef>();
  const subjectIdByRef = new Map<ParticipantRef, AffordanceSubjectId>();
  refBySubjectId.set(input.playerSubjectId, NPC_SCENE_PLAYER_REF);
  subjectIdByRef.set(NPC_SCENE_PLAYER_REF, input.playerSubjectId);

  const npcs: RomanticPermissionDigestNpc[] = [];
  const droppedRosterSubjectIds: string[] = [];
  for (const member of input.roster) {
    if (npcs.length >= NPC_SCENE_ROSTER_CAP || refBySubjectId.has(member.subjectId)) {
      droppedRosterSubjectIds.push(member.subjectId);
      continue;
    }
    const ref = npcRefAt(npcs.length);
    refBySubjectId.set(member.subjectId, ref);
    subjectIdByRef.set(ref, member.subjectId);
    npcs.push({ ref, name: member.name, aliases: [...member.aliases] });
  }

  const standingGrants: RomanticPermissionDigestGrant[] = [];
  const seenPairs = new Set<string>();
  let droppedGrantCount = 0;
  for (const grant of input.standingGrants) {
    const permittedActorRef = refBySubjectId.get(grant.permittedActorId);
    const grantingTargetRef = refBySubjectId.get(grant.grantingTargetId);
    // A grant whose granting target is not a roster NPC is undescribable here
    // (the player is never a granting target — spec §"Direction and
    // participant rules").
    if (
      permittedActorRef === undefined ||
      grantingTargetRef === undefined ||
      grantingTargetRef === NPC_SCENE_PLAYER_REF
    ) {
      droppedGrantCount += 1;
      continue;
    }
    const key = `${permittedActorRef}|${grantingTargetRef}`;
    if (seenPairs.has(key)) continue;
    seenPairs.add(key);
    standingGrants.push({ permittedActorRef, grantingTargetRef });
  }

  return {
    digest: { npcs, standingGrants },
    handles: { refBySubjectId, subjectIdByRef },
    droppedRosterSubjectIds,
    droppedGrantCount,
  };
}

// ---------------------------------------------------------------------------
// Closed decision schema
// ---------------------------------------------------------------------------

/** The three decision kinds this leg may produce — different facts by ruling 4. */
export const romanticPermissionDecisionKinds = ["granted", "attempt_denied", "withdrawn"] as const;
export type RomanticPermissionDecisionKind = (typeof romanticPermissionDecisionKinds)[number];

export interface RomanticPermissionDecisionCandidate {
  readonly kind: RomanticPermissionDecisionKind;
  readonly permittedActorRef: ParticipantRef;
  /**
   * ParticipantRef at parse on purpose: "the player granted" is a shape the
   * model CAN spell so the validator can refuse it with a typed reason
   * (`target_player`) rather than laundering it into a generic parse failure.
   */
  readonly grantingTargetRef: ParticipantRef;
  readonly evidenceQuote: string;
}

/** A closed ref enum over exactly one digest's refs (the scene contract's trick). */
function closedRefSchema<T extends string>(members: readonly T[], label: string): z.ZodType<T> {
  const set = new Set<string>(members);
  return z.custom<T>((value) => typeof value === "string" && set.has(value), {
    message: `${label} must be one of this digest's refs`,
  });
}

const evidenceQuoteSchema = z
  .string()
  .max(NPC_SCENE_EVIDENCE_MAX_CHARS)
  .refine((value) => value.trim().length > 0, { message: "evidenceQuote must be a nonblank verbatim quote" });

/** Build the per-digest decision schema. STRICT: an unknown key is a shape this contract never agreed to. */
export function romanticPermissionDecisionSchema(
  digest: RomanticPermissionDigest,
): z.ZodType<RomanticPermissionDecisionCandidate> {
  const participantRefs: readonly ParticipantRef[] = [NPC_SCENE_PLAYER_REF, ...digest.npcs.map((npc) => npc.ref)];
  const participantRef = closedRefSchema<ParticipantRef>(participantRefs, "participant ref");
  return z
    .object({
      kind: z.enum(romanticPermissionDecisionKinds),
      permittedActorRef: participantRef,
      grantingTargetRef: participantRef,
      evidenceQuote: evidenceQuoteSchema,
    })
    .strict();
}

// ---------------------------------------------------------------------------
// Item-independent parse
// ---------------------------------------------------------------------------

/**
 * One decision item's parse outcome. `malformed` is a DISTINCT durable outcome
 * from an absent list — no `.catch()` may launder a refusal into a shrug.
 */
export type RomanticPermissionDecisionSlot =
  | { readonly status: "malformed"; readonly issues: readonly string[] }
  | { readonly status: "parsed"; readonly candidate: RomanticPermissionDecisionCandidate };

export type RomanticPermissionDecisionParse =
  | { readonly status: "malformed_envelope"; readonly issues: readonly string[] }
  | { readonly status: "parsed"; readonly decisions: readonly RomanticPermissionDecisionSlot[] };

/** The outer envelope: version-pinned, decisions carried RAW so each item parses independently. */
const decisionEnvelopeSchema = z
  .object({
    version: z.literal(1),
    decisions: z.unknown().optional(),
  })
  .strict();

function boundedIssues(error: z.ZodError): readonly string[] {
  return error.issues.slice(0, ISSUE_CAP).map((issue) => {
    const path =
      issue.path.length === 0
        ? "(root)"
        : issue.path.map((part) => (typeof part === "symbol" ? "(symbol)" : String(part))).join(".");
    return `${path}: ${issue.message}`.slice(0, ISSUE_MAX_CHARS);
  });
}

/**
 * Parse one classifier output against one digest. Total — a boundary parser in
 * the `parseOr` spirit (docs/resilience.md §1): every failure is a value that
 * NAMES what failed, and the three shapes stay distinct:
 *
 * - not JSON / not this envelope / a non-array `decisions` / an unbounded list
 *   → `malformed_envelope` (there is nothing trustworthy to salvage);
 * - a missing, `null`, or empty `decisions` list → `parsed` with NO slots —
 *   the model proposing nothing is the expected common answer, not an error;
 * - each array item then parses INDEPENDENTLY, so one hallucinated ref cannot
 *   erase a valid sibling.
 */
export function parseRomanticPermissionDecisionOutput(
  digest: RomanticPermissionDigest,
  raw: unknown,
): RomanticPermissionDecisionParse {
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
  const rawDecisions = envelope.data.decisions;
  if (rawDecisions === undefined || rawDecisions === null) return { status: "parsed", decisions: [] };
  if (!Array.isArray(rawDecisions)) {
    return { status: "malformed_envelope", issues: ["decisions: must be an array when present"] };
  }
  if (rawDecisions.length > RAW_DECISION_BOUND) {
    return {
      status: "malformed_envelope",
      issues: [`decisions: ${rawDecisions.length} items exceeds the ${RAW_DECISION_BOUND}-item bound`],
    };
  }
  const schema = romanticPermissionDecisionSchema(digest);
  const decisions = rawDecisions.map((item): RomanticPermissionDecisionSlot => {
    const parsed = schema.safeParse(item);
    if (parsed.success) return { status: "parsed", candidate: parsed.data };
    return { status: "malformed", issues: boundedIssues(parsed.error) };
  });
  return { status: "parsed", decisions };
}

// ---------------------------------------------------------------------------
// Evidence geometry (dialogue + narration, absolute offsets)
// ---------------------------------------------------------------------------

/**
 * The channels permission evidence may live in. Narration AND speech — an NPC
 * grant is usually SPOKEN ("You can touch me"), unlike physical-action
 * evidence, which the scene leg confines to narration. Thought, OOC, comms,
 * and styled spans are never admissible: a thought is not an utterance, and a
 * private "she wouldn't mind" must not become a grant.
 */
export type RomanticPermissionEvidenceChannel = "narration" | "speech";

export interface RomanticPermissionEvidenceSentence {
  readonly text: string;
  /** Absolute `[start, end)` offsets into the (quote-normalized == raw) reply. */
  readonly start: number;
  readonly end: number;
  readonly kind: RomanticPermissionEvidenceChannel;
  /** 0-based reply line (newline count before `start`) — the trigger/attribution proximity unit. */
  readonly line: number;
  /** Which admissible span the sentence sits in — grounding stays span-local. */
  readonly spanIndex: number;
}

interface AdmissibleSpan {
  readonly kind: RomanticPermissionEvidenceChannel;
  readonly text: string;
  readonly start: number;
}

/** The reply's admissible spans, quote-normalized (1:1 replacement, so offsets ARE raw-reply offsets). */
function admissibleSpans(reply: string): readonly AdmissibleSpan[] {
  const normalized = normalizeTypographicQuotes(reply);
  return parseMessageSpansWithOffsets(normalized).flatMap((span) =>
    span.kind === "narration" || span.kind === "speech"
      ? [{ kind: span.kind, text: span.text, start: span.start }]
      : [],
  );
}

/** Newline offsets, ascending — the line-of-offset lookup table. */
function newlineOffsets(reply: string): readonly number[] {
  const offsets: number[] = [];
  for (let i = reply.indexOf("\n"); i !== -1; i = reply.indexOf("\n", i + 1)) offsets.push(i);
  return offsets;
}

function lineOf(newlines: readonly number[], offset: number): number {
  let line = 0;
  for (const at of newlines) {
    if (at >= offset) break;
    line += 1;
  }
  return line;
}

/** The one shared sentence boundary, global so segment offsets can be walked. */
const SENTENCE_BOUNDARY_RE = new RegExp(CHAT_CONTACT_SENTENCE_SPLIT.source, "gu");

/**
 * The reply's admissible SENTENCES with absolute offsets — the permission twin
 * of `npcSceneNarrationSentences`, widened to speech (that helper is
 * narration-only by design and cannot serve spoken grants). Same span walk,
 * same shared boundary regex — geometry, not extraction.
 */
export function romanticPermissionEvidenceSentences(reply: string): readonly RomanticPermissionEvidenceSentence[] {
  const newlines = newlineOffsets(normalizeTypographicQuotes(reply));
  const sentences: RomanticPermissionEvidenceSentence[] = [];
  admissibleSpans(reply).forEach((span, spanIndex) => {
    let cursor = 0;
    const segments: { readonly from: number; readonly to: number }[] = [];
    for (const boundary of span.text.matchAll(SENTENCE_BOUNDARY_RE)) {
      const at = boundary.index ?? 0;
      segments.push({ from: cursor, to: at });
      cursor = at + boundary[0].length;
    }
    segments.push({ from: cursor, to: span.text.length });
    for (const segment of segments) {
      const raw = span.text.slice(segment.from, segment.to);
      const text = raw.trim();
      if (text.length === 0) continue;
      const leading = raw.length - raw.trimStart().length;
      const start = span.start + segment.from + leading;
      sentences.push({ text, start, end: start + text.length, kind: span.kind, line: lineOf(newlines, start), spanIndex });
    }
  });
  return sentences;
}

// ---------------------------------------------------------------------------
// The trigger (pure, cheap)
// ---------------------------------------------------------------------------

/**
 * The cost gate: does any reply LINE carry permission-shaped language beside
 * touch/romantic context, in its admissible (narration/speech) sentences?
 * Line-level conjunction on purpose — the cue and its context usually split
 * across a dialogue span and its attribution clause (`"Not now," she murmurs,
 * easing your hand away.`), which sentence-level proximity would miss.
 *
 * Deliberately LOW-fire: an ordinary reply has neither half, and a reply with
 * only one never fires. Misses are acceptable by design — a missed grant
 * leaves permission absent, which is fail-closed — and a false fire costs one
 * cheap classifier call, never authority.
 */
export function romanticPermissionDecisionTriggered(reply: string): boolean {
  const cueLines = new Set<number>();
  const contextLines = new Set<number>();
  for (const sentence of romanticPermissionEvidenceSentences(reply)) {
    if (CHAT_ROMANTIC_PERMISSION_CUE_RE.test(sentence.text)) cueLines.add(sentence.line);
    if (
      CHAT_ROMANTIC_PERMISSION_TOUCH_RE.test(sentence.text) ||
      CHAT_CONTACT_ROMANTIC_VERB_RE.test(sentence.text) ||
      CHAT_CONTACT_ROMANTIC_TARGET_RE.test(sentence.text)
    ) {
      contextLines.add(sentence.line);
    }
  }
  for (const line of cueLines) if (contextLines.has(line)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Grounding
// ---------------------------------------------------------------------------

export interface RomanticPermissionGrounding {
  /** The normalized, trimmed quote as located. */
  readonly quote: string;
  /** Absolute `[start, end)` in the reply — `start` is the event's `evidenceOffset`. */
  readonly start: number;
  readonly end: number;
  readonly channel: RomanticPermissionEvidenceChannel;
  readonly line: number;
  /** The admissible sentences of the SAME span the quote overlaps — the veto/attribution scope. */
  readonly sentences: readonly RomanticPermissionEvidenceSentence[];
}

type GroundingResult =
  | { readonly status: "grounded"; readonly grounding: RomanticPermissionGrounding }
  | { readonly status: "dropped"; readonly reason: "evidence_ungrounded" | "evidence_ambiguous" };

/**
 * Locate the evidence quote: exactly once, inside ONE admissible span. Zero
 * occurrences is `evidence_ungrounded` (the model paraphrased or invented —
 * which is also where "silence", "affection", and "arousal" evidence dies:
 * there is no sentence to quote); two or more is `evidence_ambiguous` (nobody
 * can say WHICH occurrence decided). Occurrences inside thought/OOC/comms/
 * styled spans are invisible on purpose.
 */
export function groundRomanticPermissionEvidence(reply: string, evidence: string): GroundingResult {
  const quote = normalizeTypographicQuotes(evidence).trim();
  if (quote.length === 0) return { status: "dropped", reason: "evidence_ungrounded" };
  const spans = admissibleSpans(reply);
  const hits: { readonly start: number; readonly channel: RomanticPermissionEvidenceChannel; readonly spanIndex: number }[] =
    [];
  spans.forEach((span, spanIndex) => {
    let at = span.text.indexOf(quote);
    while (at !== -1) {
      hits.push({ start: span.start + at, channel: span.kind, spanIndex });
      at = span.text.indexOf(quote, at + 1);
    }
  });
  if (hits.length === 0) return { status: "dropped", reason: "evidence_ungrounded" };
  if (hits.length > 1) return { status: "dropped", reason: "evidence_ambiguous" };
  const hit = hits[0];
  if (hit === undefined) return { status: "dropped", reason: "evidence_ungrounded" };
  const end = hit.start + quote.length;
  const all = romanticPermissionEvidenceSentences(reply);
  const sentences = all.filter(
    (sentence) => sentence.spanIndex === hit.spanIndex && sentence.start < end && hit.start < sentence.end,
  );
  const line = sentences[0]?.line ?? lineOf(newlineOffsets(normalizeTypographicQuotes(reply)), hit.start);
  return {
    status: "grounded",
    grounding: { quote, start: hit.start, end, channel: hit.channel, line, sentences },
  };
}

// ---------------------------------------------------------------------------
// Deterministic validation
// ---------------------------------------------------------------------------

/** The bounded drop vocabulary — every refusal names exactly one of these. */
export const romanticPermissionDecisionDropReasons = [
  "over_cap",
  "target_player",
  "self_grant",
  "evidence_ungrounded",
  "evidence_ambiguous",
  "evidence_misattributed",
  "evidence_question",
  "evidence_negated",
  "evidence_conditional",
  "evidence_restrained",
  "no_standing_grant",
  "duplicate_direction",
] as const;
export type RomanticPermissionDecisionDropReason = (typeof romanticPermissionDecisionDropReasons)[number];

export interface RomanticPermissionDecisionDrop {
  /** The candidate's index in the parsed output. */
  readonly index: number;
  readonly reason: RomanticPermissionDecisionDropReason;
  /** Bounded human-readable context (a summary or the offending fragment). */
  readonly detail: string;
}

export interface ValidatedRomanticPermissionDecision {
  readonly kind: RomanticPermissionDecisionKind;
  readonly permittedActorRef: ParticipantRef;
  readonly grantingTargetRef: NpcRef;
  /** Absolute start offset of the grounded evidence — ruling 7's same-reply chronology anchor. */
  readonly evidenceOffset: number;
  /** The located quote (normalized, trimmed) — provenance for the durable event. */
  readonly evidenceQuote: string;
}

export interface RomanticPermissionValidationInput {
  /** The COMMITTED assistant reply, exactly as persisted. */
  readonly reply: string;
  readonly digest: RomanticPermissionDigest;
  /** The parsed candidates, in output order. */
  readonly candidates: readonly RomanticPermissionDecisionCandidate[];
}

export interface RomanticPermissionValidation {
  /** Survivors in reply-chronological order (evidence offset ascending) — the events' `orderInSource` order. */
  readonly accepted: readonly ValidatedRomanticPermissionDecision[];
  readonly drops: readonly RomanticPermissionDecisionDrop[];
}

function escapeRegex(token: string): string {
  return token.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * Tokens no attribution regex may be built from: pronouns, articles, copulas,
 * and the commonest connectives.
 *
 * Display names and aliases are PLAYER-AUTHORED profile data. An alias of "she"
 * — or a name of "The Weaver", whose first-name token is "the" — would compile
 * into a target regex that matches nearly every narration sentence, and a
 * target regex that matches everything is not attribution, it is a rubber
 * stamp: it would defeat the misattribution protection between NPCs in an
 * ensemble. Rejecting these is fail-closed in BOTH roles the tokens play:
 *
 * - as the TARGET's tokens, an NPC left with none fails attribution outright
 *   (`nameTokenRe` returns null ⇒ `evidence_misattributed`);
 * - as ANOTHER NPC's tokens, the loss only removes a veto, and the case it
 *   guarded (an ensemble's unattributed line) already fails closed on the
 *   sole-NPC rule below.
 *
 * Only a WHOLE token equal to a stop word is rejected, so a multi-word "The
 * Weaver" still names her. Single-character tokens go too — one letter is not
 * an attribution, it is a wildcard.
 */
const ATTRIBUTION_STOP_TOKENS: ReadonlySet<string> = new Set([
  "i", "me", "my", "mine", "myself",
  "we", "us", "our", "ours", "ourselves",
  "you", "your", "yours", "yourself",
  "he", "him", "his", "himself",
  "she", "her", "hers", "herself",
  "it", "its", "itself",
  "they", "them", "their", "theirs", "themselves",
  "who", "whom", "whose", "one", "ones",
  "a", "an", "the", "this", "that", "these", "those",
  "some", "any", "each", "every", "no", "none", "both", "either", "neither",
  "and", "or", "but", "nor", "so", "as", "if", "then", "than",
  "of", "to", "in", "on", "at", "by", "for", "with", "from", "into", "onto", "over", "under",
  "is", "are", "was", "were", "be", "been", "being", "am",
]);

/** Every written token that names one NPC: display name, aliases, first name. Lowercased, deduped, stop-words rejected. */
function npcNameTokens(digest: RomanticPermissionDigest, ref: NpcRef): readonly string[] {
  const npc = digest.npcs.find((row) => row.ref === ref);
  if (npc === undefined) return [];
  const first = (npc.name.trim().split(/\s+/u)[0] ?? "").toLowerCase();
  const tokens = new Set<string>();
  for (const raw of [npc.name, ...npc.aliases, first]) {
    const token = raw.trim().toLowerCase();
    if (token.length < 2 || ATTRIBUTION_STOP_TOKENS.has(token)) continue;
    tokens.add(token);
  }
  return [...tokens];
}

/** A whole-token regex over written names — possessives allowed (naming is naming, not subjecthood). */
function nameTokenRe(tokens: readonly string[]): RegExp | null {
  if (tokens.length === 0) return null;
  const alternation = [...tokens]
    .sort((left, right) => right.length - left.length || (left < right ? -1 : 1))
    .map(escapeRegex)
    .join("|");
  return new RegExp(`(?<=^|[^\\p{L}'’-])(?:${alternation})(?=$|[^\\p{L}'’-])`, "iu");
}

/**
 * Second-person authorship markers: the reply attributing the words (or the
 * account) to the PLAYER — quoted player speech, echoed player narrator prose,
 * a remembered or imagined line. Any of these beside the evidence means the
 * granting NPC did not author it, and ruling 5 refuses it.
 */
const PLAYER_ECHO_RE =
  /\b(?:you(?:'d|'ve)?|your)\s+(?:had\s+|have\s+|has\s+|just\s+|once\s+)?(?:say|says|said|saying|whisper(?:s|ed|ing)?|murmur(?:s|ed|ing)?|ask(?:s|ed|ing)?|repl(?:y|ies|ied)|tell(?:s|ing)?|told|repeat(?:s|ed|ing)?|echo(?:es|ed|ing)?|breathe[sd]?|mutter(?:s|ed|ing)?|offer(?:s|ed|ing)?|insist(?:s|ed|ing)?|plead(?:s|ed|ing)?|beg(?:s|ged|ging)?|call(?:s|ed|ing)?|wr(?:ite|ites|ote|itten)|typ(?:e|es|ed|ing)|narrat(?:e|es|ed|ing)|remember(?:s|ed|ing)?|recall(?:s|ed|ing)?|imagin(?:e|es|ed|ing)|word(?:s|ed)?|voice[sd]?|note[sd]?|claim(?:s|ed|ing)?|declar(?:e|es|ed|ing)|announc(?:e|es|ed|ing)|phras(?:e|es|ed|ing))\b/iu;

/** Bare third-person subject pronouns — resolvable only in a sole-NPC digest. */
const THIRD_PERSON_RE = /(?<=^|[^\p{L}'’-])(?:she|he|they)(?=$|[^\p{L}'’-])/iu;

/**
 * The narration IMMEDIATELY around the quote, in reply order — at most one
 * sentence before and one after, and only when that neighbour is narration.
 *
 * Bounded to true adjacency on purpose. The re-attribution this feeds
 * (`"You can touch me."` / `That was what you had said, mimicking her voice.`)
 * is by construction the next thing written; a wider sweep would start dropping
 * honest grants over unrelated player prose elsewhere in the same reply, and a
 * neighbour that is itself dialogue ends the scan rather than reaching past it.
 */
function adjacentNarration(
  grounding: RomanticPermissionGrounding,
  allSentences: readonly RomanticPermissionEvidenceSentence[],
): string {
  let before: RomanticPermissionEvidenceSentence | undefined;
  let after: RomanticPermissionEvidenceSentence | undefined;
  for (const sentence of allSentences) {
    if (sentence.end <= grounding.start && (before === undefined || sentence.end > before.end)) before = sentence;
    if (sentence.start >= grounding.end && (after === undefined || sentence.start < after.start)) after = sentence;
  }
  return [before, after]
    .filter((sentence): sentence is RomanticPermissionEvidenceSentence => sentence?.kind === "narration")
    .map((sentence) => sentence.text)
    .join(" ");
}

/**
 * The authorship gate (ruling 5): the evidence must be the granting NPC's OWN
 * dialogue, or narration of THAT NPC's conduct — never the reply quoting or
 * echoing the player, and never another character's words.
 *
 * - **Speech**: the quote's line-mate narration (the attribution clause) is
 *   examined. A player-authorship marker fails; the granting NPC named passes;
 *   a DIFFERENT roster NPC named fails; nobody named passes only in a sole-NPC
 *   digest (a bare dialogue line in a 1-on-1 is the NPC speaking; an
 *   ensemble's unattributed line proves nothing and fails closed).
 * - **Narration**: the overlapped sentences must name the granting NPC (or, in
 *   a sole-NPC digest, carry a bare third-person subject pronoun), and must
 *   not carry a player-authorship marker.
 *
 * Both channels admit one case on the ABSENCE of a counter-signal rather than
 * on positive attribution — the sole-NPC bare dialogue line, and the sole-NPC
 * bare pronoun narration. Those two, and ONLY those two, widen the
 * player-authorship scan to the immediately adjacent narration: a player can
 * steer the narrator into echoing their own words as a standalone line and
 * re-attributing them one line later, and a same-line attribution clause has
 * already returned before the widened scan runs, so it can never override real
 * attribution — it can only refuse an unattributed line the neighbouring prose
 * hands back to the player. The widened scan uses the SAME marker vocabulary
 * (`PLAYER_ECHO_RE`); a false drop here just leaves permission absent, which is
 * the fail-closed direction, while a false admit is manufactured permission.
 */
function attributionDrop(
  digest: RomanticPermissionDigest,
  grantingTargetRef: NpcRef,
  grounding: RomanticPermissionGrounding,
  allSentences: readonly RomanticPermissionEvidenceSentence[],
): "evidence_misattributed" | null {
  const targetRe = nameTokenRe([...npcNameTokens(digest, grantingTargetRef)]);
  if (targetRe === null) return "evidence_misattributed";
  const targetTokens = new Set(npcNameTokens(digest, grantingTargetRef));
  const otherTokens = digest.npcs
    .filter((npc) => npc.ref !== grantingTargetRef)
    .flatMap((npc) => npcNameTokens(digest, npc.ref))
    .filter((token) => !targetTokens.has(token));
  const otherRe = nameTokenRe(otherTokens);
  const sole = digest.npcs.length === 1;
  /** The widened scan: does the neighbouring narration hand these words back to the player? */
  const adjacentEchoDrop = (): "evidence_misattributed" | null =>
    PLAYER_ECHO_RE.test(adjacentNarration(grounding, allSentences)) ? "evidence_misattributed" : null;

  /**
   * Whose words are these when the prose names TWO roster NPCs?
   *
   * `Wren tells Mara, "You can touch me."` names the target (Mara) in its
   * attribution clause, so a bare "is the target named?" test accepts it — and
   * records Wren's offer as Mara's grant. But the mirror image,
   * `Mara tells Wren, "You can touch me."`, is a legitimate NPC-to-NPC grant
   * the spec requires, and it names both NPCs too. Presence alone cannot tell
   * them apart; ORDER can. English attribution puts the speaker first, so the
   * granting NPC must be the FIRST roster name in the clause. Ambiguity (the
   * other NPC named first) drops — a false drop only leaves permission absent.
   */
  const targetNamedFirst = (text: string): boolean => {
    const target = targetRe.exec(text);
    if (target === null) return false;
    if (otherRe === null) return true;
    const other = otherRe.exec(text);
    return other === null || target.index < other.index;
  };

  if (grounding.channel === "speech") {
    // Bind the quote to its NEAREST same-line attribution clause. A whole-line
    // scan confuses two separately attributed quotes on one line: the first
    // speaker's name would wrongly veto the second. Postposed attribution wins
    // when present (`"..." Mara says`); otherwise use the nearest preposed one
    // (`Mara tells Wren, "..."`).
    const sameLineNarration = allSentences.filter(
      (sentence) => sentence.kind === "narration" && sentence.line === grounding.line,
    );
    const after = sameLineNarration
      .filter((sentence) => sentence.start >= grounding.end)
      .sort((left, right) => left.start - right.start)[0];
    const before = sameLineNarration
      .filter((sentence) => sentence.end <= grounding.start)
      .sort((left, right) => right.end - left.end)[0];
    const context = after?.text ?? before?.text ?? "";
    if (PLAYER_ECHO_RE.test(context)) return "evidence_misattributed";
    if (targetNamedFirst(context)) return null;
    if (otherRe !== null && otherRe.test(context)) return "evidence_misattributed";
    return sole ? adjacentEchoDrop() : "evidence_misattributed";
  }

  const text = grounding.sentences.map((sentence) => sentence.text).join(" ");
  if (text.length === 0) return "evidence_misattributed";
  if (PLAYER_ECHO_RE.test(text)) return "evidence_misattributed";
  // Same rule for narrated conduct: `Wren guides Mara's hand to his chest` is
  // Wren's act, not Mara's offer, however plainly Mara is named in it.
  if (targetNamedFirst(text)) return null;
  if (sole && THIRD_PERSON_RE.test(text)) return adjacentEchoDrop();
  return "evidence_misattributed";
}

/**
 * The grant-only structural vetoes (ruling 4: a grant may not be conditional,
 * negated, question-shaped, or restraint-phrased). Run over the SENTENCES the
 * quote overlaps, not the bare quote, so a sub-clause quote cannot launder
 * away its own sentence's "if" or "don't". Denials and withdrawals are exempt
 * — their evidence naturally negates ("not now", "don't touch me anymore").
 */
function grantVetoDrop(
  grounding: RomanticPermissionGrounding,
): "evidence_question" | "evidence_negated" | "evidence_conditional" | "evidence_restrained" | null {
  const scope = grounding.sentences.length > 0 ? grounding.sentences.map((sentence) => sentence.text) : [grounding.quote];
  for (const sentence of scope) {
    if (sentence.includes("?")) return "evidence_question";
    if (hasChatEvidenceNegation(sentence)) return "evidence_negated";
    if (CHAT_CONTACT_CONDITIONAL_RE.test(sentence)) return "evidence_conditional";
    if (CHAT_CONTACT_RESTRAINT_RE.test(sentence)) return "evidence_restrained";
  }
  return null;
}

/**
 * Validate parsed candidates against the committed reply and the digest. PURE
 * and total: same inputs ⇒ same outcome, every refusal a typed drop, nothing
 * repaired. Order of law, per candidate:
 *
 * 1. the cap (`over_cap` — index past `ROMANTIC_PERMISSION_DECISION_CAP`);
 * 2. direction: the granting target must be a roster NPC (`target_player`) and
 *    not the permitted actor (`self_grant`);
 * 3. grounding: the quote exactly once in one admissible span, absolute offset
 *    recorded (ruling 7);
 * 4. authorship: the granting NPC's own words or conduct (ruling 5);
 * 5. grants only: the conditional/negation/question/restraint vetoes;
 * 6. `withdrawn` only, and only ONCE every candidate has been judged: something
 *    it could take back must exist — a CURRENT standing grant in the digest, OR
 *    a candidate `granted` for the same direction that survived steps 1-5 at an
 *    EARLIER evidence offset in this same reply (`no_standing_grant` otherwise —
 *    you cannot take back what stands ungiven);
 * 7. duplicate (actor → target) directions dedupe to the LARGEST evidence
 *    offset (the reply's last word on the direction stands), the loser
 *    dropping `duplicate_direction`.
 *
 * Step 6 is DEFERRED past the per-candidate walk on purpose. Judged inline
 * against the digest alone — the pre-reply projection — a reply that grants and
 * then takes it back (`"You can touch me," … "On second thought — don't touch
 * me anymore."`) dropped its own withdrawal for want of a standing grant, left
 * the grant unopposed in step 7, and recorded a standing grant the same reply
 * had retracted. That is the exact fail-open this owner exists to prevent, so
 * the reply's own accepted grants count as something to withdraw.
 *
 * Survivors return in evidence-offset order — the reply's own written
 * chronology, which is what the events' `orderInSource` then records.
 */
export function validateRomanticPermissionDecisions(
  input: RomanticPermissionValidationInput,
): RomanticPermissionValidation {
  const drops: RomanticPermissionDecisionDrop[] = [];
  const allSentences = romanticPermissionEvidenceSentences(input.reply);
  const drop = (index: number, reason: RomanticPermissionDecisionDropReason, detail: string): void => {
    drops.push({ index, reason, detail: detail.slice(0, DROP_DETAIL_MAX) });
  };

  interface Working {
    readonly index: number;
    readonly kind: RomanticPermissionDecisionKind;
    readonly permittedActorRef: ParticipantRef;
    readonly grantingTargetRef: NpcRef;
    readonly grounding: RomanticPermissionGrounding;
  }
  /** Cleared steps 1-5; a `withdrawn` here still owes step 6. */
  const eligible: Working[] = [];
  const summaryOf = (kind: RomanticPermissionDecisionKind, actor: ParticipantRef, target: ParticipantRef): string =>
    `${kind} ${actor} ← ${target}`;

  input.candidates.forEach((candidate, index) => {
    const summary = summaryOf(candidate.kind, candidate.permittedActorRef, candidate.grantingTargetRef);
    if (index >= ROMANTIC_PERMISSION_DECISION_CAP) {
      drop(index, "over_cap", summary);
      return;
    }
    if (candidate.grantingTargetRef === NPC_SCENE_PLAYER_REF) {
      // The player never authors a standing grant — their reaction is their own
      // (spec §"Direction and participant rules"; ruling 1).
      drop(index, "target_player", summary);
      return;
    }
    const grantingTargetRef = candidate.grantingTargetRef;
    if (candidate.permittedActorRef === grantingTargetRef) {
      drop(index, "self_grant", summary);
      return;
    }
    const grounded = groundRomanticPermissionEvidence(input.reply, candidate.evidenceQuote);
    if (grounded.status === "dropped") {
      drop(index, grounded.reason, summary);
      return;
    }
    const { grounding } = grounded;
    const misattributed = attributionDrop(input.digest, grantingTargetRef, grounding, allSentences);
    if (misattributed !== null) {
      drop(index, misattributed, summary);
      return;
    }
    if (candidate.kind === "granted") {
      const veto = grantVetoDrop(grounding);
      if (veto !== null) {
        drop(index, veto, summary);
        return;
      }
    }
    eligible.push({
      index,
      kind: candidate.kind,
      permittedActorRef: candidate.permittedActorRef,
      grantingTargetRef,
      grounding,
    });
  });

  // Step 6, now that every candidate has been judged: a withdrawal must have
  // something to take back. The digest's standing grants are the pre-reply
  // projection; an accepted `granted` for the SAME direction at an earlier
  // evidence offset is the same reply's own — the retraction of an offer made
  // moments ago is exactly the shape the digest cannot see. Earlier is
  // load-bearing: a withdrawal that PRECEDES the reply's only grant takes back
  // nothing (the reply's last word grants), and it drops here so step 7 leaves
  // the grant standing.
  const withdrawable = (withdrawal: Working): boolean =>
    input.digest.standingGrants.some(
      (grant) =>
        grant.permittedActorRef === withdrawal.permittedActorRef &&
        grant.grantingTargetRef === withdrawal.grantingTargetRef,
    ) ||
    eligible.some(
      (other) =>
        other.kind === "granted" &&
        other.permittedActorRef === withdrawal.permittedActorRef &&
        other.grantingTargetRef === withdrawal.grantingTargetRef &&
        other.grounding.start < withdrawal.grounding.start,
    );
  const surviving: Working[] = [];
  for (const candidate of eligible) {
    if (candidate.kind === "withdrawn" && !withdrawable(candidate)) {
      const summary = summaryOf(candidate.kind, candidate.permittedActorRef, candidate.grantingTargetRef);
      drop(candidate.index, "no_standing_grant", summary);
      continue;
    }
    surviving.push(candidate);
  }

  // Dedupe per direction: the reply's LAST statement about a direction stands.
  //
  // The retracted grant is NOT also emitted. A same-reply grant-then-withdrawal
  // therefore reaches the ledger as the withdrawal ALONE, and the fold
  // (affordances/permission/projection.ts) sets that directional key's standing
  // to `withdrawn` — a tombstone `activeRomanticPermissionGrants` never returns
  // and `derivePermissionPolicyRead` maps to `withdrawn`, so the next attempt is
  // refused. Emitting both in offset order would also end "not standing" (the
  // fold's law 2: the last standing decision for a key wins, and the events are
  // appended in this accepted order), but it is strictly weaker: with an
  // `effectiveBefore` cutoff falling between the two offsets, the grant folds as
  // effective and the withdrawal is excluded as "after", so a contact resolving
  // mid-reply would read `allowed` off an offer the same reply took back. One
  // decision per direction per reply keeps the degraded direction "less is
  // granted" (docs/resilience.md) — and it keeps the ledger's story honest:
  // what the reply ended up saying about the direction is what it recorded.
  const byDirection = new Map<string, Working>();
  for (const candidate of surviving) {
    const key = `${candidate.permittedActorRef}|${candidate.grantingTargetRef}`;
    const held = byDirection.get(key);
    if (held === undefined) {
      byDirection.set(key, candidate);
      continue;
    }
    const keepLater = candidate.grounding.start > held.grounding.start;
    const kept = keepLater ? candidate : held;
    const lost = keepLater ? held : candidate;
    byDirection.set(key, kept);
    drop(lost.index, "duplicate_direction", `${lost.kind} ${key.replace("|", " ← ")}`);
  }

  const accepted = [...byDirection.values()]
    .sort((left, right) => left.grounding.start - right.grounding.start || left.index - right.index)
    .map(
      (candidate): ValidatedRomanticPermissionDecision => ({
        kind: candidate.kind,
        permittedActorRef: candidate.permittedActorRef,
        grantingTargetRef: candidate.grantingTargetRef,
        evidenceOffset: candidate.grounding.start,
        evidenceQuote: candidate.grounding.quote,
      }),
    );
  return { accepted, drops };
}
