import { clothingCategoryById } from "./clothing-categories";
import { garmentIdentityAt, garmentNounTokens, type GarmentIdentityMatch } from "./garment-nouns";
import type { ClothingLayer } from "./item";
import type { WornItemInput } from "./visibility";

/**
 * COVERAGE from garment nouns in free text — the chat lane's wardrobe overlay
 * ("Also / instead" on the character sheet, `outfit` on chat state) turned into
 * the same coverage rows a real worn item produces. Two consumers, both in
 * `server/engine/chat-wardrobe.ts`:
 *
 * - **`resolveChatWardrobe`** — on the structured path the rows are UNIONED with
 *   the real worn items before `exposedRegions`, and on the free-text path they
 *   are the only wardrobe there is.
 * - **`resolvePlayerWardrobe`** — the persona twin, same two shapes.
 *
 * The defect this exists for: an overlay reading "pale lavender gown with
 * delicate beading" contributed ZERO coverage, so a character in a thong plus
 * that gown computed `torso: "bare"` and the scene-image prompt emitted intimate
 * chest anatomy — nipples rendered through the described gown.
 *
 * **These rows only ever reach `exposedRegions`.** They are never handed to the
 * occlusion resolver, the garment cue ranker, or the affordance coverage read —
 * nobody may take a synthetic row for a garment the wardrobe actually owns. Two
 * things follow: on the structured path text can only ADD coverage (the SFW-safe
 * direction — it can hide anatomy, never bare it), and a template's incidental
 * non-exposure ids (the `top` template's `shoulders` under a tube top) cost
 * nothing, because only chest / groin-hips-buttocks / thighs / feet are read.
 *
 * **Precision beats recall**, harder than in the noun registry itself: an
 * unmapped noun contributes nothing, which is exactly today's behavior and
 * therefore safe, while a wrong mapping suppresses or reveals anatomy that the
 * fiction did not ask for. So ambiguous-coverage garments are deliberately absent
 * from the table below even though the noun registry knows them.
 *
 * **A named garment is not a worn one.** "without a shirt", "no panties", "her
 * shirt hanging open", "gown pooled at her waist" all NAME clothing while saying
 * it is not covering anything, so `negationMarkers` / `displacementMarkers`
 * suppress the row entirely. The failure directions are asymmetric and decide the
 * design: suppressing wrongly costs nothing — that garment contributes nothing,
 * which is the pre-overlay behavior, and on the free-text path the caller's
 * intimate-region gate then keeps the covered default — while MISSING a
 * displacement over-covers, and over-covering a bared body is the failure this
 * module exists to make impossible in the other direction. Under-covering a
 * genuinely worn garment is the one thing that must never happen, which is why
 * negation is window-scoped with conjunction inheritance rather than
 * clause-scoped: clause-scoped, "no bra under her sweater, jeans" would strip the
 * sweater and bare the torso.
 *
 * Registry rules (CLAUDE.md): vocabulary and coverage changes are data edits in
 * the tables below, never logic changes. Coverage ids come from the
 * `clothing-categories.ts` templates wherever one fits, so the id lists live in
 * ONE place and a template edit reaches both authoring and this read.
 */

/** What one named garment contributes: body-location ids + the layer they sit at. */
export interface GarmentNounCoverage {
  coverage: readonly string[];
  layer: ClothingLayer;
}

/**
 * A clothing-category template as an overlay mapping. A missing category
 * degrades to no coverage (contracts never throw, docs/resilience.md) — an empty
 * row simply contributes nothing, which is this module's safe direction.
 */
function fromCategory(categoryId: string): GarmentNounCoverage {
  const category = clothingCategoryById(categoryId);
  return { coverage: category?.coverage ?? [], layer: category?.layer ?? 1 };
}

const TOP = fromCategory("top");
const OUTERWEAR = fromCategory("outerwear");
const DRESS = fromCategory("dress");
const PANTS = fromCategory("pants");
const SHORTS = fromCategory("shorts");
const SKIRT = fromCategory("skirt");
const BRA = fromCategory("bra");
const UNDERWEAR = fromCategory("underwear");
const SOCKS = fromCategory("socks");
const FOOTWEAR = fromCategory("footwear");
const GLOVES = fromCategory("gloves");
const HEADWEAR = fromCategory("headwear");

