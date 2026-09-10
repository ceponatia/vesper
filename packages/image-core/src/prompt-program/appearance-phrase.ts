/**
 * The typed value shape an appearance claim may carry so a prose dialect can
 * compose several of them into one sentence.
 *
 * An appearance fact normally travels as a finished noun phrase — "dark-brown
 * hair", "slender arms" — which every family already words through
 * `describe()`'s `text` member. That is enough to STATE a fact and not enough to
 * JOIN two: "She has dark-brown hair and hair to mid-back" is three separate
 * claims about one head, each carrying its own head noun. Composing them needs
 * the pieces, not the sentences.
 *
 * So a phrased appearance value carries both: `text` is the standalone noun
 * phrase, the answer for every dialect that does not compose, and `phrase` is
 * the same fact taken apart — which feature GROUP it belongs to, what
 * grammatical ROLE the piece plays in that group's sentence, and the FRAGMENT
 * itself. A dialect that groups can then write "healthy dark-brown hair worn
 * loose to mid-back" from four claims, and each claim is still individually
 * present, fitted and recorded in provenance.
 *
 * **No attribute id reaches this layer.** The application's registry owns which
 * fact takes which group and role and what its fragment says; this package owns
 * only the vocabulary those choices are expressed in and how a value declaring
 * one is recognized. A dialect asks {@link imageAppearancePhrase} and gets the
 * pieces or `null`; it never learns that `hair.color` exists.
 */

/**
 * The feature groups a composing dialect writes one clause about.
 *
 * Five real sentence subjects — build, hair, face, skin, eyes — plus `other`,
 * which is the honest answer for a fact that belongs to none of them (a
 * stature, a personal style). An `other` phrase is stated on its own; it never
 * joins another group's clause.
 */
export const imageAppearancePhraseGroups = ["build", "hair", "face", "skin", "eyes", "other"] as const;
export type ImageAppearancePhraseGroup = (typeof imageAppearancePhraseGroups)[number];

/**
 * What a fragment does inside its group's clause.
 *
 * - `adjective` — modifies the group noun: "slim" → "a slim build".
 * - `with` — a whole noun phrase the clause hangs off: "slender arms" → "a slim
 *   build with slender arms".
 * - `trailer` — follows the group noun: "to mid-back" → "hair to mid-back".
 */
export const imageAppearancePhraseRoles = ["adjective", "with", "trailer"] as const;
export type ImageAppearancePhraseRole = (typeof imageAppearancePhraseRoles)[number];

/** One appearance fact taken apart for composition. */
export interface ImageAppearancePhrase {
  readonly group: ImageAppearancePhraseGroup;
  readonly role: ImageAppearancePhraseRole;
  /** The composition piece — "dark-brown", "slender arms", "worn loose". */
  readonly fragment: string;
}

/**
 * A phrased appearance value: the standalone noun phrase, plus the pieces.
 *
 * `text` is what a non-composing dialect says, and it is deliberately the FIRST
 * thing here: every family reads a record's `text` member already, so a dialect
 * that never learns about phrases still words the claim correctly instead of
 * declining it.
 */
export interface ImageAppearancePhraseValue {
  readonly text: string;
  readonly phrase: ImageAppearancePhrase;
}

/**
 * The noun a group's clause is about, or `null` for `other` — which has no
 * shared noun, and whose members are therefore stated standalone.
 */
export function imageAppearancePhraseGroupNoun(group: ImageAppearancePhraseGroup): string | null {
  switch (group) {
    case "build":
      return "build";
    case "hair":
      return "hair";
    case "face":
      return "face";
    case "skin":
      return "skin";
    case "eyes":
      return "eyes";
    case "other":
      return null;
  }
}

/**
 * Whether a group's noun needs an indefinite article in a bare noun phrase.
 *
 * "a slim build" and "an oval face" are countable singulars; "dark-brown hair",
 * "smooth skin" and "hazel eyes" are mass or plural nouns that take none.
 * Getting this wrong produces "She has oval face", which is why it is a
 * property of the group rather than a guess at each call site.
 */
export function imageAppearancePhraseGroupTakesArticle(group: ImageAppearancePhraseGroup): boolean {
  return group === "build" || group === "face";
}

/**
 * The indefinite article for a phrase that starts with `text`.
 *
 * A first-letter rule, and deliberately not more: the vocabulary this serves is
 * a closed registry of appearance words with no "hour"/"unicorn" spellings in
 * it, and a pronunciation dictionary would be a large machine defending a case
 * that does not occur. A word that ever needs the other answer states its own
 * article in the registry instead.
 */
export function imageAppearanceIndefiniteArticle(text: string): "a" | "an" {
  return /^[aeiou]/iu.test(text.trim()) ? "an" : "a";
}

function isPhraseGroup(value: unknown): value is ImageAppearancePhraseGroup {
  return typeof value === "string" && (imageAppearancePhraseGroups as readonly string[]).includes(value);
}

function isPhraseRole(value: unknown): value is ImageAppearancePhraseRole {
  return typeof value === "string" && (imageAppearancePhraseRoles as readonly string[]).includes(value);
}

/**
 * Read a claim value as a phrased appearance value, or `null`.
 *
 * A narrowing reader in the shape of `imageSceneStagingForm` beside it: it
 * checks the fields it is about to use, returns a normalized record built from
 * them, and never throws on any input. `null` means "this is not a phrase" —
 * for a plain string value, for a record from some other owner, and for a
 * malformed one — and every caller already has an answer for that, because
 * every value reaching a dialect could always be a bare string.
 *
 * The returned record is rebuilt rather than cast, so an unrelated member
 * riding the same object cannot travel on into a prompt.
 */
export function imageAppearancePhrase(value: unknown): ImageAppearancePhraseValue | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const text = candidate["text"];
  if (typeof text !== "string" || text.trim().length === 0) return null;
  const phrase = candidate["phrase"];
  if (phrase === null || typeof phrase !== "object" || Array.isArray(phrase)) return null;
  const parts = phrase as Record<string, unknown>;
  const group = parts["group"];
  const role = parts["role"];
  const fragment = parts["fragment"];
  if (!isPhraseGroup(group) || !isPhraseRole(role)) return null;
  if (typeof fragment !== "string" || fragment.trim().length === 0) return null;
  return { text: text.trim(), phrase: { group, role, fragment: fragment.trim() } };
}
