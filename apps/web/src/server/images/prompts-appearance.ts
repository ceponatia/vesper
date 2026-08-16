import { attributeRegistry, type AttributeDefinition, type AttributeValue } from "@/contracts/attributes";
import type { RegionExposure } from "@/contracts/items/visibility";
import { VIEWER_SKIN_ATTRIBUTE_IDS, type ViewerBodyPart } from "@/contracts/images/viewer-body";
import type { CharacterProfile } from "@/contracts/world/profile";
import {
  excerpt,
  formatAttribute,
  formatAttributeValue,
  isIntimateAttribute,
  isNonVisualAttribute,
  realizedBodyForProfile,
} from "./prompts-format";

/** Per-character appearance summaries: what a scene prompt may say about a body, and when. */

const APPEARANCE_SUMMARY_CHARS = 200;

/**
 * Compact appearance phrase from resolved attribute values (registry labels,
 * unknown ids skipped) — describes a character textually in a render prompt
 * when they are not the identity reference.
 *
 * **Apparent age is omitted here** (it is in `buildAvatarPrompt`'s subject line):
 * scene images lean on the character's portrait avatar as the source of how old
 * they look, so re-stating an apparent-age band in the textual summary only risks
 * fighting the reference image. Apparent age stays a portrait-studio concept.
 */
export function characterAppearanceSummary(
  attributes: ReadonlyArray<AttributeValue>,
  maxChars = APPEARANCE_SUMMARY_CHARS,
  allowIntimate = false,
  profile?: CharacterProfile,
): string {
  const parts: string[] = [];
  const realizedBody = profile ? realizedBodyForProfile(profile) : undefined;
  for (const value of attributes) {
    if (value.id === "identity.apparent_age") continue; // portrait-studio-only — scene images use the avatar reference for age
    const def = attributeRegistry.byId(value.id);
    if (!def) continue;
    if (def.excludeFromPrompts) continue; // tracked but not wired into prompts yet (e.g. identity.natal_sex)
    if (realizedBody && !realizedBody.isAttributeApplicable(def)) continue;
    if (isNonVisualAttribute(def)) continue; // voice/scent don't render in an image
    if (!allowIntimate && isIntimateAttribute(def)) continue; // scene composer (gemini tool model) is moderation-prone
    const formatted = formatAttribute(def, value.value);
    if (formatted) parts.push(formatted);
  }
  return excerpt(parts.join("; "), maxChars);
}

/**
 * Identity-critical attributes for the reference-anchored render (chat-scene-fidelity.plan.md
 * slice 3): the features an identity-locked edit drifts on ever so slightly — facial identity
 * plus skin and hair. Deliberately a whitelist (a full appearance dump would fight the
 * reference image and blow the prompt budget).
 */
const IDENTITY_ANCHOR_ATTRIBUTE_IDS = [
  "skin.tone",
  "skin.undertone",
  "lips.fullness",
  "lips.shape",
  "eyes.color",
  "eyes.shape",
  "hair.color",
  "hair.length",
  "hair.style",
  "face.shape",
  "face.freckles",
] as const;

/** Char cap on the identity-anchor phrase — it must never crowd the 1500-char render budget. */
const IDENTITY_ANCHOR_CHARS = 180;

/**
 * A compact identity-anchor phrase for the character a reference image identity-locks:
 * whitelist-filtered attribute values ("skin tone: warm brown; lips fullness: full; …")
 * emitted to REINFORCE the reference, never to override it (the render prompt words the
 * reference as authoritative). "" when nothing identity-critical is authored, so the
 * prompt is unchanged for a sparsely-authored character.
 */
export function identityAnchorSummary(
  attributes: ReadonlyArray<AttributeValue>,
  profile?: CharacterProfile,
): string {
  const realizedBody = profile ? realizedBodyForProfile(profile) : undefined;
  const byId = new Map(attributes.map((v) => [v.id, v]));
  const parts: string[] = [];
  for (const id of IDENTITY_ANCHOR_ATTRIBUTE_IDS) {
    const value = byId.get(id);
    if (!value) continue;
    const def = attributeRegistry.byId(id);
    if (!def) continue;
    if (def.excludeFromPrompts) continue;
    if (realizedBody && !realizedBody.isAttributeApplicable(def)) continue;
    const formatted = formatAttribute(def, value.value);
    if (formatted) parts.push(formatted);
  }
  return excerpt(parts.join("; "), IDENTITY_ANCHOR_CHARS);
}

