import {
  attributeEnumValue,
  attributeRegistry,
  bodyLocationRegistry,
  AFFORDANCE_CUES_PER_EXCHANGE,
  HAIR_LOCATION_ID,
  HAIR_WET_CLUMPING_ID,
  HAIR_WIND_OR_MOTION_ID,
  type AffordanceIntensityBand,
  type AffordanceObservation,
  type ResolvedAttributeSnapshot,
} from "@/contracts";

/**
 * CUE PROJECTION for the chat lane (body-attribute-affordances slice 5).
 *
 * One selected `AffordanceObservation` → one short factual clause, in the
 * garment-cue register (`items/garment-observation.ts`'s `phrase`): concrete,
 * present tense, no numbers, no physics vocabulary, no instruction to the
 * narrator. The prompt block around them supplies the "weave at most one in"
 * framing; a cue line itself only ever states what is true.
 *
 * Three rules this module exists to hold:
 *
 * 1. **Projection may read colour; mechanics never may.** `hair.color` is a
 *    stable appearance attribute with no physical effect, so it is excluded from
 *    the domain's `requiredAttributeIds` on purpose — but "damp auburn strands"
 *    is the sentence the narrator actually wants. Colour therefore enters HERE,
 *    at the last step, where it cannot influence a band.
 * 2. **The phenomena that can reach production get written prose; everything
 *    else degrades to its tags.** Only `hair.wet_clumping` and
 *    `hair.wind_or_motion_response` are reachable from this lane today (adhesion
 *    needs a contact owner, shedding needs a committed impulse — see
 *    `chat-affordances.ts`). A future phenomenon, or a successor lane that can
 *    feed one, still renders something honest rather than throwing or vanishing.
 * 3. **Nothing here decides what is said.** Ranking, the repeat gate and the cap
 *    already ran in `contracts/affordances/core/ranking.ts`; this is the last,
 *    purely textual step.
 *
 * PURE — no IO, no clock, no randomness — so the retake guarantee survives the
 * projection: the same committed cut renders byte-identical cue lines.
 */

// ---------------------------------------------------------------------------
// Subject phrasing
// ---------------------------------------------------------------------------

/**
 * The character's hair colour as a bare adjective ("auburn", "dark brown",
 * "pink"), or "" when it is unset or not registry vocabulary.
 *
 * A dye job renders as its colour, not as its provenance: `dyed_pink` hair looks
 * pink, and "dyed pink hair is gathered into damp clumps" would be telling the
 * narrator a life story instead of what the eye sees. Unknown vocabulary drops
 * silently — the same rule the attribute maps use, since a value the registry
 * does not know is a value we cannot promise reads as an adjective.
 */
export function chatAffordanceHairColor(attributes: ResolvedAttributeSnapshot): string {
  const value = attributeEnumValue(attributes, "hair.color");
  if (value === undefined) return "";
  if (!(attributeRegistry.byId("hair.color")?.allowedValues ?? []).includes(value)) return "";
  return value.replace(/^dyed_/u, "").replace(/_/gu, " ");
}

/** `hair` → "hair"; an unregistered id degrades to its own readable form. */
function locationLabel(locationId: string): string {
  return bodyLocationRegistry.byId(locationId)?.label.toLowerCase() ?? locationId.replace(/_/gu, " ");
}

/**
 * "Wren's auburn hair" — the possessive, the projected colour (hair only), the
 * body location. Built per observation rather than once, because a second domain
 * speaks about a different location and must not inherit the hair's adjective.
 */
function subjectPhrase(observation: AffordanceObservation, possessive: string, color: string): string {
  const label = locationLabel(observation.sourceLocationId);
  const adjective = observation.sourceLocationId === HAIR_LOCATION_ID && color ? `${color} ` : "";
  return `${possessive} ${adjective}${label}`.trim();
}

// ---------------------------------------------------------------------------
// hair.wet_clumping
// ---------------------------------------------------------------------------

/** Loose hair: the bands describe how far the strands have gathered. */
const CLUMPING_LOOSE: Readonly<Record<AffordanceIntensityBand, string>> = {
  subtle: "has begun to gather into damp strands",
  clear: "has separated into damp, clinging strands",
  strong: "hangs in heavy damp clumps",
};

/**
 * Bound hair (`bound_mass`): a braid or a bun cannot "hang in clumps", so the
 * same three bands describe the gathered shape getting wetter instead. Same
 * observation, honest phrasing — the alternative is a cue that contradicts the
 * arrangement the Attributes section already stated.
 */
const CLUMPING_BOUND: Readonly<Record<AffordanceIntensityBand, string>> = {
  subtle: "is damp where it is bound up",
  clear: "sits dark and damp where it is bound up",
  strong: "hangs heavy with water where it is bound up",
};

