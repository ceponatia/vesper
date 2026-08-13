import { z } from "zod";
import { apiGet, apiPost } from "@/lib/client/api";

/**
 * Client data layer for the self-scoped owner-admin `romantic_touch` permission
 * override panel (romantic-contact-affordances.spec.permission.md §"Authorship
 * and developer controls") — the `api-inspector.ts` shape: forgiving zod (a
 * debug surface shows a gap, never an error page) over the
 * `/api/admin/self/chat-permissions/:chatId` base.
 */

const textOr = (fallback: string) => z.string().catch(fallback);

/** Array where invalid elements are dropped instead of failing the whole list. */
function arrayOf<T>(item: z.ZodType<T>) {
  return z
    .array(z.unknown())
    .catch([])
    .transform((items) =>
      items.flatMap((itemValue) => {
        const parsed = item.safeParse(itemValue);
        return parsed.success ? [parsed.data] : [];
      }),
    );
}

/** One directional standing: permitted actor → granting target → exact scope. */
export const permissionGrantSchema = z.object({
  permittedActorId: z.string().min(1),
  grantingTargetId: z.string().min(1),
  scope: textOr("romantic_touch"),
  standing: z.enum(["granted", "withdrawn", "revoked"]).catch("withdrawn"),
  decidedByEventId: textOr(""),
});
export type PermissionGrant = z.infer<typeof permissionGrantSchema>;

/** One recent ledger event, as the panel's audit trail lists it. */
export const permissionEventSchema = z.object({
  id: z.string().min(1),
  kind: textOr(""),
  sourceKind: textOr(""),
  operation: z
    .enum(["grant", "withdraw"])
    .nullish()
    .catch(null)
    .transform((value) => value ?? null),
  permittedActorId: textOr(""),
  grantingTargetId: textOr(""),
  scope: textOr("romantic_touch"),
  storyMinute: z.number().catch(0),
  createdAt: textOr(""),
});
export type PermissionEvent = z.infer<typeof permissionEventSchema>;

export const permissionOverviewSchema = z.object({
  scope: textOr("romantic_touch"),
  playerSubjectId: textOr("player"),
  /** Whether the POST capability gate (`CHAT_ROMANTIC_PERMISSION_DEV_OVERRIDE`) is on. */
  overrideEnabled: z.boolean().catch(false),
  grants: arrayOf(permissionGrantSchema),
  events: arrayOf(permissionEventSchema),
});
export type PermissionOverview = z.infer<typeof permissionOverviewSchema>;

export const permissionOverrideResultSchema = z.object({
  eventId: textOr(""),
  operation: z.enum(["grant", "withdraw"]).catch("grant"),
  standingBefore: z
    .enum(["granted", "withdrawn", "revoked"])
    .nullish()
    .catch(null)
    .transform((value) => value ?? null),
  standingAfter: z.enum(["granted", "withdrawn"]).catch("withdrawn"),
  standingChanged: z.boolean().catch(false),
  /** Active contacts the withdrawal's invalidation sweep ended, if any. */
  endedContactIds: z.array(z.string()).catch([]),
});
export type PermissionOverrideResult = z.infer<typeof permissionOverrideResultSchema>;

export interface PermissionOverrideRequest {
  permittedActorId: string;
  grantingTargetId: string;
  operation: "grant" | "withdraw";
}

const base = (chatId: string) => `/api/admin/self/chat-permissions/${chatId}`;

export const chatPermissionsApi = {
  overview: (chatId: string) => apiGet(permissionOverviewSchema, base(chatId)),
  override: (chatId: string, body: PermissionOverrideRequest) =>
    apiPost(permissionOverrideResultSchema, base(chatId), body),
};
