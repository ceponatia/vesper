import { z } from "zod";

/**
 * The chat-wide SCENE ENVIRONMENT — wind, precipitation, and whether the scene is
 * under cover (body-attribute-affordances.audit.md §"Capability → owner":
 * *"New scene-level environment read on `ChatScenario` (Slice 4):
 * extraction-proposed typed state"*).
 *
 * Before this the lane's only weather was prose, and the audit is explicit that
 * "may appear in narration" is not an input. So the continuity extraction leg
 * proposes a typed patch (`turns/chat-surface-ops.ts`), the fold commits it
 * through `parseOr`, and the affordance adapter reads THIS — never the narrator's
 * sentence about the sky.
 *
 * **Chat-WIDE**, like `sceneMemory`: one imagined setting for the whole roster,
 * so it lives on `ChatScenario` and rides `pre_exchange_scenario` for free. A
 * retake that discards the beat that opened the storm discards the storm.
 *
 * **Indoors-true is the conservative default** and the schema's degraded value:
 * a chat that has never said anything about weather is a chat with no wind and no
 * rain on anybody. Failing the other way would let every unlabelled conversation
 * acquire a breeze.
 */

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** Coarse air movement. Four bands is all a narrator read can honestly distinguish. */
export const chatWindLevels = ["none", "breeze", "windy", "gusting"] as const;
export const chatWindLevelSchema = z.enum(chatWindLevels);
export type ChatWindLevel = z.infer<typeof chatWindLevelSchema>;

/** Coarse falling water. */
export const chatPrecipitationLevels = ["none", "drizzle", "rain", "downpour"] as const;
export const chatPrecipitationLevelSchema = z.enum(chatPrecipitationLevels);
export type ChatPrecipitationLevel = z.infer<typeof chatPrecipitationLevelSchema>;

export const chatEnvironmentSchema = z.object({
  wind: chatWindLevelSchema.catch("none").default("none"),
  precipitation: chatPrecipitationLevelSchema.catch("none").default("none"),
  /** True when the scene is under cover — inside, in a car, under a roof. Conservative default. */
  indoors: z.boolean().catch(true).default(true),
  /** Story minute the environment last CHANGED (the freshness anchor a read may cite). */
  updatedAtMinutes: z.number().int().min(0).catch(0).default(0),
});
export type ChatEnvironment = z.infer<typeof chatEnvironmentSchema>;

/** Still air, dry, under cover — the seed value and the degraded default. */
export function emptyChatEnvironment(): ChatEnvironment {
  return { wind: "none", precipitation: "none", indoors: true, updatedAtMinutes: 0 };
}

// ---------------------------------------------------------------------------
// Band maps (fixed point, shared scale)
// ---------------------------------------------------------------------------

/**
 * Wind level → force on the shared fixed-point scale (`0 … FIXED_POINT_ONE`), the
 * scale the affordance unit algebra reads as a proportion.
 *
 * Calibrated against the hair domain's own gates rather than invented: `windy`
 * and `gusting` both clear its `ENDS_FORCE_MIN` (6_000), so strong weather can
 * stir the loose ends below a hood, while `breeze` cannot — which is the whole
 * point of having four bands instead of a boolean.
 */
export const CHAT_WIND_FORCE: Readonly<Record<ChatWindLevel, number>> = {
  none: 0,
  breeze: 3_000,
  windy: 6_500,
  gusting: 9_000,
};

/**
 * Current wind force on a subject in this scene.
 *
 * **Indoors is a hard zero.** "Windy outside" is a true fact about the weather
 * and a false one about the person standing in a kitchen; the environment is one
 * record, so enclosure is what separates them.
 */
export function windForceOf(environment: ChatEnvironment): number {
  return environment.indoors ? 0 : CHAT_WIND_FORCE[environment.wind];
}

/**
 * True when rain is actually landing ON someone in this scene. Same enclosure
 * rule as the wind: a downpour seen through a window wets nobody.
 */
export function precipitationActive(environment: ChatEnvironment): boolean {
  return !environment.indoors && environment.precipitation !== "none";
}