/**
 * The image lane's apparent-age vocabulary (owner ruling 2026-07-29) — the ONLY
 * age words an image prompt may carry. Two rules, both safety-shaped:
 *
 * 1. **The floor is an explicit adult.** The registry's minor bands (infant…teen)
 *    are narrator/world vocabulary and are deliberately ABSENT here — "teen" could
 *    read 15–17, and no such word may ever reach an image model. A minor-band or
 *    unknown value produces NO age text at all (the pre-ruling behavior), never a
 *    younger word. `eighteen` states the number outright.
 * 2. **The ceiling problem is drift, not text** (the Kristin aging report): Qwen
 *    edits re-synthesize skin with a texture-amplifying prior and "preserve
 *    apparent age" preserves the model's own over-estimate of an age-ambiguous
 *    reference, compounding a step older per edit generation. The anchor sentence
 *    is what pulls it back — A/B'd at ~15–20 apparent years on the reporting
 *    chat's avatar (phantom-limb-ab.ts, age variant).
 */
const IMAGE_AGE_PHRASES: Record<string, string> = {
  eighteen: "exactly eighteen years old, an adult",
  young_adult: "a young adult in {pos} early twenties",
  mid_twenties: "in {pos} mid-twenties",
  late_twenties: "in {pos} late twenties",
  early_thirties: "in {pos} early thirties",
  late_thirties: "in {pos} late thirties",
  forties: "in {pos} forties",
  fifties: "in {pos} fifties",
  sixties_plus: "in {pos} sixties or beyond",
};

/** Bands whose anchor also claims youthful skin — only when the sheet authors `skin.texture: smooth`. */
const YOUTHFUL_SKIN_BANDS = new Set(["eighteen", "young_adult", "mid_twenties", "late_twenties", "early_thirties"]);

/** Subject/possessive pronouns from the identity.gender value; they/their for anything unstated. */
function agePronouns(gender: string | undefined): { subject: string; possessive: string } {
  if (gender === "female" || gender?.endsWith("_born_female")) return { subject: "she", possessive: "her" };
  if (gender === "male" || gender?.endsWith("_born_male")) return { subject: "he", possessive: "his" };
  return { subject: "they", possessive: "their" };
}

/**
 * The avatar subject-descriptor's age word, floored to the image vocabulary:
 * "eighteen-year-old" for the explicit floor, the registry label for older adult
 * bands, and **undefined for minor/unknown bands** — `buildAvatarPrompt` then
 * simply omits age from the subject line rather than ever emitting a sub-adult word.
 */
export function imageAgeWord(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (value === "eighteen") return "eighteen-year-old";
  if (!(value in IMAGE_AGE_PHRASES)) return undefined;
  const def = attributeRegistry.byId("identity.apparent_age");
  return (def && formatAttributeValue(def, value)) || undefined;
}

/**
 * The identity-locked routes' age anchor (owner ruling 2026-07-29, reversing
 * "scenes omit apparent age"): one name-bound sentence stating the sheet's
 * apparent age — "Kristin is in her late twenties; her skin, hands and legs read
 * smooth and youthful." Worded TEXT-authoritative (unlike the identity anchors,
 * where the reference wins): the reference's apparent age is exactly the thing
 * the edit model mis-reads, so here the text must overrule it. "" for minor-band
 * or unstated ages (see IMAGE_AGE_PHRASES — no age text beats a wrong word).
 * The youthful-skin clause rides only young bands whose sheet says smooth skin.
 */