/** Torso + pelvis, silent about the legs — a one-piece that stops at the hip. */
const TORSO_PIECE: GarmentNounCoverage = { coverage: [...TOP.coverage, "pelvis"], layer: 1 };
/** Torso through the ankle — the trousered one-pieces. */
const FULL_SUIT: GarmentNounCoverage = { coverage: [...TOP.coverage, ...PANTS.coverage], layer: 1 };
/** Torso to mid-thigh — a romper is a shorts-legged suit. */
const SHORT_SUIT: GarmentNounCoverage = { coverage: [...TOP.coverage, ...SHORTS.coverage], layer: 1 };
/** Chest + pelvis only: the two panels a bikini is, with everything else bare. */
const TWO_PIECE: GarmentNounCoverage = { coverage: ["chest", "pelvis"], layer: 1 };
/** ONE panel of that pair: a top claims the chest and says nothing about the pelvis… */
const BIKINI_TOP: GarmentNounCoverage = { coverage: ["chest"], layer: 1 };
/** …and bottoms claim the pelvis and say nothing about the chest. */
const BIKINI_BOTTOM: GarmentNounCoverage = { coverage: ["pelvis"], layer: 1 };
/** The same two panels worn as underwear (a lingerie SET — the noun implies both halves). */
const INTIMATE_SET: GarmentNounCoverage = { coverage: ["chest", "pelvis"], layer: 0 };
/** Laced torso piece — chest and trunk, nothing below the waist. */
const BODICE: GarmentNounCoverage = { coverage: ["chest", "back", "waist"], layer: 1 };
/** Front-only cover: it hangs over whatever is under it, and covers no back. */
const APRON: GarmentNounCoverage = { coverage: ["chest", "waist"], layer: 3 };
/** Waist-to-toe hosiery. */
const HOSIERY: GarmentNounCoverage = { coverage: ["pelvis", "thighs", "calves", "ankles", "feet"], layer: 0 };
/** Thigh-to-toe hosiery — stockings deliberately claim NO pelvis. */
const LEG_HOSIERY: GarmentNounCoverage = { coverage: ["thighs", "calves", "ankles", "feet"], layer: 0 };
/** Torso plate, worn over everything. */
const CUIRASS: GarmentNounCoverage = { coverage: ["chest", "back", "waist"], layer: 3 };
/** Shin plate. */
const GREAVES: GarmentNounCoverage = { coverage: ["calves"], layer: 3 };

/**
 * Garment identity (`garment-nouns.ts`) → the coverage it contributes.
 *
 * Absent on purpose — named here rather than listed in code, so nobody can wire
 * the exclusions up by accident: **scarf · shawl · cape · poncho · cloak ·
 * garter · costume**. A cloak or cape hangs off the shoulders and may cover the chest or
 * hang open behind it; a costume is whatever the author says it is; a garter
 * covers a thigh band nobody's exposure read cares about. Any of them mapped
 * would suppress anatomy on nothing better than a guess.
 */
