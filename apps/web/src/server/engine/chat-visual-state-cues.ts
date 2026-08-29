import {
  bodyLocationRegistry,
  visualStateLocusKey,
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
  VISUAL_STATE_SPECIES_FEATURE_GROUP_KIND_ID,
  VISUAL_STATE_WARDROBE_GARMENT_KIND_ID,
  VISUAL_STATE_WARDROBE_ITEM_KIND_ID,
  type VisualConstraint,
  type VisualNarratorCue,
  type VisualNarratorCueReason,
  type VisualNarratorDigest,
  type VisualStateLocusRef,
  type VisualStateSnapshot,
} from "@/contracts";
import { chatRecognitionDetailPhrase } from "./chat-recognition-adapter";

/**
 * THE NARRATOR PROJECTION for visual state. Narrator cues carry feature keys,
 * fingerprints, semantic values, evidence, and repeat keys, not finished
 * literary sentences; the prompt adapter realizes concise factual clauses.
 *
 * This module is that adapter, and it is the ONLY place visual state becomes
 * words. Everything upstream of it — projection, composition, visibility,
 * attention, selection — deals in typed facts; everything downstream is prompt
 * bytes.
 *
 * ## Two blocks, deliberately
 *
 * The plan's slice-7 rule is "keep binding constraints separate from optional
 * positive detail", and the two do different jobs:
 *
 * - **Constraints** are the visible mandatory facts — what is worn, what
 *   morphology this body has. They exist to stop the narrator contradicting
 *   them, they are not offered as material for a beat, and they carry no
 *   "weave one in" invitation. Nothing about them is change-gated: a coat that
 *   has been on for six exchanges is exactly as contradictable on the seventh.
 * - **Cues** are the ≤2 optional details the selection actually chose, each
 *   with the reason it earned a slot. These ARE offered, under the same
 *   one-detail restraint the affordance and garment blocks use.
 *
 * ## What it may say
 *
 * Concise factual clauses in the same register the recognition adapter uses:
 * what the eye would report, never a physics readout, never an instruction, and
 * never a value the projection did not commit. Every phrase below is built from
 * the feature's own typed `value` and its locus; an unrecognized kind falls
 * through to a bare, honest locus phrase rather than inventing a sentence — the
 * `genericCue` precedent from `chat-affordance-cues.ts`.
 *
 * Hidden facts never reach here: the selection's constraints are drawn from
 * VISIBLE candidates only (`visual-selection.ts`), so contradiction prevention
 * for the unseen stays the narrator-guidance plan's business and this block
 * cannot leak what the observer cannot see.
 *
 * Pure: no IO, no clock, no flag reads. `chat-pipeline.ts` decides whether to
 * call it.
 */

// ---------------------------------------------------------------------------
// Headings
// ---------------------------------------------------------------------------

/**
 * The two block headings, re-exported from the prompt builder that writes them.
 *
 * They live there and not here for the same reason `AFFORDANCE_CUE_BLOCK_HEADING`
 * does: the sensory-allowance carve-out names the cue block by heading, and a
 * heading that drifted between the block and the carve-out would leave the
 * allowance exempting a block the prompt no longer calls that. One constant,
 * one owner, re-exported so a caller of this module never has to know which.
 */
export { VISUAL_STATE_CONSTRAINT_BLOCK_HEADING, VISUAL_STATE_CUE_BLOCK_HEADING } from "./prompts/character-chat";

// ---------------------------------------------------------------------------
// Subject and lookup context
// ---------------------------------------------------------------------------

export interface ChatVisualStateSubject {
  /** The character these lines are about. */
  readonly characterName: string;
  /** Their possessive form ("Mara's"). Blank falls back to the name. */
  readonly possessive: string;
  /**
   * The visual subject id the digest files this character under, so a value
   * that names subjects (the contact relation) can resolve which participant
   * the possessive belongs to. Absent, such values render nothing rather than
   * guessing an owner.
   */
  readonly subjectId?: string;
  /** The player viewpoint's visual subject id — the one participant "your" may name. */
  readonly playerSubjectId?: string;
}