export function apparentAgeAnchor(name: string, attributes: ReadonlyArray<AttributeValue>): string {
  const byId = new Map(attributes.map((v) => [v.id, v.value]));
  const band = byId.get("identity.apparent_age");
  if (typeof band !== "string") return "";
  const phrase = IMAGE_AGE_PHRASES[band];
  if (!phrase) return "";
  const { possessive } = agePronouns(typeof byId.get("identity.gender") === "string" ? (byId.get("identity.gender") as string) : undefined);
  const subject = name.trim() || "The subject";
  const youthful = YOUTHFUL_SKIN_BANDS.has(band) && byId.get("skin.texture") === "smooth";
  const tail = youthful ? `; ${possessive} skin, hands and legs read smooth and youthful` : "";
  return `${subject} is ${phrase.replaceAll("{pos}", possessive)}${tail}.`;
}

/** Budget for the viewer's body line — it competes with everything else for the 1500. */
const VIEWER_BODY_CHARS = 200;

/**
 * The viewer's own body facts (scene-pov-embodiment.plan.md slice 4) — **only for the parts
 * actually in frame**, so a shot of their hands on her cheek doesn't state their leg hair.
 *
 * Without this the viewer's arms change colour between shots, which reads as a different
 * person reaching in — so `skin.tone`/`build.frame` ride any embodied shot
 * (`VIEWER_SKIN_ATTRIBUTE_IDS`) and each part contributes its own descriptors on top.
 * Attribute applicability is checked against the persona's realized body, exactly like every
 * other prompt builder here, so a stale attribute can't leak.
 *
 * Intimate anatomy is deliberately NOT here: it rides `sceneRevealAppearance(…, {intimate})`
 * on the uncensored route only, the same seam the character's has always used.
 */
export function viewerBodyAppearance(
  attributes: ReadonlyArray<AttributeValue>,
  parts: ReadonlyArray<ViewerBodyPart>,
  profile?: CharacterProfile,
): string {
  if (parts.length === 0) return "";
  const realizedBody = profile ? realizedBodyForProfile(profile) : undefined;
  const byId = new Map(attributes.map((v) => [v.id, v]));
  const wanted = [...VIEWER_SKIN_ATTRIBUTE_IDS, ...parts.flatMap((p) => p.attributeIds)];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const rawId of wanted) {
    if (seen.has(rawId)) continue;
    seen.add(rawId);
    // The registry's id type is a `<category>.<name>` template union; the registry entries
    // hold plain strings. Both lookups below tolerate a miss, which IS the "unknown ids are
    // ignored" contract — and a test asserts every listed id is real, so a typo fails loudly
    // in CI rather than silently describing nothing.
    const id = rawId as AttributeValue["id"];
    const value = byId.get(id);
    if (!value) continue;
    const def = attributeRegistry.byId(id);
    if (!def || def.excludeFromPrompts) continue;
    if (realizedBody && !realizedBody.isAttributeApplicable(def)) continue;
    const formatted = formatAttribute(def, value.value);
    if (formatted) out.push(formatted);
  }
  return excerpt(out.join("; "), VIEWER_BODY_CHARS);
}

/**
 * Which exposure region uncovers each intimate attribute category. An intimate
 * category with NO entry here never renders in an image (axis undefined ⇒
 * `intimateAttrRendersExposed` returns false) — this is deliberate for the
 * universal `anus` / `perineum` categories: image inclusion is a PLACEHOLDER
 * pending image-prompt re-evaluation (owner ruling 2026-07-23). Every render
 * today views the character from the front, where anal/perineal detail can't
 * show and would only confuse the model, so those categories stay omitted (they
 * remain fully exposure-gated for chat/prose). Add `anus`/`perineum → "pelvis"`
 * when rear/exposure framing lands.
 */
const INTIMATE_CATEGORY_EXPOSURE: Record<string, keyof RegionExposure> = {
  breasts: "torso",
  vulva: "pelvis",
  penis: "pelvis",
  testicles: "pelvis",
};

/**
 * Whether an intimate-anatomy attribute should surface in an IMAGE prompt: its
 * region must read exposed (bare/sheer, not covered by a garment) and sensory
 * scent/taste attributes never render visually. The exposure rule the untagged
 * intimate attributes take in `sceneRevealAppearance` — the one place image
 * paths gate intimate anatomy, after the avatar path was made intimate-free by
 * rule (see docs/images/pipelines.md §Avatar generation).
 */
