import { z } from "zod";
import { apiGet, apiPatch } from "@/lib/client/api";

/**
 * Client data layer for the admin Shadow Parity screen (R4,
 * engine.rollout.plan.md) — the `/api/admin/sim/shadow` family (role-gated:
 * 404 for non-admins). Kept out of `lib/client/api.ts` like the inspector's
 * layer: admin-only surfaces don't bulk the player bundle. Every response is
 * parsed with forgiving `.catch()` schemas — bad fields fall back, bad list
 * elements are dropped (docs/resilience.md §7).
 */

const textOr = (fallback: string) => z.string().catch(fallback);

/** Array where invalid elements are dropped instead of failing the whole list. */
function arrayOf<T>(item: z.ZodType<T>) {
  return z
    .array(z.unknown())
    .catch([])
    .transform((xs) =>
      xs.flatMap((x) => {
        const parsed = item.safeParse(x);
        return parsed.success ? [parsed.data] : [];
      }),
    );
}

export const shadowVerdicts = ["open", "intentional", "fixed"] as const;
export type ShadowVerdict = (typeof shadowVerdicts)[number];

export const shadowChatSummarySchema = z.object({
  chatId: z.string().min(1),
  title: textOr(""),
  characterName: textOr(""),
  total: z.number().catch(0),
  open: z.number().catch(0),
  lastAt: z.string().nullable().catch(null),
});
export type ShadowChatSummary = z.infer<typeof shadowChatSummarySchema>;

export const shadowRowSchema = z.object({
  id: z.string().min(1),
  messageId: textOr(""),
  domain: textOr("unknown"),
  legacy: z.unknown(),
  successor: z.unknown(),
  detail: textOr(""),
  verdict: z.enum(shadowVerdicts).catch("open"),
  createdAt: z.string().catch(""),
});
export type ShadowRow = z.infer<typeof shadowRowSchema>;

const clockStepSchema = z.object({
  fromMessageId: textOr(""),
  toMessageId: textOr(""),
  legacyDeltaMinutes: z.number().catch(0),
  successorDeltaMinutes: z.number().catch(0),
});

const meterFindingSchema = z.object({
  messageId: textOr(""),
  meterKey: textOr(""),
  legacyValue: z.number().catch(0),
  successorValue: z.number().catch(0),
});

export const shadowReportSchema = z.object({
  totals: z
    .object({
      rows: z.number().catch(0),
      byDomain: z.record(z.string(), z.number()).catch({}),
      byVerdict: z.record(z.string(), z.number()).catch({}),
      skippedMalformed: z.number().catch(0),
    })
    .catch({ rows: 0, byDomain: {}, byVerdict: {}, skippedMalformed: 0 }),
  clock: z
    .object({
      steps: z.number().catch(0),
      driftingSteps: arrayOf(clockStepSchema),
      latestSuccessorClock: z.string().nullable().catch(null),
    })
    .catch({ steps: 0, driftingSteps: [], latestSuccessorClock: null }),
  meters: z
    .object({
      comparedRows: z.number().catch(0),
      sharedKeys: z.array(z.string()).catch([]),
      beyondTolerance: arrayOf(meterFindingSchema),
      missingOnMirror: z.array(z.string()).catch([]),
      missingOnChat: z.array(z.string()).catch([]),
    })
    .catch({ comparedRows: 0, sharedKeys: [], beyondTolerance: [], missingOnMirror: [], missingOnChat: [] }),
  presence: z
    .object({
      rows: z.number().catch(0),
      mismatches: arrayOf(z.object({ messageId: textOr(""), detail: textOr("") })),
    })
    .catch({ rows: 0, mismatches: [] }),
  prose: z
    .object({
      pairs: z.number().catch(0),
      rendered: z.number().catch(0),
      failures: arrayOf(z.object({ messageId: textOr(""), detail: textOr("") })),
    })
    .catch({ pairs: 0, rendered: 0, failures: [] }),
  findings: z.array(z.string()).catch([]),
});
export type ShadowReport = z.infer<typeof shadowReportSchema>;

export const shadowApi = {
  /** Every chat with recorded divergences, newest activity first. */
  chats: () => apiGet(z.object({ chats: arrayOf(shadowChatSummarySchema) }), "/api/admin/sim/shadow"),
  /** One chat's raw divergence rows, newest first. */
  rows: (chatId: string) =>
    apiGet(z.object({ rows: arrayOf(shadowRowSchema) }), `/api/admin/sim/shadow/${chatId}`),
  /** The computed scale-aware parity report. */
  report: (chatId: string) =>
    apiGet(z.object({ report: shadowReportSchema }), `/api/admin/sim/shadow/${chatId}/report`),
  /** Rule one row's verdict — "intentional" is the durable ruling. */
  verdict: (chatId: string, id: string, verdict: ShadowVerdict) =>
    apiPatch(z.object({ id: z.string(), verdict: z.string() }), `/api/admin/sim/shadow/${chatId}`, { id, verdict }),
};