/**
 * At most ONE enriching detail, first match wins. Provenance leads: "still wet
 * from the rain" is the detail that keeps the scene consistent, and it is only
 * ever tagged when a committed rain_exposure event is in the frame — immersion
 * and splash wet the hair but license no rain clause (a bath is not weather).
 */
const CLUMPING_DETAILS: readonly { readonly tag: string; readonly clause: string }[] = [
  { tag: "recent_rain", clause: "still wet from the rain" },
  { tag: "retains_droplets", clause: "droplets caught along it" },
  { tag: "defined_curls", clause: "the curl drawn tight" },
];

function wetClumpingCue(observation: AffordanceObservation, subject: string): string {
  const bound = observation.semanticTags.includes("bound_mass");
  const verb = (bound ? CLUMPING_BOUND : CLUMPING_LOOSE)[observation.intensityBand];
  const detail = CLUMPING_DETAILS.find((entry) => observation.semanticTags.includes(entry.tag));
  return `${subject} ${verb}${detail ? `, ${detail.clause}` : ""}`;
}

// ---------------------------------------------------------------------------
// hair.wind_or_motion_response
// ---------------------------------------------------------------------------

/** Whole-hair movement, by band. */
const WIND_WHOLE: Readonly<Record<AffordanceIntensityBand, (subject: string) => string>> = {
  subtle: (subject) => `loose strands of ${subject} stir in the moving air`,
  clear: (subject) => `${subject} lifts and shifts in the moving air`,
  strong: (subject) => `${subject} streams loose in the wind`,
};

/**
 * The ends-only read has its own sentence because it is a different claim: the
 * bulk is held (bound, pinned, covered, or water-loaded) and only what hangs
 * free below it moves. Saying "her hair lifts" there would contradict the very
 * constraint that produced the read. "loose ends" rather than "exposed ends"
 * because the constraint is not always a covering — soaked hair is held by its
 * own weight, with nothing over it at all.
 */
function windMotionCue(observation: AffordanceObservation, subject: string): string {
  if (observation.semanticTags.includes("exposed_ends")) {
    return `the loose ends of ${subject} stir in the moving air`;
  }
  return WIND_WHOLE[observation.intensityBand](subject);
}

// ---------------------------------------------------------------------------
// Fallback
// ---------------------------------------------------------------------------

/**
 * Any observation this module has no sentence for. Renders the structured
 * descriptors as a telegraphic detail note rather than inventing prose about
 * physics it does not model — honest, bounded, and impossible to throw on.
 * Unreachable in production today; it exists so registering a phenomenon can
 * never silently drop its cue.
 */
function genericCue(observation: AffordanceObservation, subject: string): string {
  const tags = observation.semanticTags
    .slice(0, 3)
    .map((tag) => tag.replace(/_/gu, " ").trim())
    .filter(Boolean);
  return tags.length > 0 ? `${subject} — ${tags.join(", ")}` : `${subject} is worth a glance`;
}

// ---------------------------------------------------------------------------
// The projection
// ---------------------------------------------------------------------------

/**
 * Render this exchange's selected observations into narrator-facing cue lines.
 *
 * `cues` is already ranked, perception-filtered, repeat-gated and capped by the
 * core; the extra `slice` is belt-and-braces so a caller that hands over raw
 * `observations` still cannot flood the prompt. Identical lines are deduped —
 * two observations that project to the same sentence are one detail to a reader.
 */
export function renderChatAffordanceCues(input: {
  cues: readonly AffordanceObservation[];
  /** The SAME resolved attributes the read was taken over (`ChatAffordanceReadResult.attributes`). */
  attributes: ResolvedAttributeSnapshot;
  /** How the lines name the subject — "Wren's". */
  possessive: string;
}): string[] {
  const possessive = input.possessive.trim();
  if (possessive.length === 0) return [];
  const color = chatAffordanceHairColor(input.attributes);
  const lines: string[] = [];
  for (const observation of input.cues.slice(0, AFFORDANCE_CUES_PER_EXCHANGE)) {
    const subject = subjectPhrase(observation, possessive, color);
    const line = cueLine(observation, subject);
    if (line.length > 0 && !lines.includes(line)) lines.push(line);
  }
  return lines;
}

/**
 * The phenomenon → sentence dispatch. Exhaustive over what this lane can
 * actually reach; everything else takes the tag fallback (see `genericCue`).
 */
function cueLine(observation: AffordanceObservation, subject: string): string {
  switch (observation.id) {
    case HAIR_WET_CLUMPING_ID:
      return wetClumpingCue(observation, subject);
    case HAIR_WIND_OR_MOTION_ID:
      return windMotionCue(observation, subject);
    default:
      return genericCue(observation, subject);
  }
}
