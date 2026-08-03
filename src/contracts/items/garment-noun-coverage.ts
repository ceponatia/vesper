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
 * **A named garment is not a worn one.** "without a shirt", "no panties", "not
 * wearing a bra", "her shirt hanging open", "gown pooled at her waist" all NAME
 * clothing while saying it is not covering anything, so `negationMarkers` /
 * `negatedWearingLeads` / `displacementMarkers` suppress the row entirely. The
 * failure directions are asymmetric and decide the design: suppressing wrongly
 * costs nothing — that garment contributes nothing, which is the pre-overlay
 * behavior, and on the free-text path the caller's intimate-region gate then
 * keeps the covered default — while MISSING a displacement over-covers, and
 * over-covering a bared body is the failure this module exists to make impossible
 * in the other direction. Under-covering a genuinely worn garment is the one
 * thing that must never happen, which is why every qualifier is scoped to ONE
 * noun — window-scoped negation with conjunction inheritance, and a shared window
 * apportioned at its layering hinge (`windowSplitters`, plus the marker-gated
 * `conditionalSplitters`) — rather than clause-scoped: clause-scoped, "no bra
 * under her sweater, jeans" would strip the sweater and bare the torso, and an
 * unapportioned "a shirt under an open jacket" would strip the shirt.
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
 * Words that deny the garment after them ONLY when immediately followed by
 * "wearing" — the contextual denial `negationMarkers` cannot express: "jeans and
 * not wearing a shirt" is a stated bare torso that used to emit an opaque chest
 * row. Read in the same forward segment as `negationMarkers`, and it carries
 * across a conjunction on the same terms ("not wearing a shirt or bra").
 *
 * **The bigram is the whole rule.** A standalone "not" must never deny: it is far
 * too common a hedge ("not the shirt she meant to wear", "not quite a dress") and
 * a bare-`not` denial would suppress a covering garment on a qualifier that was
 * never about wearing it — the one failure direction this module refuses (module
 * comment). "wearing" alone is equally inert, or "wearing only a red thong" would
 * undress her. Both halves are ordinary non-filler words to the conjunction
 * carry, which is what makes "no bra, not wearing" style prose break the carry
 * exactly as any other content word does.
 *
 * Registry-style: contractions are listed in every spelling the tokenizer can
 * produce, straight and curly apostrophe alike (`garmentNounTokens` keeps both).
 */
export const negatedWearingLeads: ReadonlySet<string> = new Set([
  "not",
  "never",
  "isn't",
  "isn’t",
  "isnt",
  "wasn't",
  "wasn’t",
  "wasnt",
  "aren't",
  "aren’t",
  "arent",
  "ain't",
  "ain’t",
  "aint",
  "stopped",
  "quit",
]);

/** The verb `negatedWearingLeads` negates. A bigram, never either half alone. */
const WEARING = "wearing";

/**
 * Words that say a named garment is open, displaced, or off the body — worn in
 * the fiction, but not covering what its coverage list claims. Read on BOTH sides
 * of the noun, because English puts them on either side: "unbuttoned jacket"
 * before, "her shirt hanging open" and "gown pooled at her waist" after — but
 * only within the segment that noun OWNS (`windowSplitters`), so one marker can
 * never displace two garments at once.
 *
 * Wider than `negationMarkers` on purpose. A wrong suppression costs the garment's
 * coverage (benign — see the module comment); a missed displacement leaves bared
 * anatomy classified as covered, which is the read the archivist's `exposed`
 * flag has to fight. "over" and "under" are NOT here: they are layering
 * prepositions, and "a jacket over a tee" dresses her twice — they are the
 * `windowSplitters` hinge instead.
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

/**
 * The HINGE in a window shared by two garment nouns — layering prepositions and
 * coordinators. The span between two nouns is the first one's post-modifier
 * ground AND the second one's pre-modifier ground at once, and only a word like
 * these says where one ends: "a shirt under an open jacket" puts `open` on the
 * jacket (the shirt keeps covering), "jacket unbuttoned over a tee" puts
 * `unbuttoned` on the jacket (the tee keeps covering). Reading such a window
 * whole displaced BOTH garments and bared the torso — the exact under-covering
 * the module comment calls the one unacceptable failure.
 *
 * Deliberately just the layering/coordination words. A hinge that is not one
 * would split a modifier off the noun it belongs to; a missing hinge hands a
 * post-modifier to the wrong garment.
 *
 * **The layering prepositions must never join `negationCarryWords`.** The carry
 * check reads the WHOLE window on purpose, and these two registries pulling in
 * opposite directions is why: "no shirt under her jacket" apportions to a
 * filler-only "her", which would carry the denial onto the jacket, while the
 * unsplit "under her" holds a preposition that is not filler and correctly breaks
 * it. The coordinators are deliberately in both sets — "or" hinges AND carries,
 * which is what keeps "without a shirt or bra" one denial. The same holds for
 * `conditionalSplitters`: "with" is not filler, so "no shirt with jeans" breaks
 * the carry and the jeans keep covering.
 *
 * Every word here hinges UNCONDITIONALLY, on first hit — each genuinely relates
 * two garments, so an empty `toPrevious` ("a shirt under…") is the right read.
 * The one word that cannot promise that lives in `conditionalSplitters` below.
 */
