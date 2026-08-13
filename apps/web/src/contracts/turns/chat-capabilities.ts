import { z } from "zod";

/**
 * Versioned chat-operation manifest returned with the transcript envelope.
 *
 * The two chat lanes deliberately do not share every mutation. Keeping the
 * availability contract explicit lets clients render only operations the
 * server will honor instead of inferring behavior from engine-authority flags.
 */
export const chatCapabilityManifestSchema = z
  .object({
    version: z.literal(1),
    canStop: z.boolean(),
    canAttachPhotos: z.boolean(),
    canEditHistory: z.boolean(),
    canDeleteHistory: z.boolean(),
    canRerunFromMessage: z.boolean(),
    canRetakeLatest: z.boolean(),
    canForkFromMessage: z.boolean(),
    canUseLegacyActionBeats: z.boolean(),
    canUseWorldActions: z.boolean(),
  })
  .strict();

export type ChatCapabilityManifest = z.infer<typeof chatCapabilityManifestSchema>;

/** Stable API error code for a known chat operation that its lane does not support. */
export const CHAT_CAPABILITY_UNAVAILABLE_CODE = "sim_unsupported_operation";

const LEGACY_CHAT_CAPABILITIES = {
  version: 1,
  canStop: true,
  canAttachPhotos: true,
  canEditHistory: true,
  canDeleteHistory: true,
  canRerunFromMessage: true,
  canRetakeLatest: true,
  canForkFromMessage: false,
  canUseLegacyActionBeats: true,
  canUseWorldActions: false,
} as const satisfies ChatCapabilityManifest;

const SUCCESSOR_CHAT_CAPABILITIES = {
  version: 1,
  canStop: false,
  canAttachPhotos: false,
  canEditHistory: false,
  canDeleteHistory: false,
  canRerunFromMessage: false,
  canRetakeLatest: false,
  canForkFromMessage: false,
  canUseLegacyActionBeats: false,
  canUseWorldActions: true,
} as const satisfies ChatCapabilityManifest;

/** Resolve the client/server operation contract for one chat lane. */
export function chatCapabilitiesForLane(simRouted: boolean): ChatCapabilityManifest {
  return simRouted ? SUCCESSOR_CHAT_CAPABILITIES : LEGACY_CHAT_CAPABILITIES;
}
