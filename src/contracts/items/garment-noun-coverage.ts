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
 * wearing a bra", "excluding a bra", "her shirt hanging open", "gown pooled at
 * her waist" all NAME clothing while saying it is not covering anything, so
 * `negationMarkers` / `negatedWearingLeads` / `exclusionMarkers` /
 * `displacementMarkers` suppress the row entirely — unless a `negationExceptions`
 * word un-negates what comes after it ("not wearing anything but a thong" is a
 * worn thong, and `bareStateWords` is what arms that flip). The failure
 * directions are asymmetric and decide the design: suppressing wrongly costs that
 * garment's coverage, and — since a denial now speaks for the free-text read
 * (below) — reports its region bare, while MISSING a displacement over-covers,
 * and over-covering a bared body is the failure this module exists to make
 * impossible in the other direction, with nothing but the archivist's `exposed`
 * flag to fight it. Both cost something; the second still costs more, which is
 * why the qualifier registries stay wide while the coverage table stays narrow.
 * Under-covering a genuinely worn garment is the one thing that must never
 * happen, which is why every qualifier is scoped to ONE noun — window-scoped
 * negation with conjunction inheritance, and a shared window apportioned at its
 * layering hinge (`windowSplitters` always bar the comparative `as … as` span,
 * the lookahead-gated `coordinatorSplitters` and the marker-gated
 * `conditionalSplitters` when they earn it) — rather than clause-scoped:
 * clause-scoped, "no bra under her sweater, jeans" would strip the sweater and
 * bare the torso, and an unapportioned "a shirt under an open jacket" would strip
 * the shirt. A clause boundary RESETS that denial scope, with one exception that
 * is literally one: a clause OPENING with a `negationExceptions` word inherits the
 * previous clause's closing verdict, because "not wearing underwear, except a bra"
 * is the same sentence "not wearing underwear except a bra" is — the comma is
 * punctuation, not a change of subject, and reading that lone "except" as a
 * standalone exclusion denied the one garment the sentence puts ON.
 *
 * **A compared garment is not a worn one either.** "a blouse as sheer as a
 * negligee" names a negligee nobody has on: the `as … as` span is a simile, its
 * inner words describe the garment BEFORE it, and the noun after it is only the
 * yardstick. So the span hinges nowhere, its sheer reading lands backward on the
 * blouse, and the object emits nothing in either direction — no row and no denial,
 * exactly like an unmapped noun (`readComparatives`). "as well as" is the one span
 * that coordinates rather than compares, and it keeps the plain hinge.
 *
 * **A denial is INFORMATION, not the absence of it** (`overlayGarmentReads`). A
 * suppressed garment leaves no coverage row, and for the union path that is the
 * whole story — but "not wearing a shirt" with nothing else named then produced
 * ZERO rows, which is the same shape as prose naming no clothing at all, and the
 * free-text caller reads that shape as fully covered: a stated-bare chest came
 * back dressed. So the scan reports BOTH sides. The worn rows are unchanged; the
 * denied garments hand back the coverage ids they claimed, which the resolver
 * reads as bareness wherever no worn row speaks for the same region.
 *
 * **Displacement counts as denial here.** "her shirt hanging open" and "gown
 * pooled at her waist" make the same claim a negation does — that garment is not
 * covering what it names — and the two suppression reasons are one verdict to
 * every consumer. An UNMAPPED noun is the genuinely different case and stays out
 * of both outputs: nobody knows what a cloak covers, so it can neither dress a
 * region nor bare one. Denied coverage is bounded exactly as the worn rows are —
 * the same table, so a garment nobody mapped bares nothing.
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
 * Words that state a BARE body rather than deny a named garment — "wearing
 * nothing under her dress", "nothing but a thong", "none of it". They are
 * negation HITS in `segmentDenies`, but they get their own registry rather than
 * joining `negationMarkers` because their job is different: a negation marker
 * denies the noun it qualifies ("no bra"), while these qualify no noun at all —
 * they deny the whole outfit, and the garment the sentence goes on to name is
 * usually the ONE thing that is on. So what they really do here is ARM the
 * exception flip, which is what keeps "nothing but a thong" a worn thong now that
 * a standalone `exclusionMarkers` word denies on its own.
 *
 * Being a negation hit is still load-bearing on its own: without it "nothing but
 * a thong" would read as a bare exclusion and lose the thong. What keeps that hit
 * from stripping a genuinely worn garment is the layering hinge — "wearing
 * nothing under her dress" apportions `wearing nothing under` to the span BEFORE
 * the hinge, which no noun owns, so the dress keeps covering (`attachWindow`).
 *
 * Deliberately tiny, and only the pronouns: an adverbial "not at all" or a
 * bare "no" is somebody else's registry.
 */
