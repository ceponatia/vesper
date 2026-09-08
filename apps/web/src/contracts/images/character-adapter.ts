import type {
  ImageSubjectDigest,
  ImageWorldFact,
  ImageWorldSuppression,
} from "@vesper/image-core";
import { AFFORDANCE_UNIT_ONE } from "../affordances/core";
import { sceneBodyZoneOf } from "../affordances/scene";
import {
  activeLocatedFacts,
  appearanceFeatureKindRegistry,
  bodyLocusKey,
  currentAnatomyStates,
  parseLocatedFactValue,
  type AnatomyPartState,
  type BodyLocusRef,
  type LocatedAppearanceFact,
} from "../appearance-features";
import {
  attributeRegistry,
  formatAttribute,
  formatAttributeValue,
  humanizeVocabularyValue,
  isNonVisualAttribute,
  type AttributeValue,
} from "../attributes";
import { bodyLocationRegistry } from "../body/locations";
import type { HairOcclusion } from "../items/hair-occlusion";
import type { RegionExposure } from "../items/visibility";
import { DEFAULT_SPECIES_ID, speciesLabelPhrase, type RealizedBody } from "../species";
import {
  visualStateSpeciesFeatureGroupValueSchema,
  visualStateFingerprint,
  visualStateWardrobeValueSchema,
  VISUAL_STATE_SPECIES_FEATURE_GROUP_KIND_ID,
  VISUAL_STATE_WARDROBE_GARMENT_KIND_ID,
  VISUAL_STATE_WARDROBE_ITEM_KIND_ID,
  type VisualFramingBand,
  type VisualStateWardrobeValue,
} from "../visual-state";
import {
  hairConcealmentFact,
  isHairConcealed,
  isHairVisualFact,
  IMAGE_CHARACTER_HAIR_CONCEALED,
} from "./hair-concealment";
import { projectSubjectDigests, IMAGE_SUBJECT_VALUE_UNRESOLVED } from "./subject-digest";
import {
  VISUAL_IMAGE_AGE_ATTRIBUTE_ID,
  type VisualImageDigest,
  type VisualImageFact,
} from "./visual-digest";
import { visualExposureReads } from "./visual-segments";

/**
 * The character image adapter — the join between visual state's fact selection
 * and the canonical owners' semantic values, producing complete character claims
 * for the world digest.
 *
 * `projectSubjectDigests` (the tested scaffold) owns the vocabulary translation:
 * segment kinds become concepts, lanes become dispositions, provenance travels
 * untouched. What it deliberately cannot do is SAY anything — appearance facts
 * arrive carrying their truth fingerprint instead of a value, exposure is not a
 * projected fact at all, and an authored amputation is opaque to it. This module
 * closes those four named gaps, plus a fifth the scaffold cannot see, and
 * nothing else; it CONSUMES the scaffold, it does not replace it:
 *
 * 1. **Apparent age** gets its canonical semantic path: the subject's
 *    `identity.apparent_age` attribute value, rendered through the owner-ruled
 *    image age vocabulary ({@link imageAgeBandPhrases}). A minor-band value the
 *    registry recognizes is WITHHELD by ruling — no age text ever beats a
 *    younger word — and recorded as a designed suppression, never as a missing
 *    anchor. An absent, unreadable, or registry-unrecognized value fails closed
 *    instead: the `age` segment kind is mandatory, so the key lands in
 *    `missingRequired` and an identity-critical lane refuses before provider
 *    spend. All of that is under the caller's apparent-age POLICY
 *    ({@link CharacterApparentAgePolicy}): a lane whose renders inherit their
 *    visible age from an identity reference says `omit`, and the adapter then
 *    states no age at all — a designed suppression, never a missing anchor —
 *    whatever the band.
 * 2. **Exposure and coverage** are stated by this adapter as authoritative
 *    `subject.exposure` claims over the caller-supplied garment coverage readout
 *    — the composition read the scaffold must never fake. The wording and the
 *    composition rules (covered = silence; bare legs unstated under a bare
 *    pelvis) are `visual-segments.ts`'s one canonical table, consumed through
 *    {@link visualExposureReads} so the two prompt paths cannot drift apart.
 *    The claims carry the table's predicate-FRAGMENT inflection, because every
 *    dialect wraps a `subject.exposure` value as "<subject> is <value>".
 * 3. **Authored absences** stop arriving opaque: an anatomy fact whose canonical
 *    state says `absent` (or `prosthetic`) is re-filed from `subject.morphology`
 *    to `subject.absence` — same `morphology` segment kind, so the scaffold's
 *    classification invariant holds — which is the concept that takes the
 *    `missing_limbs`/`missing_digits` exclusions off the negative channel's
 *    table. A prosthetic additionally tags `morphology.synthetic_surface`.
 * 4. **Prompt-ready values.** Every emitted fact's `value` is readable prompt
 *    material: fingerprint-valued facts are answered by the canonical owners
 *    through {@link characterSemanticValueResolver}, and record-shaped values (a
 *    garment's `{ name, locus: { actorId }, definitionId }`) are resolved to
 *    their semantic members with every id stripped, instead of relying on the
 *    dialect's record-flattening fallback. A record with nothing readable left is
 *    suppressed — a fact nobody can value never reaches a payload.
 * 5. **Hair the worn headwear fully hides** is selected truth the render may not
 *    say. Visual state selects hair facts by camera visibility and knows nothing
 *    of the hair-occlusion band the wardrobe seam resolved, so at `full` this
 *    adapter withholds every hair fact as a designed suppression and states one
 *    required `subject.hair_concealment` fact in their place
 *    (`hair-concealment.ts`). `partial` and `none` change nothing.
 *
 * The standing rule holds throughout: a truth fingerprint is provenance, never
 * prompt semantics. This adapter resolves values from the OWNERS (the attribute
 * registry, the located-fact rows, the anatomy rows, the coverage readout); it
 * never decodes, humanizes, or guesses from a fingerprint.
 *
 * Pure by construction: rows arrive as plain values, so the module has no
 * database and no environment. The server lane that reads the owners in one
 * transaction owns the read (and mints the read token) at cutover.
 */

