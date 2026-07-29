import {
  attributeEnumValue,
  attributeRegistry,
  bodyLocationRegistry,
  garmentDescriptorTags,
  garmentIdFromTags,
  AFFORDANCE_CUES_PER_EXCHANGE,
  GARMENT_EFFECTIVE_OPACITY_ID,
  GARMENT_WET_CLING_ID,
  GARMENT_WET_SURFACE_STATE_ID,
  HAIR_LOCATION_ID,
  HAIR_WET_CLUMPING_ID,
  HAIR_WIND_OR_MOTION_ID,
  type AffordanceIntensityBand,
  type AffordanceObservation,
  type ResolvedAttributeSnapshot,
} from "@/contracts";

/**
 * CUE PROJECTION for the chat lane (body-attribute-affordances slices 5 and 6).
 *
 * One selected `AffordanceObservation` → one short factual clause, in the
 * garment-cue register (`items/garment-observation.ts`'s `phrase`): concrete,
 * present tense, no numbers, no physics vocabulary, no instruction to the
 * narrator. The prompt block around them supplies the "weave at most one in"
 * framing; a cue line itself only ever states what is true.
 *
 * Four rules this module exists to hold:
 *
 * 1. **Projection may read colour; mechanics never may.** `hair.color` is a
 *    stable appearance attribute with no physical effect, so it is excluded from
 *    the domain's `requiredAttributeIds` on purpose — but "damp auburn strands"
 *    is the sentence the narrator actually wants. Colour therefore enters HERE,
 *    at the last step, where it cannot influence a band. Garment NAMES enter the
 *    same way, and for the same reason.
 * 2. **The phenomena that can reach production get written prose; everything
 *    else degrades to its tags.** Reachable from this lane today:
 *    `hair.wet_clumping`, `hair.wind_or_motion_response`,
 *    `garment.wet_surface_state`, and `garment.effective_opacity`. Hair adhesion
 *    and garment cling both need a contact owner; droplet shedding needs a
 *    committed impulse (see `chat-affordances.ts`). A future phenomenon, or a
 *    successor lane that can feed one, still renders something honest rather
 *    than throwing or vanishing.
 * 3. **Nothing here decides what is said.** Ranking, the repeat gate and the cap
 *    already ran in `contracts/affordances/core/ranking.ts`; this is the last,
 *    purely textual step.
 * 4. **It does not repeat the wardrobe's own cue block.** See "The
 *    `CHAT_GARMENT_CUES` boundary" below.
 *
 * ## The `CHAT_GARMENT_CUES` boundary
 *
 * The clothing system already has a narrator cue block behind its own flag
 * (`chat-garments.ts` → `items/garment-observation.ts`). The division of labour:
 *
 * - **`CHAT_GARMENT_CUES` owns garment STATE and its changes** — a placket that
 *   came open, a sleeve rolled back, a strap slipped, mud, a tear, and the
 *   condition-vector band ("her shirt is damp"). It speaks when a band MOVES.
 * - **`CHAT_AFFORDANCE_CUES` owns the current derived VISUAL EFFECT of that
 *   state** — what the water is doing on the surface (beading, running off,
 *   darkening), what saturation has done to opacity, and where wet fabric is
 *   clinging. It speaks about consequences, never about the state change itself.
 *
 * The two touch at exactly one place: garment wetness. The wardrobe block's
 * `surface_damp_or_wet` family and this block's `garment.wet_surface_state` can
 * both be true of the same shirt in the same exchange, so when BOTH flags are on
 * the caller passes the garment ids the wardrobe block already spoke about
 * (`spokenGarmentIds`) and this projection drops its line for them. The
 * wardrobe's is the authority read and wins; ours is the elaboration and yields.
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
 * A garment name as it reads AFTER a possessive.
 *
 * Library items are named the way a wardrobe list wants them ("a linen shirt",
 * "the leather jacket"), and "Wren's a linen shirt" is not a sentence. Stripping
 * the leading determiner is the whole fix — the same one `wardrobeOutfitText`'s
 * register already assumes when it lists garments after a possessive.
 */
function possessedGarmentName(name: string): string {
  return name.trim().replace(/^(?:an?|the|her|his|their|your|my)\s+/iu, "");
}

/**
 * "Wren's auburn hair", or "Wren's jacket" — the possessive plus whichever
 * subject this observation is actually about.
 *
 * Built per observation rather than once, because the second domain speaks about
 * a garment and must not inherit the hair's adjective. A garment observation
 * names its garment through the domain's `garment:<id>` tag; with no name on
 * hand it falls back to the body location it covers, which is always true even
 * when it is less vivid.
 */
