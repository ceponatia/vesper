import { z } from "zod";
import { visualExtractionImageRegionSchema } from "@/contracts";

export const portraitVisibilityValues = ["clear", "partial", "occluded", "out_of_frame", "uncertain"] as const;
export const portraitVisibilitySchema = z.enum(portraitVisibilityValues);
export type PortraitVisibility = z.infer<typeof portraitVisibilitySchema>;

const portraitAttributeValueSchema = z.union([z.string(), z.array(z.string()), z.number(), z.boolean()]);

/** Evidence attached to one model observation. Fixed-point confidence and image
 * regions use the same 0…10 000 vocabulary as reference-image extraction. */
export const portraitFieldEvidenceSchema = z.object({
  id: z.string().min(1),
  value: portraitAttributeValueSchema.nullable(),
  confidence: z.number().int().min(0).max(10_000),
  visibility: portraitVisibilitySchema,
  evidence: z.string().trim().min(1).max(500),
  evidenceRegion: visualExtractionImageRegionSchema.nullable(),
  defaultSelected: z.boolean(),
});
export type PortraitFieldEvidence = z.infer<typeof portraitFieldEvidenceSchema>;

export const portraitDecisionSchema = z.object({
  proposalRevision: z.number().int().positive(),
  action: z.enum(["accepted", "rejected", "undone"]),
  fields: z.array(z.object({
    id: z.string().min(1),
    decision: z.enum(["accepted", "kept", "rejected", "undone"]),
  })),
});
export type PortraitDecision = z.infer<typeof portraitDecisionSchema>;

export const portraitExtractionEvidenceSchema = z.object({
  outcome: z.enum(["proposals", "supported_match", "read_failed"]),
  readFailure: z.enum(["provider_or_parse", "insufficient_visible_evidence", "source_unavailable", "source_changed"]).nullable(),
  source: z.object({
    imageId: z.string().min(1),
    contentHash: z.string().regex(/^[0-9a-f]{64}$/),
    authoringRevision: z.number().int().positive(),
    authoringFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  model: z.object({
    id: z.string().min(1),
    promptVersion: z.string().min(1),
    provider: z.string().nullable(),
  }),
  timing: z.object({
    startedAt: z.string(),
    finishedAt: z.string(),
    durationMs: z.number().int().nonnegative(),
    providerLatencyMs: z.number().int().nonnegative().nullable(),
  }),
  fields: z.array(portraitFieldEvidenceSchema),
  decision: portraitDecisionSchema.nullable().default(null),
}).superRefine((evidence, ctx) => {
  if ((evidence.outcome === "read_failed") !== (evidence.readFailure !== null)) {
    ctx.addIssue({ code: "custom", path: ["readFailure"], message: "read failures require a reason and successful reads cannot carry one" });
  }
});
export type PortraitExtractionEvidence = z.infer<typeof portraitExtractionEvidenceSchema>;

export function portraitVisibilityLabel(visibility: PortraitVisibility): string {
  return visibility === "out_of_frame" ? "Out of frame" : visibility.charAt(0).toUpperCase() + visibility.slice(1);
}
