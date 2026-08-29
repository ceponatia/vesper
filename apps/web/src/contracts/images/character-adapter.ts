import type {
  ImageSubjectDigest,
  ImageWorldFact,
  ImageWorldSuppression,
} from "@vesper/image-core";
import { AFFORDANCE_UNIT_ONE } from "../affordances/core";
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
import type { RegionExposure } from "../items/visibility";
import type { RealizedBody } from "../species";
import {
  visualStateSpeciesFeatureGroupValueSchema,
  visualStateWardrobeValueSchema,
  VISUAL_STATE_SPECIES_FEATURE_GROUP_KIND_ID,
  VISUAL_STATE_WARDROBE_GARMENT_KIND_ID,
  VISUAL_STATE_WARDROBE_ITEM_KIND_ID,
  type VisualFramingBand,
  type VisualStateWardrobeValue,
} from "../visual-state";
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
 * closes those four named gaps and nothing else; it CONSUMES the scaffold, it
 * does not replace it:
 *
 * 1. **Apparent age** gets its canonical semantic path: the subject's
 *    `identity.apparent_age` attribute value, rendered through the owner-ruled
 *    image age vocabulary ({@link imageAgeBandPhrases}). A minor-band value the
 *    registry recognizes is WITHHELD by ruling — no age text ever beats a
 *    younger word — and recorded as a designed suppression, never as a missing
 *    anchor. An absent, unreadable, or registry-unrecognized value fails closed
 *    instead: the `age` segment kind is mandatory, so the key lands in
 *    `missingRequired` and an identity-critical lane refuses before provider
 *    spend.
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
 * `{pos}` is a possessive slot for the lane-side anchor sentence
 * (`apparentAgeAnchor`, server/images/prompts-appearance.ts), which resolves it
 * from the sheet's gender. The world-digest path never guesses a pronoun, so
 * {@link imageApparentAgeValue} renders the neutral article instead.
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
  /** When present, body-inapplicable attributes resolve to nothing rather than stale words. */
  readonly realizedBody?: RealizedBody;
}

export interface CharacterWorldSlicesInput {
  readonly digest: VisualImageDigest;
  /** Display names by subject id — the one field a compiled sentence may name somebody by. */
  readonly labels?: Readonly<Record<string, string>>;
  /** Canonical owners by subject id. A subject with no entry fails its opaque anchors closed. */
  readonly sources: Readonly<Record<string, CharacterSubjectSources>>;
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

  const subjects = base.subjects.map((slice): ImageSubjectDigest => {
    const sources = input.sources[slice.entityId];
    const digestSubject = digestSubjectById.get(slice.entityId);

    // --- gaps 3 and 4: re-file authored absences, resolve prompt-ready values --
    const facts: ImageWorldFact[] = [];
    const unreadableRequired: string[] = [];
    for (const fact of slice.facts) {
      const source = sourceFactByKey.get(fact.key);
      if (source === undefined) {
        facts.push(fact);
        continue;
      }
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

    let missingRequired = [...slice.missingRequired, ...unreadableRequired];

    // --- gap 1: the apparent-age anchor ---------------------------------------
    const ref = slice.ref;
    const ageBand = sources?.attributes?.find((entry) => entry.id === VISUAL_IMAGE_AGE_ATTRIBUTE_ID)?.value;
    const digestAgeFact = [...(digestSubject?.required ?? []), ...(digestSubject?.optional ?? [])].find(
      (fact) =>
        fact.sourceRef.kind === "appearance" &&
        fact.sourceRef.ref.kind === "attribute" &&
        fact.sourceRef.ref.attributeId === VISUAL_IMAGE_AGE_ATTRIBUTE_ID,
    );
    const bandWithheld = isWithheldImageAgeBand(ageBand);

    if (digestAgeFact !== undefined) {
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
    const morphology = slice.morphology
      .map((fact) => byKey.get(fact.key))
      .filter((fact): fact is ImageWorldFact => fact !== undefined);

    return { ...slice, facts, morphology, missingRequired };
  });

  return { subjects, suppressions };
}