function subjectPhrase(
  observation: AffordanceObservation,
  possessive: string,
  color: string,
  garmentNames: Readonly<Record<string, string>>,
): string {
  const garmentId = garmentIdFromTags(observation.semanticTags);
  if (garmentId !== undefined) {
    const name = possessedGarmentName(garmentNames[garmentId] ?? "");
    return `${possessive} ${name.length > 0 ? name : locationLabel(observation.sourceLocationId)}`.trim();
  }
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
// garment.wet_surface_state
// ---------------------------------------------------------------------------

/**
 * What water is doing on the surface, by material response.
 *
 * The tags carry the branch (the domain decided it from authored absorbency, not
 * from a material name), so these tables only have to render it. The two
 * families read as different SENTENCES on purpose — "beads and runs" versus
 * "gone dark with water" is the whole acceptance test, and a shared template
 * with a swapped adjective would have quietly failed it.
 */
const WET_SURFACE_SHEDDING: readonly { readonly tag: string; readonly clause: string }[] = [
  { tag: "sheeting", clause: "is running with water, none of it soaking in" },
  { tag: "runoff", clause: "is beaded with water that runs off it" },
  { tag: "beading", clause: "is beaded with water" },
];

const WET_SURFACE_ABSORBING: readonly { readonly tag: string; readonly clause: string }[] = [
  { tag: "water_heavy", clause: "hangs heavy and soaked through" },
  { tag: "saturated", clause: "is soaked through" },
  { tag: "damp_through", clause: "has gone dark and damp through" },
  { tag: "darkened", clause: "has gone dark with water" },
  { tag: "darkening", clause: "is darkening where the water has caught it" },
];

function wetSurfaceCue(observation: AffordanceObservation, subject: string): string {
  const table = observation.semanticTags.includes("beading") ? WET_SURFACE_SHEDDING : WET_SURFACE_ABSORBING;
  const entry = table.find((row) => observation.semanticTags.includes(row.tag));
  if (!entry) return "";
  // Provenance only on a committed rain event — the domain tags it, never guesses it.
  const rain = observation.semanticTags.includes("recent_rain") ? ", still wet from the rain" : "";
  return `${subject} ${entry.clause}${rain}`;
}

// ---------------------------------------------------------------------------
// garment.effective_opacity
// ---------------------------------------------------------------------------

/**
 * Wet fabric that has stopped concealing as much as it did.
 *
 * Deliberately understated at every band, and deliberately silent about what is
 * underneath. The read establishes that the fabric has gone translucent; whether
 * anything beneath it is actually perceptible is the captured coverage read's
 * answer, and the exposure and narrative-focus gates have already run. A cue that
 * volunteered anatomy here would be inventing the one thing this layer refuses to.
 */
const OPACITY_CLAUSES: readonly { readonly tag: string; readonly clause: string }[] = [
  { tag: "see_through", clause: "has gone near-transparent where the water has soaked it" },
  { tag: "translucent", clause: "has turned translucent where it is wet" },
  { tag: "translucent_edge", clause: "is starting to go translucent where it is wet" },
];

function effectiveOpacityCue(observation: AffordanceObservation, subject: string): string {
  const entry = OPACITY_CLAUSES.find((row) => observation.semanticTags.includes(row.tag));
  return entry ? `${subject} ${entry.clause}` : "";
}

// ---------------------------------------------------------------------------
// garment.wet_cling
// ---------------------------------------------------------------------------

/**
 * Wet fabric actually following the body it touches. Unreachable in production
 * today (no lane owns garment/body contact), written because a lane that gains
 * one must not fall through to the tag fallback.
 */
const CLING_CLAUSES: readonly { readonly tag: string; readonly clause: string }[] = [
  { tag: "moulded", clause: "clings wetly, following every line of" },
  { tag: "contour_followed", clause: "clings wet against" },
  { tag: "traced_faintly", clause: "clings faintly against" },
];

function wetClingCue(observation: AffordanceObservation, subject: string, locationId: string): string {
  const entry = CLING_CLAUSES.find((row) => observation.semanticTags.includes(row.tag));
  return entry ? `${subject} ${entry.clause} the ${locationLabel(locationId)}` : "";
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
  const tags = garmentDescriptorTags(observation.semanticTags)
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
  /** Instance id → display name (`ChatAffordanceReadResult.garmentNames`). */
  garmentNames?: Readonly<Record<string, string>>;
  /**
   * Garment instance ids the WARDROBE cue block already spoke about this
   * exchange (`CHAT_GARMENT_CUES`). Their surface-wetness line is dropped here —
   * see "The `CHAT_GARMENT_CUES` boundary" above. Empty/absent with that flag
   * off, which is the default.
   */
  spokenGarmentIds?: ReadonlySet<string>;
}): string[] {
  const possessive = input.possessive.trim();
  if (possessive.length === 0) return [];
  const color = chatAffordanceHairColor(input.attributes);
  const garmentNames = input.garmentNames ?? {};
  const lines: string[] = [];
  for (const observation of input.cues.slice(0, AFFORDANCE_CUES_PER_EXCHANGE)) {
    if (duplicatesGarmentBlock(observation, input.spokenGarmentIds)) continue;
    const subject = subjectPhrase(observation, possessive, color, garmentNames);
    const line = cueLine(observation, subject);
    if (line.length > 0 && !lines.includes(line)) lines.push(line);
  }
  return lines;
}

/**
 * True when the wardrobe's own cue block has already covered this read.
 *
 * ONLY surface wetness overlaps: the wardrobe block states the condition band
 * ("her shirt is damp"), and repeating it as "her shirt has gone dark with
 * water" is one detail said twice in one exchange. Opacity and cling have no
 * counterpart there — the wardrobe knows how wet a garment is, not what being
 * wet has done to it — so they always survive.
 */
function duplicatesGarmentBlock(
  observation: AffordanceObservation,
  spokenGarmentIds: ReadonlySet<string> | undefined,
): boolean {
  if (observation.id !== GARMENT_WET_SURFACE_STATE_ID || spokenGarmentIds === undefined) return false;
  const garmentId = garmentIdFromTags(observation.semanticTags);
  return garmentId !== undefined && spokenGarmentIds.has(garmentId);
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
    case GARMENT_WET_SURFACE_STATE_ID:
      return wetSurfaceCue(observation, subject);
    case GARMENT_EFFECTIVE_OPACITY_ID:
      return effectiveOpacityCue(observation, subject);
    case GARMENT_WET_CLING_ID:
      return wetClingCue(observation, subject, observation.sourceLocationId);
    default:
      return genericCue(observation, subject);
  }
}
