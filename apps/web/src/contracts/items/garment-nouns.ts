/**
 * Garment IDENTITIES for the chat lane's wardrobe folds: the vocabulary that
 * names which garments a stretch of free text mentions. Three consumers:
 *
 * - **Telemetry** (chat-state's outfit folds) — a KEPT restatement can report
 *   the garments it named that no worn item accounts for, the observable trace
 *   of a change the guard may have missed.
 * - **Delta matching** (`chat-wardrobe.ts`'s `matchGarment`) — where the
 *   archivist's typed `removed`/`added` phrases ARE the change grammar, so the
 *   only question left is which worn/pool item each phrase names. Identity gates
 *   that match: both sides fold through this table, so a plural, an alias or a
 *   compound resolves to the right garment, and adjective/material overlap can
 *   never pick a mistyped one ("leather boots" ≠ a leather jacket).
 * - **Coverage** (`garment-noun-coverage.ts`) — where a named garment in the
 *   free-text overlay contributes real coverage to the exposure read. It scans
 *   positionally (`garmentIdentityAt` over `garmentNounTokens`) because it cares
 *   WHERE each garment was named, but reads this same vocabulary.
 *
 * **It does not decide keep-vs-replace** (owner ruling, 2026-08-01). That
 * decision belongs to the archivist's verbatim `changeEvidence`, validated
 * against the exchange text (`outfitChangeEvidenceValidated` in
 * `server/engine/chat-state/outfit-evidence.ts`): a whole-look description replaces the modelled
 * wardrobe only when the exchange itself says the outfit CHANGED. A noun list
 * could never make that call — "a black silk shirt" over a worn "soft cotton
 * shirt" shares its head noun and IS a change, while "her white cotton t-shirt"
 * over a worn "white cotton tee" is a different word for the SAME garment.
 *
 * Registry rules (CLAUDE.md): vocabulary changes are data edits here, never
 * schema or logic changes.
 *
 * **Precision beats recall in this set.** A missing entry costs a line of
 * telemetry detail and drops matching back to raw token overlap; an over-eager
 * one names a garment nobody was wearing, on both consumers. So
 * ambiguous tokens stay out AS UNIGRAMS even though they can name garments:
 * "top" (top button), "tie"/"ties" (ties at the waist), "hood" (hood of a worn
 * hoodie), "slip" (verb), "pumps" (espresso), "flats" (housing), "trainers"
 * (people). Excluding the bare "top" is only affordable because the genuine
 * compounds — "tank top", "crop top" — are recognized as multiword heads.
 *
 * Every spelling of one garment folds to ONE canonical identity (boot/boots,
 * tee/t-shirt/tshirts, jacket/jackets), so a plural or an alias is never
 * mistaken for a garment nobody is wearing.
 */

/**
 * Garments whose canonical identity is the SINGULAR; the regular plural folds
 * onto it ("jackets" → "jacket", "dresses" → "dress").
 */
const GARMENT_SINGULARS = [
  // tops
  "shirt",
  "blouse",
  "camisole",
  "chemise",
  "tunic",
  "turtleneck",
  "sweater",
  "jumper",
  "cardigan",
  "hoodie",
  "sweatshirt",
  "pullover",
  "vest",
  "waistcoat",
  // outerwear
  "jacket",
  "coat",
  "blazer",
  "parka",
  "anorak",
  "windbreaker",
  "overcoat",
  "raincoat",
  "trenchcoat",
  "cloak",
  "cape",
  "poncho",
  "shawl",
  "scarf",
  // whole-body
  "dress",
  "sundress",
  "gown",
  "nightgown",
  "negligee",
  "robe",
  "bathrobe",
  "kimono",
  "yukata",
  "sari",
  "toga",
  "jumpsuit",
  "romper",
  "suit",
  "tuxedo",
  "uniform",
  "costume",
  "apron",
  "swimsuit",
  "bikini",
  "leotard",
  "corset",
  "bodice",
  // bottoms
  "skirt",
  // underwear
  "bra",
  "bralette",
  "underwear",
  "thong",
  "lingerie",
  "garter",
  // footwear
  "sock",
  "shoe",
  "boot",
  // hands / head
  "glove",
  "hat",
  "beanie",
  "helmet",
  // fantasy / armor
  "armor",
  "breastplate",
  "chainmail",
] as const;

/**
 * Inherently-plural garments: the bare form IS the identity. Never stripped to a
 * bogus singular ("jean", "trouser", "greave") — an s-stripping rule applied to
 * these would mint identities no worn item name can ever match.
 */
const GARMENT_PLURALS = [
  // bottoms
  "jeans",
  "pants",
  "trousers",
  "slacks",
  "chinos",
  "leggings",
  "tights",
  "shorts",
  "pantyhose",
  // underwear
  "panties",
  "briefs",
  "boxers",
  "stockings",
  // footwear
  "sneakers",
  "sandals",
  "slippers",
  "loafers",
  "heels",
  "stilettos",
  // hands
  "mittens",
  // whole-body
  "overalls",
  "dungarees",
  "pajamas",
  // fantasy / armor
  "gauntlets",
  "greaves",
] as const;

/**
 * Alias groups — every spelling/plural of ONE garment, folded to one identity.
 * This is what makes "her white cotton t-shirt" and a worn "white cotton tee"
 * the same garment rather than two, and it is where irregular plurals
 * ("scarves") and regional spellings ("pyjamas", "armour") live.
 */