export const windowSplitters: ReadonlySet<string> = new Set([
  "over",
  "under",
  "underneath",
  "beneath",
  "atop",
  "above",
  "below",
  "and",
  "or",
  "nor",
]);

/**
 * Hinge words that only hinge when there is something to fence — "with", which
 * is two different words in wardrobe prose:
 *
 * - a **layering hinge**, joining two garments the way the prepositions do:
 *   "shirt unbuttoned with jeans" (the marker is the shirt's, the jeans are on);
 * - a **postmodifier introducer**, opening a phrase that describes the garment
 *   BEFORE it: "a shirt with buttons open and jeans" (the shirt is open, the
 *   jeans are on).
 *
 * Splitting unconditionally read the second shape as the first and inverted it —
 * the shirt kept covering while `buttons open` sailed forward and displaced the
 * jeans. So "with" hinges only when a fenceable marker
 * (`displacementMarkers` ∪ `negationMarkers` ∪ `sheerModifiers`) already stands
 * before it in the window; otherwise the hinge search reads straight past it and
 * the window is hinge-less unless a real splitter follows.
 *
 * The rule falls out of what a hinge is FOR: fencing the previous noun's
 * postmodifiers off the next noun's premodifiers. A "with" preceded by nothing
 * that needs fencing is either accompaniment ("a jacket with a tee" — no
 * qualifier to apportion) or the opening of the previous garment's postmodifier
 * phrase ("with buttons open"). Both readings want the tokens up to the next REAL
 * splitter to attach backward, which is exactly what skipping the "with" does.
 */
export const conditionalSplitters: ReadonlySet<string> = new Set(["with"]);

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
   * modifier question here and no second scan can disagree with the first. Which
   * HALF of a shared window each of the two nouns owns is `attachWindow`'s
   * answer; the unsplit window survives for the one check that needs it whole
   * (the negation carry).
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

/** Does this segment carry any word from a marker registry? */
function windowHas(segment: readonly string[], markers: ReadonlySet<string>): boolean {
  return segment.some((token) => markers.has(token));
}

/**
 * Does this segment DENY the garment named after it — a `negationMarkers` word,
 * or a `negatedWearingLeads` + "wearing" bigram? The bigram is checked here and
 * nowhere else, so a standalone lead can never deny on its own.
 */
function segmentDenies(segment: readonly string[]): boolean {
  return segment.some(
    (token, index) =>
      negationMarkers.has(token) || (negatedWearingLeads.has(token) && segment[index + 1] === WEARING),
  );
}

/** One window's tokens divided between the garment before it and the garment after it. */
interface WindowAttachment {
  /** What the PRECEDING noun owns — the post-noun displacement scan. */
  toPrevious: readonly string[];
  /** What the FOLLOWING noun owns — its sheer, negation, and displacement scans. */
  toNext: readonly string[];
}

/**
 * A qualifier a hinge exists to fence — the only tokens whose side of the split
 * changes an outcome. Everything else in a window (articles, colors, nouns like
 * "buttons") is inert whichever garment it lands on.
 */
function isFenceableMarker(token: string): boolean {
  return displacementMarkers.has(token) || negationMarkers.has(token) || sheerModifiers.has(token);
}

/**
 * Where a shared window splits — the index of its hinge, or `-1` for hinge-less.
 *
 * `windowSplitters` hinge on first hit. A `conditionalSplitters` word ("with")
 * hinges only when a fenceable marker precedes it in this window; unmarked, the
 * search reads past it, so "a shirt with buttons open and jeans" lands on the
 * "and" and keeps "with buttons open" on the shirt. See `conditionalSplitters`
 * for why an unmarked "with" is never the boundary.
 */
function findHinge(window: readonly string[]): number {
  // Explicitly typed on purpose: loop-carried booleans read and reassigned in the
  // same scan are where this module has hit TS7022 (implicit-`any` cycle) before.
  let marked: boolean = false;
  for (let index = 0; index < window.length; index += 1) {
    const token = window[index];
    if (token === undefined) continue;
    if (windowSplitters.has(token)) return index;
    if (conditionalSplitters.has(token)) {
      if (marked) return index;
      continue;
    }
    if (isFenceableMarker(token)) marked = true;
  }
  return -1;
}

