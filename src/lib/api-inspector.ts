import { z } from "zod";
import { apiDelete, apiGet, apiPatch, apiPost, withQuery } from "@/lib/client/api";

/** Client data layer for the explicitly self-scoped owner-admin chat inspector. */
const textOr = (fallback: string) => z.string().catch(fallback);
const optionalId = z
  .string()
  .nullish()
  .catch(null)
  .transform((value) => value ?? null);

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

export const inspectorFactSchema = z.object({
  id: z.string().min(1),
  kind: textOr("knowledge"),
  subjectKind: textOr("character"),
  subjectId: optionalId,
  subjectName: textOr(""),
  text: textOr(""),
  tags: z.array(z.string()).catch([]),
  confidence: z.number().catch(0),
  status: z.enum(["active", "superseded", "retracted"]).catch("active"),
  pinned: z.boolean().catch(false),
  origin: z.enum(["extracted", "player", "dev"]).catch("extracted"),
  sourceTurnId: optionalId,
  sourceMessageId: optionalId,
  supersededById: optionalId,
  createdAt: optionalId,
  supersededAt: optionalId,
});
export type InspectorFact = z.infer<typeof inspectorFactSchema>;

export const inspectorEpisodeSchema = z.object({
  id: z.string().min(1),
  turnNumber: z.number().catch(0),
  summary: textOr(""),
  sourceMessageId: optionalId,
  createdAt: optionalId,
  embedded: z.boolean().catch(false),
});
export type InspectorEpisode = z.infer<typeof inspectorEpisodeSchema>;

export const inspectorSummarySchema = z.object({
  summary: textOr(""),
  watermarkAt: optionalId,
  coveredExchanges: z.number().catch(0),
});
export type InspectorSummary = z.infer<typeof inspectorSummarySchema>;

export const inspectorOverviewSchema = z.object({
  facts: arrayOf(inspectorFactSchema),
  episodes: arrayOf(inspectorEpisodeSchema),
  summary: inspectorSummarySchema.nullable().catch(null),
  character: z.object({ id: textOr(""), name: textOr("") }).catch({ id: "", name: "" }),
});
export type InspectorOverview = z.infer<typeof inspectorOverviewSchema>;

export const inspectorPromptSchema = z.object({
  prefix: textOr(""),
  tail: textOr(""),
  memory: z
    .object({
      facts: z.array(z.string()).catch([]),
      episodes: z.array(z.string()).catch([]),
    })
    .catch({ facts: [], episodes: [] }),
  memoryQueries: z.array(z.string()).catch([]),
});
export type InspectorPrompt = z.infer<typeof inspectorPromptSchema>;

export const episodeScoresSchema = z.object({
  scores: arrayOf(z.object({ id: z.string().min(1), score: z.number().catch(0) })),
  degraded: z.boolean().catch(false),
});
export type EpisodeScores = z.infer<typeof episodeScoresSchema>;

const factPatchResponseSchema = z.object({
  fact: inspectorFactSchema,
  embedDegraded: z.boolean().catch(false),
});

const episodePatchResponseSchema = z.object({
  episode: inspectorEpisodeSchema,
  embedDegraded: z.boolean().catch(false),
});

export interface InspectorFactPatch {
  text?: string;
  pinned?: boolean;
  status?: "active" | "retracted";
}

export interface InspectorFactCreate {
  text: string;
  subjectName?: string;
  subjectKind?: string;
  kind?: string;
  pinned?: boolean;
}

const base = (chatId: string) => `/api/admin/self/chat-inspector/${chatId}`;

export const agentFailureRowSchema = z.object({
  legId: textOr("unknown"),
  kind: z.enum(["timeout", "api_error", "parse_failed"]).catch("timeout"),
  cause: textOr("unknown"),
  messageId: optionalId,
  modelId: textOr(""),
  provider: optionalId,
  promptChars: z.number().catch(0),
  maxOutputTokens: z.number().catch(0),
  timeoutMs: z.number().catch(0),
  latencyMs: z.number().catch(0),
  detail: textOr(""),
  at: textOr(""),
});
export type AgentFailureRow = z.infer<typeof agentFailureRowSchema>;

const tallyRowSchema = z.object({ key: textOr(""), count: z.number().catch(0) });

const failureReportSchema = z.object({
  recent: arrayOf(agentFailureRowSchema),
  total: z.number().catch(0),
  byLeg: arrayOf(tallyRowSchema),
  byCause: arrayOf(tallyRowSchema),
});
const EMPTY_FAILURE_REPORT = { recent: [], total: 0, byLeg: [], byCause: [] } as const;

