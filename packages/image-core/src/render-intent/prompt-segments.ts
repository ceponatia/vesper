import { diag, type DiagnosticSink } from "@vesper/contracts";
import type { ImagePromptBinding } from "../capabilities/image-model-capabilities";

/**
 * Ordered semantic prompt segments (image-render-quality.spec.md §"Structured
 * prompt segments").
 *
 * A dialect compiler should consume SEMANTICS, not a finished paragraph. Before
 * this existed, every lane handed the render path one opaque string, so the only
 * way to shorten a prompt that did not fit was to cut characters off the end —
 * which is precisely where the identity lock, the age anchor and the edit delta
 * had been appended. A budget squeeze silently removed the sentences the render
 * exists to honor, and nothing downstream could tell that had happened.
 *
 * A segment says what a piece of prompt text IS. That single fact buys three
 * things this module then provides:
 *
 * - a canonical ORDER, so load-bearing content leads whatever the lane assembled
 *   first (the compilers still order identity, subject count, morphology, pose
 *   and clothing first when no budget has been measured);
 * - a MANDATORY floor, so fitting removes a mood adjective rather than the
 *   sentence that keeps a character recognizable;
 * - PROVENANCE (`source`), so a diagnostic can say which projection contributed a
 *   segment — without that string ever reaching a provider.
 *
 * This module owns the vocabulary and the fitting rules only. Writing prose,
 * compact SDXL tags or Pony-flavoured tags from these segments is the dialect
 * work of slice 3; the one compiler here is the `prose` dialect's initial
 * behavior — today's prose, in segment order.
 */

/**
 * The kinds of thing a prompt says, in CANONICAL EMISSION ORDER.
 *
 * Declaration order is the contract: {@link orderImagePromptSegments} reads this
 * tuple's index and nothing else, so moving an entry moves it in every compiled
 * prompt. The order is the spec's union, which runs from the operation contract
 * outward through the subject, the subject's state, its surroundings, and finally
 * how the whole thing should be rendered — mandatory content first, decoration
 * last, which is exactly the order a budget squeeze wants to eat from the tail of.
 *
 * `framing` sits between `age` and `pose` because the spec's union puts it there.
 * The plan's prose groups it with lighting and atmosphere; that grouping is a
 * reading aid, and the union is the shape code was asked to implement. Framing
 * also genuinely constrains what a pose can mean — a waist-up crop decides
 * whether a hand is in the picture at all — so it earns the earlier position.
 *
 * A dialect may REORDER these when it compiles (the spec's `sdxl_tag` order leads
 * with the rendering medium, which is `quality` here). That is a dialect's
 * business; this order is what a segment list means before any dialect touches it.
 */
export const imagePromptSegmentKinds = [
  "operation",
  "identity",
  "morphology",
  "age",
  "framing",
  "pose",
  "current_state",
  "wardrobe",
  "exposure",
  "setting",
  "lighting",
  "atmosphere",
  "style",
  "quality",
] as const;
export type ImagePromptSegmentKind = (typeof imagePromptSegmentKinds)[number];

/** One semantic piece of a prompt. */
export interface ImagePromptSegment {
  kind: ImagePromptSegmentKind;
  /** The prose this segment contributes. The ONLY field a provider ever sees. */
  text: string;
  /**
   * The same meaning as compact comma-separated tags, for the `sdxl_tag` and
   * `pony_tag` dialects.
   *
   * Carried but deliberately UNUSED here: the prose compiler must never emit tag
   * syntax, and choosing between the two renderings is the dialect decision slice
   * 3 owns. It is on the shape now so a lane that already knows both spellings
   * can state both once, rather than the tag rendering being reverse-engineered
   * from prose later — which is the exact mistake the segment vocabulary exists
   * to prevent.
   */
  tagText?: string;
  /**
   * Whether fitting may drop this segment.
   *
   * Caller-declared, but not caller-final: the kinds the spec names as
   * load-bearing are promoted to mandatory by {@link normalizeImagePromptSegments}
   * with a diagnostic. A lane that marked its age anchor optional would otherwise
   * be one long setting description away from letting a budget squeeze delete it,
   * and the age anchor is an owner ruling rather than a preference.
   */
  mandatory: boolean;
  /**
   * Strength of this segment's claim on the budget; HIGHER survives longer.
   *
   * Compared only against other segments, and only when something has to go, so
   * the absolute numbers mean nothing on their own. Ties fall back to canonical
   * order and then to the caller's own order, so an unprioritized list still
   * degrades from the tail — which is the behavior a lane gets for free by not
   * thinking about priority at all.
   */
  priority: number;
  /**
   * DIAGNOSTIC provenance — `character.attributes`, `body.morphology`,
   * `garment.presentation`, `scene_plan.pose`, `location.description`.
   *
   * It never reaches the provider. That is a structural guarantee rather than a
   * convention: every compiler in this module reads `text` and `tagText`, and
   * {@link joinImagePromptSegments} is the only thing that produces prompt text
   * from a segment. A test pins it with a canary value.
   */
  source?: string;
}