// ---------------------------------------------------------------------------
// Owners and suppression reasons
// ---------------------------------------------------------------------------

/** The attribute registry as a projection owner — the age anchor's provenance. */
export const IMAGE_CHARACTER_ATTRIBUTE_OWNER = "character.attributes";
/** The garment coverage readout as a projection owner — exposure's provenance. */
export const IMAGE_CHARACTER_COVERAGE_OWNER = "character.wardrobe_coverage";
/** Ordinary sheet appearance projected only for image consumers. */
export const IMAGE_CHARACTER_APPEARANCE_OWNER = "character.image_appearance";
/** Species and subtype identity projected only for image consumers. */
export const IMAGE_CHARACTER_SPECIES_OWNER = "character.realized_body";

/** Apparent age withheld by the owner ruling: a minor-band value states nothing, ever. */
export const IMAGE_CHARACTER_AGE_WITHHELD = "character.apparent_age.withheld";
/** No usable apparent-age value from the canonical owner — fail-closed, lands in `missingRequired`. */
export const IMAGE_CHARACTER_AGE_UNRESOLVED = "character.apparent_age.unresolved";
/** Apparent age withheld by the lane's policy: this render inherits its visible age from the reference. */
export const IMAGE_CHARACTER_AGE_OMITTED = "character.apparent_age.omitted";
/** No coverage readout was joined for this subject — fail-closed, lands in `missingRequired`. */
export const IMAGE_CHARACTER_COVERAGE_UNRESOLVED = "character.wardrobe_coverage.unresolved";
/** A record value with no readable member left after ids were stripped. */
export const IMAGE_CHARACTER_VALUE_UNREADABLE = "character.value_unreadable";

// ---------------------------------------------------------------------------
// The image age vocabulary (owner ruling 2026-07-29)
// ---------------------------------------------------------------------------

/**
 * The ONLY age words an image prompt may carry, keyed by `identity.apparent_age`
 * band. The floor is an explicit adult: the registry's minor bands (infant…teen)
 * are narrator/world vocabulary and are deliberately ABSENT here — "teen" could
 * read 15–17, and no such word may ever reach an image model. A minor-band or
 * unknown value produces NO age text at all, never a younger word; `eighteen`
 * states the number outright.
 *
 * `{pos}` is a possessive slot. The world-digest path never guesses a pronoun,
 * so {@link imageApparentAgeValue} — the table's one reader — renders the
 * neutral article there.
 */