export const garmentNounCoverage: ReadonlyMap<string, GarmentNounCoverage> = new Map<string, GarmentNounCoverage>([
  // Tops. Every one covers the chest, which is the only exposure claim taken
  // from them — sleeve length and neckline are the template's, not the garment's.
  ["shirt", TOP],
  ["blouse", TOP],
  ["camisole", TOP],
  ["chemise", TOP],
  ["tunic", TOP],
  ["turtleneck", TOP],
  ["sweater", TOP],
  ["jumper", TOP],
  ["cardigan", TOP],
  ["hoodie", TOP],
  ["sweatshirt", TOP],
  ["pullover", TOP],
  ["vest", TOP],
  ["waistcoat", TOP],
  ["tee", TOP],
  ["tank_top", TOP],
  // A crop top bares the midriff, never the chest — and `waist` is not an
  // exposure region, so the template's extra reach is inert here.
  ["crop_top", TOP],
  ["tube_top", TOP],
  // Outerwear — layer 3, over whatever else the text names.
  ["jacket", OUTERWEAR],
  ["coat", OUTERWEAR],
  ["blazer", OUTERWEAR],
  ["parka", OUTERWEAR],
  ["anorak", OUTERWEAR],
  ["windbreaker", OUTERWEAR],
  ["overcoat", OUTERWEAR],
  ["raincoat", OUTERWEAR],
  ["trenchcoat", OUTERWEAR],
  // Whole-body: torso through the calves.
  ["dress", DRESS],
  ["sundress", DRESS],
  ["gown", DRESS],
  ["nightgown", DRESS],
  // Negligees and nightgowns are often see-through — but only when the TEXT says
  // so (`sheerModifiers`); the noun alone never implies it.
  ["negligee", DRESS],
  ["robe", DRESS],
  ["bathrobe", DRESS],
  ["kimono", DRESS],
  ["yukata", DRESS],
  ["sari", DRESS],
  ["toga", DRESS],
  // A uniform reliably covers torso and pelvis; its hem is anyone's guess
  // (a skirted uniform stops mid-thigh), so it claims no legs.
  ["uniform", TORSO_PIECE],
  ["jumpsuit", FULL_SUIT],
  ["overalls", FULL_SUIT],
  ["dungarees", FULL_SUIT],
  ["pajamas", FULL_SUIT],
  ["suit", FULL_SUIT],
  ["tuxedo", FULL_SUIT],
  ["romper", SHORT_SUIT],
  ["swimsuit", TORSO_PIECE],
  ["leotard", TORSO_PIECE],
  // The pair covers both panels; each SEPARATE covers only its own. The split is
  // vocabulary, not logic — `garment-nouns.ts` scans "bikini top" / "bikini
  // bottoms" as compound heads before the bare unigram can claim them.
  ["bikini", TWO_PIECE],
  ["bikini_top", BIKINI_TOP],
  ["bikini_bottom", BIKINI_BOTTOM],
  ["corset", BODICE],
  ["bodice", BODICE],
  ["apron", APRON],
  // Bottoms.
  ["skirt", SKIRT],
  ["shorts", SHORTS],
  ["jeans", PANTS],
  ["pants", PANTS],
  ["trousers", PANTS],
  ["slacks", PANTS],
  ["chinos", PANTS],
  ["leggings", PANTS],
  ["tights", HOSIERY],
  ["pantyhose", HOSIERY],
  ["stockings", LEG_HOSIERY],
  // Underwear.
  ["bra", BRA],
  ["bralette", BRA],
  ["underwear", UNDERWEAR],
  ["panties", UNDERWEAR],
  ["thong", UNDERWEAR],
  ["briefs", UNDERWEAR],
  ["boxers", UNDERWEAR],
  ["lingerie", INTIMATE_SET],
  // Footwear + extremities. Exposure-irrelevant for the intimate regions, but a
  // named boot is what keeps a structured look from reading barefoot.
  ["sock", SOCKS],
  ["shoe", FOOTWEAR],
  ["boot", FOOTWEAR],
  ["sneakers", FOOTWEAR],
  ["sandals", FOOTWEAR],
  ["slippers", FOOTWEAR],
  ["loafers", FOOTWEAR],
  ["heels", FOOTWEAR],
  ["stilettos", FOOTWEAR],
  ["glove", GLOVES],
  ["mittens", GLOVES],
  ["hat", HEADWEAR],
  ["beanie", HEADWEAR],
  ["helmet", HEADWEAR],
  // Armor.
  ["armor", CUIRASS],
  ["breastplate", CUIRASS],
  ["chainmail", CUIRASS],
  ["gauntlets", GLOVES],
  ["greaves", GREAVES],
]);

/**
 * Words that make the garment they qualify see-through. Registry-style: adding a
 * synonym is a line here. Deliberately narrow — a modifier wrongly applied turns
 * a covered region into a stated-sheer one, which is anatomy the fiction did not
 * ask for.
 *
 * "lace"/"lacy" are in, but the tokenizer keeps hyphenated compounds whole
 * (`garmentNounTokens`), so "a lace-trimmed cotton robe" reads OPAQUE — the trim is
 * not the fabric. That is the intended behavior of the choice, not a side effect.
 */