/**
 * The kinds that may never be dropped to save space
 * (image-render-quality.spec.md §"Structured prompt segments": "Identity, age
 * safety anchors, person count, intended morphology, current clothing/exposure
 * authority, and the edit delta remain mandatory").
 *
 * An exhaustive switch rather than a set literal, so a fifteenth segment kind is
 * a COMPILE ERROR here until somebody decides whether losing it is acceptable.
 * A new kind silently defaulting to "droppable" is the failure this classification
 * exists to prevent, and a set would default it exactly that way.
 *
 * Person count has no kind of its own: it is a fact about the subjects, so it
 * travels in `identity` — which is mandatory, so the count is protected with it.
 */
export function isMandatoryImagePromptSegmentKind(kind: ImagePromptSegmentKind): boolean {
  switch (kind) {
    case "operation":
    case "identity":
    case "morphology":
    case "age":
    case "wardrobe":
    case "exposure":
      return true;
    case "framing":
    case "pose":
    case "current_state":
    case "setting":
    case "lighting":
    case "atmosphere":
    case "style":
    case "quality":
      return false;
  }
}

/** A kind's position in the canonical order; every kind has one. */
function segmentKindRank(kind: ImagePromptSegmentKind): number {
  return imagePromptSegmentKinds.indexOf(kind);
}

/**
 * The prompt-length budget a render is fitted to, in CHARACTERS.
 *
 * Characters rather than tokens on purpose. The spec's effective-context protocol
 * measures a budget per pinned version by moving a sentinel through a prompt, and
 * no such measurement exists yet; a token count invented here would be a second
 * guess wearing a measurement's name. Characters are a unit this process can
 * actually count, and both fields come straight off the version's probed prompt
 * binding rather than from anything this module decides.
 *
 * Absent budget means NO FITTING — every segment is emitted, in canonical order.
 * That is what keeps this seam payload-neutral: no seeded model has a probed
 * prompt binding, so no render is trimmed by its arrival.
 */
export interface ImagePromptBudget {
  /**
   * The hard provider ceiling. Exceeding it is a provider ERROR, so this is the
   * only limit that may compress a mandatory segment.
   */
  maxCharacters?: number;
  /**
   * Where quality starts degrading, per the model's documentation. Advisory: it
   * is what OPTIONAL material is trimmed toward, and exceeding it is reported,
   * never refused.
   */
  recommendedCharacters?: number;
}

/** The budget a version's probed prompt binding declares, or an empty one. */
export function imagePromptBudgetFromBinding(binding: ImagePromptBinding | undefined): ImagePromptBudget {
  if (!binding) return {};
  return {
    ...(binding.maxChars === undefined ? {} : { maxCharacters: binding.maxChars }),
    ...(binding.recommendedChars === undefined ? {} : { recommendedCharacters: binding.recommendedChars }),
  };
}

/** The separator between two segments' prose. One space — these are sentences. */
const SEGMENT_SEPARATOR = " ";

/**
 * Put a segment list into canonical order.
 *
 * Canonical kind order first, then priority DESCENDING within a kind, then the
 * caller's own order. Sorted on a copy: the caller's array is not ours to
 * reorder, and a lane that assembled its segments in a meaningful sequence still
 * has that sequence afterwards.
 *
 * Priority breaks ties WITHIN a kind rather than across kinds, which is the
 * deliberate half of the rule: a high-priority atmosphere segment must not be
 * able to push identity down the prompt. Across kinds, priority decides only who
 * is eaten FIRST when something has to go ({@link fitImagePromptSegments}), never
 * who is READ first.
 */
