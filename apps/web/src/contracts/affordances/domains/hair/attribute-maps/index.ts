import { validateAxisSet, type AttributeAxisSetMember } from "../../../core";
import { hairLengthAxis } from "./length";
import { hairDensityAxis } from "./density";
import { hairStrandThicknessAxis } from "./strand-thickness";
import { hairTextureAxis } from "./texture";
import { hairConditionAxis } from "./condition";

export * from "./contribution";
export * from "./length";
export * from "./density";
export * from "./strand-thickness";
export * from "./texture";
export * from "./condition";

/**
 * The five EXECUTABLE hair axes, in profile-compilation order.
 *
 * Two hair attributes are deliberately absent and must stay absent:
 *
 * - `hair.color` is cue-realization metadata. It helps phrase an observation and
 *   must never influence whether one occurred.
 * - `hair.style` is free display text; the core refuses a text attribute outright.
 *
 * `hair.arrangement` is also absent from this set: it is live PRESENTATION
 * state, not stable structure, so it is read as a domain input and compiled into
 * bound/pinned fractions in `mechanics.ts` — never into the structural profile.
 */
export const hairAttributeAxes = [
  hairLengthAxis,
  hairDensityAxis,
  hairStrandThicknessAxis,
  hairTextureAxis,
  hairConditionAxis,
] as const;

/**
 * Definition-time proof, run at module load: every axis maps real vocabulary of
 * a real attribute, and each of the nine profile paths has exactly one owner.
 * Throws on a violation; returns the diagnostics a provisional mapping would
 * have to surface (empty today — nothing in this set is quarantined).
 */
export const hairAxisDiagnostics = validateAxisSet(hairAttributeAxes as readonly AttributeAxisSetMember[]);

/** The attribute ids the hair domain declares as required structure. */
export const hairRequiredAttributeIds: readonly string[] = hairAttributeAxes.map((axis) => axis.attributeId);