export const sheerModifiers: ReadonlySet<string> = new Set([
  "sheer",
  "see-through",
  "seethrough",
  "transparent",
  "translucent",
  "gauzy",
  "gossamer",
  "diaphanous",
  "mesh",
  "lace",
  "lacy",
  "fishnet",
]);

/**
 * Words that DENY the garment named after them. Read in the PRE-noun window only
 * (the same window the sheer scan reads), because that is where English puts
 * them: "without a shirt", "no panties", "sans corset". A denial past the noun
 * ("a shirt? she has none") is prose this scanner is not trying to parse.
 *
 * Registry-style, and deliberately narrow: every word here is unambiguously a
 * denial in a wardrobe description. "bare" and "naked" are absent on purpose —
 * they describe the BODY, not the garment beside them, and "bare shoulders over a
 * silk dress" must leave the dress covering.
 */
export const negationMarkers: ReadonlySet<string> = new Set([
  "no",
  "without",
  "sans",
  "minus",
  "lacking",
  "missing",
]);

/**
 * Words that say a named garment is open, displaced, or off the body — worn in
 * the fiction, but not covering what its coverage list claims. Read in BOTH
 * windows around the noun, because English puts them on either side:
 * "unbuttoned jacket" before, "her shirt hanging open" and "gown pooled at her
 * waist" after.
 *
 * Wider than `negationMarkers` on purpose. A wrong suppression costs the garment's
 * coverage (benign — see the module comment); a missed displacement leaves bared
 * anatomy classified as covered, which is the read the archivist's `exposed`
 * flag has to fight. "over" and "under" are NOT here: they are layering
 * prepositions, and "a jacket over a tee" dresses her twice.
 */
export const displacementMarkers: ReadonlySet<string> = new Set([
  "open",
  "unbuttoned",
  "unzipped",
  "undone",
  "unfastened",
  "unlaced",
  "untied",
  "unhooked",
  "unclasped",
  "pooled",
  "pushed",
  "tugged",
  "hiked",
  "bunched",
  "shoved",
  "hanging",
  "fallen",
  "slipping",
  "slipped",
  "lowered",
  "dropped",
  "discarded",
  "removed",
  "shed",
  "doffed",
  "stripped",
  "off",
  "aside",
  "askew",
  "around",
]);

/**
 * The ONLY words a window may contain and still carry the previous noun's
 * negation across it — conjunctions, articles, possessives. "without a shirt or
 * bra" denies both, because "or" alone joins them into one denial.
 *
 * Tiny on purpose: any other word breaks the carry, which is what keeps "no bra
 * under her sweater" from stripping the sweater ("under her" is not pure filler,
 * so the sweater states its own coverage). That scoping is the whole reason
 * negation is not clause-wide.
 */
export const negationCarryWords: ReadonlySet<string> = new Set([
  "and",
  "or",
  "nor",
  "a",
  "an",
  "the",
  "her",
  "his",
  "their",
  "its",
  "my",
  "your",
  "own",
]);

/** Synthetic-row id prefix — never collides with a real instance or definition id. */
const OVERLAY_ROW_PREFIX = "overlay:";

/**
 * A modifier only reaches past a comma if we let it, and we do not: "a
 * lace-trimmed cotton robe, sheer stockings" must leave the robe opaque.
 */
const CLAUSE_BOUNDARY = /[,;.\n]+/;

/** One clause as the garment nouns it names plus the token windows around them. */
interface ClauseScan {
  /** The garment nouns, in order — mapped or not; an unmapped one still bounds a window. */
  nouns: GarmentIdentityMatch[];
  /**
   * `windows[k]` is every non-noun token between noun `k - 1` and noun `k`
   * (window 0 starts at the clause start, the last runs to the clause end), so
   * there is always exactly one more window than noun. A noun's PRE window is
   * `windows[k]` and its POST window is `windows[k + 1]` — literally the span the
   * next noun reads as its own pre window, which is why one array answers every
   * modifier question here and no second scan can disagree with the first.
   */
  windows: string[][];
}