export function orderImagePromptSegments(segments: readonly ImagePromptSegment[]): ImagePromptSegment[] {
  return segments
    .map((segment, index) => ({ segment, index }))
    .sort((left, right) => {
      const kindDelta = segmentKindRank(left.segment.kind) - segmentKindRank(right.segment.kind);
      if (kindDelta !== 0) return kindDelta;
      const priorityDelta = right.segment.priority - left.segment.priority;
      if (priorityDelta !== 0) return priorityDelta;
      return left.index - right.index;
    })
    .map((entry) => entry.segment);
}

/**
 * Bring a caller's segments to the shape the rest of this module assumes:
 * trimmed text, no empties, a usable priority, and the spec's mandatory floor
 * enforced rather than trusted.
 *
 * Every correction is a DIAGNOSTIC and a degraded default, never a throw
 * (docs/resilience.md §2): a lane that mislabels one segment must still get its
 * render. The promotion in particular is the safety-relevant one — an `age`
 * segment marked optional is an age anchor one budget squeeze away from being
 * deleted, and the owner ruling against age drift does not bend to a caller's
 * boolean.
 */
export function normalizeImagePromptSegments(
  segments: readonly ImagePromptSegment[],
  sink?: DiagnosticSink,
): ImagePromptSegment[] {
  const normalized: ImagePromptSegment[] = [];
  for (const segment of segments) {
    const text = segment.text.trim();
    if (text.length === 0) {
      sink?.push(
        diag("info", "image_prompt.segment_empty", "a prompt segment carried no text and was dropped", {
          path: "image_render_intent",
          context: { kind: segment.kind, ...(segment.source === undefined ? {} : { source: segment.source }) },
        }),
      );
      continue;
    }
    const mandatory = segment.mandatory || isMandatoryImagePromptSegmentKind(segment.kind);
    if (mandatory && !segment.mandatory) {
      sink?.push(
        diag("warn", "image_prompt.segment_mandatory_promoted", "a load-bearing prompt segment arrived optional", {
          path: "image_render_intent",
          context: { kind: segment.kind, ...(segment.source === undefined ? {} : { source: segment.source }) },
        }),
      );
    }
    normalized.push({
      ...segment,
      text,
      mandatory,
      priority: Number.isFinite(segment.priority) ? segment.priority : 0,
    });
  }
  return normalized;
}

/** What fitting did, beyond the segments it kept. */
export interface FittedImagePromptSegments {
  /** The surviving segments, in canonical order. */
  segments: ImagePromptSegment[];
  /** Segments removed entirely, weakest first. Never a mandatory one. */
  removed: ImagePromptSegment[];
  /**
   * Segment KINDS shortened by whole sentences, and how many sentences that kind
   * gave up in total. Aggregated by kind rather than per segment because this is
   * read by a diagnostic and by the mandatory-compression check, both of which
   * ask "what kind of meaning did this render lose", never "which of the two
   * setting segments was it".
   */
  compressed: { kind: ImagePromptSegmentKind; droppedSentences: number }[];
  /** The joined length of {@link FittedImagePromptSegments.segments}. */
  characters: number;
  /**
   * True when the mandatory floor STILL exceeds the hard ceiling — the spec's
   * `image_model.prompt_too_long_required` case. Nothing further can be given up
   * without cutting a sentence the render depends on, so the caller sends an
   * over-long prompt and says so rather than mutilating one.
   */
  overBudget: boolean;
  /** True when the result is within the advisory recommended length (or none was set). */
  withinRecommended: boolean;
}

/**
 * Fit a segment list to a budget.
 *
 * Two phases, because the budget has two halves that mean different things:
 *
 * 1. **Optional material is trimmed toward `recommendedCharacters`** (falling
 *    back to the hard ceiling when no advisory length is declared). The weakest
 *    optional segment — lowest priority, then latest in canonical order, then
 *    latest supplied — gives up its LAST SENTENCE, and when it is down to a
 *    single sentence it is removed entirely. Compress-then-remove rather than
 *    remove-outright keeps the most meaning per character surrendered, and it
 *    still satisfies "lowest-priority optional segments first" because the
 *    weakest is re-chosen every round.
 * 2. **Only if a HARD ceiling is still exceeded do mandatory segments compress**,
 *    by whole sentences, weakest first, and never below one sentence. This is
 *    what "never truncates through the middle of a mandatory sentence" means in
 *    code: a mandatory segment loses whole sentences or nothing, and it is never
 *    removed. Exceeding the advisory length alone compresses nothing — the
 *    provider will accept it, and shortening an identity lock to chase a quality
 *    hint trades a real guarantee for a soft one.
 *
 * A budget with neither half set returns every segment untouched, which is the
 * behavior every render gets today.
 */