export const bareStateWords: ReadonlySet<string> = new Set(["nothing", "none"]);

/**
 * Words that END a negation — everything after one is EXCEPTED from it, and so
 * is worn: "not wearing anything but a thong", "isn't wearing anything except a
 * bra", "nothing other than a corset". Read against the same segment as the
 * negation itself, and the rule is positional: the segment denies only when its
 * LAST negation stands after its last exception. An exception BEFORE the negation
 * is inert — "but not wearing a shirt" still denies — because it excepts nothing
 * that has been denied yet.
 *
 * This is the one place a negation registry can bare a body instead of covering
 * it, so it is worth being precise about which direction each spelling fails in:
 * a missing exception word reads a stated-worn garment as absent (the benign
 * direction — the garment simply contributes nothing), while a word here that is
 * NOT an exception would cancel a real denial and cover a stated-bare body. Hence
 * only unambiguous exceptive function words. "than" is in for "other than a
 * thong", where the negation and the exception are two words apart.
 *
 * **Multiword exceptives ("apart from", "aside from") are out of scope** — this
 * scanner reads unigrams, and a bare "apart"/"aside" is not reliably exceptive.
 * "aside" would not reach here anyway: it is a `displacementMarkers` word, so
 * "not wearing anything aside from a thong" suppresses on displacement before
 * negation is ever consulted. A known limitation, and the safe direction of one.
 *
 * **These words must never join `negationCarryWords`.** An exception BREAKS the
 * carry the way any other content word does: "without a shirt but jeans" denies
 * the shirt and keeps the jeans, which is only true while "but" is not filler.
 */
export const negationExceptions: ReadonlySet<string> = new Set([
  "but",
  "except",
  "save",
  "besides",
  "excluding",
  "barring",
  "than",
]);

/**
 * The `negationExceptions` words that DENY on their own — an exclusion with no
 * negation anywhere before it to except FROM. "jeans, excluding a bra" and
 * "everything except a bra" are stating what is NOT on, and reading them as mere
 * exceptions emitted an opaque bra row over a bared chest.
 *
 * **"Anywhere before it" reaches past the segment**, which is why `segmentDenies`
 * takes the previous noun's verdict: "jeans and not wearing underwear except a
 * bra" denies the underwear and then excepts the BRA from that denial — the bra
 * is the one thing on, and reading its lone "except" as a fresh exclusion bared a
 * torso the sentence dresses. The clause boundary is what keeps the standalone
 * reading alive: "no shirt, jeans excluding a bra" starts the second clause with
 * nothing denied, so the exclusion is again the denial.
 *
 * A strict SUBSET of `negationExceptions`, because the exceptive reading is still
 * the primary one: these words only turn into denials when the flip has nothing
 * to undo. The subset is where the precision lives, and "but" is why it exists —
 * a standalone "but" is an ordinary coordinator ("without a shirt but jeans"
 * keeps the jeans), so promoting the whole exception registry would strip a
 * garment the prose plainly puts on. That leaves the exclusive "everything BUT a
 * bra" unread — a known limitation, and the deliberate side of the trade: telling
 * the two "but"s apart needs more context than a unigram scan has, and guessing
 * wrong on the common one strips a worn garment.
 *
 * Only the words whose sole reading is exclusion-of-a-named-thing. "save" and
 * "besides" are held out on purpose: "save" is a verb far more often than a
 * preposition ("save her dress from the wash"), and a standalone "besides" is
 * additive as readily as exceptive ("besides a bra, jeans and a tee"). Both still
 * cancel a real negation, which is the reading that costs nothing when wrong.
 */
