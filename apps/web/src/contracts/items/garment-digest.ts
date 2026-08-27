import { GARMENT_CONDITION_NEUTRAL_BANDS } from "./garment-condition";
import type { GarmentPartControl, GarmentReadout } from "./garment-effective-coverage";
import { garmentConditionKeys, type GarmentConditionKey } from "./garment-instance";
import type { GarmentDegreeBand } from "./garment-material";
import type { GarmentPresentationChannel } from "./garment-presentation";

/**
 * The AUTHORITATIVE wardrobe digest. Raw state never enters narrator prose.
 *
 * The narrator's wardrobe input is split in two, and this file owns the
 * first half: **authority**, "a terse state guard" the narrator cannot
 * contradict — who is wearing what, how each piece currently sits, and what is
 * lying around the room. Attention — the ranked, repeat-gated cue block — is
 * `garment-observation.ts`. Unchanged state stays HERE (it must not vanish just
 * because it is old news) and never becomes a fresh cue.
 *
 * Everything is a semantic band. Fixed point, coefficients and thresholds stay
 * inspector data: the only numbers this module can emit are the ones already
 * baked into a part label, and `renderGarmentDigest` is snapshot-tested against
 * that.
 *
 * `garmentStructuralFacts` is deliberately shared: the digest renders it, the cue
 * families key off it, and OQ8's look fingerprint hashes it, so "the front is
 * open" can never mean three different things to the three consumers.
 */

// --- Structural presentation bands --------------------------------------------

/** The closure ladder OQ8 names: shut · a little open · hanging open. */
export const garmentClosureBands = ["fastened", "partly_open", "open"] as const;
export type GarmentClosureBand = (typeof garmentClosureBands)[number];

/** The roll ladder OQ8 names — a sleeve is either down or pushed up. */
export const garmentRollBands = ["down", "rolled"] as const;
export type GarmentRollBand = (typeof garmentRollBands)[number];

/** One part's current structural reading — the shared band every consumer quotes. */
export interface GarmentStructuralFact {
  partId: string;
  /** Authoring alias, else the humanized part id. Never a raw handle. */
  label: string;
  channel: GarmentPresentationChannel;
  /**
   * The semantic band: closure `fastened|partly_open|open` · roll `down|rolled` ·
   * tuck `out|partial|in` · displacement `seated|off_shoulder|lifted`.
   */
  band: string;
  /** The underlying degree band, when the channel has one (`null` at neutral, and for tuck). */
  degree: GarmentDegreeBand | null;
  /** True when the band is worth stating — see `NEUTRAL_STRUCTURAL_BAND`. */
  deviation: boolean;
}

/**
 * The reading each channel considers "nothing to say". Tuck has NO neutral: a hem
 * is always out, half, or in, and which one it is is a fact the narrator must not
 * contradict — so every tuck reading is a deviation and always reaches the digest.
 */
const NEUTRAL_STRUCTURAL_BAND: Readonly<Record<GarmentPresentationChannel, string>> = {
  closure: "fastened",
  roll: "down",
  tuck: "",
  displacement: "seated",
};

function structuralBandOf(control: GarmentPartControl): string {
  switch (control.channel) {
    case "closure":
      if (control.band === null) return "fastened";
      return control.band === "slight" || control.band === "moderate" ? "partly_open" : "open";
    case "roll":
      return control.band === null ? "down" : "rolled";
    case "tuck":
      return control.tuck ?? "out";
    case "displacement":
      return control.band === null ? "seated" : (control.displacementKind ?? "seated");
  }
}

/**
 * One worn garment's structural presentation, part by part. PURE and ordered by
 * the blueprint's own behavior order, so the same garment always renders the same
 * way (and hashes to the same look key).
 */
export function garmentStructuralFacts(readout: GarmentReadout): GarmentStructuralFact[] {
  return readout.controls.map((control): GarmentStructuralFact => {
    const band = structuralBandOf(control);
    return {
      partId: control.partId,
      label: control.label,
      channel: control.channel,
      band,
      degree: control.band,
      deviation: band !== NEUTRAL_STRUCTURAL_BAND[control.channel],
    };
  });
}

// --- Digest -------------------------------------------------------------------

/** Max garments listed per actor — a digest is a guard, not an inventory. */
export const GARMENT_DIGEST_MAX_GARMENTS = 6;
/** Max notes per garment (structural + condition, in that order). */
export const GARMENT_DIGEST_MAX_NOTES = 4;
/** Max garments named as lying around the current place. */
export const GARMENT_DIGEST_MAX_PLACED = 3;

/** One garment as the digest states it: its name plus the few facts that qualify it. */
export interface GarmentDigestGarment {
  garmentId: string;
  name: string;
  notes: string[];
}

/** One dressed actor's line. */
export interface GarmentDigestActor {
  label: string;
  garments: GarmentDigestGarment[];
}

/** One garment left somewhere in the current place. */
export interface GarmentDigestPlaced {
  garmentId: string;
  name: string;
  /** The stored grounded anchor ("over the desk chair"); "" ⇒ just "here". */
  anchor: string;
}

export interface GarmentDigest {
  actors: GarmentDigestActor[];
  placed: GarmentDigestPlaced[];
  /** The place the loose garments are in — the digest's own grounding. */
  placeName: string;
}

/** Empty digest — nothing modelled, so the block never renders. */
export function emptyGarmentDigest(): GarmentDigest {
  return { actors: [], placed: [], placeName: "" };
}