export function fitImagePromptSegments(
  segments: readonly ImagePromptSegment[],
  budget: ImagePromptBudget = {},
): FittedImagePromptSegments {
  const ordered = orderImagePromptSegments(segments);
  const hard = budget.maxCharacters;
  const soft = budget.recommendedCharacters ?? hard;
  const removed: ImagePromptSegment[] = [];
  const droppedSentences = new Map<ImagePromptSegmentKind, number>();

  if (soft === undefined) {
    return {
      segments: ordered,
      removed,
      compressed: [],
      characters: joinedLength(ordered),
      overBudget: false,
      withinRecommended: true,
    };
  }

  let kept = ordered;
  /**
   * Give up the smallest useful piece of the weakest segment, or report that
   * nothing more may be given. Optional segments are always tried first, so
   * `allowMandatory` widens the search rather than redirecting it — which is what
   * keeps a misconfigured budget (an advisory length ABOVE the hard ceiling, so
   * phase 1 stops with optional material still in hand) from compressing an
   * identity lock while a mood adjective is still there to lose.
   */
  const shrinkOnce = (allowMandatory: boolean): boolean => {
    const index = weakestIndex(kept, false) ?? (allowMandatory ? weakestIndex(kept, true) : null);
    if (index === null) return false;
    const target = kept[index];
    if (target === undefined) return false;
    const sentences = splitSentences(target.text);
    if (sentences.length > 1) {
      kept = replaceAt(kept, index, { ...target, text: sentences.slice(0, -1).join(SEGMENT_SEPARATOR) });
      droppedSentences.set(target.kind, (droppedSentences.get(target.kind) ?? 0) + 1);
      return true;
    }
    // Down to one sentence. An optional segment goes entirely; a mandatory one is
    // never a candidate here at all (`weakestIndex` excludes it), so reaching this
    // line with a mandatory segment is impossible.
    if (target.mandatory) return false;
    removed.push(target);
    kept = [...kept.slice(0, index), ...kept.slice(index + 1)];
    return true;
  };

  // Phase 1 — optional material only, trimmed toward the advisory length.
  while (joinedLength(kept) > soft) {
    if (!shrinkOnce(false)) break;
  }
  // Phase 2 — the hard ceiling, the only limit that may shorten a mandatory
  // segment, and then only by whole sentences and never below its last one.
  if (hard !== undefined) {
    while (joinedLength(kept) > hard) {
      if (!shrinkOnce(true)) break;
    }
  }

  const characters = joinedLength(kept);
  return {
    segments: kept,
    removed,
    compressed: [...droppedSentences].map(([kind, count]) => ({ kind, droppedSentences: count })),
    characters,
    overBudget: hard !== undefined && characters > hard,
    withinRecommended: budget.recommendedCharacters === undefined || characters <= budget.recommendedCharacters,
  };
}

/**
 * The index of the weakest segment on one side of the mandatory line, or null
 * when that side has nothing left to give.
 *
 * Weakest is lowest priority, then LATEST canonical position, then latest
 * supplied — the mirror of the emission order, so an unprioritized prompt
 * degrades from its tail.
 *
 * `mandatory` selects the side rather than widening the search, and the mandatory
 * side additionally excludes a segment already down to its last sentence: such a
 * segment cannot help (it may not be removed, and it may not be cut mid-sentence),
 * and returning it would spin the caller's loop against a candidate that never
 * shrinks.
 *
 * A plain loop rather than `forEach` because the running best is compared against
 * itself on every pass, and TypeScript gives a closed-over `let` its declared type
 * inside a callback — the readable version of that code needs a non-null assertion
 * this one does not.
 */
function weakestIndex(segments: readonly ImagePromptSegment[], mandatory: boolean): number | null {
  let weakest: number | null = null;
  let best: ImagePromptSegment | undefined;
  for (const [index, segment] of segments.entries()) {
    if (segment.mandatory !== mandatory) continue;
    if (mandatory && splitSentences(segment.text).length <= 1) continue;
    if (best === undefined || segment.priority < best.priority) {
      weakest = index;
      best = segment;
      continue;
    }
    if (segment.priority > best.priority) continue;
    // Equal priority: later canonical position wins, then later supplied — the
    // reverse of emission order, so the tail goes first.
    if (segmentKindRank(segment.kind) >= segmentKindRank(best.kind)) {
      weakest = index;
      best = segment;
    }
  }
  return weakest;
}

