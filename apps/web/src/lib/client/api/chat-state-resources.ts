import { z } from "zod";
import {
  activeConditionSchema,
  chatPlansSchema,
  emotionLabelSchema,
  relationshipTextureSchema,
  socialReactionCardSchema,
  supportingCastSchema,
  type ActiveCondition,
  type ChatPlan,
  type GarmentOperation,
  type RelationshipTexture,
  type SocialReactionCard,
  type SupportingCastMember,
} from "@/contracts";
import { calendarStartSchema, type CalendarStart } from "@/lib/clock";
import { textOr } from "./shared";
import { garmentReadoutSchema } from "./chat-schemas";

export const chatScenarioViewSchema = z.object({
  premise: textOr(""),
  activeSocialCards: z.array(socialReactionCardSchema).catch([]),
  sceneAuto: z.enum(["off", "milestones"]).catch("off"),
  sceneModel: textOr(""),
  supportingCast: supportingCastSchema.catch([]),
  plans: chatPlansSchema.catch([]),
  calendarStart: calendarStartSchema.catch({ year: 2024, month: 1, day: 1, hour: 8, minute: 0 }),
  clockMinutes: z.number().catch(0),
});
export type ChatScenarioView = z.infer<typeof chatScenarioViewSchema>;

export interface ChatScenarioPatch {
  premise?: string;
  activeSocialCards?: SocialReactionCard[];
  sceneAuto?: "off" | "milestones";
  sceneModel?: string;
  supportingCast?: SupportingCastMember[];
  plans?: ChatPlan[];
  calendarStart?: CalendarStart;
}

export const chatParticipantStateViewSchema = z.object({
  characterId: z.string(),
  persisted: z.boolean().catch(true),
  regard: z.number().catch(0),
  familiarity: z.number().catch(0),
  regardBand: z.object({ id: z.string(), label: z.string() }).catch({ id: "neutral", label: "Neutral" }),
  familiarityBand: z.object({ id: z.string(), label: z.string() }).catch({ id: "strangers", label: "Strangers" }),
  relationship: relationshipTextureSchema.catch({ kind: "", history: "", presented: undefined, looming: false }),
  emotion: z
    .object({ label: emotionLabelSchema, intensity: z.number().min(0).max(1).catch(0) })
    .catch({ label: "neutral", intensity: 0 }),
  meters: z.record(z.string(), z.number()).catch({}),
  conditions: z.array(activeConditionSchema).catch([]),
  mindNote: textOr(""),
  whereabouts: textOr(""),
});
export type ChatParticipantStateView = z.infer<typeof chatParticipantStateViewSchema>;

export interface ChatParticipantStatePatch {
  regard?: number;
  familiarity?: number;
  relationship?: RelationshipTexture;
  meters?: Record<string, number>;
  conditions?: ActiveCondition[];
  mindNote?: string;
  whereabouts?: string;
}

const garmentDiagnosticsSchema = z.array(z.object({ code: z.string(), message: textOr("") })).catch([]);

export const chatParticipantWardrobeViewSchema = z.object({
  characterId: z.string(),
  wornItemIds: z.array(z.string()).catch([]),
  outfitPresetId: textOr(""),
  outfit: textOr(""),
  outfitExposed: z.boolean().catch(false),
  outfitLabel: textOr(""),
  garments: z.array(garmentReadoutSchema).catch([]),
  garmentDiagnostics: garmentDiagnosticsSchema,
});
export type ChatParticipantWardrobeView = z.infer<typeof chatParticipantWardrobeViewSchema>;

export interface ChatParticipantWardrobePatch {
  wornItemIds?: string[];
  outfitPresetId?: string;
  outfit?: string;
  outfitExposed?: boolean;
  garmentOperations?: GarmentOperation[];
}

export const chatPlayerWardrobeViewSchema = z.object({
  wornItemIds: z.array(z.string()).catch([]),
  seeded: z.boolean().catch(false),
  outfitPresetId: textOr(""),
  overlay: textOr(""),
  garments: z.array(garmentReadoutSchema).catch([]),
  garmentDiagnostics: garmentDiagnosticsSchema,
});
export type ChatPlayerWardrobeView = z.infer<typeof chatPlayerWardrobeViewSchema>;

export interface ChatPlayerWardrobePatch {
  wornItemIds?: string[];
  outfitPresetId?: string;
  overlay?: string;
  garmentOperations?: GarmentOperation[];
}

export const chatPlayerStateViewSchema = z.object({ personaId: z.string().catch("") });
export type ChatPlayerStateView = z.infer<typeof chatPlayerStateViewSchema>;
export interface ChatPlayerStatePatch {
  personaId: string;
}

export const chatInspectorStateViewSchema = z.object({
  openLoops: z.array(z.string()).catch([]),
  memoryQueries: z.array(z.string()).catch([]),
  surfacedCues: z.record(z.string(), z.string()).catch({}),
  attributeOverlays: z.array(z.unknown()).catch([]),
  traitOverlays: z.array(z.unknown()).catch([]),
  voiceExemplars: z.array(z.unknown()).catch([]),
  callbackHistory: z.array(z.unknown()).catch([]),
  feeling: z.unknown(),
  selfieHistory: z.array(z.unknown()).catch([]),
  drives: z.array(z.unknown()).catch([]),
  lastPulseTrace: z.unknown(),
  lastMemoryTrace: z.unknown(),
});
export type ChatInspectorStateView = z.infer<typeof chatInspectorStateViewSchema>;

/** The state-tools client currently authors only these two inspector fields. */
export interface ChatInspectorStatePatch {
  openLoops?: string[];
  memoryQueries?: string[];
}
