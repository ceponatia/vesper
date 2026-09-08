import { z } from "zod";
import { diagnosticSchema } from "@/contracts";
import { characterSheetScopes } from "@/lib/character-scopes";
import { portraitExtractionEvidenceSchema } from "@/lib/portrait-extraction";
import { apiGet, apiPatch, apiPost, withQuery } from "./http";
import { characterDetailSchema, characterDraftSchema } from "./library";

export const characterAuthoringTargetSchema = z.object({
  kind: z.enum(["creation", "character"]),
  id: z.string().min(1),
});

export const characterAuthoringSourceSchema = z.object({
  authoringRevision: z.number().int().positive(),
  imageId: z.string().min(1).nullable().default(null),
  imageContentHash: z.string().regex(/^[0-9a-f]{64}$/).nullable().optional(),
  authoringFingerprint: z.string().regex(/^[0-9a-f]{64}$/).nullable().optional(),
});

export const characterAuthoringResultSchema = z.object({
  proposed: characterDraftSchema,
  diagnostics: z.array(diagnosticSchema),
  portrait: portraitExtractionEvidenceSchema.nullable().optional(),
});

const authoringUndoSchema = z.object({
  id: z.string(),
  label: z.string(),
  base: characterDraftSchema,
  proposed: characterDraftSchema,
  undo: z.literal(true),
  sourceRunId: z.string(),
  proposalRevision: z.number().int().positive(),
});

export const characterAuthoringProposalStateSchema = z.object({
  revision: z.number().int().positive().default(1),
  status: z.enum(["unresolved", "accepted", "rejected", "undone", "dismissed"]).default("unresolved"),
  choices: z.record(z.string(), z.enum(["current", "proposed"])).default({}),
  appliedDraft: characterDraftSchema.nullable().default(null),
  undo: authoringUndoSchema.nullable().default(null),
});

export const characterAuthoringRunSchema = z.object({
  id: z.string(),
  ownerId: z.string(),
  target: characterAuthoringTargetSchema,
  operation: z.enum(["create", "fill", "redraft", "portrait"]),
  scope: z.enum(characterSheetScopes).nullable(),
  label: z.string(),
  base: characterDraftSchema,
  creationStart: z.object({
    draft: characterDraftSchema,
    prompt: z.string(),
    initialPreview: z.boolean(),
  }).nullable(),
  source: characterAuthoringSourceSchema.nullable(),
  status: z.enum(["pending", "completed", "failed"]),
  result: characterAuthoringResultSchema.nullable(),
  error: z.string().nullable(),
  errorCode: z.string().nullable().optional(),
  retryOf: z.string().nullable(),
  rootRunId: z.string(),
  persisted: z.boolean(),
  proposal: characterAuthoringProposalStateSchema,
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
});

export type CharacterAuthoringTarget = z.infer<typeof characterAuthoringTargetSchema>;
export type CharacterAuthoringSource = z.infer<typeof characterAuthoringSourceSchema>;
export type CharacterAuthoringResult = z.infer<typeof characterAuthoringResultSchema>;
export type CharacterAuthoringRun = z.infer<typeof characterAuthoringRunSchema>;
export type CharacterAuthoringGenerationInput = Pick<CharacterAuthoringRun, "operation" | "scope" | "label" | "base" | "creationStart" | "source">;
export type CharacterAuthoringDecision = "accept" | "reject" | "undo" | "dismiss";

const runEnvelopeSchema = z.object({ run: characterAuthoringRunSchema });
const runListEnvelopeSchema = z.object({
  runs: z.array(characterAuthoringRunSchema),
  diagnostics: z.array(diagnosticSchema).default([]),
});
const decisionEnvelopeSchema = runEnvelopeSchema.extend({ character: characterDetailSchema.optional() });

export const characterAuthoringRunsApi = {
  list: (target: CharacterAuthoringTarget) => apiGet(
    runListEnvelopeSchema,
    withQuery("/api/characters/authoring-runs", {
      targetKind: target.kind,
      targetId: target.id,
    }),
  ),
  start: (requestId: string, target: CharacterAuthoringTarget, input: CharacterAuthoringGenerationInput) => apiPost(
    runEnvelopeSchema,
    "/api/characters/authoring-runs",
    { requestId, target, ...input },
  ),
  retry: (runId: string, requestId: string) => apiPost(
    runEnvelopeSchema,
    `/api/characters/authoring-runs/${runId}/retry`,
    { requestId },
  ),
  decide: (runId: string, body: {
    action: CharacterAuthoringDecision;
    expectedProposalRevision: number;
    expectedAuthoringRevision?: number;
    choices?: Record<string, "current" | "proposed">;
    currentDraft?: z.infer<typeof characterDraftSchema>;
  }) => apiPatch(decisionEnvelopeSchema, `/api/characters/authoring-runs/${runId}/decision`, body),
};
