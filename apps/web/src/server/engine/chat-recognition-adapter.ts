import {
  bodyLocationRegistry,
  buildRecognitionCandidates,
  projectAppearanceTruth,
  selectRecognitionCue,
  type AffordancePerceptionView,
  type AnatomyPartState,
  type AppearanceDetailTier,
  type AttributeValue,
  type BodyLocusRef,
  type DiagnosticSink,
  type LocatedAppearanceFact,
  type RecognitionCue,
  type RecognitionCueReason,
  type RecognitionCueSelection,
  type VisualMemoryState,
} from "@/contracts";

/**
 * THE CHAT-LANE RECOGNITION ADAPTER (body-attribute-affordances slice 7;
 * body-attribute-affordances.spec.code-organization.md §Recognition ownership).
 *
 * One function, three contract calls, one sentence out:
 *
 * ```text
 * body truth      → projectAppearanceTruth      (appearance-features)
 * this observer   → buildRecognitionCandidates  (affordances/recognition)
 * worth the beat? → selectRecognitionCue        (affordances/recognition)
 * → renderChatRecognitionCue                    (here, and only here)
 * ```
 *
 * The division of labour is the whole design: the contracts decide WHAT is
 * perceptible, what was noticed, and whether saying it earns the beat. This
 * module decides only HOW the winning cue reads in English, exactly as
 * `chat-affordance-cues.ts` does for the physical read — same register, same
 * refusals.
 *
 * Four rules it exists to hold:
 *
 * 1. **PURE.** No IO, no clock, no randomness, no env. The story clock arrives as
 *    `clockMinutes`, memory arrives as a value, and the persistence half lives in
 *    `visual-memory-store.ts`. That is what makes a retake reproduce a
 *    byte-identical cue line from the same committed cut.
 * 2. **Nothing is invented.** A cue states a body detail that is true, currently
 *    perceptible, and above the notice threshold — nothing about arousal,
 *    consent, feelings, or what anyone intends. The three salience dimensions
 *    already ran; this is the last, purely textual step.
 * 3. **It never says who is looking.** In this prompt the second person is the
 *    CHARACTER ("You are feeling…"), so an observer-facing "you notice it" would
 *    have Mara noticing her own nose. The cue names the detail and why it is
 *    live; the observer stays out of the sentence.
 * 4. **At most one line.** `selectRecognitionCue` returns at most one cue by
 *    contract; this module cannot manufacture a second.
 *
 * ## What production actually feeds it today
 *
 * Only canonical ATTRIBUTES. Located appearance facts and evented anatomy state
 * have contracts and registries but no authoring surface in the chat lane yet, so
 * the pipeline passes neither. They are accepted here as optional inputs — the
 * same optional shape `AppearanceProjectionInput` carries — so that the lane that
 * gains an author (or a fixture, or the successor) threads them without reshaping
 * this seam, and so this adapter's own tests can exercise the paths the priors
 * were calibrated for.
 */

/**
 * The tier a chat observer reaches at ordinary conversational distance. Not 3:
 * that is deliberate inspection, and this lane has no signal for it — a crooked
 * nose reads across a table, a chipped tooth does not.
 */
export const CHAT_RECOGNITION_BASE_DETAIL_TIER: AppearanceDetailTier = 2;

export interface ChatRecognitionReadInput {
  readonly subjectId: string;
  readonly characterName: string;
  /** How the line names the subject — "Wren's". */
  readonly possessive: string;
  /** Already-resolved attribute values (`ChatAffordanceReadResult.attributes.values`). */
  readonly attributes: readonly AttributeValue[];
  /** Authored/acquired marks. Absent in the chat lane today — see the header. */
  readonly locatedFacts?: readonly LocatedAppearanceFact[];
  /** Evented topology. Absent in the chat lane today — see the header. */
  readonly anatomy?: readonly AnatomyPartState[];
  /** The affordance read's perception view (`ChatAffordanceReadResult.request.perception`). */
  readonly perception: AffordancePerceptionView;
  /** This observer's memory of this subject, as loaded from `chat_visual_memory`. */
  readonly memory: VisualMemoryState;
  readonly clockMinutes: number;
  readonly sink?: DiagnosticSink;
}