export interface ChatVisualStateRenderInput {
  readonly digest: VisualNarratorDigest;
  readonly subject: ChatVisualStateSubject;
  /**
   * Garment instance id → its name, so a `garment_part` cue can say "the coat's
   * left cuff" rather than an opaque id. Built from the snapshot's wardrobe
   * features by `visualStateGarmentNames`; an id absent from the map renders as
   * the bare part, which is honest rather than wrong.
   */
  readonly garmentNames?: ReadonlyMap<string, string>;
}

export interface ChatVisualStateLines {
  /** Must-not-contradict clauses, in the digest's own order. */
  readonly constraints: readonly string[];
  /** The selected optional cues, best first — already within the selection's budget. */
  readonly cues: readonly string[];
}

/**
 * Garment instance id → name, from a snapshot's wardrobe features.
 *
 * A garment's name lives on its `wardrobe.garment` value and its locus is the
 * instance; a `garment_part` feature carries the instance id but no name, so
 * this map is what joins them. Built from the SNAPSHOT rather than the digest
 * because a part can be cue-worthy while its garment is not itself a selected
 * constraint.
 */
export function visualStateGarmentNames(snapshot: VisualStateSnapshot): ReadonlyMap<string, string> {
  const names = new Map<string, string>();
  for (const feature of snapshot.features) {
    if (feature.kindId !== VISUAL_STATE_WARDROBE_GARMENT_KIND_ID && feature.kindId !== VISUAL_STATE_WARDROBE_ITEM_KIND_ID) {
      continue;
    }
    if (feature.locus.kind !== "item") continue;
    const name = wardrobeName(feature.value);
    if (name !== undefined) names.set(feature.locus.itemInstanceId, name);
  }
  return names;
}

// ---------------------------------------------------------------------------
// Value readers
// ---------------------------------------------------------------------------

/**
 * Every reader below takes `unknown` and narrows defensively. The values ARE
 * schema-validated upstream, and this module still refuses to trust them: a
 * prompt adapter that throws would cost a turn, and the degraded answer here
 * (drop the clause) is always available.
 */
function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function wardrobeName(value: unknown): string | undefined {
  return text(record(value)?.["name"]);
}

/** `nose.size` → "nose size"; `three_quarter` → "three quarter". */
function humanize(token: string): string {
  return token.replaceAll("_", " ").replaceAll(".", " ").trim();
}

function collapse(phrase: string): string {
  return phrase.replace(/\s+/gu, " ").trim();
}

// ---------------------------------------------------------------------------
// Locus phrases
// ---------------------------------------------------------------------------

/** A body location as the eye would name it, with its side when it has one. */
function bodyPhrase(locus: VisualStateLocusRef & { kind: "body" }): string {
  const { bodyLocationId, side, detail } = locus.locus;
  const leaf = detail?.path.at(-1);
  const label = leaf === undefined ? (bodyLocationRegistry.byId(bodyLocationId)?.label ?? humanize(bodyLocationId)) : humanize(leaf);
  return side === "left" || side === "right" ? collapse(`${side} ${label.toLowerCase()}`) : label.toLowerCase();
}

/** "the coat's left cuff", or just "the left cuff" when the garment has no name here. */
function garmentPartPhrase(
  locus: VisualStateLocusRef & { kind: "garment_part" },
  names: ReadonlyMap<string, string> | undefined,
): string {
  const part = humanize(locus.partId);
  const garment = names?.get(locus.garmentInstanceId);
  return garment === undefined ? `the ${part}` : `the ${garment}'s ${part}`;
}

