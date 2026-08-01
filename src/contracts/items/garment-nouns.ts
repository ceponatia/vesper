/**
 * Garment head-nouns for the outfit restatement guard (chat-state's
 * `outfitDescriptionRestatesWorn`): the vocabulary that decides whether a
 * whole-look outfit description names a garment FOREIGN to the structured worn
 * list — the positive evidence of a genuinely different look, as opposed to a
 * narration-only restatement ("sleeves shoved past her elbows") that must not
 * demote a modelled wardrobe to free text.
 *
 * Registry rules (CLAUDE.md): vocabulary changes are data edits here, never
 * schema or logic changes.
 *
 * **Precision beats recall in this set.** A noun missing from the list makes
 * the guard KEEP the modelled wardrobe (the safe direction — the store stays
 * structured and the next explicit change still applies); an over-eager entry
 * wrongly WIPES it, which is exactly the defect the guard exists to stop. So
 * ambiguous tokens stay out even though they can name garments: "top" (top
 * button), "tie"/"ties" (ties at the waist), "hood" (hood of a worn hoodie),
 * "slip" (verb), "pumps" (espresso), "flats" (housing), "trainers" (people).
 */
const GARMENT_NOUN_LIST = [
  // tops
  "shirt",
  "tee",
  "t-shirt",
  "tshirt",
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
  "overalls",
  "dungarees",
  "suit",
  "tuxedo",
  "uniform",
  "costume",
  "apron",
  "pajamas",
  "pyjamas",
  "swimsuit",
  "bikini",
  "leotard",
  "corset",
  "bodice",
  // bottoms
  "skirt",
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
  "bra",
  "bralette",
  "panties",
  "briefs",
  "boxers",
  "underwear",
  "thong",
  "lingerie",
  "garter",
  "stockings",
  // footwear
  "sock",
  "socks",
  "shoe",
  "shoes",
  "boot",
  "boots",
  "sneakers",
  "sandals",
  "slippers",
  "loafers",
  "heels",
  "stilettos",
  // hands / head
  "glove",
  "gloves",
  "mittens",
  "hat",
  "beanie",
  "helmet",
  // fantasy / armor
  "armor",
  "armour",
  "breastplate",
  "gauntlets",
  "greaves",
  "chainmail",
] as const;

const GARMENT_NOUNS: ReadonlySet<string> = new Set(GARMENT_NOUN_LIST);

/**
 * Words that CLAIM an undressed body outright. A description carrying one is
 * never a restatement of a dressed worn list, even with no garment noun in it.
 * Deliberately excludes "bare"/"stripped" — routine styling narration ("her
 * forearms bare where the sleeves are pushed up") must not read as undress.
 */
const UNDRESS_WORDS: ReadonlySet<string> = new Set([
  "naked",
  "nude",
  "undressed",
  "unclothed",
  "topless",
  "bottomless",
]);

/** True when this (lowercased) token claims an undressed body. */
export function isUndressWord(token: string): boolean {
  return UNDRESS_WORDS.has(token);
}

/**
 * The canonical garment noun a (lowercased) token names, or undefined when it
 * names none. Folds simple plurals — "jackets" → "jacket", "dresses" →
 * "dress" — by trying the stripped forms against the set, so "dress" itself
 * never mis-strips.
 */
export function garmentNounOf(token: string): string | undefined {
  if (GARMENT_NOUNS.has(token)) return token;
  if (token.endsWith("es")) {
    const stem = token.slice(0, -2);
    if (GARMENT_NOUNS.has(stem)) return stem;
  }
  if (token.endsWith("s")) {
    const stem = token.slice(0, -1);
    if (GARMENT_NOUNS.has(stem)) return stem;
  }
  return undefined;
}