/** A copy of `segments` with one entry replaced. */
function replaceAt(
  segments: readonly ImagePromptSegment[],
  index: number,
  segment: ImagePromptSegment,
): ImagePromptSegment[] {
  return segments.map((entry, position) => (position === index ? segment : entry));
}

/**
 * Split text into sentences, terminators kept.
 *
 * Deliberately naive — a period, question mark or exclamation mark ends a
 * sentence — because the alternative is a sentence tokenizer, and the only
 * consequence of being wrong here is that a segment gives up a slightly larger
 * or smaller piece of itself. What the rule guarantees is the property the spec
 * asks for: whatever comes back, a boundary is never inside one of these units,
 * so a mandatory segment shortened by whole units is never cut mid-sentence.
 *
 * Run ONLY when compression is actually needed, so an unfitted prompt is never
 * reassembled from its pieces and stays byte-identical to what the lane wrote.
 */
function splitSentences(text: string): string[] {
  return (text.match(/[^.!?]+[.!?]*/g) ?? []).map((sentence) => sentence.trim()).filter((s) => s.length > 0);
}

/** The length {@link joinImagePromptSegments} would produce. */
function joinedLength(segments: readonly ImagePromptSegment[]): number {
  return joinImagePromptSegments(segments).length;
}

/**
 * The `prose` dialect's initial compiler: the segments' own prose, in the order
 * given, separated by a space.
 *
 * It reads `text` and NOTHING ELSE, which is the structural half of the guarantee
 * that `source` never reaches a provider — provenance cannot leak through a
 * function that does not look at it. `tagText` is likewise untouched: emitting
 * tag syntax into prose would corrupt the very models this dialect serves.
 */
export function joinImagePromptSegments(segments: readonly ImagePromptSegment[]): string {
  return segments
    .map((segment) => segment.text.trim())
    .filter((text) => text.length > 0)
    .join(SEGMENT_SEPARATOR);
}

/**
 * Normalize, order, fit and compile one segment list into the prompt text a
 * render will send — the single call a lane or planner makes.
 *
 * Every degradation is reported and none of them fails the render: trimmed
 * optional material is an `info`, a shortened mandatory segment is a `warn`, and
 * a mandatory floor that still exceeds the provider's hard ceiling is
 * `image_model.prompt_too_long_required` — the code the prompt binding's own
 * contract already names for exactly this case. Sending the over-long prompt and
 * saying so beats cutting an identity lock in half to fit.
 */
export function compileImagePromptSegments(
  segments: readonly ImagePromptSegment[],
  budget: ImagePromptBudget = {},
  sink?: DiagnosticSink,
): string {
  const fitted = fitImagePromptSegments(normalizeImagePromptSegments(segments, sink), budget);

  if (fitted.removed.length > 0 || fitted.compressed.length > 0) {
    sink?.push(
      diag("info", "image_prompt.segments_trimmed", "this prompt did not fit its budget and gave up optional detail", {
        path: "image_render_intent",
        context: {
          removed: fitted.removed.map((segment) => segment.kind),
          compressed: fitted.compressed,
          characters: fitted.characters,
          ...(budget.recommendedCharacters === undefined ? {} : { recommended: budget.recommendedCharacters }),
          ...(budget.maxCharacters === undefined ? {} : { maximum: budget.maxCharacters }),
        },
      }),
    );
  }
  // Reported apart from the trim above, because the two are different events for
  // an operator: optional detail going is the budget working as designed, while a
  // mandatory sentence going means the render is now describing less than the
  // lane guaranteed.
  const mandatoryCompressed = fitted.compressed.filter((entry) => isMandatoryImagePromptSegmentKind(entry.kind));
  if (mandatoryCompressed.length > 0) {
    sink?.push(
      diag("warn", "image_prompt.mandatory_segment_compressed", "a load-bearing prompt segment lost a sentence", {
        path: "image_render_intent",
        context: { compressed: mandatoryCompressed, characters: fitted.characters },
      }),
    );
  }
  if (fitted.overBudget) {
    sink?.push(
      diag("warn", "image_model.prompt_too_long_required", "the mandatory prompt segments exceed this model's limit", {
        path: "image_render_intent",
        context: {
          characters: fitted.characters,
          ...(budget.maxCharacters === undefined ? {} : { maximum: budget.maxCharacters }),
        },
      }),
    );
  }
  return joinImagePromptSegments(fitted.segments);
}