/** A structural fact as one digest note; "" when the band has no phrasing (neutral). */
function structuralNote(fact: GarmentStructuralFact): string {
  switch (fact.band) {
    case "partly_open":
      return `${fact.label} partly open`;
    case "open":
      return `${fact.label} open`;
    case "rolled":
      return `${fact.label} rolled`;
    case "out":
      return "untucked";
    case "partial":
      return "half-tucked";
    case "in":
      return "tucked in";
    case "off_shoulder":
      return `${fact.label} off the shoulder`;
    case "lifted":
      return `${fact.label} lifted`;
    default:
      return "";
  }
}

/**
 * The condition bands worth stating, in registry order. Bands only — the reader
 * already applied hysteresis, so this is the same word the last exchange used
 * unless the state genuinely moved.
 */
function conditionNotes(readout: GarmentReadout): string[] {
  const notes: string[] = garmentConditionKeys.flatMap((channel: GarmentConditionKey) => {
    const band = readout.condition[channel];
    return band === GARMENT_CONDITION_NEUTRAL_BANDS[channel] ? [] : [band];
  });
  for (const deposit of readout.deposits) {
    const where = deposit.labels[0];
    notes.push(where ? `${deposit.kind} on the ${where}` : `${deposit.kind} on it`);
  }
  for (const mark of readout.damage) notes.push(`${mark.kind} at the ${mark.label}`);
  return notes;
}

/** One worn garment's digest entry: structural deviations first, then material state. */
export function garmentDigestEntry(readout: GarmentReadout): GarmentDigestGarment {
  const structural = garmentStructuralFacts(readout)
    .filter((fact) => fact.deviation)
    .map(structuralNote)
    .filter(Boolean);
  return {
    garmentId: readout.garmentId,
    name: readout.name,
    notes: [...structural, ...conditionNotes(readout)].slice(0, GARMENT_DIGEST_MAX_NOTES),
  };
}

/** One actor's worn readouts, with the label the digest states them under. */
export interface GarmentDigestActorInput {
  label: string;
  readouts: readonly GarmentReadout[];
}

/**
 * Build the digest. PURE: readouts in, bands out — the caller owns loading and
 * perception, this owns the shape and the caps.
 */
export function buildGarmentDigest(input: {
  actors: readonly GarmentDigestActorInput[];
  /** Garments lying in the current place (`garmentsAtScenePlace`), already scoped by the caller. */
  placed?: readonly { garmentId: string; name: string; anchor: string }[];
  placeName?: string;
}): GarmentDigest {
  const actors = input.actors.flatMap((actor): GarmentDigestActor[] => {
    if (actor.readouts.length === 0) return [];
    return [
      {
        label: actor.label,
        garments: actor.readouts.slice(0, GARMENT_DIGEST_MAX_GARMENTS).map(garmentDigestEntry),
      },
    ];
  });
  return {
    actors,
    placed: (input.placed ?? []).slice(0, GARMENT_DIGEST_MAX_PLACED).map((entry) => ({ ...entry })),
    placeName: (input.placeName ?? "").trim(),
  };
}

/** `shirt: untucked, left sleeve rolled` — or just the name when nothing qualifies it. */
function renderDigestGarment(garment: GarmentDigestGarment): string {
  return garment.notes.length > 0 ? `${garment.name}: ${garment.notes.join(", ")}` : garment.name;
}

/**
 * The narrator block. "" when there is nothing modelled — which is what keeps the
 * flag-off prompt byte-identical (the pipeline never even calls this) AND keeps a
 * modelled-but-empty chat from rendering an empty heading.
 */
export function renderGarmentDigest(digest: GarmentDigest): string {
  const lines = digest.actors.map(
    (actor) => `- ${actor.label}: ${actor.garments.map(renderDigestGarment).join("; ")}`,
  );
  if (digest.placed.length > 0) {
    const where = digest.placeName ? `Left in ${digest.placeName}` : "Left here";
    const placed = digest.placed.map((entry) =>
      entry.anchor ? `${entry.name} — ${entry.anchor}` : entry.name,
    );
    lines.push(`- ${where}: ${placed.join("; ")}`);
  }
  if (lines.length === 0) return "";
  return [
    "Wardrobe right now (authoritative — never contradict what is worn, where a garment is, or how it sits):",
    ...lines,
  ].join("\n");
}

// --- OQ8 look fingerprint ------------------------------------------------------

/**
 * The garment half of the `chat_look` identity key (audit OQ8). What enters:
 *
 * - the worn INSTANCE set (a doff/don/transfer is a new look);
 * - every structural presentation band (fastened → open is a new look);
 * - `wetness` only from `wet` upward — portrait-visible soaking;
 * - deposit / damage PRESENCE per garment, never intensity.
 *
 * What deliberately stays out — `crease_load`, `cleanliness`, `damp` and every
 * drying step — reaches only the per-scene prompt. Drying is continuous, and
 * reminting an identity anchor per step would buy an image generation for a
 * change invisible at portrait framing.
 *
 * "" for an unmodelled actor, so a legacy chat's key is byte-identical to today's
 * and no cached look invalidates on materialization alone.
 */
export function garmentLookFingerprint(readouts: readonly GarmentReadout[]): string {
  return [...readouts]
    .map((readout) => {
      const structural = garmentStructuralFacts(readout)
        .map((fact) => `${fact.partId}=${fact.band}`)
        .join(",");
      const wet = readout.condition.wetness === "wet" || readout.condition.wetness === "soaked"
        ? readout.condition.wetness
        : "";
      const marks = `${readout.deposits.length > 0 ? "d" : ""}${readout.damage.length > 0 ? "x" : ""}`;
      return `${readout.garmentId}|${structural}|${wet}|${marks}`;
    })
    .sort()
    .join(";");
}