export const imageAgeBandPhrases: Readonly<Record<string, string>> = {
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

/**
 * The pronoun-free semantic value of one apparent-age band, or `null` for a band
 * the image vocabulary carries no phrase for (minor bands, unknown strings,
 * non-string values). `null` alone does not say WHY — that classification is
 * {@link isWithheldImageAgeBand}'s job, and the two answers diverge on purpose:
 * withheld renders age-silent, unresolved fails the mandatory anchor closed.
 */
export function imageApparentAgeValue(band: unknown): string | null {
  if (typeof band !== "string") return null;
  const phrase = imageAgeBandPhrases[band];
  return phrase === undefined ? null : phrase.replaceAll("{pos}", "the");
}

/**
 * Whether a band is withheld BY RULING: a value the apparent-age registry
 * recognizes and the image vocabulary deliberately refuses — exactly the minor
 * bands (infant…teen). Derived from the canonical registry definition rather
 * than a second list, so the registry stays the one owner of the band
 * vocabulary. Anything the registry does NOT recognize ("adult", legacy free
 * text, a typo) is no ruling of anybody's: `attributeValueSchema` accepts
 * arbitrary strings, and classifying a malformed value as withheld would render
 * the character age-silent instead of failing the mandatory anchor closed.
 */
function isWithheldImageAgeBand(band: unknown): boolean {
  if (typeof band !== "string" || imageAgeBandPhrases[band] !== undefined) return false;
  const allowed = attributeRegistry.byId(VISUAL_IMAGE_AGE_ATTRIBUTE_ID)?.allowedValues;
  return allowed !== undefined && allowed.includes(band);
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/**
 * One subject's canonical owners, as plain values the caller already read.
 *
 * `exposure` is deliberately REQUIRED: the coverage readout is the one owner
 * whose absence would be silent (there is no fingerprint-valued fact to fail
 * closed on), and silently dropping wardrobe authority is the exact failure this
 * adapter exists to prevent. A caller with no worn set passes the readout its
 * lane already derives (`exposedRegions([])` / `FULLY_COVERED`).
 */
export interface CharacterSubjectSources {
  /** The subject's RESOLVED attribute values (overlays applied by the caller). */
  readonly attributes?: readonly AttributeValue[];
  readonly locatedFacts?: readonly LocatedAppearanceFact[];
  readonly anatomy?: readonly AnatomyPartState[];
  /** The canonical garment coverage readout for this subject. */
  readonly exposure: RegionExposure;
  /**
   * How much of this subject's hair their worn headwear hides — resolved once
   * at the lane's wardrobe seam and carried here beside `exposure`
   * (docs/contracts/items/README.md §Hair occlusion). Absent reads `none`: bad
   * or missing data shows hair rather than erasing it.
   */
  readonly hairOcclusion?: HairOcclusion;
  /** When present, body-inapplicable attributes resolve to nothing rather than stale words. */
  readonly realizedBody?: RealizedBody;
}

/**
 * Whether a render STATES each subject's apparent age or leaves it to the
 * picture. A lane decides this once for every subject it draws, never per
 * person: `state` is the standalone and reference-edit lanes' answer — the
 * text anchor is authoritative beside a portrait — and `omit` is a scene's,
 * whose cast inherits their visible age from their identity references and
 * whose prompt therefore carries no age sentence for anyone.
 */
export type CharacterApparentAgePolicy = "state" | "omit";

export interface CharacterWorldSlicesInput {
  readonly digest: VisualImageDigest;
  /** Display names by subject id — the one field a compiled sentence may name somebody by. */
  readonly labels?: Readonly<Record<string, string>>;
  /** Canonical owners by subject id. A subject with no entry fails its opaque anchors closed. */
  readonly sources: Readonly<Record<string, CharacterSubjectSources>>;
  /** The caller's apparent-age policy for every subject. Absent reads `state`. */
  readonly apparentAge?: CharacterApparentAgePolicy;
}

/** The completed subject slices plus everything the join lost, ready for `buildImageWorldDigest`. */
export interface CharacterWorldSlices {
  readonly subjects: readonly ImageSubjectDigest[];
  readonly suppressions: readonly ImageWorldSuppression[];
}

// ---------------------------------------------------------------------------
// The semantic value resolver — the join with the canonical owners
// ---------------------------------------------------------------------------

/** The two fields the resolver reads; a full `VisualImageFact` always satisfies it. */
export type CharacterFactRef = Pick<VisualImageFact, "subjectId" | "sourceRef">;

function attributeSemanticValue(
  attributeId: string,
  sources: CharacterSubjectSources,
): string | undefined {
  const def = attributeRegistry.byId(attributeId);
  if (def === undefined) return undefined; // unknown vocabulary — never a raw id in a prompt
  if (def.excludeFromPrompts === true) return undefined;
  if (isNonVisualAttribute(def)) return undefined; // voice and scent have nothing visual to say
  if (sources.realizedBody !== undefined && !sources.realizedBody.isAttributeApplicable(def)) {
    return undefined; // a stale value must not outlive the body
  }
  const value = sources.attributes?.find((entry) => entry.id === attributeId)?.value;
  if (value === undefined) return undefined; // the owner holds no value — nothing honest to say
  // The age band goes through the owner-ruled image vocabulary, never through the
  // generic label form: `imageApparentAgeValue` is the floor.
  if (attributeId === VISUAL_IMAGE_AGE_ATTRIBUTE_ID) return imageApparentAgeValue(value) ?? undefined;
  const formatted = formatAttribute(def, value);
  return formatted.length > 0 ? formatted : undefined;
}

function locatedFactSemanticValue(
  factId: string,
  sources: CharacterSubjectSources,
  atMinutes: number,
): string | undefined {
  const row = activeLocatedFacts(sources.locatedFacts ?? [], atMinutes).find((fact) => fact.id === factId);
  if (row === undefined) return undefined;
  const kind = appearanceFeatureKindRegistry.byId(row.kindId);
  if (kind === undefined) return undefined;
  const value = parseLocatedFactValue(appearanceFeatureKindRegistry, row);
  if (value === null) return undefined;
  const tokens = readableLeaves(value);
  // Self-describing, like the attribute form: "Freckle cluster: dense, clustered".
  // The fact's own locus travels beside the claim; the value does not restate it.
  return tokens.length > 0 ? `${kind.label}: ${tokens.join(", ")}` : kind.label;
}

/** The part a topology row is about, in body-registry words — "left ring finger". */
function anatomyPartPhrase(locus: BodyLocusRef): string {
  const detail = locus.detail?.path[locus.detail.path.length - 1];
  const part =
    detail !== undefined
      ? humanizeVocabularyValue(detail)
      : (bodyLocationRegistry.byId(locus.bodyLocationId)?.label.toLowerCase() ??
        humanizeVocabularyValue(locus.bodyLocationId));
  return locus.side === undefined ? part : `${locus.side} ${part}`;
}

/**
 * The semantic value of one anatomy row — readable, self-describing, and derived
 * from the OWNER's parsed state, never from the fingerprint that looks like it.
 */
function anatomySemanticValue(state: AnatomyPartState): string {
  const part = anatomyPartPhrase(state.locus);
  const alteration =
    state.alterationKindId === undefined ? undefined : humanizeVocabularyValue(state.alterationKindId);
  switch (state.state) {
    case "absent":
      return `${part}: absent`;
    case "prosthetic":
      return alteration === undefined ? `${part}: prosthetic` : `${part}: prosthetic (${alteration})`;
    case "altered":
      return alteration === undefined ? `${part}: altered` : `${part}: ${alteration}`;
    case "present":
      // Only projected upstream when an alteration rides the row.
      return alteration === undefined ? `${part}: present` : `${part}: ${alteration}`;
  }
}

/** The row in force for one adapted anatomy fact, matched by the locus key its sourceRef carries. */
function anatomyStateFor(
  locusKey: string,
  sources: CharacterSubjectSources,
  atMinutes: number,
): AnatomyPartState | undefined {
  return currentAnatomyStates(sources.anatomy ?? [], atMinutes).find(
    (state) => bodyLocusKey(state.locus) === locusKey,
  );
}

/**
 * The `semanticValue` resolver over the canonical owners — consulted by the
 * scaffold ONLY for facts whose value is their own truth fingerprint, which is
 * exactly the appearance-projection set: attribute-, located-fact- and
 * anatomy-sourced facts. `undefined` means "no owner could value this", which
 * the scaffold suppresses and, for a required fact, reports — never guesses.
 */
export function characterSemanticValueResolver(input: {
  readonly sources: Readonly<Record<string, CharacterSubjectSources>>;
  readonly atMinutes: number;
}): (fact: CharacterFactRef) => unknown {
  return (fact) => {
    const sources = input.sources[fact.subjectId];
    if (sources === undefined) return undefined;
    if (fact.sourceRef.kind !== "appearance") return undefined;
    const ref = fact.sourceRef.ref;
    switch (ref.kind) {
      case "attribute":
        return attributeSemanticValue(ref.attributeId, sources);
      case "located_fact":
        return locatedFactSemanticValue(ref.factId, sources, input.atMinutes);
      case "anatomy": {
        const state = anatomyStateFor(ref.locusKey, sources, input.atMinutes);
        return state === undefined ? undefined : anatomySemanticValue(state);
      }
      // No owner projects these through the compat adapter today; when one does,
      // it gains an arm here. Silence, never a guess.
      case "condition":
      case "presentation":
        return undefined;
    }
  };
}

// ---------------------------------------------------------------------------
// Prompt-ready values for structured (non-fingerprint) facts
// ---------------------------------------------------------------------------

/** Record members that are handles, ids or placement internals — never prompt material. */
const INTERNAL_VALUE_KEY = /^id$|Id$|^locus$|^key$|^ref$/;

/** Every readable leaf of a structured value, ids stripped, in canonical key order. */
function readableLeaves(value: unknown): string[] {
  if (typeof value === "string") {
    const token = humanizeVocabularyValue(value);
    return token.length > 0 ? [token] : [];
  }
  if (typeof value === "number" || typeof value === "boolean") return [String(value)];
  if (Array.isArray(value)) return value.flatMap(readableLeaves);
  if (value !== null && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !INTERNAL_VALUE_KEY.test(key))
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .flatMap(([, member]) => readableLeaves(member));
  }
  return [];
}

/**
 * A garment value as the phrase a prompt may carry: the name, subtype-led when
 * the subtype is not already in it ("nose ring: thin gold hoop" — a bare jewelry
 * name gives the model nothing to place the piece with). `locus` and
 * `definitionId` are provenance and are dropped entirely.
 */
function garmentPromptValue(value: VisualStateWardrobeValue): string {
  const name = value.name.trim();
  if (value.subtypeId === undefined) return name;
  const subtype = humanizeVocabularyValue(value.subtypeId);
  return name.toLowerCase().includes(subtype.toLowerCase()) ? name : `${subtype}: ${name}`;
}

/**
 * A species feature group's value: its authored descriptive attributes from the
 * canonical registry ("wings: leathery, black"), else the bare group word —
 * existence is the fact, and a required morphology anchor must never unresolve
 * merely because nobody authored what the wings look like.
 */
function speciesGroupValue(group: string, sources: CharacterSubjectSources | undefined): string {
  const tokens: string[] = [];
  for (const value of sources?.attributes ?? []) {
    const def = attributeRegistry.byId(value.id);
    if (def === undefined || def.category !== group) continue;
    if (def.excludeFromPrompts === true || isNonVisualAttribute(def)) continue;
    if (sources?.realizedBody !== undefined && !sources.realizedBody.isAttributeApplicable(def)) continue;
    const token = formatAttributeValue(def, value.value);
    if (token.length > 0) tokens.push(token);
  }
  return tokens.length > 0 ? `${group}: ${tokens.join(", ")}` : group;
}

type PromptReadyValue =
  | { readonly kind: "keep" }
  | { readonly kind: "value"; readonly value: string }
  | { readonly kind: "suppress" };

/** Resolve one emitted fact's value into prompt-ready form, judged by its source fact's kind. */
function promptReadyValue(
  source: VisualImageFact,
  value: unknown,
  sources: CharacterSubjectSources | undefined,
): PromptReadyValue {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return { kind: "keep" }; // already readable — resolver output and plain values pass through
  }
  if (
    source.kindId === VISUAL_STATE_WARDROBE_GARMENT_KIND_ID ||
    source.kindId === VISUAL_STATE_WARDROBE_ITEM_KIND_ID
  ) {
    const parsed = visualStateWardrobeValueSchema.safeParse(value);
    if (parsed.success) return { kind: "value", value: garmentPromptValue(parsed.data) };
  }
  if (source.kindId === VISUAL_STATE_SPECIES_FEATURE_GROUP_KIND_ID) {
    const parsed = visualStateSpeciesFeatureGroupValueSchema.safeParse(value);
    if (parsed.success) return { kind: "value", value: speciesGroupValue(parsed.data.group, sources) };
  }
  const readable = readableLeaves(value).join(", ");
  return readable.length > 0 ? { kind: "value", value: readable } : { kind: "suppress" };
}

