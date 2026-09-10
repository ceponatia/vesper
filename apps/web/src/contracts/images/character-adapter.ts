import {
  imageAppearancePhrase,
  type ImageAppearancePhraseValue,
  type ImageSubjectDigest,
  type ImageSubjectPronounSet,
  type ImageWorldFact,
  type ImageWorldSuppression,
} from "@vesper/image-core";
import { AFFORDANCE_UNIT_ONE } from "../affordances/core";
import {
  activeLocatedFacts,
  appearanceFeatureKindRegistry,
  bodyLocusKey,
  currentAnatomyStates,
  parseLocatedFactValue,
  projectImageAppearanceAttributes,
  type AnatomyPartState,
  type BodyLocusRef,
  type LocatedAppearanceFact,
} from "../appearance-features";
import {
  attributeRegistry,
  formatAttribute,
  formatAttributePhrase,
  formatAttributeValue,
  humanizeVocabularyValue,
  isNonVisualAttribute,
  type AttributeValue,
} from "../attributes";
import { bodyLocationRegistry, isIntimateAttributeCategory } from "../body/locations";
import type { HairOcclusion } from "../items/hair-occlusion";
import { FULLY_COVERED, type RegionExposure } from "../items/visibility";
import { DEFAULT_SPECIES_ID, speciesLabelPhrase, type RealizedBody } from "../species";
import {
  visualStateActiveConditionValueSchema,
  visualStateBodyLanguagePostureValueSchema,
  visualStateBodyLanguageSupportValueSchema,
  visualStateBodySurfaceWetnessValueSchema,
  visualStateCosmeticMarkValueSchema,
  visualStateGarmentConditionValueSchema,
  visualStateGarmentDamageValueSchema,
  visualStateGarmentDepositValueSchema,
  visualStateGarmentMaterialEffectValueSchema,
  visualStateGarmentPresentationValueSchema,
  visualStateGroomingValueSchema,
  visualStateHairstyleValueSchema,
  visualStateMakeupValueSchema,
  visualStateNailFinishValueSchema,
  visualStateSpeciesFeatureGroupValueSchema,
  visualStateWardrobeValueSchema,
  VISUAL_STATE_AFFORDANCE_OBSERVATION_KIND_ID,
  VISUAL_STATE_APPEARANCE_ANATOMY_KIND_ID,
  VISUAL_STATE_APPEARANCE_ATTRIBUTE_KIND_ID,
  VISUAL_STATE_APPEARANCE_LOCATED_FACT_KIND_ID,
  VISUAL_STATE_BODY_LANGUAGE_CONTACT_RELATION_KIND_ID,
  VISUAL_STATE_BODY_LANGUAGE_FACING_KIND_ID,
  VISUAL_STATE_BODY_LANGUAGE_HAND_OCCUPATION_KIND_ID,
  VISUAL_STATE_BODY_LANGUAGE_MOTION_KIND_ID,
  VISUAL_STATE_BODY_LANGUAGE_POSTURE_KIND_ID,
  VISUAL_STATE_BODY_LANGUAGE_SUPPORT_KIND_ID,
  VISUAL_STATE_BODY_SURFACE_DEPOSIT_KIND_ID,
  VISUAL_STATE_BODY_SURFACE_MARK_KIND_ID,
  VISUAL_STATE_BODY_SURFACE_WETNESS_KIND_ID,
  VISUAL_STATE_CONDITION_ACTIVE_KIND_ID,
  VISUAL_STATE_GARMENT_CONDITION_KIND_ID,
  VISUAL_STATE_GARMENT_DAMAGE_KIND_ID,
  VISUAL_STATE_GARMENT_DEPOSIT_KIND_ID,
  VISUAL_STATE_GARMENT_MATERIAL_EFFECT_KIND_ID,
  VISUAL_STATE_GARMENT_PRESENTATION_KIND_ID,
  VISUAL_STATE_PRESENTATION_COSMETIC_MARK_KIND_ID,
  VISUAL_STATE_PRESENTATION_GROOMING_KIND_ID,
  VISUAL_STATE_PRESENTATION_HAIRSTYLE_KIND_ID,
  VISUAL_STATE_PRESENTATION_MAKEUP_KIND_ID,
  VISUAL_STATE_PRESENTATION_NAIL_FINISH_KIND_ID,
  VISUAL_STATE_SPECIES_FEATURE_GROUP_KIND_ID,
  VISUAL_STATE_WARDROBE_GARMENT_KIND_ID,
  VISUAL_STATE_WARDROBE_ITEM_KIND_ID,
  VISUAL_STATE_WARDROBE_CONCEALED_TAG,
  type VisualFramingBand,
  type VisualStateLocusRef,
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
import { revealSurfaces } from "./subject-reveal";

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
 * closes those four named gaps, plus three more the scaffold cannot see, and
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
 *    through {@link characterSemanticValueResolver}, and EVERY value then goes
 *    through its own visual-state kind's decision
 *    ({@link imageCharacterKindPromptDecisions}) — a garment's
 *    `{ name, locus: { actorId }, definitionId }` becomes its name, a support
 *    relation becomes "standing on the floor", a tuck reading becomes a clause
 *    bound to the garment it belongs to. There is NO structural fallback: the
 *    flattening this replaced sorted a record's keys alphabetically and shipped
 *    "Katelyn Nacon is surface, ground, legs, borne by." and "Katelyn Nacon is
 *    out, tuck." (#544 D1). Scalars are judged by the kind too (#553), so a kind
 *    the registry refuses cannot escape as a string. A value no renderer can
 *    word is suppressed with {@link IMAGE_CHARACTER_VALUE_UNREADABLE} — and,
 *    when the fact was required, reported in `missingRequired` — because a fact
 *    nobody can word must never reach a payload. A census test walks the kind
 *    registry, so a new kind without a decision fails the build rather than
 *    inheriting nonsense.
 * 4b. **Appearance attributes are worded by the REGISTRY, as prose.** An
 *    image-eligible attribute that declares an `imageAppearance.phrase` reaches
 *    the digest as the record `{ text, phrase: { group, role, fragment } }`
 *    instead of as "Hair color: dark brown": `text` is the standalone noun
 *    phrase every dialect words through `describe()`, and `phrase` is the same
 *    fact taken apart so a prose dialect can compose "healthy dark-brown hair
 *    worn loose to mid-back" from four claims that each stay individually
 *    fitted and recorded. Both paths into a subject's appearance facts — the
 *    visual-state resolver and the registry projection below — emit the same
 *    record, and an attribute with no declared phrase keeps its label form.
 *    The wording is the registry's and the grammar is the dialect's; no
 *    attribute id ever reaches `@vesper/image-core`.
 * 5. **Hair the worn headwear fully hides** is selected truth the render may not
 *    say. Visual state selects hair facts by camera visibility and knows nothing
 *    of the hair-occlusion band the wardrobe seam resolved, so at `full` this
 *    adapter withholds every hair fact as a designed suppression and states one
 *    required `subject.hair_concealment` fact in their place
 *    (`hair-concealment.ts`). `partial` and `none` change nothing.
 * 6. **A garment opaque outer layers fully conceal** is withheld the same way
 *    ({@link IMAGE_CHARACTER_WARDROBE_CONCEALED}, #544 D6): a bra under a sweater
 *    is wardrobe truth for coverage and nothing a render can show. The judgment
 *    is the wardrobe projection's, carried as a semantic tag on the source fact;
 *    the exposure claims over the same coverage readout are untouched, and the
 *    key never lands in `missingRequired`.
 * 7. **Pronouns.** Each subject slice carries the pronoun set its
 *    `identity.gender` implies ({@link imageSubjectPronouns}), so a prose dialect
 *    can introduce a subject once and refer to them afterwards instead of
 *    re-naming a real person beside their own identity reference in every
 *    sentence (#544 D2). Absent or unrecognized gender yields no set, and a
 *    dialect then never guesses.
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

/** Apparent age withheld by the owner ruling: a minor-band value states nothing, ever. */
export const IMAGE_CHARACTER_AGE_WITHHELD = "character.apparent_age.withheld";
/** No usable apparent-age value from the canonical owner — fail-closed, lands in `missingRequired`. */
export const IMAGE_CHARACTER_AGE_UNRESOLVED = "character.apparent_age.unresolved";
/** Apparent age withheld by the lane's policy: this render inherits its visible age from the reference. */
export const IMAGE_CHARACTER_AGE_OMITTED = "character.apparent_age.omitted";
/** No coverage readout was joined for this subject — fail-closed, lands in `missingRequired`. */
export const IMAGE_CHARACTER_COVERAGE_UNRESOLVED = "character.wardrobe_coverage.unresolved";
/**
 * A structured value no kind renderer could word — an unregistered kind, a value
 * that fails its own schema, or a reading a renderer deliberately says nothing
 * about. Silence plus this record, never the alphabetically flattened leaves
 * that shipped "Katelyn Nacon is out, tuck." (#544 D1).
 */
export const IMAGE_CHARACTER_VALUE_UNREADABLE = "character.value_unreadable";
/**
 * A worn garment opaque outer layers fully conceal — a DESIGNED suppression
 * (#544 D6/F6), not a lost anchor. The wardrobe fact stays coverage truth: the
 * exposure claims this adapter states over the same readout are untouched, and
 * the key never reaches `missingRequired`.
 */
export const IMAGE_CHARACTER_WARDROBE_CONCEALED = "character.wardrobe.concealed";
/** A canonical appearance fact was outside the shot's useful framing. */
export const IMAGE_CHARACTER_APPEARANCE_OUT_OF_FRAME = "character.appearance.out_of_frame";
/** A surface detail is hidden by opaque garment coverage. */
export const IMAGE_CHARACTER_APPEARANCE_HIDDEN = "character.appearance.hidden";
/** Current visual state replaced the character-sheet fallback. */
export const IMAGE_CHARACTER_APPEARANCE_REPLACED = "character.appearance.replaced";
/** A required reference-free appearance owner had no usable canonical value. */
export const IMAGE_CHARACTER_APPEARANCE_UNRESOLVED = "character.appearance.unresolved";

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
// Pronouns (#544 F2)
// ---------------------------------------------------------------------------

/** The canonical owner of a subject's pronoun set — presented gender, never natal sex. */
export const IMAGE_CHARACTER_GENDER_ATTRIBUTE_ID = "identity.gender";

/**
 * The pronoun set a dialect may use for one subject once it has introduced them.
 *
 * Derived HERE rather than guessed downstream. A dialect that inferred a pronoun
 * would be asserting a gender the world digest never stated, which is why
 * `dialect-qwen-prose.ts` re-names the subject in every clause instead — 28
 * repetitions of a real person's name beside an identity reference (#544 D2).
 * The application owns the answer, and `identity.gender` is where it lives.
 *
 * The mapping (owner decision, #544): `female` and `male` take the gendered
 * sets; every androgynous or nonbinary presentation takes `they_them`, whichever
 * natal variant it carries — the `…_born_…` split exists so image generation can
 * render the right underlying BUILD, and it says nothing about what to call
 * somebody. An absent value, a non-string, or a member outside those families
 * yields NO set at all, and a subject with no set is referred to by label or by
 * the reference that shows them. Silence is the safe direction: a wrong pronoun
 * is a wrong person.
 */
export function imageSubjectPronouns(
  sources: CharacterSubjectSources | undefined,
): ImageSubjectPronounSet | undefined {
  const value = sources?.attributes?.find((entry) => entry.id === IMAGE_CHARACTER_GENDER_ATTRIBUTE_ID)?.value;
  if (typeof value !== "string") return undefined;
  if (value === "female") return "she_her";
  if (value === "male") return "he_him";
  if (value.startsWith("androgynous_") || value.startsWith("nonbinary_")) return "they_them";
  return undefined;
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
  /** Subjects actually bound to planned, required identity references. */
  readonly identityReferenceSubjects?: ReadonlySet<string>;
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

/**
 * One canonical attribute as prompt material: the registry's PHRASE for this
 * value when it declares one, and its self-describing `Label: value` form when
 * it does not.
 *
 * A phrase is a record rather than a string because a sentence about a person
 * joins several of them — "a slim, lightly toned build with slender arms and a
 * subtle waist" — and a finished noun phrase cannot be taken apart again. Every
 * dialect reads the record's `text` member and states the fact on its own, so a
 * dialect that does not compose is unaffected; a composing one asks
 * `imageAppearancePhrase` for the pieces. The label form is the fallback for an
 * attribute (or a single enum member) the registry gives no wording, which is
 * exactly what every attribute shipped before phrases existed.
 */
function attributeSemanticValue(
  attributeId: string,
  sources: CharacterSubjectSources,
): ImageAppearancePhraseValue | string | undefined {
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
  const phrase = formatAttributePhrase(def, value);
  if (phrase !== null) return phrase;
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

/**
 * Every readable leaf of ONE bounded, owner-parsed value — ids stripped, in
 * canonical key order.
 *
 * Deliberately NOT a general fallback any more (#544 D1). As a catch-all over
 * any record with no renderer this sorted the surviving keys alphabetically and
 * joined the leaves, so a body-language support relation compiled as "Katelyn
 * Nacon is surface, ground, legs, borne by." and a garment tuck reading as
 * "Katelyn Nacon is out, tuck." Structured visual-state values now go through
 * {@link imageCharacterPromptValue}'s per-kind renderers, and a value no
 * renderer can word is SUPPRESSED rather than flattened.
 *
 * The one remaining caller is {@link locatedFactSemanticValue}, whose input the
 * appearance-feature registry itself parsed against that kind's own schema — a
 * bounded authored descriptor list ("dense, clustered"), not an open record.
 */
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
/**
 * A garment name the forge stored in Title Case ("Brown Leather Loafers"), as
 * the common noun it is mid-sentence. Only a name whose EVERY word is a
 * capitalised lower-case word is touched: "Thin gold hoop" is already prose,
 * "T-Shirt" and "Levi's 501 Jeans" carry casing that means something, and the
 * dialect lower-cases nothing but a leading capital (#544).
 */
const TITLE_CASED_NAME = /^[A-Z][a-z'’]*(?:\s+[A-Z][a-z'’]*)*$/u;

function sentenceCaseGarmentName(name: string): string {
  return TITLE_CASED_NAME.test(name) ? name.toLowerCase() : name;
}

function garmentPromptValue(value: VisualStateWardrobeValue): string {
  const name = sentenceCaseGarmentName(value.name.trim());
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

// ---------------------------------------------------------------------------
// The per-kind renderers (#544 F1)
// ---------------------------------------------------------------------------

/**
 * How a rendered fragment is worded.
 *
 * Every dialect wraps a subject claim with a fixed verb — `subject.body_language`
 * and `subject.current_state` become "<subject> is <value>", `subject.appearance`
 * "<subject> has <value>", `subject.wardrobe` "<subject> wears <value>" — so a
 * value is a CLAUSE FRAGMENT, never a sentence, and never a bare vocabulary
 * token. Two shapes, applied consistently:
 *
 * - a WHOLE-SUBJECT state is a bare participle or adjective that completes the
 *   wrapper directly ("standing", "seated on the bed", "blindfolded");
 * - a PART-SCOPED state is a `with …` clause naming the thing it is about
 *   ("with the hair worn loose", "with the sweater tucked in", "with damp hair"),
 *   because the state belongs to a garment or a body part rather than to the
 *   person, and the part has to be named or the model cannot place it.
 *
 * The `with …` shape composes in the grouped prose emission #544 F10 builds and
 * reads as an appositive; under the CURRENT one-claim-one-sentence 2511 wrapper
 * it still lands after "is". That is a dialect-side wart the grouped emission
 * removes, and it is a strict improvement on the flattened record it replaces.
 *
 * Two rules hold everywhere: never emit an id, key, handle or registry token,
 * and prefer SILENCE to a clause nobody can place — a suppressed claim is
 * recorded in provenance, an invented one is not recoverable.
 */

/** A kind whose value is real but is not something an image prompt can say. */
export const IMAGE_CHARACTER_NOT_PROMPT_MATERIAL = "not_prompt_material";
/**
 * A kind the visual-state registry does not admit to image selection at all
 * (`imageEligible: false`), so no value of it can reach a subject claim. Flipping
 * that flag is a deliberate enable, and the census test fails here first so the
 * enable comes with a clause rather than with silence.
 */
export const IMAGE_CHARACTER_NOT_IMAGE_ELIGIBLE = "not_image_eligible";

/** The fields a renderer may read from another selected fact of the same subject. */
export type CharacterPromptSibling = Pick<VisualImageFact, "kindId" | "locus" | "value" | "semanticTags">;

/** One structured value, with everything its renderer is allowed to consult. */
export interface CharacterPromptValueInput {
  /** The SOURCE fact's visual-state kind — the renderer's only dispatch key. */
  readonly kindId: string;
  /** Where the fact sits: a garment part names its garment, a body locus names its part. */
  readonly locus: VisualStateLocusRef;
  readonly value: unknown;
  /** The subject's canonical owners, for the kinds that read them. */
  readonly sources?: CharacterSubjectSources;
  /** The same subject's other selected facts, in selection order. */
  readonly siblings?: readonly CharacterPromptSibling[];
}

/**
 * What a renderer may produce: prompt WORDS, or the typed appearance-phrase
 * record a composing dialect takes apart ({@link ImageAppearancePhraseValue}).
 * Both are prompt-ready — every dialect words the record through its `text`
 * member — and `null` beside them is silence.
 */
export type CharacterPromptRendering = string | ImageAppearancePhraseValue;

type CharacterKindRenderer = (input: CharacterPromptValueInput) => CharacterPromptRendering | null;

/**
 * One visual-state kind's decision: a renderer, or a refusal.
 *
 * A renderer sees EVERY value shape its kind can carry, scalars included
 * (#553). Scalar pass-through used to happen ahead of this table, which meant a
 * kind declared `not_prompt_material` could still reach a prompt as a string —
 * the census test asserted an invariant the code did not enforce. Now the table
 * is consulted first for every value, so a refusal is a refusal whatever shape
 * arrives, and a kind that legitimately receives a resolver-supplied string
 * says so by having a renderer that passes one through.
 */
export type CharacterKindPromptDecision =
  | CharacterKindRenderer
  | typeof IMAGE_CHARACTER_NOT_PROMPT_MATERIAL
  | typeof IMAGE_CHARACTER_NOT_IMAGE_ELIGIBLE;

/**
 * The semantic tag the visual-state wardrobe projection stamps on a WORN garment
 * that opaque outer layers fully conceal (#544 F6, `visual-state/wardrobe.ts`).
 * Read off the SOURCE visual fact's tags, never off the world fact — the world
 * fact is this adapter's own product.
 */
const WARDROBE_CONCEALED_TAG = VISUAL_STATE_WARDROBE_CONCEALED_TAG;

/** The garment instance a part- or item-scoped fact belongs to. */
function garmentInstanceOf(locus: VisualStateLocusRef): string | null {
  if (locus.kind === "garment_part") return locus.garmentInstanceId;
  if (locus.kind === "item") return locus.itemInstanceId;
  return null;
}

/**
 * The NAME of the garment a part-scoped current-state fact is about, resolved
 * through the same wardrobe facts the subject emits.
 *
 * `null` — and therefore silence — in three cases, each deliberate: the fact
 * hangs at no garment; the subject states no wardrobe fact for that instance
 * (the garment is not in this prompt, so a clause about it has nothing to
 * attach to); or the garment is one #544 F6 withholds, where a clause naming it
 * would restate exactly what the concealment suppression removed.
 *
 * The garment PART is deliberately never named: part ids (`cuff_left`,
 * `front_panel`) are opaque authoring slugs whose readable labels live in the
 * blueprint, which this adapter cannot see, and humanizing the slug would put a
 * registry token in a payload.
 */
function garmentNameFor(input: CharacterPromptValueInput): string | null {
  const instanceId = garmentInstanceOf(input.locus);
  if (instanceId === null) return null;
  for (const sibling of input.siblings ?? []) {
    if (
      sibling.kindId !== VISUAL_STATE_WARDROBE_GARMENT_KIND_ID &&
      sibling.kindId !== VISUAL_STATE_WARDROBE_ITEM_KIND_ID
    ) {
      continue;
    }
    if (sibling.locus.kind !== "item" || sibling.locus.itemInstanceId !== instanceId) continue;
    if (sibling.semanticTags.includes(WARDROBE_CONCEALED_TAG)) return null;
    const parsed = visualStateWardrobeValueSchema.safeParse(sibling.value);
    if (!parsed.success) return null;
    const name = parsed.data.name.trim();
    return name.length > 0 ? name : null;
  }
  return null;
}

/** Whether this subject also states a readable posture — support defers to it. */
function statesPosture(input: CharacterPromptValueInput): boolean {
  return (input.siblings ?? []).some(
    (sibling) =>
      sibling.kindId === VISUAL_STATE_BODY_LANGUAGE_POSTURE_KIND_ID &&
      visualStateBodyLanguagePostureValueSchema.safeParse(sibling.value).success,
  );
}

/**
 * The appearance kinds' values ARE their truth fingerprints, and
 * {@link characterSemanticValueResolver} answers them from the canonical owners
 * before anything reaches here — so what arrives is that owner's own
 * prompt-ready answer, a readable string, and this renderer's whole job is to
 * let it through (#553: pass-through is a per-kind policy, not a shape check
 * ahead of the table). Anything else means the compatibility adapter changed
 * shape, and there is nothing honest to say about it.
 */
const ownerResolvedValue: CharacterKindRenderer = (input) =>
  typeof input.value === "string" && input.value.trim().length > 0 ? input.value : null;

/**
 * The attribute kind, which additionally carries the registry's PHRASE record
 * for a value the registry words as prose ({@link attributeSemanticValue}). The
 * record travels to the dialect intact — a prose dialect composes several of
 * them into one sentence, and every other family reads its `text` member — so
 * this is the one appearance kind whose value is not always a string.
 */
const ownerResolvedAppearanceValue: CharacterKindRenderer = (input) =>
  imageAppearancePhrase(input.value) ?? ownerResolvedValue(input);

const wardrobeValue: CharacterKindRenderer = (input) => {
  const parsed = visualStateWardrobeValueSchema.safeParse(input.value);
  return parsed.success ? garmentPromptValue(parsed.data) : null;
};

const speciesFeatureGroupValue: CharacterKindRenderer = (input) => {
  const parsed = visualStateSpeciesFeatureGroupValueSchema.safeParse(input.value);
  return parsed.success ? speciesGroupValue(parsed.data.group, input.sources) : null;
};

/** How hair is currently worn. Colour, length and condition are appearance facts, not this. */
const HAIR_ARRANGEMENT_PHRASES = {
  loose: "worn loose",
  tied_back: "tied back",
  ponytail: "in a ponytail",
  braided: "braided",
  bun: "in a bun",
  updo: "in an updo",
  pinned: "pinned up",
  wrapped: "wrapped",
} as const;

const hairstyleValue: CharacterKindRenderer = (input) => {
  const parsed = visualStateHairstyleValueSchema.safeParse(input.value);
  if (!parsed.success) return null;
  const phrase = HAIR_ARRANGEMENT_PHRASES[parsed.data.arrangement];
  const disturbance = parsed.data.disturbance;
  return disturbance === undefined
    ? `with the hair ${phrase}`
    : `with the hair ${phrase} and ${humanizeVocabularyValue(disturbance)}`;
};

const MAKEUP_PHRASES = {
  bare: "with no makeup",
  natural: "with natural makeup",
  defined: "with defined makeup",
  dramatic: "with dramatic makeup",
  theatrical: "with theatrical makeup",
} as const;

const makeupValue: CharacterKindRenderer = (input) => {
  const parsed = visualStateMakeupValueSchema.safeParse(input.value);
  if (!parsed.success) return null;
  const phrase = MAKEUP_PHRASES[parsed.data.style];
  // A bare face cannot be smudged: the disturbance rides the entry generically,
  // and pairing it with "no makeup" would state a contradiction.
  if (parsed.data.style === "bare" || parsed.data.disturbance === undefined) return phrase;
  return `${phrase}, ${humanizeVocabularyValue(parsed.data.disturbance)}`;
};

const GROOMING_AREA_PHRASES = {
  facial_hair: "facial hair",
  body_hair: "body hair",
  brows: "brows",
  hands: "hands",
} as const;

const groomingValue: CharacterKindRenderer = (input) => {
  const parsed = visualStateGroomingValueSchema.safeParse(input.value);
  if (!parsed.success) return null;
  return `with ${parsed.data.state} ${GROOMING_AREA_PHRASES[parsed.data.area]}`;
};

const NAIL_FINISH_PHRASES = {
  bare: "with bare nails",
  buffed: "with buffed nails",
  clear: "with clear-varnished nails",
  polished: "with polished nails",
  painted: "with painted nails",
  french: "with a french manicure",
  sculpted: "with sculpted nails",
} as const;

const nailFinishValue: CharacterKindRenderer = (input) => {
  const parsed = visualStateNailFinishValueSchema.safeParse(input.value);
  return parsed.success ? NAIL_FINISH_PHRASES[parsed.data.finish] : null;
};

const COSMETIC_MARK_PHRASES = {
  bindi: "with a bindi",
  face_paint: "with face paint",
  body_paint: "with body paint",
  glitter: "with glitter",
  temporary_tattoo: "with a temporary tattoo",
  decal: "with a cosmetic decal",
} as const;

const cosmeticMarkValue: CharacterKindRenderer = (input) => {
  const parsed = visualStateCosmeticMarkValueSchema.safeParse(input.value);
  if (!parsed.success) return null;
  const phrase = COSMETIC_MARK_PHRASES[parsed.data.mark];
  return parsed.data.disturbance === undefined
    ? phrase
    : `${phrase}, ${humanizeVocabularyValue(parsed.data.disturbance)}`;
};

/**
 * Standing wetness, at the body part carrying it — damp hair is the plan's own
 * opening example of a visible current state. The band words are already
 * readable ("damp", "wet", "soaked"); the part comes from the fact's own locus
 * through the body registry, never from the value.
 */
const bodySurfaceWetnessValue: CharacterKindRenderer = (input) => {
  const parsed = visualStateBodySurfaceWetnessValueSchema.safeParse(input.value);
  if (!parsed.success) return null;
  const part = input.locus.kind === "body" ? anatomyPartPhrase(input.locus.locus) : "";
  return part.length === 0 ? parsed.data.band : `${parsed.data.band} at the ${part}`;
};

/**
 * One garment condition channel off its neutral band. Every band in the union is
 * already an English adjective ("soaked", "soiled", "rumpled", "threadbare"), so
 * the renderer's job is to BIND it to the garment; an unbound "is rumpled" would
 * describe the person.
 */
const garmentConditionValue: CharacterKindRenderer = (input) => {
  const parsed = visualStateGarmentConditionValueSchema.safeParse(input.value);
  if (!parsed.success) return null;
  const garment = garmentNameFor(input);
  return garment === null ? null : `with the ${garment} ${parsed.data.band}`;
};

/**
 * Tuck has no neutral band (the garment digest's ruling), but `out` IS the
 * default look for a picture: an untucked hem is what a model draws unasked, so
 * stating it spends a sentence to change nothing. `in` and `partial` are the
 * readings a render can get wrong.
 */
const TUCK_PHRASES = { out: null, partial: "half-tucked", in: "tucked in" } as const;
const CLOSURE_PHRASES = { partly_open: "unbuttoned", open: "open" } as const;
const DISPLACEMENT_PHRASES = { off_shoulder: "slipped off one shoulder", lifted: "lifted" } as const;

const garmentPresentationValue: CharacterKindRenderer = (input) => {
  const parsed = visualStateGarmentPresentationValueSchema.safeParse(input.value);
  if (!parsed.success) return null;
  const garment = garmentNameFor(input);
  if (garment === null) return null;
  const reading = parsed.data;
  switch (reading.channel) {
    case "tuck": {
      const phrase = TUCK_PHRASES[reading.band];
      return phrase === null ? null : `with the ${garment} ${phrase}`;
    }
    case "closure":
      return `with the ${garment} ${CLOSURE_PHRASES[reading.band]}`;
    case "roll":
      // The blueprint binds `roll` to sleeve-shaped parts; the part id itself is
      // an authoring slug this adapter may not say.
      return `with the ${garment} sleeves rolled up`;
    case "displacement":
      return `with the ${garment} ${DISPLACEMENT_PHRASES[reading.band]}`;
  }
};

/**
 * Freshness drives PHRASING (the deposit owner's own words), which is why it is
 * on the value at all. The degree band and the carrying parts are deliberately
 * not worded: the parts are opaque authoring ids, and "substantial" versus
 * "extreme" mud is a quantity a still frame cannot be checked against.
 */
const DEPOSIT_FRESHNESS_WORDS = { set: "dried", drying: "drying", fresh: "fresh" } as const;

const garmentDepositValue: CharacterKindRenderer = (input) => {
  const parsed = visualStateGarmentDepositValueSchema.safeParse(input.value);
  if (!parsed.success) return null;
  const garment = garmentNameFor(input);
  if (garment === null) return null;
  // `unknown` is the deposit owner's "something is on this" member — it names no
  // substance, so it is worded as the mark it makes rather than as a material.
  const substance = parsed.data.deposit === "unknown" ? "staining" : humanizeVocabularyValue(parsed.data.deposit);
  return `with ${DEPOSIT_FRESHNESS_WORDS[parsed.data.freshness]} ${substance} on the ${garment}`;
};

/** A missing fastener is an absence rather than a mark, so it is worded as one. */
const DAMAGE_PHRASES = {
  tear: "tear",
  hole: "hole",
  fray: "frayed edge",
  scuff: "scuff",
  burn: "burn mark",
  missing_fastener: null,
} as const;

const garmentDamageValue: CharacterKindRenderer = (input) => {
  const parsed = visualStateGarmentDamageValueSchema.safeParse(input.value);
  if (!parsed.success) return null;
  const garment = garmentNameFor(input);
  if (garment === null) return null;
  const phrase = DAMAGE_PHRASES[parsed.data.damage];
  return phrase === null
    ? `with a fastener missing from the ${garment}`
    : `with a ${parsed.data.severity} ${phrase} in the ${garment}`;
};

const garmentMaterialEffectValue: CharacterKindRenderer = (input) => {
  const parsed = visualStateGarmentMaterialEffectValueSchema.safeParse(input.value);
  if (!parsed.success) return null;
  const garment = garmentNameFor(input);
  if (garment === null) return null;
  switch (parsed.data.effect) {
    case "beading":
      return `with water beading on the ${garment}`;
    case "clinging":
      return `with the ${garment} clinging wet to the body`;
    case "translucent":
      return `with the wet ${garment} gone translucent`;
  }
};

/**
 * An active condition, in the condition owner's OWN word — the normalized label
 * every condition table in the app matches on ("blindfolded", "bound"). It is
 * already English rather than a registry token, so the adapter states it and
 * reshapes nothing.
 *
 * The severity band is dropped on purpose: it grades how much the condition
 * IMPAIRS somebody, which is not a visible difference a render could be judged
 * against, and "moderate blindfolded" is not English.
 */
const activeConditionValue: CharacterKindRenderer = (input) => {
  const parsed = visualStateActiveConditionValueSchema.safeParse(input.value);
  if (!parsed.success) return null;
  const condition = parsed.data.condition.trim().toLowerCase();
  return condition.length > 0 ? condition : null;
};

/**
 * The posture word, and nothing else. The dialect dedupes it against the
 * composer's own pose text (#544 F10); this adapter states the committed truth
 * and does not guess what the composer wrote.
 */
const postureValue: CharacterKindRenderer = (input) => {
  const parsed = visualStateBodyLanguagePostureValueSchema.safeParse(input.value);
  return parsed.success ? humanizeVocabularyValue(parsed.data.posture) : null;
};

/**
 * Where the weight rests, as a phrase somebody can draw.
 *
 * Silent whenever the same subject already states a posture: the posture places
 * the body, and a second clause about the same configuration is the duplication
 * #544 D10 records. Silent for a PARTICIPANT anchor, because who is carrying
 * whom is scene staging's geometry, not a fact about one body. Silent when the
 * anchor carries no `surfaceKind`, because a support id is not a surface anybody
 * can render. `loadZones` is reach arithmetic and is never worded.
 */
const SUPPORT_BORNE_BY_PHRASES = {
  ground: "standing on the floor",
  seat: "seated on the chair",
  bed: "seated on the bed",
  table: "seated on the table",
  // A wall does not carry weight; leaning is the honest read, and it has its own role.
  wall: null,
  // The scene names its own props; "supported by a prop" is bookkeeping.
  prop: null,
} as const;

const SUPPORT_LEANING_PHRASES = {
  ground: null,
  seat: "leaning on the chair",
  bed: "leaning on the bed",
  table: "leaning on the table",
  wall: "leaning against the wall",
  prop: null,
} as const;

const supportValue: CharacterKindRenderer = (input) => {
  const parsed = visualStateBodyLanguageSupportValueSchema.safeParse(input.value);
  if (!parsed.success) return null;
  if (statesPosture(input)) return null;
  for (const relation of parsed.data.relations) {
    if (relation.anchor.kind !== "surface") continue;
    const surfaceKind = relation.anchor.surfaceKind;
    if (surfaceKind === undefined) continue;
    const phrase =
      relation.role === "borne_by"
        ? SUPPORT_BORNE_BY_PHRASES[surfaceKind]
        : relation.role === "leaning_on"
          ? SUPPORT_LEANING_PHRASES[surfaceKind]
          : null;
    if (phrase !== null) return phrase;
  }
  return null;
};

/**
 * Every visual-state kind's prompt decision — the census the #544 F1 test walks.
 *
 * Keyed by the SOURCE fact's kind id, so the decision is made where the value's
 * schema is known. A kind missing from this table renders nothing and its fact
 * is suppressed with {@link IMAGE_CHARACTER_VALUE_UNREADABLE}: silence plus a
 * provenance record, never a flattened record in a payload.
 */
export const imageCharacterKindPromptDecisions: Readonly<Record<string, CharacterKindPromptDecision>> = {
  // --- identity ------------------------------------------------------------
  [VISUAL_STATE_APPEARANCE_ATTRIBUTE_KIND_ID]: ownerResolvedAppearanceValue,
  [VISUAL_STATE_APPEARANCE_LOCATED_FACT_KIND_ID]: ownerResolvedValue,
  [VISUAL_STATE_APPEARANCE_ANATOMY_KIND_ID]: ownerResolvedValue,
  [VISUAL_STATE_SPECIES_FEATURE_GROUP_KIND_ID]: speciesFeatureGroupValue,
  // --- presentation --------------------------------------------------------
  [VISUAL_STATE_WARDROBE_GARMENT_KIND_ID]: wardrobeValue,
  [VISUAL_STATE_WARDROBE_ITEM_KIND_ID]: wardrobeValue,
  [VISUAL_STATE_PRESENTATION_HAIRSTYLE_KIND_ID]: hairstyleValue,
  [VISUAL_STATE_PRESENTATION_MAKEUP_KIND_ID]: makeupValue,
  [VISUAL_STATE_PRESENTATION_GROOMING_KIND_ID]: groomingValue,
  [VISUAL_STATE_PRESENTATION_NAIL_FINISH_KIND_ID]: nailFinishValue,
  [VISUAL_STATE_PRESENTATION_COSMETIC_MARK_KIND_ID]: cosmeticMarkValue,
  // --- current state -------------------------------------------------------
  [VISUAL_STATE_BODY_SURFACE_WETNESS_KIND_ID]: bodySurfaceWetnessValue,
  [VISUAL_STATE_BODY_SURFACE_MARK_KIND_ID]: IMAGE_CHARACTER_NOT_IMAGE_ELIGIBLE,
  [VISUAL_STATE_BODY_SURFACE_DEPOSIT_KIND_ID]: IMAGE_CHARACTER_NOT_IMAGE_ELIGIBLE,
  [VISUAL_STATE_GARMENT_CONDITION_KIND_ID]: garmentConditionValue,
  [VISUAL_STATE_GARMENT_PRESENTATION_KIND_ID]: garmentPresentationValue,
  [VISUAL_STATE_GARMENT_DEPOSIT_KIND_ID]: garmentDepositValue,
  [VISUAL_STATE_GARMENT_DAMAGE_KIND_ID]: garmentDamageValue,
  [VISUAL_STATE_GARMENT_MATERIAL_EFFECT_KIND_ID]: garmentMaterialEffectValue,
  [VISUAL_STATE_CONDITION_ACTIVE_KIND_ID]: activeConditionValue,
  // The value's `phenomenon` is an affordance registry id (`hair.strand_adhesion`)
  // and no owner anywhere ships prompt words for one. Humanizing the id would put
  // a registry token in a provider payload — the exact leak F1 removes — so an
  // observation earns a clause when its domain earns prompt vocabulary.
  [VISUAL_STATE_AFFORDANCE_OBSERVATION_KIND_ID]: IMAGE_CHARACTER_NOT_PROMPT_MATERIAL,
  // --- body language -------------------------------------------------------
  [VISUAL_STATE_BODY_LANGUAGE_POSTURE_KIND_ID]: postureValue,
  [VISUAL_STATE_BODY_LANGUAGE_SUPPORT_KIND_ID]: supportValue,
  // Directional toward a SUBJECT ID. Which way a body is turned relative to the
  // shot is the camera's own read (`camera.angle`) and the scene staging's
  // geometry; the id is a handle, and an orientation with no named counterpart
  // is nothing a renderer can place.
  [VISUAL_STATE_BODY_LANGUAGE_FACING_KIND_ID]: IMAGE_CHARACTER_NOT_PROMPT_MATERIAL,
  // The value says a hand is engaged and DELIBERATELY not by what (kinds.ts).
  // "One hand is occupied" gives a renderer nothing to draw; what the hands are
  // doing is the composer's action text.
  [VISUAL_STATE_BODY_LANGUAGE_HAND_OCCUPATION_KIND_ID]: IMAGE_CHARACTER_NOT_PROMPT_MATERIAL,
  // A committed contact's motion over time, and the contact it belongs to is not
  // image-eligible — so nothing in the prompt names what is moving. A still
  // frame's own movement is `camera.motion`.
  [VISUAL_STATE_BODY_LANGUAGE_MOTION_KIND_ID]: IMAGE_CHARACTER_NOT_PROMPT_MATERIAL,
  [VISUAL_STATE_BODY_LANGUAGE_CONTACT_RELATION_KIND_ID]: IMAGE_CHARACTER_NOT_IMAGE_ELIGIBLE,
};

/**
 * One visual-state value as the prompt fragment its kind's decision words, or
 * `null` for silence — a refusal kind, an unregistered kind, an unparseable
 * value, or a reading the renderer deliberately says nothing about (an untucked
 * hem, a support relation a posture already places).
 *
 * **Every value shape is judged by the kind, scalars included** (#553). The
 * previous rule passed any string, number or boolean straight through and
 * consulted the table only for records, so `not_prompt_material` was a promise
 * about record values alone: a string arriving at `affordance.observation` or
 * `body_language.facing` would have reached a payload, and the census test that
 * exists to forbid exactly that could not see it. Today's schemas made the leak
 * unreachable, which is precisely why the invariant had to move into the code
 * before a schema change made it reachable again.
 *
 * Pass-through did not disappear; it became a policy a kind declares. The
 * appearance kinds' values are answered from the canonical owners before they
 * arrive, so their renderers pass a resolver string through (and the attribute
 * kind additionally carries the registry's phrase record). Every other kind
 * carries a structured visual-state value, and a scalar at one of them is a
 * shape its own schema never produced.
 */
export function imageCharacterPromptValue(input: CharacterPromptValueInput): CharacterPromptRendering | null {
  const decision = imageCharacterKindPromptDecisions[input.kindId];
  if (typeof decision !== "function") return null;
  const rendered = decision(input);
  if (rendered === null) return null;
  if (typeof rendered !== "string") return rendered;
  return rendered.trim().length === 0 ? null : rendered;
}

type PromptReadyValue =
  | { readonly kind: "value"; readonly value: CharacterPromptRendering }
  | { readonly kind: "suppress" };

/** Resolve one emitted fact's value into prompt-ready form, judged by its source fact's kind. */
function promptReadyValue(
  source: VisualImageFact,
  value: unknown,
  sources: CharacterSubjectSources | undefined,
  siblings: readonly CharacterPromptSibling[],
): PromptReadyValue {
  const rendered = imageCharacterPromptValue({
    kindId: source.kindId,
    locus: source.locus,
    value,
    ...(sources === undefined ? {} : { sources }),
    siblings,
  });
  return rendered === null ? { kind: "suppress" } : { kind: "value", value: rendered };
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

const APPEARANCE_FRAMING_RANK: Readonly<Record<VisualFramingBand, number>> = {
  close_up: 0,
  portrait: 1,
  waist_up: 2,
  full_figure: 3,
  wide: 4,
};

const APPEARANCE_PRIORITY = {
  core: 8_500,
  reinforcement: 6_000,
  fine: 3_500,
  fallback: 2_000,
} as const;

function digestFraming(digest: VisualImageDigest): VisualFramingBand | undefined {
  return digest.cameraFacts.find((fact) => fact.component === "framing")?.band as
    | VisualFramingBand
    | undefined;
}

function isAppearanceAttributeFact(
  fact: Pick<VisualImageFact, "sourceRef">,
  attributeId: string,
): boolean {
  return (
    fact.sourceRef.kind === "appearance" &&
    fact.sourceRef.ref.kind === "attribute" &&
    fact.sourceRef.ref.attributeId === attributeId
  );
}

function appearanceReplacementReason(
  attributeId: string,
  selected: readonly VisualImageFact[],
  emitted: readonly ImageWorldFact[],
): string | undefined {
  const emittedKind = (kindId: string): boolean =>
    selected.some((selectedFact) => {
      if (selectedFact.kindId !== kindId) return false;
      return emitted.some((fact) => fact.key === selectedFact.key);
    });
  if (
    (attributeId === "hair.arrangement" || attributeId === "hair.style") &&
    emittedKind(VISUAL_STATE_PRESENTATION_HAIRSTYLE_KIND_ID)
  ) {
    return IMAGE_CHARACTER_APPEARANCE_REPLACED;
  }
  if (
    attributeId === "presentation.grooming" &&
    emittedKind(VISUAL_STATE_PRESENTATION_GROOMING_KIND_ID)
  ) {
    return IMAGE_CHARACTER_APPEARANCE_REPLACED;
  }
  if (
    attributeId === "face.expression_default" &&
    selected.some(
      (fact) =>
        emitted.some((emittedFact) => emittedFact.key === fact.key) &&
        (fact.segmentKind === "pose" ||
          (fact.segmentKind === "current_state" && fact.sourceRef.kind === "scene_relation")),
    )
  ) {
    return IMAGE_CHARACTER_APPEARANCE_REPLACED;
  }
  if (attributeId === "presentation.style" && emitted.some((fact) => fact.concept === "subject.wardrobe")) {
    return IMAGE_CHARACTER_APPEARANCE_REPLACED;
  }
  return undefined;
}

function speciesIdentityFact(
  slice: ImageSubjectDigest,
  sources: CharacterSubjectSources | undefined,
): { readonly fact?: ImageWorldFact; readonly missing?: string } {
  const body = sources?.realizedBody;
  if (body === undefined || body.speciesId === DEFAULT_SPECIES_ID) return {};
  const key = `${slice.ref}.species`;
  const label = speciesLabelPhrase(body.speciesId, body.heritageId);
  if (!label) return { missing: key };
  return {
    fact: {
      key,
      concept: "subject.morphology",
      value: label,
      subjectRef: slice.ref,
      semanticTags: ["morphology.species", body.speciesId],
      disposition: "required_visual",
      priority: AFFORDANCE_UNIT_ONE,
      source: { owner: "character.species", key: "species.label", entityId: slice.entityId },
      truthFingerprint: `${body.speciesId}:${body.heritageId ?? ""}`,
    },
  };
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
  const baseEntityIds = new Set(base.subjects.map((subject) => subject.entityId));
  const sourceOnlySubjects: ImageSubjectDigest[] = Object.keys(input.sources)
    .filter((subjectId) => !baseEntityIds.has(subjectId))
    .sort()
    .map((subjectId) => ({
      kind: "subject",
      ref: `subject.${subjectId}`,
      entityId: subjectId,
      label: input.labels?.[subjectId]?.trim() || "the subject",
      facts: [],
      morphology: [],
      missingRequired: [],
    }));

  const subjects = [...base.subjects, ...sourceOnlySubjects].map((slice): ImageSubjectDigest => {
    const sources = input.sources[slice.entityId];
    const digestSubject = digestSubjectById.get(slice.entityId);
    const selected = [...(digestSubject?.required ?? []), ...(digestSubject?.optional ?? [])];
    const referenceAnchored = input.identityReferenceSubjects?.has(slice.ref) ?? false;

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

    // --- gap 6: a garment opaque outer layers fully hide is not render truth --
    // The composer path already drops hidden layers; the render prompt used to
    // state a bra and panties under a sweater and jeans as two more "wears"
    // sentences (#544 D6). The tag is the WARDROBE projection's own read of its
    // occlusion edges, taken off the SOURCE fact — this adapter never re-derives
    // layering, and the coverage readout the exposure claims run over is
    // untouched, so the garment stays wardrobe truth for what it covers.
    const concealedWardrobe = (fact: ImageWorldFact, source: VisualImageFact): boolean =>
      fact.concept === "subject.wardrobe" && source.semanticTags.includes(WARDROBE_CONCEALED_TAG);
    const concealedWardrobeKeys = new Set<string>();

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
      if (concealedWardrobe(fact, source)) {
        concealedWardrobeKeys.add(fact.key);
        suppressions.push({
          key: fact.key,
          owner: fact.source.owner,
          reason: IMAGE_CHARACTER_WARDROBE_CONCEALED,
        });
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
      const ready = promptReadyValue(source, next.value, sources, selected);
      if (ready.kind === "suppress") {
        suppressions.push({ key: fact.key, owner: fact.source.owner, reason: IMAGE_CHARACTER_VALUE_UNREADABLE });
        if (fact.disposition === "required_visual") unreadableRequired.push(fact.key);
        continue;
      }
      facts.push({ ...next, value: ready.value });
    }

    let missingRequired = [...slice.missingRequired, ...unreadableRequired].filter(
      // Both concealments are DESIGNED absences: neither may refuse a rung.
      (key) => !concealedHair(key) && !concealedWardrobeKeys.has(key),
    );
    if (hairConcealed) facts.push(hairConcealmentFact(slice.ref, slice.entityId));

    // --- registry-backed image appearance ------------------------------------
    // One projection over the resolved sheet, independent of the deliberately
    // narrow recognition catalog. The adapter alone applies render policy.
    const projectedAppearance =
      sources === undefined
        ? []
        : projectImageAppearanceAttributes({
            attributes: sources.attributes ?? [],
            isAttributeApplicable: (definition) =>
              sources.realizedBody?.isAttributeApplicable(definition) ?? true,
          });
    const projectedIds = new Set(projectedAppearance.map((appearance) => appearance.attributeId));
    const framing = digestFraming(digest);

    for (const appearance of projectedAppearance) {
      if (appearance.attributeId === VISUAL_IMAGE_AGE_ATTRIBUTE_ID) continue;
      const key = `${slice.ref}.appearance.${appearance.attributeId}`;
      if (hairConcealed && appearance.bodyLocationId === "hair") {
        suppressions.push({ key, owner: IMAGE_CHARACTER_ATTRIBUTE_OWNER, reason: IMAGE_CHARACTER_HAIR_CONCEALED });
        continue;
      }
      const replacement = appearanceReplacementReason(appearance.attributeId, selected, facts);
      if (replacement !== undefined) {
        suppressions.push({ key, owner: IMAGE_CHARACTER_ATTRIBUTE_OWNER, reason: replacement });
        continue;
      }
      if (isIntimateAttributeCategory(appearance.definition.category) && !appearance.ordinarySilhouette) {
        continue;
      }
      if (
        appearance.definition.imageReveal !== undefined &&
        !revealSurfaces(appearance.definition, sources?.exposure ?? FULLY_COVERED, false)
      ) {
        suppressions.push({ key, owner: IMAGE_CHARACTER_ATTRIBUTE_OWNER, reason: IMAGE_CHARACTER_APPEARANCE_HIDDEN });
        continue;
      }

      const required = appearance.referenceFreeRequired && !referenceAnchored;
      const inFrame =
        framing === undefined ||
        (APPEARANCE_FRAMING_RANK[framing] >= APPEARANCE_FRAMING_RANK[appearance.minimumFraming] &&
          APPEARANCE_FRAMING_RANK[framing] <= APPEARANCE_FRAMING_RANK[appearance.maximumFraming]);
      if (!required && !inFrame) {
        suppressions.push({ key, owner: IMAGE_CHARACTER_ATTRIBUTE_OWNER, reason: IMAGE_CHARACTER_APPEARANCE_OUT_OF_FRAME });
        continue;
      }

      const existingSource = selected.find((fact) => isAppearanceAttributeFact(fact, appearance.attributeId));
      if (existingSource !== undefined) {
        if (required) {
          const index = facts.findIndex((fact) => fact.key === existingSource.key);
          const existing = facts[index];
          if (existing !== undefined) {
            facts[index] = { ...existing, disposition: "required_visual", priority: AFFORDANCE_UNIT_ONE };
            missingRequired = missingRequired.filter((missing) => missing !== existingSource.key);
          }
        }
        continue;
      }

      facts.push({
        key,
        concept: "subject.appearance",
        // The registry's prose when it has some, its label form when it does
        // not — the same choice `attributeSemanticValue` makes on the other
        // path into this loop, so one attribute reads the same however it got
        // here.
        value: appearance.phraseValue ?? appearance.readableValue,
        subjectRef: slice.ref,
        ...(appearance.bodyLocationId === undefined ? {} : { locus: appearance.bodyLocationId }),
        semanticTags: [`appearance:${appearance.class}`, `attribute:${appearance.attributeId}`],
        disposition: required ? "required_visual" : "optional_visual",
        priority: required ? AFFORDANCE_UNIT_ONE : APPEARANCE_PRIORITY[appearance.class],
        source: {
          owner: IMAGE_CHARACTER_ATTRIBUTE_OWNER,
          key: appearance.attributeId,
          entityId: slice.entityId,
        },
        truthFingerprint: appearance.truthFingerprint,
      });
    }

    if (!referenceAnchored) {
      for (const definition of attributeRegistry.definitions) {
        if (!definition.imageAppearance?.referenceFreeRequired) continue;
        if (definition.id === VISUAL_IMAGE_AGE_ATTRIBUTE_ID) continue;
        if (sources?.realizedBody !== undefined && !sources.realizedBody.isAttributeApplicable(definition)) continue;
        if (hairConcealed && definition.bodyLocationId === "hair") continue;
        if (projectedIds.has(definition.id)) continue;
        const key = `${slice.ref}.appearance.${definition.id}`;
        suppressions.push({
          key,
          owner: IMAGE_CHARACTER_ATTRIBUTE_OWNER,
          reason: IMAGE_CHARACTER_APPEARANCE_UNRESOLVED,
        });
        missingRequired.push(key);
      }
    }

    const species = speciesIdentityFact(slice, sources);
    if (
      species.fact !== undefined &&
      !facts.some(
        (fact) => fact.source.owner === species.fact?.source.owner && fact.source.key === species.fact?.source.key,
      )
    ) {
      facts.push(species.fact);
    }
    if (species.missing !== undefined) {
      suppressions.push({ key: species.missing, owner: "character.species", reason: IMAGE_CHARACTER_APPEARANCE_UNRESOLVED });
      missingRequired.push(species.missing);
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
      } else if (referenceAnchored) {
        // A required subject-bound identity image may carry a missing stable
        // age anchor. Available age text remains authoritative and required;
        // only absence stops refusing the reference edit.
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
        if (!referenceAnchored) missingRequired = [...missingRequired, ageKey];
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
    const morphology = slice.morphology
      .map((fact) => byKey.get(fact.key))
      .filter((fact): fact is ImageWorldFact => fact !== undefined);
    if (species.fact !== undefined) {
      const emittedSpecies = byKey.get(species.fact.key);
      if (emittedSpecies !== undefined) morphology.push(emittedSpecies);
    }

    const pronouns = imageSubjectPronouns(sources);
    return {
      ...slice,
      ...(pronouns === undefined ? {} : { pronouns }),
      facts,
      morphology,
      missingRequired: [...new Set(missingRequired)],
    };
  });

  return { subjects, suppressions };
}
