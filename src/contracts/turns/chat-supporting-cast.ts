import { z } from "zod";

/**
 * Chat supporting cast (chat-supporting-cast.plan.md): recurring named side
 * characters — the player's coworker, the character's sister — who are NOT
 * character entities and NOT roster members. The scene-memory pattern applied
 * to people: an accumulating, forward-compatible memory of who the fiction has
 * established, kept on the chat-wide scenario (one cast for the whole roster)
 * as a jsonb column so field additions are never migrations.
 *
 * Maintained author-first (the Supporting Cast panel edits the whole list) and
 * reconciled post-turn from the archivist's optional `cast` proposal
 * (`mergeSupportingCast`). Every write is capped + deduped; roster members and
 * the player can never become cast entries (the exclusion list). A bad stored
 * value parses to the empty cast at the trust boundary (docs/resilience.md §1).
 */

/** Cap on cast members — a story's recurring extras, not a census. */
export const SUPPORTING_CAST_MAX = 8;
/** Cap on durable details per member (a person is a few salient touches, not a dossier). */
export const CAST_MAX_DETAILS = 6;
/** Length cap on a member's name. */
export const CAST_NAME_MAX_CHARS = 60;
/** Length cap on the relation phrase ("Riley's coworker and close friend"). */
export const CAST_RELATION_MAX_CHARS = 160;
/** Length cap on a single detail phrase. */
export const CAST_DETAIL_MAX_CHARS = 140;
/** Length cap on the voice note (how they talk). */
export const CAST_VOICE_MAX_CHARS = 200;
/** Length cap on the whereabouts phrase (where they usually are). */
export const CAST_WHEREABOUTS_MAX_CHARS = 120;

const nameString = z.string().trim().min(1).max(CAST_NAME_MAX_CHARS);
const detailString = z.string().trim().min(1).max(CAST_DETAIL_MAX_CHARS);

/** One recurring side character: a name plus the durable texture play established. */
export const supportingCastMemberSchema = z.object({
  name: nameString,
  /** Who they are to the story ("Riley's coworker and close friend"). "" until established. */
  relation: z
    .string()
    .catch("")
    .default("")
    .transform((s) => s.trim().slice(0, CAST_RELATION_MAX_CHARS)),
  details: z
    .array(detailString)
    .catch([])
    .default([])
    .transform((d) => dedupeCap(d, CAST_MAX_DETAILS)),
  /** How they talk — a register/voice note for when the narrator plays them. */
  voice: z.string().trim().min(1).max(CAST_VOICE_MAX_CHARS).optional().catch(undefined),
  /** Where they usually are / were last ("works the front desk at the clinic"). */
  whereabouts: z.string().trim().min(1).max(CAST_WHEREABOUTS_MAX_CHARS).optional().catch(undefined),
});
export type SupportingCastMember = z.infer<typeof supportingCastMemberSchema>;

/**
 * The persisted cast list. The hard cap rides the schema (last N, oldest-out)
 * as a safety net; the merge enforces it too. A bad row parses away.
 */
export const supportingCastSchema = z
  .array(supportingCastMemberSchema)
  .catch([])
  .default([])
  .transform((cast) => cast.slice(-SUPPORTING_CAST_MAX));
export type SupportingCast = z.infer<typeof supportingCastSchema>;

/** The empty cast — the degraded default and the seed value. */
export function emptySupportingCast(): SupportingCast {
  return [];
}

/**
 * The archivist's optional post-turn `cast` proposal: recurring named people the
 * exchange introduced or established something durable about. Lenient — a bad
 * proposal parses to [] and merges as a no-op, so it never fails the turn.
 */
export const chatCastProposalSchema = z
  .array(
    z.object({
      name: nameString,
      relation: z.string().catch("").default(""),
      details: z.array(detailString).catch([]).default([]),
    }),
  )
  .catch([])
  .default([]);
export type ChatCastProposal = z.infer<typeof chatCastProposalSchema>;

const normalizeName = (name: string): string => name.trim().toLowerCase();

/** Dedupe (case-insensitive, first-write-wins on casing), drop blanks, keep the NEWEST `cap`. Pure. */
function dedupeCap(items: readonly string[], cap: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of items) {
    const item = raw.trim();
    const key = normalizeName(item);
    if (!item || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out.slice(-cap);
}

/** True when two member names refer to the same person (case-insensitive, trimmed). */
export function sameCastName(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  return normalizeName(a) === normalizeName(b);
}

/** The cast member by name, or null when the story hasn't established them. */
export function findCastMember(cast: SupportingCast, name: string): SupportingCastMember | null {
  const key = normalizeName(name);
  return cast.find((m) => normalizeName(m.name) === key) ?? null;
}

/**
 * Merge the archivist's post-turn `cast` proposal into the accumulated cast (pure):
 * members upsert by normalized name, details dedupe + cap (oldest-out), and
 * `relation` fills ONLY when the standing entry has none — author edits are
 * canonical, so a proposal never rewrites an established relation. Names on the
 * exclusion list (roster members, the player — full characters must never double
 * as cast entries) drop outright. An empty proposal is a no-op.
 */
export function mergeSupportingCast(
  cast: SupportingCast,
  proposal: ChatCastProposal,
  excludeNames: readonly string[] = [],
): SupportingCast {
  if (!proposal.length) return cast;
  const excluded = new Set(excludeNames.map(normalizeName));
  const out: SupportingCastMember[] = cast.map((m) => ({ ...m, details: [...m.details] }));
  for (const proposed of proposal) {
    const name = proposed.name.trim().slice(0, CAST_NAME_MAX_CHARS);
    const key = normalizeName(name);
    if (!name || excluded.has(key)) continue;
    let member = out.find((m) => normalizeName(m.name) === key);
    if (!member) {
      member = { name, relation: "", details: [] };
      out.push(member);
    }
    if (!member.relation && proposed.relation.trim()) {
      member.relation = proposed.relation.trim().slice(0, CAST_RELATION_MAX_CHARS);
    }
    member.details = dedupeCap([...member.details, ...proposed.details], CAST_MAX_DETAILS);
  }
  return out.slice(-SUPPORTING_CAST_MAX);
}