// ---------------------------------------------------------------------------
// Exposure — the composition read this adapter owns
// ---------------------------------------------------------------------------

const ALL_EXPOSURE_REGIONS: readonly (keyof RegionExposure)[] = ["torso", "pelvis", "legs", "feet"];

/**
 * Which exposure regions each framing band can honestly show, mirroring the
 * frame-zone semantics the visibility layer already applies (a head close-up
 * shows no torso; only a whole-figure frame reaches the legs and feet). An
 * exhaustive record, so a new band is a compile error here — somebody then
 * decides what the new frame contains instead of inheriting a fallback.
 */
const EXPOSURE_REGIONS_BY_FRAMING: Readonly<Record<VisualFramingBand, readonly (keyof RegionExposure)[]>> = {
  close_up: [],
  portrait: ["torso"],
  waist_up: ["torso"],
  full_figure: ALL_EXPOSURE_REGIONS,
  wide: ALL_EXPOSURE_REGIONS,
};

/**
 * The authoritative exposure claims for one subject. Required and priority-one:
 * wardrobe authority may never be dropped by a budget squeeze, and the
 * `exposure` segment kind is mandatory-protected anyway. A fully covered body
 * yields no facts — silence IS the covered statement.
 */
function exposureFacts(
  ref: string,
  subjectId: string,
  digest: VisualImageDigest,
  exposure: RegionExposure,
): ImageWorldFact[] {
  let framing: VisualFramingBand | undefined;
  for (const fact of digest.cameraFacts) {
    if (fact.component === "framing") {
      framing = fact.band;
      break;
    }
  }
  const regions = framing === undefined ? ALL_EXPOSURE_REGIONS : EXPOSURE_REGIONS_BY_FRAMING[framing];
  // The FRAGMENT inflection, not the standalone clause: every dialect wraps a
  // `subject.exposure` value as "<subject> is <value>", so the clause form
  // would compile "Mira is the torso is bare". Same canonical table either way.
  return visualExposureReads(exposure, regions).map((read) => ({
    key: `${ref}.exposure.${read.region}`,
    concept: "subject.exposure",
    value: read.fragment,
    subjectRef: ref,
    semanticTags: [`coverage:${read.coverage}`],
    disposition: "required_visual",
    priority: AFFORDANCE_UNIT_ONE,
    source: { owner: IMAGE_CHARACTER_COVERAGE_OWNER, key: `exposure.${read.region}`, entityId: subjectId },
    truthFingerprint: `${read.region}:${read.coverage}`,
  }));
}