export interface ChatRecognitionRead {
  /** The one narrator-facing line, or `null` when nothing earned the beat. */
  readonly cueLine: string | null;
  /**
   * The full selection. `memoryAfterNotices` is what the caller persists once the
   * exchange commits — WITH `mentionCommit` applied only if the cue actually
   * entered the cut (`commitRecognitionMention`). Notices are persisted either
   * way: recognition strengthens by looking, not by being talked about.
   */
  readonly selection: RecognitionCueSelection;
}

/**
 * Body truth → this observer → at most one cue line.
 *
 * The observer context is fixed for the lane and each value is a claim:
 * `baseDetailTier` 2 is conversational distance, `intimateAllowed: false` is the
 * hard gate staying shut (this lane has no consent owner, and "no owner" is not
 * "allowed"), no `inspectionFocus` because nothing here can detect deliberate
 * inspection, and no `importanceBoosts` because observer-relationship weighting
 * has no seam yet — boosts ride the observer context when it does, never the
 * stored priors.
 */
export function buildChatRecognitionRead(input: ChatRecognitionReadInput): ChatRecognitionRead {
  const projected = projectAppearanceTruth({
    subjectId: input.subjectId,
    attributes: input.attributes,
    ...(input.locatedFacts === undefined ? {} : { locatedFacts: input.locatedFacts }),
    ...(input.anatomy === undefined ? {} : { anatomy: input.anatomy }),
    atMinutes: input.clockMinutes,
    ...(input.sink === undefined ? {} : { sink: input.sink }),
  });
  const { candidates } = buildRecognitionCandidates({
    projected,
    observer: {
      perception: input.perception,
      baseDetailTier: CHAT_RECOGNITION_BASE_DETAIL_TIER,
      intimateAllowed: false,
    },
    ...(input.sink === undefined ? {} : { sink: input.sink }),
  });
  const selection = selectRecognitionCue({
    candidates,
    memory: input.memory,
    atMinutes: input.clockMinutes,
  });
  const line =
    selection.cue === null
      ? ""
      : renderChatRecognitionCue(selection.cue, {
          characterName: input.characterName,
          possessive: input.possessive,
        });
  return { cueLine: line.length > 0 ? line : null, selection };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** How the line names the subject. */
export interface ChatRecognitionSubject {
  readonly characterName: string;
  readonly possessive: string;
}

/** `ring_finger` → "ring finger". The one humanizer; tags and ids share it. */
function humanize(token: string): string {
  return token.replace(/_/gu, " ").trim();
}

/** `fingers` → "fingers"; an unregistered id degrades to its own readable form. */
function locationLabel(locationId: string): string {
  return bodyLocationRegistry.byId(locationId)?.label.toLowerCase() ?? humanize(locationId);
}

/**
 * Paired-part labels are plural ("forearms", "hands") because coverage asks about
 * both at once. A SIDED locus names exactly one of the pair, so the label has to
 * follow — "a scar on Mara's right forearms" is not a sentence. The irregulars
 * are listed rather than derived: there is no rule that turns "calves" into
 * "calf", and guessing one would be worse than a three-entry table.
 */
const IRREGULAR_SINGULARS: Readonly<Record<string, string>> = {
  calves: "calf",
  feet: "foot",
  teeth: "tooth",
};

function singularLabel(label: string): string {
  const irregular = IRREGULAR_SINGULARS[label];
  if (irregular !== undefined) return irregular;
  return label.endsWith("s") && !label.endsWith("ss") ? label.slice(0, -1) : label;
}

/**
 * The body part this cue is about — "nose", "right forearm", "left ring finger".
 *
 * A fine detail path names the part outright ("ring finger") and is already
 * singular, so only the coarse label needs the pair treatment. `center` is a
 * placement, not one of a pair, so it never reaches the sentence.
 */
function partPhrase(locus: BodyLocusRef): string {
  const detail = locus.detail?.path.at(-1);
  const sided = locus.side === "left" || locus.side === "right";
  const base = detail === undefined ? locationLabel(locus.bodyLocationId) : humanize(detail);
  const label = sided && detail === undefined ? singularLabel(base) : base;
  return sided ? `${locus.side ?? ""} ${label}`.trim() : label;
}

/** The topology vocabulary, as the eye would put it. */
const ANATOMY_STATE_WORDS: Readonly<Record<string, string>> = {
  absent: "missing",
  altered: "altered",
  prosthetic: "prosthetic",
  present: "",
};

/**
 * The detail as a noun phrase — "Mara's crooked nose", "the linear scar on
 * Mara's right arm", "Mara's missing left ring finger".
 *
 * The projection's TAG ORDER is the discriminator, and it is stable per source
 * (`appearance-features/projection.ts`):
 *
 * - anatomy — `["anatomy", state, alteration?, locationId, side?, …detailPath]`;
 * - located fact — `[family, kindId, locationId, side?, …valueTags]`, where the
 *   kind id is the only tag carrying a dot, and its last segment is the noun
 *   ("mark.scar" → "scar"): the family is a namespace, not a word;
 * - attribute — `semanticTagsFor(value)`, which puts the value LAST and any facet
 *   noun ("freckles") between the location and it.
 *
 * Anything unrecognized falls through to the bare part, which is honest and
 * cannot throw — the `genericCue` precedent in `chat-affordance-cues.ts`.
 */
function detailPhrase(cue: RecognitionCue, possessive: string): string {
  const tags = cue.semanticTags.map(humanize).filter((tag) => tag.length > 0);
  const part = partPhrase(cue.locus);
  const [first] = tags;

  if (first === "anatomy") {
    const state = tags[1] ?? "";
    const word = ANATOMY_STATE_WORDS[state] ?? state;
    return collapse(`${possessive} ${word} ${part}`);
  }

  const kindIndex = cue.semanticTags.findIndex((tag) => tag.includes("."));
  if (kindIndex > 0) {
    const kindId = cue.semanticTags[kindIndex] ?? "";
    const noun = humanize(kindId.slice(kindId.lastIndexOf(".") + 1));
    // Everything after the kind id is locus echo then value tags; the locus is
    // already in `part`, so only the first VALUE tag earns a word.
    const values = cue.semanticTags
      .slice(kindIndex + 1)
      .filter((tag) => tag !== cue.locus.bodyLocationId && tag !== cue.locus.side)
      .map(humanize);
    const [adjective] = values;
    return collapse(`the ${adjective ?? ""} ${noun} on ${possessive} ${part}`);
  }

  const value = tags.at(-1);
  if (value === undefined) return collapse(`${possessive} ${part}`);
  const facet = tags.length > 2 ? tags.slice(1, -1).join(" ") : "";
  if (facet.length > 0) return collapse(`the ${value} ${facet} on ${possessive} ${part}`);
  return collapse(`${possessive} ${value} ${part}`);
}

/** Squeeze the gaps an absent optional leaves behind. */
function collapse(phrase: string): string {
  return phrase.replace(/\s+/gu, " ").trim();
}

/**
 * Why this detail is live, one clause each, in the cue register: a statement the
 * narrator may weave in, never an instruction and never a physics report.
 *
 * The five reasons are the memory doc's §Narrator behavior list, and each clause
 * says only what the policy actually decided — "not remarked on before now" is
 * literally "this observer has no memory row"; "changed from what it was" is
 * literally a fingerprint that no longer matches. Nothing here is allowed to
 * editorialize past the datum that produced it.
 */
const REASON_CLAUSES: Readonly<Record<RecognitionCueReason, string>> = {
  first_notice: "not remarked on before now",
  recognition_refresh: "familiar, after all this time",
  change: "changed from what it was",
  action_relevance: "right where this moment is happening",
  emotional_callback: "it carries the weight of what happened",
};

/**
 * One selected cue → one narrator-facing line.
 *
 * A blank possessive falls back to the character's name rather than rendering
 * "'s crooked nose"; with neither, the line is "" and the caller drops it (a
 * degraded default, never a throw).
 */
export function renderChatRecognitionCue(cue: RecognitionCue, subject: ChatRecognitionSubject): string {
  const named = subject.characterName.trim();
  const possessive = subject.possessive.trim() || (named.length > 0 ? `${named}'s` : "");
  if (possessive.length === 0) return "";
  const detail = detailPhrase(cue, possessive);
  if (detail.length === 0) return "";
  return `${detail} — ${REASON_CLAUSES[cue.reason]}`;
}