const GARMENT_ALIASES: readonly (readonly [string, readonly string[]])[] = [
  ["tee", ["tee", "tees", "t-shirt", "t-shirts", "tshirt", "tshirts"]],
  ["scarf", ["scarves"]],
  ["pajamas", ["pyjamas"]],
  ["armor", ["armour", "armours"]],
];

/**
 * Unambiguous multiword heads, recognized as single identities. Scanned BEFORE
 * any unigram (and consuming both tokens), which is what lets the ambiguous
 * "top" stay out of the registry while "a paint-streaked tank top" still names a
 * garment. "sports bra" and "dress shirt" fold onto the plain garment they are:
 * a description saying "dress shirt" must not read as naming a dress.
 */
const GARMENT_COMPOUNDS: ReadonlyMap<string, string> = new Map([
  ["tank top", "tank_top"],
  ["crop top", "crop_top"],
  ["tube top", "tube_top"],
  ["sports bra", "bra"],
  ["dress shirt", "shirt"],
  // Bikini SEPARATES are their own identities, never the pair. Coverage is the
  // reason: bare "bikini" claims chest AND pelvis, so without these a bikini top
  // covered the pelvis and bottoms covered the chest — anatomy suppressed on a
  // garment that is demonstrably not there (garment-noun-coverage.ts). Distinct
  // identities also give the archivist's matcher two things to tell apart, so
  // "she unties the bikini top" can never resolve to the bottoms.
  ["bikini top", "bikini_top"],
  ["bikini tops", "bikini_top"],
  ["bikini bottom", "bikini_bottom"],
  ["bikini bottoms", "bikini_bottom"],
]);

/** The regular English plural of a registry singular (the only forms folded automatically). */
function regularPlural(word: string): string {
  if (/(?:s|x|z|ch|sh)$/.test(word)) return `${word}es`;
  if (/[^aeiou]y$/.test(word)) return `${word.slice(0, -1)}ies`;
  return `${word}s`;
}

/** variant token → canonical identity. Built once; the data above is the only edit surface. */
function buildGarmentIdentities(): ReadonlyMap<string, string> {
  const identities = new Map<string, string>();
  for (const word of GARMENT_SINGULARS) {
    identities.set(word, word);
    identities.set(regularPlural(word), word);
  }
  for (const word of GARMENT_PLURALS) identities.set(word, word);
  for (const [identity, variants] of GARMENT_ALIASES) {
    for (const variant of variants) identities.set(variant, identity);
  }
  return identities;
}

const GARMENT_IDENTITIES = buildGarmentIdentities();

/**
 * The canonical garment identity a (lowercased) token names, or undefined when
 * it names none. Every variant of one garment answers with the SAME string —
 * `garmentNounOf("boot") === garmentNounOf("boots")` — so a plural, an irregular
 * plural, or an alias spelling can never read as a second, foreign garment.
 */
export function garmentNounOf(token: string): string | undefined {
  return GARMENT_IDENTITIES.get(token);
}

/**
 * The chat lane's garment word tokens (lowercased). A hyphenated compound stays
 * ONE token — "lace-trimmed" is not "lace" — so a trim or material adjective can
 * never read as the thing itself.
 */
export function garmentNounTokens(text: string): string[] {
  return text.toLowerCase().match(/[a-z][a-z'’-]*/g) ?? [];
}

/** A garment identity read at one token position, with the tokens it consumed. */
export interface GarmentIdentityMatch {
  identity: string;
  /** 2 for a compound head ("tank top"), 1 for a unigram. */
  length: 1 | 2;
}

/**
 * The garment identity starting at `index` — COMPOUNDS first (two tokens), then
 * the unigram fold. Positional, so a caller that cares WHERE a garment was named
 * (the overlay-coverage scanner's sheer window, garment-noun-coverage.ts) reads
 * the same vocabulary `garmentIdentitiesIn` does instead of re-deriving the
 * compound table.
 */
export function garmentIdentityAt(tokens: readonly string[], index: number): GarmentIdentityMatch | undefined {
  const head = tokens[index];
  if (head === undefined) return undefined;
  const next = tokens[index + 1];
  const compound = next === undefined ? undefined : GARMENT_COMPOUNDS.get(`${head} ${next}`);
  if (compound !== undefined) return { identity: compound, length: 2 };
  const identity = garmentNounOf(head);
  return identity === undefined ? undefined : { identity, length: 1 };
}

/**
 * Every garment identity named in a stretch of text — a description, or a worn
 * item's name. Tokenizes with the chat lane's word pattern, takes adjacent-token
 * COMPOUNDS first (consuming both tokens), then unigrams via `garmentNounOf`.
 *
 * Both sides of a comparison — telemetry's foreign-garment check and
 * `matchGarment`'s identity gate alike — go through this one function, so
 * "leather boots" over a worn "leather boot" compares equal.
 */
export function garmentIdentitiesIn(text: string): Set<string> {
  const tokens = garmentNounTokens(text);
  const found = new Set<string>();
  for (let i = 0; i < tokens.length; i += 1) {
    const match = garmentIdentityAt(tokens, i);
    if (match === undefined) continue;
    found.add(match.identity);
    i += match.length - 1;
  }
  return found;
}