/** Whether a selected fact is the projected apparent-age anchor — the age attribute's own feature. */
function isAgeAnchorFact(fact: Pick<VisualImageFact, "sourceRef">): boolean {
  return (
    fact.sourceRef.kind === "appearance" &&
    fact.sourceRef.ref.kind === "attribute" &&
    fact.sourceRef.ref.attributeId === VISUAL_IMAGE_AGE_ATTRIBUTE_ID
  );
}

// ---------------------------------------------------------------------------
// Ordinary visual identity — image-only, independent of recognition
// ---------------------------------------------------------------------------

/**
 * The bounded sheet vocabulary image prompts may state without routing it
 * through observer recognition. This is intentionally explicit: adding a
 * narrator-recognizable feature and adding an image descriptor are separate
 * product decisions, and neither registry flag silently opts into the other.
 */
export const IMAGE_CHARACTER_APPEARANCE_ATTRIBUTE_IDS = [
  "identity.gender",
  "identity.heritage",
  "skin.tone",
  "skin.undertone",
  "skin.texture",
  "hair.color",
  "hair.length",
  "hair.texture",
  "hair.density",
  "hair.strand_thickness",
  "hair.condition",
  "hair.arrangement",
  "hair.style",
  "eyes.color",
  "eyes.shape",
  "eyes.pupil",
  "eyes.luminosity",
  "face.shape",
  "face.freckles",
  "nose.shape",
  "nose.size",
  "nose.piercings",
  "brows.shape",
  "brows.thickness",
  "lips.fullness",
  "lips.shape",
  "lips.piercings",
  "ears.shape",
  "ears.piercings",
  "teeth.shape",
  "teeth.condition",
  "build.height",
  "build.frame",
  "build.musculature",
  "build.weight_presentation",
  "shoulders.width",
  "shoulders.slope",
  "neck.length",
  "neck.prominence",
  "arms.build",
  "arms.hair",
  "hands.size",
  "hands.texture",
  "hands.nails",
  "chest.size",
  "breasts.size",
  "waist.definition",
  "hips.width",
  "legs.build",
  "legs.length",
  "legs.hair",
  "presentation.grooming",
] as const;

/** Stable facts a reference-free portrait must carry before provider spend. */
export const IMAGE_CHARACTER_REFERENCE_FREE_REQUIRED_ATTRIBUTE_IDS = [
  "identity.gender",
  "skin.tone",
  "hair.color",
  "hair.length",
  "eyes.color",
  "face.shape",
  "build.frame",
  "build.weight_presentation",
] as const;

const IMAGE_CHARACTER_APPEARANCE_ATTRIBUTES = new Set<string>(IMAGE_CHARACTER_APPEARANCE_ATTRIBUTE_IDS);
const WHOLE_FIGURE_ONLY_ATTRIBUTES = new Set(["build.height", "hands.size", "hands.texture", "hands.nails"]);
const FINE_DETAIL_ATTRIBUTES = new Set([
  "skin.texture",
  "hair.strand_thickness",
  "hair.condition",
  "eyes.pupil",
  "eyes.luminosity",
  "nose.piercings",
  "lips.piercings",
  "ears.piercings",
  "teeth.shape",
  "teeth.condition",
  "arms.hair",
  "legs.hair",
]);
const HAIR_ATTRIBUTE_PREFIX = "hair.";

function framingOf(digest: VisualImageDigest): VisualFramingBand | undefined {
  return digest.cameraFacts.find((fact) => fact.component === "framing")?.band;
}

function attributeFitsFrame(attributeId: string, bodyLocationId: string | undefined, framing: VisualFramingBand | undefined): boolean {
  if (framing === undefined) return true;
  if (WHOLE_FIGURE_ONLY_ATTRIBUTES.has(attributeId)) return framing === "full_figure" || framing === "wide";
  if (framing === "wide" && FINE_DETAIL_ATTRIBUTES.has(attributeId)) return false;
  if (bodyLocationId === undefined) return true;
  const zone = sceneBodyZoneOf(bodyLocationId);
  if (zone === undefined) return false;
  switch (framing) {
    case "close_up":
      return zone === "head";
    case "portrait":
      return zone === "head" || zone === "torso";
    case "waist_up":
      return zone === "head" || zone === "torso" || zone === "arms";
    case "full_figure":
    case "wide":
      return true;
  }
}

function exposureRegionFor(bodyLocationId: string | undefined): keyof RegionExposure | undefined {
  if (bodyLocationId === undefined) return undefined;
  const zone = sceneBodyZoneOf(bodyLocationId);
  if (zone === "torso" || zone === "arms") return "torso";
  if (zone === "pelvis") return "pelvis";
  if (zone === "legs") return bodyLocationId === "feet" || bodyLocationId.startsWith("foot") || bodyLocationId.startsWith("toe") ? "feet" : "legs";
  return undefined;
}

/** Surface detail needs exposed skin; silhouette facts remain visible through clothing. */
function attributeFitsExposure(attributeId: string, imageReveal: "shape" | "skin" | undefined, bodyLocationId: string | undefined, exposure: RegionExposure): boolean {
  if (imageReveal !== "skin" && !attributeId.endsWith(".hair") && !attributeId.includes(".texture")) return true;
  const region = exposureRegionFor(bodyLocationId);
  return region === undefined || exposure[region] !== "covered";
}

function attributeValueOrDefault(
  def: ReturnType<typeof attributeRegistry.byId>,
  sources: CharacterSubjectSources,
): AttributeValue["value"] | undefined {
  if (def === undefined) return undefined;
  const stored = sources.attributes?.find((entry) => entry.id === def.id)?.value;
  const candidate = stored ?? sources.realizedBody?.defaultValueFor(def) ?? def.defaultValue;
  if (candidate === undefined) return undefined;
  const parsed = attributeRegistry.parseValue(def.id, candidate);
  return parsed.ok ? parsed.value : undefined;
}

