import type { DaylightBand } from "@/lib/clock";
import { conditionKey, type ActiveCondition, type SenseEffects } from "../conditions/condition";
import type { PerceptionMods } from "./witness";

/**
 * Darkness model (multi-character-v1-defaults.phase3.md §Darkness, decision 24).
 * v1 keyword heuristic over the location's authored `ambient.light` string,
 * gated on the night daylight band. A location is dark when band = night AND
 * the light is empty or dark-leaning; any lit-leaning light keeps it lit.
 * (Banded ambients — authored truth replacing this heuristic — are a phase-4
 * location-design item; until then this is the rule.)
 */
export const LIT_LIGHT_KEYWORDS = [
  "lamp", "lamplit", "lit", "candle", "candlelit", "firelight", "fire", "torch",
  "torchlit", "bright", "glow", "glowing", "neon", "electric", "bulb", "lantern",
  "sconce", "moonlight", "moonlit", "fluorescent", "spotlight", "string lights",
];
export const DARK_LIGHT_KEYWORDS = [
  "dark", "darkness", "unlit", "pitch", "pitch-black", "pitch black", "black",
  "shadow", "shadows", "shadowy", "gloom", "gloomy", "moonless", "no light",
  "lightless", "blackout",
];

export interface DarknessVerdict {
  dark: boolean;
  /** Light text was non-empty but matched no keyword — log a miss to tune the lists. */
  miss: boolean;
}

export function darknessVerdict(band: DaylightBand, ambientLight: string | undefined): DarknessVerdict {
  if (band !== "night") return { dark: false, miss: false };
  const light = (ambientLight ?? "").trim().toLowerCase();
  if (!light) return { dark: true, miss: false };
  if (LIT_LIGHT_KEYWORDS.some((k) => light.includes(k))) return { dark: false, miss: false };
  if (DARK_LIGHT_KEYWORDS.some((k) => light.includes(k))) return { dark: true, miss: false };
  // Night + ambiguous light: default dark (a setting must declare its light), flag a miss.
  return { dark: true, miss: true };
}

/**
 * Per-observer sense modifiers from active conditions (presence-spec §Environment,
 * decision 24). A condition supplies `senseEffects` explicitly, or its label is
 * matched against the known map below. The strongest effect per sense wins
 * (blocked beats reduced).
 */
export const SENSE_EFFECT_BY_LABEL: Record<string, SenseEffects> = {
  blindfolded: { sight: "blocked" },
  blind: { sight: "blocked" },
  blinded: { sight: "blocked" },
  "eyes covered": { sight: "blocked" },
  deaf: { hearing: "blocked" },
  deafened: { hearing: "blocked" },
  "ears covered": { hearing: "blocked" },
  drunk: { sight: "reduced", hearing: "reduced" },
  intoxicated: { sight: "reduced", hearing: "reduced" },
  dazed: { sight: "reduced", hearing: "reduced" },
  concussed: { sight: "reduced", hearing: "reduced" },
  "dim-sighted": { sight: "reduced" },
};

function stronger(a: "reduced" | "blocked" | undefined, b: "reduced" | "blocked" | undefined) {
  if (a === "blocked" || b === "blocked") return "blocked" as const;
  if (a === "reduced" || b === "reduced") return "reduced" as const;
  return undefined;
}

/** Fold an observer's conditions into sight/hearing modifiers for `perceives`. */
export function senseModsFromConditions(conditions: readonly ActiveCondition[]): Pick<PerceptionMods, "sight" | "hearing"> {
  let sight: "reduced" | "blocked" | undefined;
  let hearing: "reduced" | "blocked" | undefined;
  for (const c of conditions) {
    const eff: SenseEffects | undefined = c.senseEffects ?? SENSE_EFFECT_BY_LABEL[conditionKey(c)];
    if (!eff) continue;
    sight = stronger(sight, eff.sight);
    hearing = stronger(hearing, eff.hearing);
  }
  return {
    sight: sight ?? "normal",
    hearing: hearing ?? "normal",
  };
}