export const agentRunDetailRowSchema = z.object({ label: textOr(""), items: arrayOf(z.string().catch("")) });
export type AgentRunDetailRow = z.infer<typeof agentRunDetailRowSchema>;

export const agentRunRowSchema = z.object({
  legId: textOr("unknown"),
  messageId: optionalId,
  modelId: textOr(""),
  provider: optionalId,
  promptChars: z.number().catch(0),
  maxOutputTokens: z.number().catch(0),
  latencyMs: z.number().catch(0),
  summary: textOr(""),
  details: arrayOf(agentRunDetailRowSchema),
  at: textOr(""),
});
export type AgentRunRow = z.infer<typeof agentRunRowSchema>;

const runStatRowSchema = z.object({
  key: textOr(""),
  count: z.number().catch(0),
  medianMs: z.number().catch(0),
  maxMs: z.number().catch(0),
});
export type AgentRunStatRow = z.infer<typeof runStatRowSchema>;

const runReportSchema = z.object({
  recent: arrayOf(agentRunRowSchema),
  total: z.number().catch(0),
  byLeg: arrayOf(runStatRowSchema),
});
const EMPTY_RUN_REPORT = { recent: [], total: 0, byLeg: [] } as const;

/**
 * Global fields remain as empty compatibility defaults for the current UI, but
 * the self-scoped API never returns cross-chat data.
 */
export const agentHealthSchema = z.object({
  days: z.number().catch(7),
  chat: failureReportSchema,
  global: failureReportSchema.catch(EMPTY_FAILURE_REPORT).default(EMPTY_FAILURE_REPORT),
  runs: runReportSchema.catch(EMPTY_RUN_REPORT).default(EMPTY_RUN_REPORT),
  runsGlobal: runReportSchema.catch(EMPTY_RUN_REPORT).default(EMPTY_RUN_REPORT),
});
export type AgentHealth = z.infer<typeof agentHealthSchema>;

export const compositionFallbackRowSchema = z.object({
  site: textOr("departure"),
  code: textOr("drain_short"),
  messageId: optionalId,
  detail: textOr(""),
  at: textOr(""),
});
export type CompositionFallbackRow = z.infer<typeof compositionFallbackRowSchema>;

const compositionReportSchema = z.object({
  recent: arrayOf(compositionFallbackRowSchema),
  total: z.number().catch(0),
  byCode: arrayOf(tallyRowSchema),
  bySite: arrayOf(tallyRowSchema),
});
const EMPTY_COMPOSITION_REPORT = { recent: [], total: 0, byCode: [], bySite: [] } as const;

export const compositionHealthSchema = z.object({
  days: z.number().catch(7),
  chat: compositionReportSchema,
  global: compositionReportSchema.catch(EMPTY_COMPOSITION_REPORT).default(EMPTY_COMPOSITION_REPORT),
});
export type CompositionHealth = z.infer<typeof compositionHealthSchema>;

export const chatInspectorApi = {
  overview: (chatId: string) => apiGet(inspectorOverviewSchema, base(chatId)),
  prompt: (chatId: string) => apiGet(inspectorPromptSchema, `${base(chatId)}/prompt`),
  agentFailures: (chatId: string, days?: number) =>
    apiGet(agentHealthSchema, withQuery(`${base(chatId)}/agent-failures`, days ? { days: String(days) } : {})),
  compositionFallbacks: (chatId: string, days?: number) =>
    apiGet(
      compositionHealthSchema,
      withQuery(`${base(chatId)}/composition-fallbacks`, days ? { days: String(days) } : {}),
    ),
  createFact: (chatId: string, body: InspectorFactCreate) =>
    apiPost(z.object({ id: z.string().min(1) }), `${base(chatId)}/facts`, body),
  updateFact: (chatId: string, factId: string, patch: InspectorFactPatch) =>
    apiPatch(factPatchResponseSchema, `${base(chatId)}/facts/${factId}`, patch),
  updateEpisode: (chatId: string, episodeId: string, summary: string) =>
    apiPatch(episodePatchResponseSchema, `${base(chatId)}/episodes/${episodeId}`, { summary }),
  deleteEpisode: (chatId: string, episodeId: string) => apiDelete(`${base(chatId)}/episodes/${episodeId}`),
  scoreEpisodes: (chatId: string, query: string) =>
    apiGet(episodeScoresSchema, withQuery(`${base(chatId)}/episodes/score`, { q: query })),
  updateSummary: (chatId: string, summary: string) =>
    apiPatch(inspectorSummarySchema, `${base(chatId)}/summary`, { summary }),
};