/** Split one clause into nouns + windows. Total: text naming nothing yields one empty window. */
function scanClause(tokens: readonly string[]): ClauseScan {
  const nouns: GarmentIdentityMatch[] = [];
  const windows: string[][] = [[]];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === undefined) continue;
    const match = garmentIdentityAt(tokens, i);
    if (match === undefined) {
      windows[windows.length - 1]?.push(token);
      continue;
    }
    // A garment noun closes the window whether or not this module maps it, and
    // whether or not it ends up suppressed: it was NAMED, so the modifiers beside
    // it were its modifiers, not the next garment's.
    nouns.push(match);
    windows.push([]);
    i += match.length - 1;
  }
  return { nouns, windows };
}

/** Does this window carry any word from a marker registry? */
function windowHas(window: readonly string[], markers: ReadonlySet<string>): boolean {
  return window.some((token) => markers.has(token));
}

/**
 * Coverage rows for the garments a stretch of overlay text names — one row per
 * canonical identity, mapped and unsuppressed ones only.
 *
 * **The windows.** Every scan here reads the tokens between two garment nouns
 * (or between a noun and the clause edge); clause boundaries (`,` `;` `.`
 * newline) end them.
 *
 * - **Sheer** reads the PRE window: a modifier there makes THIS garment sheer and
 *   is then spent, so "a sheer robe over a shift" leaves the shift opaque and "a
 *   sheer black negligee" reads sheer through two intervening adjectives.
 * - **Negation** reads the PRE window too, and SUPPRESSES the row: "without a
 *   shirt" names a shirt that is not on. It carries to the next noun when the
 *   window between them is nothing but `negationCarryWords` ("without a shirt or
 *   bra" denies both; "no bra under her sweater" denies only the bra) — an empty
 *   window carries vacuously, which is the same reading.
 * - **Displacement** reads BOTH windows and suppresses: "unbuttoned jacket" puts
 *   the marker before the noun, "her shirt hanging open" after it.
 *
 * A suppressed noun contributes nothing but still bounds its neighbors' windows,
 * exactly as an unmapped one does. Suppression never DELETES a row an earlier
 * clause affirmed — "a linen shirt, then no shirt" keeps the cover, the safe
 * direction (see the module comment on failure directions).
 *
 * One identity named twice keeps the most-covering read (opaque wins), the same
 * direction the rest of this module leans.
 *
 * PURE and total: odd text simply yields fewer rows, never a throw.
 */
export function overlayWornInputs(text: string): WornItemInput[] {
  const rows = new Map<string, WornItemInput>();
  for (const clause of text.split(CLAUSE_BOUNDARY)) {
    const { nouns, windows } = scanClause(garmentNounTokens(clause));
    // Negation carries noun-to-noun within a clause and resets with it: a new
    // clause states its own denial or none at all.
    let negatedBefore = false;
    for (let k = 0; k < nouns.length; k += 1) {
      const noun = nouns[k];
      const pre = windows[k];
      const post = windows[k + 1];
      if (noun === undefined || pre === undefined || post === undefined) continue;
      // Annotated: the initializer reads `negatedBefore`, which is assigned from
      // this value below — without the annotation TS sees the cycle as `any`.
      const negated: boolean =
        windowHas(pre, negationMarkers) ||
        (negatedBefore && pre.every((token) => negationCarryWords.has(token)));
      // Updated BEFORE the coverage lookup, so the carry flows through nouns this
      // table does not map: "without a scarf or shirt" denies the shirt too.
      negatedBefore = negated;
      const mapped = garmentNounCoverage.get(noun.identity);
      if (mapped === undefined) continue;
      if (negated || windowHas(pre, displacementMarkers) || windowHas(post, displacementMarkers)) continue;
      if (rows.get(noun.identity)?.opacity === "opaque") continue;
      const id = `${OVERLAY_ROW_PREFIX}${noun.identity}`;
      rows.set(noun.identity, {
        instanceId: id,
        garmentId: id,
        name: noun.identity,
        coverage: mapped.coverage,
        layer: mapped.layer,
        opacity: windowHas(pre, sheerModifiers) ? "sheer" : "opaque",
      });
    }
  }
  return [...rows.values()];
}