export const exclusionMarkers: ReadonlySet<string> = new Set(["except", "excluding", "barring"]);

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
 * The HINGE in a window shared by two garment nouns — the layering prepositions
 * and the clause transitions. The span between two nouns is the first one's
 * post-modifier ground AND the second one's pre-modifier ground at once, and only
 * a word like these says where one ends: "a shirt under an open jacket" puts
 * `open` on the jacket (the shirt keeps covering), "jacket unbuttoned over a tee"
 * puts `unbuttoned` on the jacket (the tee keeps covering). Reading such a window
 * whole displaced BOTH garments and bared the torso — the exact under-covering
 * the module comment calls the one unacceptable failure.
 *
 * Deliberately just the layering words plus the clause transitions
 * "while"/"whilst"/"as". A hinge that is not one would split a modifier off the
 * noun it belongs to; a missing hinge hands a post-modifier to the wrong garment
 * — which is what "a shirt hanging open while wearing jeans" did: with nothing to
 * hinge on, the whole span attached forward, so `hanging open` displaced the JEANS
 * and the stated-open shirt kept covering, inverting the sentence. A clause
 * transition earns the unconditional treatment for the same reason a preposition
 * does: it never premodifies the noun after it, so anything before it is finished
 * business.
 *
 * **"as" is here for its transition reading** ("a shirt hanging open as she wears
 * jeans"), which is the one that costs a garment when missed. A LONE comparative
 * "as" agrees with it on what matters — the hinge fires on first hit, and a
 * comparative only ever stands after the previous noun's own post-modifiers, so
 * "a robe soft as silk over a chemise" fences exactly what the later preposition
 * would have fenced and both garments keep covering. The correlative `as … as`
 * SPAN is the reading that disagrees, and `readComparatives` takes it out of this
 * registry's hands: inside a span neither "as" hinges.
 *
 * **The layering prepositions must never join `negationCarryWords`.** The carry
 * check reads the WHOLE window on purpose, and these two registries pulling in
 * opposite directions is why: "no shirt under her jacket" apportions to a
 * filler-only "her", which would carry the denial onto the jacket, while the
 * unsplit "under her" holds a preposition that is not filler and correctly breaks
 * it. `conditionalSplitters` is the same: "with" is not filler, so "no shirt with
 * jeans" breaks the carry and the jeans keep covering. Only
 * `coordinatorSplitters` is deliberately in both — "or" hinges AND carries, which
 * is what keeps "without a shirt or bra" one denial.
 *
 * Every word here hinges UNCONDITIONALLY, on first hit — a preposition genuinely
 * relates two garments and a clause transition genuinely ends a phrase, so an
 * empty `toPrevious` ("a shirt under…") is the right read. The two sets that
 * cannot promise that are `coordinatorSplitters` and `conditionalSplitters`
 * below.
 */
export const windowSplitters: ReadonlySet<string> = new Set([
  "over",
  "under",
  "underneath",
  "beneath",
  "atop",
  "above",
  "below",
  "while",
  "whilst",
  "as",
]);

/** The token a comparative span is two of. A span, never either half alone. */
const AS = "as";

/**
 * The INNER text of an `as … as` span that COORDINATES rather than compares — the
 * additive idiom. "a bra as well as a thong" names two garments and both are on,
 * so its two "as" tokens keep their ordinary `windowSplitters` reading (the first
 * hinges, exactly as it did before spans existed) instead of being consumed as a
 * simile that would strand the thong as a yardstick nobody wears.
 *
 * Registry-style, keyed on the JOINED inner tokens so a multiword idiom is a line
 * here rather than a branch. Deliberately tiny: every other "as X as" in wardrobe
 * prose compares ("as sheer as", "as dark as"), and reading one of THOSE as
 * additive puts the comparison's yardstick on the body as clothing — the
 * over-covering direction this module exists to close.
 */
export const additiveAsInners: ReadonlySet<string> = new Set(["well"]);

/**
 * Hinge words that hinge only when they join two GARMENTS rather than two
 * descriptions of one — the coordinators. "a shirt and jeans" coordinates
 * garments; "shirt unbuttoned and hanging open with jeans" coordinates two
 * postmodifiers OF THE SHIRT, and hinging at that "and" sent `hanging open`
 * forward to displace the jeans while the stated-open shirt kept covering — both
 * garments read backwards at once.
 *
 * The test is a lookahead: a coordinator does NOT hinge when a
 * `displacementMarkers` word stands between it and the next hinge candidate (or
 * the window end). That works because of what the two marker families are
 * grammatically. Displacement markers are participial POSTmodifiers in English
 * ("unbuttoned", "hanging", "pooled") — one directly after a coordinator means
 * the coordination is still inside the PREVIOUS garment's postmodifier phrase.
 * `sheerModifiers` are PREmodifiers of the noun that follows ("and sheer
 * stockings"), which is exactly why they must not defer the hinge.
 *
 * A displacing word that IS a premodifier ("and discarded jeans") lands in the
 * next garment's segment either way — skipped, the window goes hinge-less and
 * attaches wholly forward; hinged, everything after the coordinator attaches
 * forward too. The happy accident is worth naming because it is what makes the
 * lookahead cheap: it can only mis-fire on the previous garment, never on the
 * next one. The cost it does pay is that a skipped coordinator with no later
 * hinge strands the FIRST garment's own marker in the forward segment ("a shirt
 * unbuttoned and discarded jeans" keeps the shirt), which over-covers by one
 * garment instead of under-covering the following one — the direction every
 * other guess in this module already leans.
 */
export const coordinatorSplitters: ReadonlySet<string> = new Set(["and", "or", "nor"]);

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
 * Does this segment DENY the garment named after it — a `negationMarkers` or
 * `bareStateWords` word, or a `negatedWearingLeads` + "wearing" bigram, with no
 * `negationExceptions` word after it? The bigram is checked here and nowhere
 * else, so a standalone lead can never deny on its own.
 *
 * Positional, not boolean. Three readings come from which registry hit LAST
 * inside the segment; the fourth needs `deniedBefore` — the verdict the PREVIOUS
 * noun reached — because an exclusion's meaning is entirely a question of whether
 * there is a denial to except from, and that denial can live one noun back:
 *
 * - **negation after every exception ⇒ denies.** "but not wearing a shirt"
 *   excepts at 0 and negates at 1: the exception excepted nothing yet denied.
 * - **exception after a real negation ⇒ worn.** "not wearing anything but a
 *   thong" negates at 0 and excepts at 3, so the thong is on.
 * - **an `exclusionMarkers` word with no negation in THIS segment ⇒ the previous
 *   noun decides.** Nothing denied upstream and the exclusion is itself the
 *   denial ("jeans, excluding a bra" — the comma resets the scope, so the bra is
 *   off). A denied noun upstream and the exclusion excepts FROM that denial
 *   ("jeans and not wearing underwear except a bra" — the underwear is off and
 *   the bra is the exception, i.e. on), exactly as it would inside one segment.
 *   Only the exclusion subset asks the question; a bare "but" is a coordinator
 *   ("without a shirt but jeans" keeps the jeans) and never denies either way.
 * - **anything else ⇒ no verdict, worn.**
 *
 * Reading either registry as a bare presence check gets one of the three
 * in-segment readings wrong; ignoring `deniedBefore` gets the fourth wrong in the
 * one direction this module refuses — a stated-worn garment stripped, and on the
 * free-text path a bare torso reported through it.
 *
 * A kept-via-exception noun reports `false`, which ENDS the denial scope for the
 * noun after it — the vacuous carry then keeps "not wearing underwear except a
 * bra and panties" wearing both, the same way an in-segment exception does.
 */
function segmentDenies(segment: readonly string[], deniedBefore: boolean): boolean {
  // Explicitly typed on purpose: loop-carried indices read and reassigned in the
  // same scan are where this module has hit TS7022 (implicit-`any` cycle) before.
  let lastNegation: number = -1;
  let lastException: number = -1;
  let lastExclusion: number = -1;
  for (let index = 0; index < segment.length; index += 1) {
    const token = segment[index];
    if (token === undefined) continue;
    if (
      negationMarkers.has(token) ||
      bareStateWords.has(token) ||
      (negatedWearingLeads.has(token) && segment[index + 1] === WEARING)
    ) {
      lastNegation = index;
      continue;
    }
    if (negationExceptions.has(token)) {
      lastException = index;
      if (exclusionMarkers.has(token)) lastExclusion = index;
    }
  }
  // A negation standing after every exception in this segment denies outright.
  if (lastNegation > lastException) return true;
  // Still a real negation here, so the only way past the check above is an
  // exception after it (the two roles never share an index) — the local cancel.
  if (lastNegation >= 0) return false;
  // No negation in this segment: an exclusion word is the denial when nothing is
  // denied yet, and the cancel of an inherited denial when something is.
  if (lastExclusion >= 0) return !deniedBefore;
  return false;
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

/** Any word that could be a hinge — where a lookahead past one hinge stops. */
function isHingeCandidate(token: string): boolean {
  return windowSplitters.has(token) || coordinatorSplitters.has(token) || conditionalSplitters.has(token);
}

/**
 * Does a displacement marker stand in the stretch a coordinator at `from - 1`
 * governs — from `from` to the next hinge candidate, or the window end? Past that
 * next candidate the tokens are somebody else's apportionment question, so they
 * say nothing about whether THIS coordinator joins garments or postmodifiers.
 * See `coordinatorSplitters` for why a following participle means it does not.
 */
function displacementFollows(window: readonly string[], from: number): boolean {
  for (let index = from; index < window.length; index += 1) {
    const token = window[index];
    if (token === undefined) continue;
    if (isHingeCandidate(token)) return false;
    if (displacementMarkers.has(token)) return true;
  }
  return false;
}

/** What an `as … as` span in one window says about the nouns on either side of it. */
interface WindowComparatives {
  /**
   * The index of every "as" a span claimed. No hinge fires on one: the span is a
   * POSTmodifier of the noun before this window, so splitting there fences an
   * empty segment off the garment being described and hands the whole simile
   * forward to the next one.
   */
  spanned: ReadonlySet<number>;
  /**
   * A `sheerModifiers` word stands INSIDE a span ⇒ the noun BEFORE this window is
   * the see-through one. "a blouse as sheer as a negligee" describes the blouse.
   */
  sheerBackward: boolean;
  /**
   * The noun this window ENDS at is the comparison's object — the yardstick a
   * simile measures against, not clothing on this body — because nothing but
   * `negationCarryWords` filler stands between the closing "as" and it.
   */
  objectFollows: boolean;
}

/**
 * The comparative `as … as` spans in one window — the reading of "as" that is not
 * a hinge.
 *
 * "as" earns its `windowSplitters` place on the clause transition ("a shirt
 * hanging open as she wears jeans"), and that was safe while every other reading
 * merely fenced an empty segment. The correlative span with a garment on the far
 * side of it is the reading that is not: "a blouse as sheer as a negligee" hinged
 * at the first "as", handed the blouse an empty post-segment and `sheer` forward,
 * so the described-sheer blouse read OPAQUE and a negligee nobody is wearing
 * appeared as a row — both halves of one sentence, backwards.
 *
 * A span is an "as" plus the next one at least two tokens on, because a
 * comparison needs something to compare: "as as" has no inner and opens nothing.
 * Neither "as" hinges, the inner tokens describe the PRECEDING noun, and the noun
 * the window ends at is the yardstick that noun is held against — worn by nobody.
 * `additiveAsInners` is the one inner that means coordination instead, and it
 * leaves both tokens to the ordinary hinge.
 *
 * Known limitation, and the shape it takes: the pairing is greedy and
 * left-to-right, so a TRANSITION "as" sharing an unpunctuated window with a later
 * comparative one is read as that span's opener and loses its hinge ("a shirt
 * hanging open as she is as tired as ever jeans" would displace the jeans). It
 * takes two "as" readings, no comma between them, and no other hinge word in the
 * window to reach — every one of which is rarer than the comparative this fixes.
 */
function readComparatives(window: readonly string[]): WindowComparatives {
  const spanned = new Set<number>();
  // Explicitly typed on purpose: loop-carried values read and reassigned in the
  // same scan are where this module has hit TS7022 (implicit-`any` cycle) before.
  let sheerBackward: boolean = false;
  let objectFollows: boolean = false;
  let open: number = window.indexOf(AS);
  while (open >= 0) {
    const close: number = window.indexOf(AS, open + 2);
    if (close < 0) break;
    const inner = window.slice(open + 1, close);
    if (!additiveAsInners.has(inner.join(" "))) {
      spanned.add(open);
      spanned.add(close);
      if (inner.some((token) => sheerModifiers.has(token))) sheerBackward = true;
      // Only filler between the span and the window's end means the noun that
      // closes the window IS the yardstick. A substantive token means the
      // sentence moved on and that noun is dressed prose again ("a blouse as
      // sheer as glass over a negligee" wears the negligee). The LAST span in a
      // window is the one that answers — it is the one standing next to the noun.
      objectFollows = window.slice(close + 1).every((token) => negationCarryWords.has(token));
    }
    open = window.indexOf(AS, close + 1);
  }
  return { spanned, sheerBackward, objectFollows };
}

/**
 * Where a shared window splits — the index of its hinge, or `-1` for hinge-less.
 *
 * `windowSplitters` hinge on first hit. A `coordinatorSplitters` word hinges
 * unless a displacement marker follows it, which makes it the joint of the
 * previous garment's postmodifier phrase rather than a garment boundary ("shirt
 * unbuttoned and hanging open with jeans"). A `conditionalSplitters` word
 * ("with") hinges only when a fenceable marker precedes it in this window;
 * unmarked, the search reads past it, so "a shirt with buttons open and jeans"
 * lands on the "and" and keeps "with buttons open" on the shirt.
 *
 * Skipping never ends the scan: the tokens after a passed-over coordinator still
 * arm `marked`, which is what lets the "with" in "shirt unbuttoned and hanging
 * open with jeans" be the hinge the coordinator declined to be. An "as" a
 * comparative span claimed is skipped for a different reason — it is a
 * postmodifier's opener rather than a boundary (`readComparatives`).
 */
function findHinge(window: readonly string[], spanned: ReadonlySet<number> | undefined): number {
  // Explicitly typed on purpose: loop-carried booleans read and reassigned in the
  // same scan are where this module has hit TS7022 (implicit-`any` cycle) before.
  let marked: boolean = false;
  for (let index = 0; index < window.length; index += 1) {
    const token = window[index];
    if (token === undefined) continue;
    if (spanned?.has(index) === true) continue;
    if (windowSplitters.has(token)) return index;
    if (coordinatorSplitters.has(token)) {
      if (!displacementFollows(window, index + 1)) return index;
      continue;
    }
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
 * - **No noun after it** (clause-final): wholly BACKWARD — "her shirt hanging
 *   open", "gown pooled at her waist". Hinge or no hinge: the post-noun
 *   displacement scan wants the whole tail, and no negation reads it.
 * - **No noun before it** (clause-initial): the post-hinge remainder, FORWARD.
 *   "unbuttoned jacket" is hinge-less and attaches whole, while "wearing nothing
 *   under her dress" hands the dress only "her" — the pre-hinge tokens are
 *   DISCARDED, because there is no previous noun to own them. Dropping them is
 *   the point: they qualify something the text never named, so letting them reach
 *   forward would strip a garment on a qualifier that was never its own.
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
function attachWindow(
  window: readonly string[],
  hasPrevious: boolean,
  hasNext: boolean,
  spanned: ReadonlySet<number> | undefined,
): WindowAttachment {
  if (!hasNext) return { toPrevious: window, toNext: [] };
  const hinge = findHinge(window, spanned);
  if (!hasPrevious) return { toPrevious: [], toNext: hinge < 0 ? window : window.slice(hinge + 1) };
  if (hinge < 0) return { toPrevious: [], toNext: window };
  return { toPrevious: window.slice(0, hinge), toNext: window.slice(hinge + 1) };
}

/** Both sides of one overlay read: what the text puts ON, and what it takes OFF. */
export interface OverlayGarmentReads {
  /** Coverage rows for the garments the text says are worn — the union input. */
  worn: WornItemInput[];
  /**
   * Body-location ids claimed by garments the text DENIES or DISPLACES, deduped
   * and unordered. Not a negative row — coverage a caller with no other wardrobe
   * may read as stated-bare, and the only output of this module that can bare
   * anything. Bounded by the same `garmentNounCoverage` table as `worn`, so an
   * unmapped noun contributes to neither side.
   */
  deniedCoverage: string[];
}

/**
 * Coverage rows for the garments a stretch of overlay text names — one row per
 * canonical identity, mapped and unsuppressed ones only — PLUS the coverage the
 * text says is missing.
 *
 * **The windows, and who owns them.** Every scan here reads the tokens between
 * two garment nouns (or between a noun and the clause edge); clause boundaries
 * (`,` `;` `.` newline) end them. A window BETWEEN two nouns belongs to both —
 * the first garment's post-modifier ground and the second's pre-modifier ground
 * are the same span — so `attachWindow` apportions it at the layering hinge
 * (`windowSplitters` always, bar an "as" a comparative span claimed; a
 * `coordinatorSplitters` word unless a displacement marker follows it, so "shirt
 * unbuttoned and hanging open with jeans" keeps the
 * whole participle phrase on the shirt; `conditionalSplitters`' "with" only once
 * a marker precedes it, so "a shirt with buttons open and jeans" opens the shirt
 * and leaves the jeans on), and each noun scans only the segment it owns. A
 * clause-INITIAL window splits at the same hinge and keeps only the remainder —
 * the tokens before it modify a garment the text never named, so no noun owns
 * them ("wearing nothing under her dress" hands the dress just "her").
 *
 * - **Sheer** reads the owned PRE segment: a modifier there makes THIS garment
 *   sheer and is then spent, so "a sheer robe over a shift" leaves the shift
 *   opaque and "a sheer black negligee" reads sheer through two intervening
 *   adjectives. A modifier stranded on the far side of a hinge ("a chemise sheer
 *   beneath a jacket") belongs to the garment BEFORE it, where a post-noun
 *   adjective is inert — inert is right, and better than dressing the jacket in
 *   the chemise's fabric.
 * - **Negation** reads the same owned segment and SUPPRESSES the row: "without a
 *   shirt" — or "not wearing a shirt" (`negatedWearingLeads`), or a bare
 *   `exclusionMarkers` word with nothing anywhere before it to except from
 *   ("excluding a bra") — names a shirt that is not on, unless a
 *   `negationExceptions` word stands after a real negation, which un-negates what
 *   follows ("not wearing anything but a thong", "nothing but a thong", where the
 *   `bareStateWords` hit is the negation being excepted). That negation may be
 *   the PREVIOUS noun's rather than this segment's — "not wearing underwear
 *   except a bra" excepts the bra from the underwear's denial and wears it — so
 *   the exclusion reading is reserved for the case with no denial in scope. It
 *   carries to the next noun when the window
 *   between them is nothing but `negationCarryWords`, and that check reads the
 *   window WHOLE, unapportioned: "without a shirt or bra" denies both — as does
 *   "excluding a bra or panties" — while "no shirt under her jacket" keeps the
 *   jacket precisely because the hinge it holds is not filler. An empty window
 *   carries vacuously, which is the same reading. What carries is the segment's
 *   VERDICT, so an excepted noun carries its un-negated state on ("not wearing
 *   anything but a bra or panties" wears both). A clause boundary resets the
 *   scope, EXCEPT for a clause opening on a `negationExceptions` word: "not
 *   wearing underwear, except a bra" inherits the previous clause's closing
 *   verdict and wears the bra, while "no shirt, jeans excluding a bra" — nothing
 *   denied at that clause's close — still reads the exclusion as its own denial.
 * - **Displacement** reads both owned segments and suppresses: "unbuttoned
 *   jacket" puts the marker before the noun, "her shirt hanging open" after it,
 *   and "a shirt under an open jacket" puts it after one noun and before another
 *   in the same breath — where only the hinge says it displaces the jacket alone.
 * - **Comparison** (`readComparatives`) reads a whole window for an `as … as`
 *   span, and answers in both directions at once: a `sheerModifiers` word inside
 *   the span makes the noun BEFORE the window sheer ("a blouse as sheer as a
 *   negligee" describes the blouse), and the noun AFTER it, reached across nothing
 *   but filler, is the simile's yardstick and emits nothing at all. "as well as"
 *   (`additiveAsInners`) coordinates instead, and keeps the ordinary hinge.
 *
 * A suppressed noun contributes no ROW but still bounds its neighbors' windows,
 * exactly as an unmapped one does — and, unlike an unmapped one, it reports the
 * coverage it would have had as `deniedCoverage` (module comment: a denial is
 * information). Suppression never DELETES a row an earlier clause affirmed — "a
 * linen shirt, then no shirt" keeps the cover, the safe direction (see the module
 * comment on failure directions) — and never subtracts from a row either: the two
 * outputs are independent, and it is the CALLER that decides a worn row outranks
 * a denial of the same region.
 *
 * One identity named twice keeps the most-covering read (opaque wins), the same
 * direction the rest of this module leans — with one exemption, the postpositive
 * comparative, which is one naming's own modifier landing after its row rather
 * than a second naming competing with it.
 *
 * PURE and total: odd text simply yields fewer rows, never a throw.
 */
export function overlayGarmentReads(text: string): OverlayGarmentReads {
  const rows = new Map<string, WornItemInput>();
  // Deduped by construction, and never expanded here: the ids stay exactly what
  // the table says, so the caller's own expansion rule is the only one in play.
  const denied = new Set<string>();
  // The verdict the PREVIOUS clause closed on. Annotated: it is read into the next
  // clause's seed and assigned from that clause's own result, which is the
  // loop-carried cycle TS reads as `any` without help.
  let carriedDenial: boolean = false;
  for (const clause of text.split(CLAUSE_BOUNDARY)) {
    const tokens = garmentNounTokens(clause);
    const { nouns, windows } = scanClause(tokens);
    // Read once per window, before anything asks a question of it: the hinge
    // search, the preceding noun's opacity, and the following noun's very
    // existence as clothing all come out of the same span analysis.
    const comparatives = windows.map(readComparatives);
    // Window `i` has a noun before it whenever it is not the clause-initial one,
    // and a noun after it whenever it is not the clause-final one — the whole
    // input `attachWindow` needs, computed once so the two nouns sharing a window
    // can never read it apart differently.
    const attachments = windows.map((window, index) =>
      attachWindow(window, index > 0, index < nouns.length, comparatives[index]?.spanned),
    );
    // Negation carries noun-to-noun within a clause and resets with it: a new
    // clause states its own denial or none at all — UNLESS it opens with an
    // exception word, which has to have something to except FROM. "not wearing
    // underwear, except a bra" is the sentence "not wearing underwear except a
    // bra" with punctuation in it, and the reset made that lone "except" a
    // standalone exclusion that denied the one garment the sentence puts ON.
    //
    // The seed can only ever be READ by an exclusion in the first noun's segment,
    // never propagated by the filler carry: the exception word that armed it
    // stands in that same window, and no exception word is a `negationCarryWords`
    // one. So the reach is exactly the exclusion reading and nothing wider.
    const opener = tokens[0];
    let negatedBefore: boolean = opener !== undefined && negationExceptions.has(opener) ? carriedDenial : false;
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
      //
      // `negatedBefore` feeds BOTH halves, for opposite reasons: it is what an
      // exclusion in `pre` excepts from (so "not wearing underwear except a bra"
      // keeps the bra), and what the filler carry propagates (so "without a shirt
      // or bra" denies both). The two can never fight — the carry needs a window
      // of pure `negationCarryWords`, and no exception word is one.
      const negated: boolean =
        segmentDenies(pre, negatedBefore) || (negatedBefore && between.every((token) => negationCarryWords.has(token)));
      // Updated BEFORE the coverage lookup, so the carry flows through nouns this
      // table does not map: "without a scarf or shirt" denies the shirt too.
      negatedBefore = negated;
      // A comparison OBJECT is the yardstick a simile holds the previous garment
      // against, not clothing on this body: "a blouse as sheer as a negligee"
      // names exactly one worn garment. So it contributes to NEITHER output — no
      // row and no denial — while still closing windows and bounding its
      // neighbours, which is precisely how an unmapped noun behaves.
      if (comparatives[k]?.objectFollows === true) continue;
      const mapped = garmentNounCoverage.get(noun.identity);
      // An unmapped noun is the one case that says nothing in EITHER direction:
      // we do not know what it covers, so it can neither dress a region nor bare
      // one. Everything below is a claim about a garment whose coverage we know.
      if (mapped === undefined) continue;
      const displaced = windowHas(pre, displacementMarkers) || windowHas(post, displacementMarkers);
      if (negated || displaced) {
        // Denied and displaced are ONE verdict — "not wearing a shirt" and "her
        // shirt hanging open" both say this garment is not covering what it
        // names, and that is a positive statement about the body under it.
        for (const id of mapped.coverage) denied.add(id);
        continue;
      }
      // A comparative in the noun's POST window is a postmodifier of THIS naming
      // ("a blouse as sheer as a negligee"), which is why it may overrule an
      // opaque row an earlier clause left: the opaque-wins dedup arbitrates two
      // competing NAMINGS of one identity, and a postpositive modifier arriving
      // after its own row is not a second naming. The dedup rule itself is
      // untouched — this is the one read exempt from it.
      const comparativeSheer = comparatives[k + 1]?.sheerBackward === true;
      if (!comparativeSheer && rows.get(noun.identity)?.opacity === "opaque") continue;
      const id = `${OVERLAY_ROW_PREFIX}${noun.identity}`;
      rows.set(noun.identity, {
        instanceId: id,
        garmentId: id,
        name: noun.identity,
        coverage: mapped.coverage,
        layer: mapped.layer,
        opacity: comparativeSheer || windowHas(pre, sheerModifiers) ? "sheer" : "opaque",
      });
    }
    // Whatever this clause closed on is what an exception OPENING the next one
    // excepts from. A clause naming no garment closes on its own seed, so it
    // carries `false` — the garment-keeping direction, and the reading that keeps
    // "no shirt, jeans excluding a bra" a standalone exclusion.
    carriedDenial = negatedBefore;
  }
  return { worn: [...rows.values()], deniedCoverage: [...denied] };
}

/**
 * The worn half alone — the union input both structured paths hand to
 * `exposedRegions` alongside the real items. Text may only ADD cover there, so
 * the denials are deliberately unreachable from this shape: a modelled wardrobe
 * knows what is on the body better than prose describing it does.
 */
export function overlayWornInputs(text: string): WornItemInput[] {
  return overlayGarmentReads(text).worn;
}
