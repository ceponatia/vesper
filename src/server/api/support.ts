import { db, events } from "@/server/db";

export const SUPPORT_ACCESS_EVENT = "support_access";
export const SUPPORT_MEMORY_REDACTION = "[redacted memory content]";

export interface SupportAccessAuditInput {
  actorUserId: string;
  targetOwnerId: string;
  resourceType: string;
  resourceId: string;
  method: string;
  route: string;
  reason: string | null;
  ticketId: string | null;
}

/**
 * Append one immutable support-access event. Unlike ordinary observability
 * logging this is awaited and deliberately does not swallow failures: a support
 * route must fail closed if its access cannot be recorded.
 */
export async function recordSupportAccessAudit(input: SupportAccessAuditInput): Promise<string> {
  const [event] = await db()
    .insert(events)
    .values({
      type: SUPPORT_ACCESS_EVENT,
      payload: {
        schemaVersion: 1,
        actorUserId: input.actorUserId,
        targetOwnerId: input.targetOwnerId,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        method: input.method,
        route: input.route,
        reason: input.reason,
        ticketId: input.ticketId,
      },
    })
    .returning({ id: events.id });
  if (!event) throw new Error("support audit insert returned no event");
  return event.id;
}

export interface SupportMemoryMetadata {
  id: string;
  kind: string;
  status: string | null;
  createdAt: string | null;
  content: typeof SUPPORT_MEMORY_REDACTION | null;
}

/**
 * Allow-listed cross-account memory DTO. Raw prose, prompts, summaries,
 * embeddings, tags, and model diagnostics are intentionally never spread into
 * the result. A caller can establish that content exists without reading it.
 */
export function toSupportMemoryMetadata(record: Record<string, unknown>): SupportMemoryMetadata {
  const sensitiveKeys = ["text", "summary", "prompt", "memory", "embedding", "detail"] as const;
  const hasSensitiveContent = sensitiveKeys.some((key) => {
    const value = record[key];
    return typeof value === "string" ? value.length > 0 : value !== null && value !== undefined;
  });
  const createdAt = record.createdAt;
  return {
    id: typeof record.id === "string" ? record.id : "",
    kind: typeof record.kind === "string" ? record.kind : "memory",
    status: typeof record.status === "string" ? record.status : null,
    createdAt:
      createdAt instanceof Date
        ? createdAt.toISOString()
        : typeof createdAt === "string"
          ? createdAt
          : null,
    content: hasSensitiveContent ? SUPPORT_MEMORY_REDACTION : null,
  };
}