/**
 * Apportion one window to the nouns on either side of it.
 *
 * - **No noun before it** (clause-initial): wholly FORWARD — "unbuttoned jacket".
 * - **No noun after it** (clause-final): wholly BACKWARD — "her shirt hanging
 *   open", "gown pooled at her waist".
 * - **Shared**: split at the hinge `findHinge` picks, which is excluded from both
 *   sides. "a shirt under an open jacket" gives the shirt an empty post-segment
 *   and the jacket "an open"; "jacket unbuttoned over a tee" gives the jacket
 *   "unbuttoned" and the tee "a".
 * - **Shared with no hinge**: wholly FORWARD, because English stacks bare
 *   attributive modifiers ahead of their noun.
 *
 * Forward is the default everywhere it is a guess, and that is the safe
 * direction: a modifier landing on the wrong LATER garment suppresses it, while
 * the same modifier landing backward would suppress a garment the text never
 * qualified — the under-covering the module comment forbids.
 */
function attachWindow(window: readonly string[], hasPrevious: boolean, hasNext: boolean): WindowAttachment {
  if (!hasPrevious) return { toPrevious: [], toNext: window };
  if (!hasNext) return { toPrevious: window, toNext: [] };
  const hinge = findHinge(window);
  if (hinge < 0) return { toPrevious: [], toNext: window };
  return { toPrevious: window.slice(0, hinge), toNext: window.slice(hinge + 1) };
}

/**
 * Coverage rows for the garments a stretch of overlay text names — one row per
 * canonical identity, mapped and unsuppressed ones only.
 *
 * **The windows, and who owns them.** Every scan here reads the tokens between
 * two garment nouns (or between a noun and the clause edge); clause boundaries
 * (`,` `;` `.` newline) end them. A window BETWEEN two nouns belongs to both —
 * the first garment's post-modifier ground and the second's pre-modifier ground
 * are the same span — so `attachWindow` apportions it at the layering hinge
 * (`windowSplitters` always; `conditionalSplitters`' "with" only once a marker
 * precedes it, so "a shirt with buttons open and jeans" opens the shirt and
 * leaves the jeans on), and each noun scans only the segment it owns.
 *
 * - **Sheer** reads the owned PRE segment: a modifier there makes THIS garment
 *   sheer and is then spent, so "a sheer robe over a shift" leaves the shift
 *   opaque and "a sheer black negligee" reads sheer through two intervening
 *   adjectives. A modifier stranded on the far side of a hinge ("a chemise sheer
 *   beneath a jacket") belongs to the garment BEFORE it, where a post-noun
 *   adjective is inert — inert is right, and better than dressing the jacket in
 *   the chemise's fabric.
 * - **Negation** reads the same owned segment and SUPPRESSES the row: "without a
 *   shirt" — or "not wearing a shirt" (`negatedWearingLeads`) — names a shirt
 *   that is not on. It carries to the next noun when the window between them is
 *   nothing but `negationCarryWords`, and that check reads the window WHOLE,
 *   unapportioned: "without a shirt or bra" denies both, while "no shirt under
 *   her jacket" keeps the jacket precisely because the hinge it holds is not
 *   filler. An empty window carries vacuously, which is the same reading.
 * - **Displacement** reads both owned segments and suppresses: "unbuttoned
 *   jacket" puts the marker before the noun, "her shirt hanging open" after it,
 *   and "a shirt under an open jacket" puts it after one noun and before another
 *   in the same breath — where only the hinge says it displaces the jacket alone.
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
    // Window `i` has a noun before it whenever it is not the clause-initial one,
    // and a noun after it whenever it is not the clause-final one — the whole
    // input `attachWindow` needs, computed once so the two nouns sharing a window
    // can never read it apart differently.
    const attachments = windows.map((window, index) => attachWindow(window, index > 0, index < nouns.length));
    // Negation carries noun-to-noun within a clause and resets with it: a new
    // clause states its own denial or none at all.
    let negatedBefore = false;
    for (let k = 0; k < nouns.length; k += 1) {
      const noun = nouns[k];
      // The unsplit pre window — the ONLY scan that reads a window whole (see
      // `windowSplitters` on why the carry must).
      const between = windows[k];
      const pre = attachments[k]?.toNext;
      const post = attachments[k + 1]?.toPrevious;
      if (noun === undefined || between === undefined || pre === undefined || post === undefined) continue;
      // Annotated: the initializer reads `negatedBefore`, which is assigned from
      // this value below — without the annotation TS sees the cycle as `any`.
      const negated: boolean =
        segmentDenies(pre) || (negatedBefore && between.every((token) => negationCarryWords.has(token)));
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