/**
 * Deterministically project the ordinary visible sheet facts for one subject.
 * These facts never enter a visual-state snapshot, so they cannot widen
 * recognition or narrator memory; they exist only in the image world digest.
 */
export function projectCharacterAppearanceFacts(input: {
  readonly subjectRef: string;
  readonly subjectId: string;
  readonly digest: VisualImageDigest;
  readonly sources: CharacterSubjectSources;
  readonly alreadyProjectedAttributeIds?: ReadonlySet<string>;
}): readonly ImageWorldFact[] {
  const framing = framingOf(input.digest);
  const hairConcealed = isHairConcealed(input.sources.hairOcclusion ?? "none");
  const selectedKinds = new Set(
    (input.digest.subjects.find((subject) => subject.subjectId === input.subjectId)?.required ?? [])
      .concat(input.digest.subjects.find((subject) => subject.subjectId === input.subjectId)?.optional ?? [])
      .map((fact) => fact.kindId),
  );
  const facts: ImageWorldFact[] = [];

  for (const attributeId of IMAGE_CHARACTER_APPEARANCE_ATTRIBUTE_IDS) {
    if (input.alreadyProjectedAttributeIds?.has(attributeId)) continue;
    if (hairConcealed && attributeId.startsWith(HAIR_ATTRIBUTE_PREFIX)) continue;
    if ((attributeId === "hair.arrangement" || attributeId === "hair.style") && selectedKinds.has("presentation.hairstyle")) continue;
    if (attributeId === "presentation.grooming" && selectedKinds.has("presentation.grooming")) continue;
    const def = attributeRegistry.byId(attributeId);
    if (def === undefined || !IMAGE_CHARACTER_APPEARANCE_ATTRIBUTES.has(def.id)) continue;
    if (def.excludeFromPrompts === true || isNonVisualAttribute(def)) continue;
    if (input.sources.realizedBody !== undefined && !input.sources.realizedBody.isAttributeApplicable(def)) continue;
    if (!attributeFitsFrame(def.id, def.bodyLocationId, framing)) continue;
    if (!attributeFitsExposure(def.id, def.imageReveal, def.bodyLocationId, input.sources.exposure)) continue;
    const value = attributeValueOrDefault(def, input.sources);
    if (value === undefined) continue;
    const rendered = formatAttribute(def, value);
    if (rendered.length === 0) continue;
    facts.push({
      key: `${input.subjectRef}.appearance.${def.id}`,
      concept: "subject.appearance",
      value: rendered,
      subjectRef: input.subjectRef,
      ...(def.bodyLocationId === undefined ? {} : { locus: `body:${def.bodyLocationId}` }),
      semanticTags: ["appearance.attribute", def.id],
      disposition: "optional_visual",
      priority: def.coreVisual === true ? 0.85 : def.renderVisual === true ? 0.7 : 0.5,
      source: { owner: IMAGE_CHARACTER_APPEARANCE_OWNER, key: def.id, entityId: input.subjectId },
      truthFingerprint: visualStateFingerprint(value),
    });
  }

  const body = input.sources.realizedBody;
  if (body !== undefined && body.speciesId !== DEFAULT_SPECIES_ID) {
    const value = speciesLabelPhrase(body.speciesId, body.heritageId);
    if (value.length > 0) {
      facts.push({
        key: `${input.subjectRef}.appearance.species`,
        concept: "subject.morphology",
        value,
        subjectRef: input.subjectRef,
        semanticTags: ["appearance.species"],
        disposition: "optional_visual",
        priority: 0.9,
        source: { owner: IMAGE_CHARACTER_SPECIES_OWNER, key: "species", entityId: input.subjectId },
        truthFingerprint: visualStateFingerprint({ speciesId: body.speciesId, heritageId: body.heritageId }),
      });
    }
  }
  return facts;
}

/**
 * Apply the task-level appearance policy after references have been planned.
 * A reference-free portrait promotes its stable descriptors to mandatory and
 * records any absent applicable fact. A reference-backed edit leaves the same
 * current sheet facts optional because the image itself satisfies stable
 * identity completeness. The default expression belongs only to the neutral
 * standalone portrait and is appended when that lane asks for it.
 */
export function applyCharacterAppearancePolicy(input: {
  readonly subject: ImageSubjectDigest;
  readonly sources: CharacterSubjectSources;
  readonly referenceAnchored: boolean;
  readonly requireStableIdentity: boolean;
  readonly includeDefaultExpression: boolean;
}): ImageSubjectDigest {
  let facts = input.referenceAnchored
    ? input.subject.facts.filter((fact) => {
        if (fact.source.owner !== IMAGE_CHARACTER_APPEARANCE_OWNER) return true;
        return attributeRegistry.byId(fact.source.key)?.mutability !== "inherent";
      })
    : [...input.subject.facts];
  if (input.includeDefaultExpression) {
    const def = attributeRegistry.byId("face.expression_default");
    if (def !== undefined && input.sources.realizedBody?.isAttributeApplicable(def) !== false) {
      const value = attributeValueOrDefault(def, input.sources);
      const rendered = value === undefined ? "" : formatAttribute(def, value);
      if (rendered.length > 0) {
        facts.push({
          key: `${input.subject.ref}.appearance.${def.id}`,
          concept: "subject.appearance",
          value: rendered,
          subjectRef: input.subject.ref,
          locus: "body:face",
          semanticTags: ["appearance.attribute", def.id],
          disposition: "optional_visual",
          priority: 0.55,
          source: { owner: IMAGE_CHARACTER_APPEARANCE_OWNER, key: def.id, entityId: input.subject.entityId },
          truthFingerprint: visualStateFingerprint(value),
        });
      }
    }
  }
  if (!input.requireStableIdentity) return { ...input.subject, facts };

  const requiredIds = new Set<string>(IMAGE_CHARACTER_REFERENCE_FREE_REQUIRED_ATTRIBUTE_IDS);
  if (isHairConcealed(input.sources.hairOcclusion ?? "none")) {
    requiredIds.delete("hair.color");
    requiredIds.delete("hair.length");
  }
  for (const attributeId of [...requiredIds]) {
    const def = attributeRegistry.byId(attributeId);
    if (def === undefined || input.sources.realizedBody?.isAttributeApplicable(def) === false) requiredIds.delete(attributeId);
  }

  const found = new Set<string>();
  facts = facts.map((fact) => {
    if (fact.source.owner !== IMAGE_CHARACTER_APPEARANCE_OWNER || !requiredIds.has(fact.source.key)) return fact;
    found.add(fact.source.key);
    return { ...fact, disposition: "required_visual", priority: AFFORDANCE_UNIT_ONE };
  });
  const missing = [...requiredIds]
    .filter((attributeId) => !found.has(attributeId))
    .map((attributeId) => `${input.subject.ref}.appearance.${attributeId}`);

  const body = input.sources.realizedBody;
  if (body !== undefined && body.speciesId !== DEFAULT_SPECIES_ID) {
    const speciesKey = `${input.subject.ref}.appearance.species`;
    let foundSpecies = false;
    facts = facts.map((fact) => {
      if (fact.key !== speciesKey) return fact;
      foundSpecies = true;
      return { ...fact, disposition: "required_visual", priority: AFFORDANCE_UNIT_ONE };
    });
    if (!foundSpecies) missing.push(speciesKey);
  }

  return { ...input.subject, facts, missingRequired: [...input.subject.missingRequired, ...missing] };
}