function intimateAttrRendersExposed(def: AttributeDefinition, exposure: RegionExposure): boolean {
  if (def.kind === "sensory") return false; // scent/taste don't render in an image
  const axis = INTIMATE_CATEGORY_EXPOSURE[def.category];
  return axis !== undefined && exposure[axis] !== "covered";
}

/** Non-intimate body regions a waist-up portrait can't show — the scene subject's "shape" line draws from these. */
const LOWER_BODY_CATEGORIES: ReadonlySet<string> = new Set(["waist", "hips", "legs", "feet"]);

/**
 * Which exposure axis uncovers a `skin`-tier attribute, keyed by category. A
 * superset of INTIMATE_CATEGORY_EXPOSURE that also covers the everyday lower
 * body (legs/feet), so the same exposure state drives both the intimate and
 * the SFW reveal lines.
 */
const REVEAL_EXPOSURE_REGION: Record<string, keyof RegionExposure> = {
  chest: "torso",
  breasts: "torso",
  hips: "pelvis",
  vulva: "pelvis",
  penis: "pelvis",
  testicles: "pelvis",
  legs: "legs",
  feet: "feet",
};

/**
 * Whether a `imageReveal`-tagged attribute surfaces in a scene render given the
 * coverage state: `shape` reads through clothing (always), `skin` only when its
 * region is uncovered. Untagged intimate attributes keep the existing
 * exposure-only rule (`intimateAttrRendersExposed`); untagged non-intimate
 * attributes are not part of the reveal line at all.
 */
function revealSurfaces(def: AttributeDefinition, exposure: RegionExposure, intimate: boolean): boolean {
  if (def.kind === "sensory") return false; // scent/taste never render visually
  if (def.imageReveal === "shape") return true;
  if (def.imageReveal === "skin") {
    const axis = REVEAL_EXPOSURE_REGION[def.category];
    return axis !== undefined && exposure[axis] !== "covered";
  }
  return intimate ? intimateAttrRendersExposed(def, exposure) : false;
}

/**
 * The identity-locked scene subject's body description, split by sensitivity so
 * the caller can route each half (docs/images/pipelines.md §Scene images): the reference
 * image is a waist-up portrait, so it conveys the face and upper body but
 * underspecifies the figure. This supplements it from `imageReveal`-tagged
 * attributes — `shape` (silhouette: breast size, waist, hips, leg build) always,
 * `skin` (nipples, leg hair, toenails) only when the region is bare/sheer.
 *
 * - `{ intimate: false }` → the SFW lower-body line (waist/hips/legs/feet),
 *   emitted on every route.
 * - `{ intimate: true }` → exposed/silhouette intimate anatomy, emitted only on
 *   the uncensored route (it folds in untagged intimate attrs by the existing
 *   exposure rule, so vulva/penis detail is never lost).
 */
export function sceneRevealAppearance(
  attributes: ReadonlyArray<AttributeValue>,
  exposure: RegionExposure | undefined,
  profile: CharacterProfile | undefined,
  opts: { intimate: boolean },
  maxChars = APPEARANCE_SUMMARY_CHARS,
): string {
  if (!exposure) return "";
  const realizedBody = profile ? realizedBodyForProfile(profile) : undefined;
  const parts: string[] = [];
  for (const value of attributes) {
    const def = attributeRegistry.byId(value.id);
    if (!def) continue;
    if (def.excludeFromPrompts) continue; // tracked but not wired into prompts yet (e.g. identity.natal_sex)
    const intimate = isIntimateAttribute(def);
    if (intimate !== opts.intimate) continue;
    if (realizedBody && !realizedBody.isAttributeApplicable(def)) continue;
    // The SFW half describes only the lower body — the portrait already covers
    // the face/upper body, so re-stating it wastes the (tight) prompt budget.
    if (!intimate && !LOWER_BODY_CATEGORIES.has(def.category)) continue;
    if (!revealSurfaces(def, exposure, intimate)) continue;
    const formatted = formatAttribute(def, value.value);
    if (formatted) parts.push(formatted);
  }
  return excerpt(parts.join("; "), maxChars);
}