/** The thing a clause is about, in the possessive voice where a body owns it. */
function locusPhrase(
  locus: VisualStateLocusRef,
  possessive: string,
  names: ReadonlyMap<string, string> | undefined,
): string {
  switch (locus.kind) {
    case "body":
      return collapse(`${possessive} ${bodyPhrase(locus)}`);
    case "garment_part":
      return garmentPartPhrase(locus, names);
    case "item":
      return names?.get(locus.itemInstanceId) === undefined
        ? "the garment"
        : `the ${String(names.get(locus.itemInstanceId))}`;
    case "subject":
      return possessive.replace(/'s$/u, "");
    case "relation":
      return "the contact";
  }
}

/**
 * How the narrator may name one contact participant: "your" for the player
 * viewpoint, the possessive for the digest's own character, and NOTHING for
 * anyone else — a roster member's subject id is an id, and naming an id in
 * prose is worse than silence (the support-anchor precedent above).
 */
function contactOwnerPhrase(
  subjectId: string | undefined,
  context: { possessive: string; subjectId?: string; playerSubjectId?: string },
): string | undefined {
  if (subjectId === undefined) return undefined;
  if (context.playerSubjectId !== undefined && subjectId === context.playerSubjectId) return "your";
  if (context.subjectId !== undefined && subjectId === context.subjectId) return context.possessive;
  return undefined;
}

/**
 * The paired everyday locations whose registry label is a plural: a SIDED
 * reference names one of the pair, so the clause needs the singular ("left
 * hand", never "left hands"). Renderer prose calibration only — the registry's
 * labels stay authoritative everywhere else. Exported for the sensory cue
 * renderer, which names the same locations in the same register; one owner,
 * so the two renderers cannot drift on what a sided hand is called.
 */
export const SIDED_SINGULAR_LABEL: Readonly<Record<string, string>> = {
  eyes: "eye",
  ears: "ear",
  shoulders: "shoulder",
  upper_arms: "upper arm",
  forearms: "forearm",
  wrists: "wrist",
  hands: "hand",
  hips: "hip",
  thighs: "thigh",
  calves: "calf",
  ankles: "ankle",
  feet: "foot",
  arms: "arm",
  legs: "leg",
};

/** A contact-end locus as the eye would name it — the bodyPhrase rules, from the relation value's own shape. */
function contactPartPhrase(locus: Record<string, unknown> | undefined): string | undefined {
  const location = text(locus?.["bodyLocationId"]);
  if (location === undefined) return undefined;
  const detail = text(locus?.["detail"]);
  const side = text(locus?.["side"]);
  const sided = side === "left" || side === "right";
  const label =
    detail !== undefined
      ? humanize(detail)
      : ((sided ? SIDED_SINGULAR_LABEL[location] : undefined) ??
        bodyLocationRegistry.byId(location)?.label ??
        humanize(location)).toLowerCase();
  return sided ? collapse(`${side} ${label}`) : label;
}

// ---------------------------------------------------------------------------
// Per-kind clauses
// ---------------------------------------------------------------------------

/** Where a garment currently is, in the words the wardrobe owner's locus commits. */
function wardrobeClause(value: unknown, subjectPhrase: string): string | undefined {
  const parsed = record(value);
  const name = wardrobeName(value);
  if (name === undefined) return undefined;
  const locus = record(parsed?.["locus"]);
  const kind = text(locus?.["kind"]);
  switch (kind) {
    case "worn":
      return `${subjectPhrase} is wearing the ${name}`;
    case "held":
      return `${subjectPhrase} is holding the ${name}`;
    case "scene":
      return `the ${name} is where it was left, not on ${subjectPhrase}`;
    case undefined:
    default:
      // A locus vocabulary this adapter has not learned: name the garment
      // without claiming where it is, rather than guessing a placement.
      return `the ${name} is in play`;
  }
}

const SURFACE_WETNESS_WORD: Readonly<Record<string, string>> = {
  damp: "damp",
  wet: "wet",
  soaked: "soaked",
};

/** The body-surface owner's mark bands, as noun phrases — the mark IS the thing named. */
const SURFACE_MARK_WORD: Readonly<Record<string, string>> = {
  subtle: "a faint pressure mark",
  clear: "a visible pressure mark",
  strong: "a pronounced pressure mark",
};

const CONDITION_CHANNEL_WORD: Readonly<Record<string, string>> = {
  wetness: "",
  cleanliness: "",
  crease_load: "",
  wear: "",
};

/** Facing, from the subject's side of the pair. `towardSubjectId` is not rendered — the scene id is not a name. */
const FACING_WORD: Readonly<Record<string, string>> = {
  toward: "facing you",
  side_on: "turned side-on to you",
  away: "turned away from you",
};

/** The CONTACT owner's motion bands, verbatim — this is a touch's movement, not the body's. */
const MOTION_WORD: Readonly<Record<string, string>> = {
  still: "resting still",
  pressing: "pressing",
  sliding: "sliding",
  rolling: "rolling",
  tapping: "tapping",
};

/** The SCENE owner's support roles, verbatim. `bearing` is the mirror: this body carries the other. */
const SUPPORT_ROLE_WORD: Readonly<Record<string, string>> = {
  borne_by: "held up by",
  leaning_on: "leaning on",
  held_by: "held by",
  bearing: "carrying the weight of",
};

/**
 * One feature → one clause, or `undefined` when this adapter cannot say
 * anything honest about it.
 *
 * Dispatch is on the KIND ID, never on the semantic tags, because the kind is
 * what fixes the value's shape — reading a tag order would make this renderer
 * silently wrong the first time an adapter reordered its tags.
 */
function featureClause(input: {
  kindId: string;
  value: unknown;
  locus: VisualStateLocusRef;
  semanticTags: readonly string[];
  possessive: string;
  characterName: string;
  names: ReadonlyMap<string, string> | undefined;
  subjectId?: string;
  playerSubjectId?: string;
}): string | undefined {
  const { kindId, value, locus, possessive, names } = input;
  const subjectPhrase = possessive.replace(/'s$/u, "");
  const thing = locusPhrase(locus, possessive, names);
  const parsed = record(value);

  switch (kindId) {
    case VISUAL_STATE_WARDROBE_GARMENT_KIND_ID:
    case VISUAL_STATE_WARDROBE_ITEM_KIND_ID:
      return wardrobeClause(value, subjectPhrase);

    case VISUAL_STATE_SPECIES_FEATURE_GROUP_KIND_ID: {
      // `{ group }` — one of wings / horns / tail, already a plain English
      // plural or mass noun, so it needs no article and no count.
      const group = text(parsed?.["group"]);
      return group === undefined ? undefined : `${subjectPhrase} has ${humanize(group)}`;
    }

    case VISUAL_STATE_BODY_SURFACE_WETNESS_KIND_ID: {
      const band = text(parsed?.["band"]);
      const word = band === undefined ? undefined : SURFACE_WETNESS_WORD[band];
      return word === undefined ? undefined : `${thing} is ${word}`;
    }

    case VISUAL_STATE_BODY_SURFACE_MARK_KIND_ID: {
      // `pressure` is the one committed mark kind. A kind this renderer has not
      // learned is silence, not "a pressure mark" — naming the nearest thing is
      // exactly the substitution the owner vocabulary exists to prevent.
      if (text(parsed?.["kind"]) !== "pressure") return undefined;
      const band = text(parsed?.["band"]);
      const word = band === undefined ? undefined : SURFACE_MARK_WORD[band];
      return word === undefined ? undefined : `there is ${word} on ${thing}`;
    }

    case VISUAL_STATE_BODY_SURFACE_DEPOSIT_KIND_ID: {
      // The garment-deposit clause's wording, deliberately: the same substance
      // in the same three freshness states should read the same whether it is
      // on her sleeve or on the arm inside it. `unknown` is a real member —
      // something is there and nobody committed what — so it renders as a mark
      // rather than as silence. The AMOUNT band is not spoken: "slight" and
      // "extreme" are the owner's scale, and a narrator told there is blood on
      // her hands does not also need to be told how much before it can avoid
      // contradicting the record.
      const deposit = text(parsed?.["deposit"]);
      const freshness = text(parsed?.["freshness"]);
      if (deposit === undefined) return undefined;
      const what = deposit === "unknown" ? "a mark" : humanize(deposit);
      const fresh = freshness === "fresh" ? "fresh " : freshness === "drying" ? "drying " : "";
      return `there is ${fresh}${what} on ${thing}`;
    }

    case VISUAL_STATE_GARMENT_CONDITION_KIND_ID: {
      const band = text(parsed?.["band"]);
      const channel = text(parsed?.["channel"]);
      if (band === undefined || channel === undefined || CONDITION_CHANNEL_WORD[channel] === undefined) {
        return undefined;
      }
      // The band IS the adjective in every channel's ladder ("soaked",
      // "soiled", "rumpled", "threadbare"), so no channel word is needed.
      return `${thing} is ${humanize(band)}`;
    }

    case VISUAL_STATE_GARMENT_PRESENTATION_KIND_ID: {
      const channel = text(parsed?.["channel"]);
      const band = text(parsed?.["band"]);
      if (channel === undefined || band === undefined) return undefined;
      switch (channel) {
        case "closure":
          return `${thing} is ${band === "open" ? "open" : "partly open"}`;
        case "roll":
          return `${thing} is rolled up`;
        case "tuck":
          // The garment owner's three readings: `in`, `partial`, `out`.
          return band === "in"
            ? `${thing} is tucked in`
            : band === "partial"
              ? `${thing} is half untucked`
              : `${thing} is untucked`;
        case "displacement":
          return `${thing} is ${humanize(band)}`;
        default:
          return undefined;
      }
    }

    case VISUAL_STATE_GARMENT_DEPOSIT_KIND_ID: {
      // `unknown` is a real deposit member — something is on the garment and
      // nobody committed what. It renders as a mark rather than as nothing.
      const deposit = text(parsed?.["deposit"]);
      const freshness = text(parsed?.["freshness"]);
      if (deposit === undefined) return undefined;
      const what = deposit === "unknown" ? "a mark" : humanize(deposit);
      const fresh = freshness === "fresh" ? "fresh " : freshness === "drying" ? "drying " : "";
      return `there is ${fresh}${what} on ${thing}`;
    }

    case VISUAL_STATE_GARMENT_DAMAGE_KIND_ID: {
      // The damage vocabulary is NOUNS (a tear, a hole), not adjectives, so the
      // clause has to carry the noun rather than read "the cuff is tear".
      const damage = text(parsed?.["damage"]);
      if (damage === undefined) return undefined;
      return damage === "missing_fastener"
        ? `${thing} is missing a fastener`
        : `${thing} has a ${humanize(damage)}`;
    }

    case VISUAL_STATE_GARMENT_MATERIAL_EFFECT_KIND_ID: {
      const effect = text(parsed?.["effect"]);
      switch (effect) {
        case "beading":
          return `water beads on ${thing}`;
        case "clinging":
          return `${thing} clings where it is wet`;
        case "translucent":
          return `${thing} has gone translucent where it is wet`;
        case undefined:
        default:
          return undefined;
      }
    }

    case VISUAL_STATE_CONDITION_ACTIVE_KIND_ID: {
      const condition = text(parsed?.["condition"]);
      return condition === undefined ? undefined : `${subjectPhrase} is ${humanize(condition)}`;
    }

    case VISUAL_STATE_BODY_LANGUAGE_POSTURE_KIND_ID: {
      const posture = text(parsed?.["posture"]);
      return posture === undefined ? undefined : `${subjectPhrase} is ${humanize(posture)}`;
    }

    case VISUAL_STATE_BODY_LANGUAGE_FACING_KIND_ID: {
      const facing = text(parsed?.["facing"]);
      const word = facing === undefined ? undefined : FACING_WORD[facing];
      return word === undefined ? undefined : `${subjectPhrase} is ${word}`;
    }

    case VISUAL_STATE_BODY_LANGUAGE_HAND_OCCUPATION_KIND_ID: {
      const side = text(parsed?.["side"]);
      return side === undefined || side === "unspecified"
        ? `one of ${possessive} hands is occupied`
        : `${possessive} ${side} hand is occupied`;
    }

    case VISUAL_STATE_BODY_LANGUAGE_MOTION_KIND_ID: {
      const band = text(parsed?.["band"]);
      const word = band === undefined ? undefined : MOTION_WORD[band];
      return word === undefined ? undefined : `${thing} is ${word}`;
    }

    case VISUAL_STATE_BODY_LANGUAGE_SUPPORT_KIND_ID: {
      const relations = parsed?.["relations"];
      if (!Array.isArray(relations) || relations.length === 0) return undefined;
      const first = record(relations[0]);
      const role = text(first?.["role"]);
      const anchor = record(first?.["anchor"]);
      const word = role === undefined ? undefined : SUPPORT_ROLE_WORD[role];
      if (word === undefined) return undefined;
      const surface = text(anchor?.["surfaceKind"]);
      // Without a resolved surface kind the anchor is an opaque id, and naming
      // an id in narrator prose is worse than saying nothing.
      return surface === undefined ? undefined : `${subjectPhrase} is ${word} the ${humanize(surface)}`;
    }

    case VISUAL_STATE_APPEARANCE_ATTRIBUTE_KIND_ID:
    case VISUAL_STATE_APPEARANCE_LOCATED_FACT_KIND_ID:
    case VISUAL_STATE_APPEARANCE_ANATOMY_KIND_ID: {
      // The three adapted appearance kinds are the recognition cue block's own
      // material, so they borrow its renderer rather than growing a second
      // phrasing of the same facts — two renderers would drift, and one prompt
      // can carry both blocks at once.
      if (locus.kind !== "body") return undefined;
      const phrase = chatRecognitionDetailPhrase({
        semanticTags: input.semanticTags,
        locus: locus.locus,
        possessive,
      });
      // Used VERBATIM, as a named fact rather than a sentence: the phrase is
      // already a noun phrase ("Mara's crooked nose", "the linear scar on
      // Mara's right arm"), and every way of forcing it into a clause either
      // loses an article or grows a wrong one. It is also byte-identical to
      // what the recognition cue block writes for the same fact, so a prompt
      // carrying both never says one thing two ways.
      return phrase.length === 0 ? undefined : phrase;
    }

    case VISUAL_STATE_BODY_LANGUAGE_CONTACT_RELATION_KIND_ID: {
      // The whole committed relation, as a NOUN PHRASE like the appearance
      // kinds above ("Mara's hand on your shoulder") — verbless, so a plural
      // location can never break agreement. Both participants must be nameable
      // and the target must be a body: an object surface id, or a roster member
      // this digest has no name for, is silence rather than an id in prose.
      const source = record(parsed?.["source"]);
      const target = record(parsed?.["target"]);
      const sourceOwner = contactOwnerPhrase(text(source?.["subjectId"]), input);
      const sourcePart = contactPartPhrase(record(source?.["locus"]));
      if (sourceOwner === undefined || sourcePart === undefined) return undefined;
      if (text(target?.["kind"]) !== "body") return undefined;
      const targetOwner = contactOwnerPhrase(text(target?.["subjectId"]), input);
      const targetPart = contactPartPhrase(record(target?.["locus"]));
      if (targetOwner === undefined || targetPart === undefined) return undefined;
      return collapse(`${sourceOwner} ${sourcePart} on ${targetOwner} ${targetPart}`);
    }

    case VISUAL_STATE_AFFORDANCE_OBSERVATION_KIND_ID:
    default: {
      // Anything this adapter has not learned. The semantic tags are the only
      // thing every kind carries, and their LAST entry is the value in every
      // projection that produces them, so "<thing> is <value>" is the honest
      // floor. A kind with no usable tag says nothing at all.
      const value = input.semanticTags.at(-1);
      return value === undefined ? undefined : collapse(`${thing} is ${humanize(value)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Reasons
// ---------------------------------------------------------------------------

/**
 * Why this detail earned the slot, one clause each — the recognition adapter's
 * register, extended by the one reason the cue state made sayable.
 *
 * Each clause says only what the policy decided. "just became visible" is
 * literally "the cue state had no record of this family being in view last
 * cut"; it is not an instruction to make a moment of it.
 */
const VISUAL_REASON_CLAUSES: Readonly<Record<VisualNarratorCueReason, string>> = {
  first_notice: "not remarked on before now",
  recognition_refresh: "familiar, after all this time",
  change: "changed from what it was",
  action_relevance: "right where this moment is happening",
  emotional_callback: "it carries the weight of what happened",
  newly_visible: "just became visible",
};

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function subjectPossessive(subject: ChatVisualStateSubject): string {
  const named = subject.characterName.trim();
  const possessive = subject.possessive.trim();
  if (possessive.length > 0) return possessive;
  return named.length > 0 ? `${named}'s` : "";
}

/** One constraint → one must-not-contradict clause. */
export function renderChatVisualStateConstraint(
  constraint: VisualConstraint,
  subject: ChatVisualStateSubject,
  garmentNames?: ReadonlyMap<string, string>,
): string {
  const possessive = subjectPossessive(subject);
  if (possessive.length === 0) return "";
  return (
    featureClause({
      kindId: constraint.kindId,
      value: constraint.value,
      locus: constraint.locus,
      semanticTags: constraint.semanticTags,
      possessive,
      characterName: subject.characterName,
      names: garmentNames,
      ...(subject.subjectId === undefined ? {} : { subjectId: subject.subjectId }),
      ...(subject.playerSubjectId === undefined ? {} : { playerSubjectId: subject.playerSubjectId }),
    }) ?? ""
  );
}

/** One selected cue → one narrator-facing line, with the reason it is live. */
export function renderChatVisualStateCue(
  cue: VisualNarratorCue,
  subject: ChatVisualStateSubject,
  garmentNames?: ReadonlyMap<string, string>,
): string {
  const possessive = subjectPossessive(subject);
  if (possessive.length === 0) return "";
  const clause = featureClause({
    kindId: cue.kindId,
    value: cue.value,
    locus: cue.locus,
    semanticTags: cue.semanticTags,
    possessive,
    characterName: subject.characterName,
    names: garmentNames,
    ...(subject.subjectId === undefined ? {} : { subjectId: subject.subjectId }),
    ...(subject.playerSubjectId === undefined ? {} : { playerSubjectId: subject.playerSubjectId }),
  });
  if (clause === undefined || clause.length === 0) return "";
  return `${clause} — ${VISUAL_REASON_CLAUSES[cue.reason]}`;
}

/**
 * One subject's digest → the two blocks' lines.
 *
 * Empty clauses are dropped rather than rendered blank, and a duplicate clause
 * is dropped too: two features can legitimately reduce to the same sentence
 * (a garment's wetness and the material effect it derives), and saying it twice
 * in one block is the repetition this whole layer exists to avoid.
 */
export function renderChatVisualStateLines(input: ChatVisualStateRenderInput): ChatVisualStateLines {
  const { digest, subject } = input;
  const seen = new Set<string>();
  const keep = (line: string): boolean => {
    const normalized = line.toLowerCase();
    if (line.length === 0 || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  };
  const constraints = digest.constraints
    .map((constraint) => renderChatVisualStateConstraint(constraint, subject, input.garmentNames))
    .filter(keep);
  // Cue clauses are checked against the CONSTRAINT clauses too: a cue that
  // merely restates a must-preserve line adds nothing and reads as a stutter.
  const cues = digest.selected
    .map((cue) => renderChatVisualStateCue(cue, subject, input.garmentNames))
    .filter((line) => line.length > 0 && keep(line.slice(0, line.lastIndexOf(" — "))));
  return { constraints, cues };
}

/** The locus keys a rendered digest speaks about — the trial's leakage check. */
export function visualStateSpokenLoci(digest: VisualNarratorDigest): readonly string[] {
  return [
    ...digest.constraints.map((constraint) => visualStateLocusKey(constraint.locus)),
    ...digest.selected.map((cue) => visualStateLocusKey(cue.locus)),
  ];
}