// ---------------------------------------------------------------------------
// The join
// ---------------------------------------------------------------------------

/**
 * Every subject in one committed visual digest, joined to its canonical owners:
 * the scaffold's translation, plus the four gap-closures documented at the top
 * of this file. The result plugs straight into `buildImageWorldDigest`.
 *
 * Complete means completable: on a fully joined subject, no required anchor is
 * suppressed and `missingRequired` is empty, so a character lane compiled with
 * `refuseOnMissingRequired` can bind. A subject whose owners were not supplied
 * fails closed instead — opaque anchors stay suppressed and reported, and its
 * age and coverage both land in `missingRequired` rather than silently absent.
 */
export function projectCharacterWorldSlices(input: CharacterWorldSlicesInput): CharacterWorldSlices {
  const { digest } = input;
  const resolver = characterSemanticValueResolver({ sources: input.sources, atMinutes: digest.atMinutes });
  const base = projectSubjectDigests({
    digest,
    ...(input.labels === undefined ? {} : { labels: input.labels }),
    semanticValue: resolver,
  });

  const suppressions: ImageWorldSuppression[] = [...base.suppressions];
  const sourceFactByKey = new Map<string, VisualImageFact>();
  for (const subject of digest.subjects) {
    for (const fact of [...subject.required, ...subject.optional]) sourceFactByKey.set(fact.key, fact);
  }
  const digestSubjectById = new Map(digest.subjects.map((subject) => [subject.subjectId, subject]));
  const ageOmitted = input.apparentAge === "omit";

  const subjects = base.subjects.map((slice): ImageSubjectDigest => {
    const sources = input.sources[slice.entityId];
    const digestSubject = digestSubjectById.get(slice.entityId);

    // --- gap 5: hair the headwear fully hides is not visual truth ------------
    // Decided from the resolved band the lane carried beside its coverage
    // readout, never from a garment name: at `full` every selected hair fact is
    // withheld as a designed suppression, and one required fact states the
    // concealment in their place (`hair-concealment.ts`). A withheld hair fact
    // is not a lost anchor either — it leaves `missingRequired` below.
    const hairConcealed = sources !== undefined && isHairConcealed(sources.hairOcclusion ?? "none");
    const concealedHair = (key: string): boolean => {
      const source = sourceFactByKey.get(key);
      return hairConcealed && source !== undefined && isHairVisualFact(source);
    };

    // --- gaps 3 and 4: re-file authored absences, resolve prompt-ready values --
    const facts: ImageWorldFact[] = [];
    const unreadableRequired: string[] = [];
    for (const fact of slice.facts) {
      const source = sourceFactByKey.get(fact.key);
      if (source === undefined) {
        facts.push(fact);
        continue;
      }
      if (concealedHair(fact.key)) {
        suppressions.push({ key: fact.key, owner: fact.source.owner, reason: IMAGE_CHARACTER_HAIR_CONCEALED });
        continue;
      }
      // A projected age anchor under the omit policy is dropped here and
      // recorded once, below, with the synthesized anchor's own bookkeeping.
      if (ageOmitted && isAgeAnchorFact(source)) continue;
      let next = fact;
      if (sources !== undefined && source.sourceRef.kind === "appearance" && source.sourceRef.ref.kind === "anatomy") {
        const state = anatomyStateFor(source.sourceRef.ref.locusKey, sources, digest.atMinutes);
        if (state !== undefined && (state.state === "absent" || state.state === "prosthetic")) {
          next = {
            ...next,
            // Same `morphology` segment kind, so the scaffold's classification
            // invariant survives; what changes is what the claim PROTECTS.
            concept: "subject.absence",
            semanticTags:
              state.state === "prosthetic"
                ? [...next.semanticTags, "morphology.synthetic_surface"]
                : next.semanticTags,
          };
        }
      }
      const ready = promptReadyValue(source, next.value, sources);
      if (ready.kind === "suppress") {
        suppressions.push({ key: fact.key, owner: fact.source.owner, reason: IMAGE_CHARACTER_VALUE_UNREADABLE });
        if (fact.disposition === "required_visual") unreadableRequired.push(fact.key);
        continue;
      }
      facts.push(ready.kind === "value" ? { ...next, value: ready.value } : next);
    }

    let missingRequired = [...slice.missingRequired, ...unreadableRequired].filter((key) => !concealedHair(key));
    if (hairConcealed) facts.push(hairConcealmentFact(slice.ref, slice.entityId));

    // Ordinary image identity is intentionally projected BESIDE the narrow
    // observer-recognition facts. If visual state already selected an
    // attribute, its resolved fact stays authoritative and the ordinary path
    // does not repeat it.
    if (sources !== undefined) {
      const alreadyProjectedAttributeIds = new Set<string>();
      for (const source of sourceFactByKey.values()) {
        if (
          source.subjectId === slice.entityId &&
          source.sourceRef.kind === "appearance" &&
          source.sourceRef.ref.kind === "attribute"
        ) {
          alreadyProjectedAttributeIds.add(source.sourceRef.ref.attributeId);
        }
      }
      facts.push(
        ...projectCharacterAppearanceFacts({
          subjectRef: slice.ref,
          subjectId: slice.entityId,
          digest,
          sources,
          alreadyProjectedAttributeIds,
        }),
      );
    }

    // --- gap 1: the apparent-age anchor ---------------------------------------
    const ref = slice.ref;
    const ageBand = sources?.attributes?.find((entry) => entry.id === VISUAL_IMAGE_AGE_ATTRIBUTE_ID)?.value;
    const digestAgeFact = [...(digestSubject?.required ?? []), ...(digestSubject?.optional ?? [])].find(isAgeAnchorFact);
    const bandWithheld = isWithheldImageAgeBand(ageBand);

    if (ageOmitted) {
      // The lane's policy, ahead of the band: a render whose subjects inherit
      // their visible age from a reference states none, whatever the sheet
      // says. A designed suppression like the minor-band ruling — so the
      // scaffold's fail-closed record for a projected anchor is rewritten, a
      // synthesized anchor is recorded as withheld, and `missingRequired`
      // never names the key: an omitted age must not refuse a rung.
      const ageKey = digestAgeFact?.key ?? `${ref}.apparent_age`;
      const omitted: ImageWorldSuppression = {
        key: ageKey,
        owner: IMAGE_CHARACTER_ATTRIBUTE_OWNER,
        reason: IMAGE_CHARACTER_AGE_OMITTED,
      };
      const index = suppressions.findIndex((entry) => entry.key === ageKey);
      if (index === -1) suppressions.push(omitted);
      else suppressions[index] = omitted;
      missingRequired = missingRequired.filter((key) => key !== ageKey);
    } else if (digestAgeFact !== undefined) {
      // Visual state projected the anchor; the resolver already valued an adult
      // band. A minor band was refused BY RULING, which is a designed absence:
      // reclassify the scaffold's fail-closed record so the lane renders
      // age-silent rather than refusing.
      if (bandWithheld) {
        const index = suppressions.findIndex(
          (entry) => entry.key === digestAgeFact.key && entry.reason === IMAGE_SUBJECT_VALUE_UNRESOLVED,
        );
        if (index !== -1) {
          suppressions[index] = {
            key: digestAgeFact.key,
            owner: IMAGE_CHARACTER_ATTRIBUTE_OWNER,
            reason: IMAGE_CHARACTER_AGE_WITHHELD,
          };
        }
        missingRequired = missingRequired.filter((key) => key !== digestAgeFact.key);
      }
    } else {
      const ageKey = `${ref}.apparent_age`;
      const ageValue = typeof ageBand === "string" ? imageApparentAgeValue(ageBand) : null;
      if (typeof ageBand === "string" && ageValue !== null) {
        facts.push({
          key: ageKey,
          concept: "subject.apparent_age",
          value: ageValue,
          subjectRef: ref,
          semanticTags: [],
          disposition: "required_visual",
          priority: AFFORDANCE_UNIT_ONE,
          source: {
            owner: IMAGE_CHARACTER_ATTRIBUTE_OWNER,
            key: VISUAL_IMAGE_AGE_ATTRIBUTE_ID,
            entityId: slice.entityId,
          },
          // The band IS the owner's fingerprint convention for attribute truth.
          truthFingerprint: ageBand,
        });
      } else if (bandWithheld) {
        suppressions.push({ key: ageKey, owner: IMAGE_CHARACTER_ATTRIBUTE_OWNER, reason: IMAGE_CHARACTER_AGE_WITHHELD });
      } else {
        // No band at all, or one the registry does not recognize ("adult", a
        // legacy value): the age segment is mandatory, so this is degradation
        // and the lane must see it before spend.
        suppressions.push({ key: ageKey, owner: IMAGE_CHARACTER_ATTRIBUTE_OWNER, reason: IMAGE_CHARACTER_AGE_UNRESOLVED });
        missingRequired = [...missingRequired, ageKey];
      }
    }

    // --- gap 2: authoritative exposure claims ---------------------------------
    if (sources !== undefined) {
      facts.push(...exposureFacts(ref, slice.entityId, digest, sources.exposure));
    } else {
      // Fail-closed, not diagnostic-only: coverage is the one owner whose
      // absence is otherwise silent, and the `exposure` segment kind is
      // mandatory-protected — an unjoined subject must refuse a
      // `refuseOnMissingRequired` lane rather than render without any
      // wardrobe-coverage authority.
      const exposureKey = `${ref}.exposure`;
      suppressions.push({
        key: exposureKey,
        owner: IMAGE_CHARACTER_COVERAGE_OWNER,
        reason: IMAGE_CHARACTER_COVERAGE_UNRESOLVED,
      });
      missingRequired = [...missingRequired, exposureKey];
    }

    // Morphology re-read from the mapped facts, exactly as the scaffold does it,
    // so a suppressed or re-filed fact cannot leave a stale guard behind.
    const byKey = new Map(facts.map((fact) => [fact.key, fact]));
    const morphology = [
      ...slice.morphology
        .map((fact) => byKey.get(fact.key))
        .filter((fact): fact is ImageWorldFact => fact !== undefined),
      ...facts.filter(
        (fact) => fact.concept === "subject.morphology" && !slice.morphology.some((member) => member.key === fact.key),
      ),
    ];

    return { ...slice, facts, morphology, missingRequired };
  });

  return { subjects, suppressions };
}
