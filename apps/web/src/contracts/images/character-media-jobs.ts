import { z } from "zod";

export const characterMediaOperations = ["portrait", "variant", "identity_pack", "reference_views"] as const;
export const characterMediaOperationSchema = z.enum(characterMediaOperations);
export type CharacterMediaOperation = z.infer<typeof characterMediaOperationSchema>;

export const characterMediaLifecycles = ["queued", "running", "succeeded", "partial", "failed", "interrupted"] as const;
export const characterMediaLifecycleSchema = z.enum(characterMediaLifecycles);
export type CharacterMediaLifecycle = z.infer<typeof characterMediaLifecycleSchema>;

export const characterMediaRetryTargetSchema = z.object({
  operation: characterMediaOperationSchema,
  targets: z.array(z.string()).max(32).default([]),
});
export type CharacterMediaRetryTarget = z.infer<typeof characterMediaRetryTargetSchema>;

export const characterMediaResultSchema = z.object({
  kind: z.enum(["image", "identity_pack", "reference_view_attempt"]),
  id: z.string().min(1),
  imageId: z.string().min(1).nullable().default(null),
});
export type CharacterMediaResult = z.infer<typeof characterMediaResultSchema>;

export const characterMediaJobSchema = z.object({
  id: z.string().min(1),
  operation: characterMediaOperationSchema,
  label: z.string().min(1),
  targets: z.array(z.string()).max(32),
  lifecycle: characterMediaLifecycleSchema,
  progress: z.object({
    completed: z.number().int().nonnegative(),
    total: z.number().int().positive(),
    failed: z.number().int().nonnegative(),
  }),
  error: z
    .object({ code: z.string().min(1), message: z.string().min(1) })
    .nullable(),
  results: z.array(characterMediaResultSchema).max(64),
  retry: characterMediaRetryTargetSchema,
  createdAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable(),
  finishedAt: z.string().datetime().nullable(),
});
export type CharacterMediaJob = z.infer<typeof characterMediaJobSchema>;

export const characterMediaJobsResponseSchema = z.object({
  jobs: z.array(characterMediaJobSchema).max(12).catch([]),
});
export type CharacterMediaJobsResponse = z.infer<typeof characterMediaJobsResponseSchema>;

export type CharacterMediaJobType = "avatar" | "portrait_variant" | "identity_pack" | "reference_views";
export type CharacterMediaJobStatus = "queued" | "running" | "done" | "failed";

/** The deliberately small row shape accepted by the safe projection. */
export interface CharacterMediaJobProjectionInput {
  id: string;
  type: CharacterMediaJobType;
  status: CharacterMediaJobStatus;
  payload: unknown;
  createdAt: Date | string;
  startedAt: Date | string | null;
  finishedAt: Date | string | null;
}

export interface CharacterMediaJobProjectionContext {
  now?: Date;
  staleAfterMs: number;
  results?: readonly CharacterMediaResult[];
}

const payloadSchema = z
  .object({
    kind: z.string().max(80).optional(),
    imageId: z.string().min(1).max(128).optional(),
    code: z.string().min(1).max(100).optional(),
    outcome: z.string().min(1).max(100).optional(),
    status: z
      .enum(["built", "not_found", "not_accepted", "source_unreadable", "unavailable"])
      .optional(),
    targets: z.array(z.string().min(1).max(100)).max(32).optional(),
    planned: z.number().int().nonnegative().optional(),
    built: z.number().int().nonnegative().optional(),
    failed: z.number().int().nonnegative().optional(),
  })
  .passthrough();

const operationByType: Record<CharacterMediaJobType, { operation: CharacterMediaOperation; label: string }> = {
  avatar: { operation: "portrait", label: "Main portrait" },
  portrait_variant: { operation: "variant", label: "Portrait variant" },
  identity_pack: { operation: "identity_pack", label: "Identity reference" },
  reference_views: { operation: "reference_views", label: "Reference views" },
};

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : new Date(0).toISOString();
}

function safeDiagnosticCode(payload: z.infer<typeof payloadSchema>): string {
  if (payload.status && payload.status !== "built") return `images.reference_views.${payload.status}`;
  const candidate = payload.code ?? payload.outcome;
  return candidate && /^[a-z0-9._-]+$/i.test(candidate) ? candidate : "media_job.failed";
}

/**
 * Project a jobs row into the character-facing contract.
 *
 * Raw payloads and error strings never cross this boundary. Only allowlisted
 * target/result identifiers, bounded counts and stable diagnostic codes survive.
 */
export function projectCharacterMediaJob(
  input: CharacterMediaJobProjectionInput,
  context: CharacterMediaJobProjectionContext,
): CharacterMediaJob {
  const payload = payloadSchema.safeParse(input.payload);
  const safe = payload.success ? payload.data : {};
  const descriptor = operationByType[input.type];
  const targets = input.type === "reference_views"
    ? (safe.targets ?? [])
    : input.type === "portrait_variant" && safe.kind
      ? [safe.kind]
      : [];
  const targetCount = Math.max(1, targets.length > 0 ? targets.length : (safe.planned ?? 0));
  const built = Math.min(targetCount, safe.built ?? 0);
  const failedCount = Math.min(targetCount - built, safe.failed ?? 0);
  const createdAt = new Date(input.createdAt);
  const stale = (input.status === "queued" || input.status === "running")
    && context.now !== undefined
    && Number.isFinite(createdAt.getTime())
    && context.now.getTime() - createdAt.getTime() >= context.staleAfterMs;

  let lifecycle: CharacterMediaLifecycle;
  if (stale) lifecycle = "interrupted";
  else if (input.status === "queued") lifecycle = "queued";
  else if (input.status === "running") lifecycle = "running";
  else if (input.status === "failed") lifecycle = "failed";
  else if (input.type === "identity_pack" && safe.outcome === "blocked") lifecycle = "failed";
  else if (input.type === "reference_views" && safe.status && safe.status !== "built") lifecycle = "failed";
  else if (failedCount > 0) lifecycle = built > 0 ? "partial" : "failed";
  else lifecycle = "succeeded";

  const terminalFailure = lifecycle === "failed" || lifecycle === "partial" || lifecycle === "interrupted";
  const message = lifecycle === "partial"
    ? `${descriptor.label} finished with ${failedCount} failed target${failedCount === 1 ? "" : "s"}.`
    : lifecycle === "interrupted"
      ? `${descriptor.label} was interrupted. Retry it from the character tools.`
      : `${descriptor.label} failed. Retry it from the character tools.`;
  const results = [...(context.results ?? [])];
  if (safe.imageId && !results.some((result) => result.kind === "image" && result.id === safe.imageId)) {
    results.unshift({ kind: "image", id: safe.imageId, imageId: safe.imageId });
  }

  return characterMediaJobSchema.parse({
    id: input.id,
    operation: descriptor.operation,
    label: descriptor.label,
    targets,
    lifecycle,
    progress: {
      completed: lifecycle === "succeeded" ? targetCount : lifecycle === "partial" ? built + failedCount : built,
      total: targetCount,
      failed: lifecycle === "failed" && failedCount === 0 ? 1 : failedCount,
    },
    error: terminalFailure ? { code: safeDiagnosticCode(safe), message } : null,
    results,
    retry: { operation: descriptor.operation, targets },
    createdAt: iso(input.createdAt),
    startedAt: iso(input.startedAt),
    finishedAt: iso(input.finishedAt),
  });
}
