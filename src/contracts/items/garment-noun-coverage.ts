import { clothingCategoryById } from "./clothing-categories";
import { garmentIdentityAt, garmentNounTokens } from "./garment-nouns";
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
  ["bikini", TWO_PIECE],
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

/** Synthetic-row id prefix — never collides with a real instance or definition id. */
const OVERLAY_ROW_PREFIX = "overlay:";

/**
 * A modifier only reaches past a comma if we let it, and we do not: "a
 * lace-trimmed cotton robe, sheer stockings" must leave the robe opaque.
 */
const CLAUSE_BOUNDARY = /[,;.\n]+/;

/**
 * Coverage rows for the garments a stretch of overlay text names — one row per
 * canonical identity, mapped ones only.
 *
 * **The sheer window** is the tokens between the previous garment noun (or the
 * start of the clause) and this one: a modifier there makes THIS garment sheer
 * and is then spent, so "a sheer robe over a shift" leaves the shift opaque and
 * "a sheer black negligee" reads sheer through two intervening adjectives.
 * Clause boundaries (`,` `;` `.` newline) reset it. An unmapped garment noun
 * still closes the window — it was named, so the modifier belonged to it.
 *
 * One identity named twice keeps the most-covering read (opaque wins), the same
 * direction the rest of this module leans.
 *
 * PURE and total: odd text simply yields fewer rows, never a throw.
 */
export function overlayWornInputs(text: string): WornItemInput[] {
  const rows = new Map<string, WornItemInput>();
  for (const clause of text.split(CLAUSE_BOUNDARY)) {
    const tokens = garmentNounTokens(clause);
    let sheerPending = false;
    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i];
      if (token === undefined) continue;
      const match = garmentIdentityAt(tokens, i);
      if (match === undefined) {
        if (sheerModifiers.has(token)) sheerPending = true;
        continue;
      }
      i += match.length - 1;
      const opacity = sheerPending ? "sheer" : "opaque";
      sheerPending = false;
      const mapped = garmentNounCoverage.get(match.identity);
      if (mapped === undefined) continue;
      if (rows.get(match.identity)?.opacity === "opaque") continue;
      const id = `${OVERLAY_ROW_PREFIX}${match.identity}`;
      rows.set(match.identity, {
        instanceId: id,
        garmentId: id,
        name: match.identity,
        coverage: mapped.coverage,
        layer: mapped.layer,
        opacity,
      });
    }
  }
  return [...rows.values()];
}
