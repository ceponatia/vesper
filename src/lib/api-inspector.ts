import { z } from "zod";
import { apiDelete, apiGet, apiPatch, apiPost, withQuery } from "@/lib/client/api";

/**
 * Client data layer for the admin chat inspector
 * (character-chat-standalone.spec.md §6.1) — the `/api/admin/chat-inspector`
 * family (role-gated: 404 for non-admins, so it works on the deployed build,
 * unlike the NODE_ENV-gated `/api/dev` namespace it used to live in). Kept out
 * of `lib/client/api.ts` deliberately: this surface is admin-only and shouldn't
 * bulk the player bundle's schema module. Same rules apply, though: every
 * response crosses a trust boundary, so it is parsed with forgiving `.catch()`
 * schemas — bad fields fall back, bad list elements are dropped
 * (docs/resilience.md §7).
 */

const textOr = (fallback: string) => z.string().catch(fallback);
const optionalId = z
  .string()
  .nullish()
  .catch(null)
  .transform((v) => v ?? null);

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
  /** False ⇒ no stored embedding: the row is invisible to similarity retrieval. */
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

/** The rebuilt "what reaches the narrator now" prompt (spec §5 dev affordance). */
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
  /** True ⇒ the query embed failed; no scores, not an error (resilience). */
  degraded: z.boolean().catch(false),
});
export type EpisodeScores = z.infer<typeof episodeScoresSchema>;

const factPatchResponseSchema = z.object({
  fact: inspectorFactSchema,
  /** Text saved but the re-embed failed — the row left similarity retrieval. */
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

const base = (chatId: string) => `/api/admin/chat-inspector/${chatId}`;

export const chatInspectorApi = {
  /** Everything stored for the conversation: all facts, episodes, summary row, character card. */
  overview: (chatId: string) => apiGet(inspectorOverviewSchema, base(chatId)),
  /** Rebuild the exact prompt the next exchange would send (read-only). */
  prompt: (chatId: string) => apiGet(inspectorPromptSchema, `${base(chatId)}/prompt`),
  /** Ad-hoc dev fact — origin "dev", confidence 1; subjectName defaults to the character. */
  createFact: (chatId: string, body: InspectorFactCreate) =>
    apiPost(z.object({ id: z.string().min(1) }), `${base(chatId)}/facts`, body),
  /** Edit text (re-embeds) / hard-set pinned / retract / restore one fact. */
  updateFact: (chatId: string, factId: string, patch: InspectorFactPatch) =>
    apiPatch(factPatchResponseSchema, `${base(chatId)}/facts/${factId}`, patch),
  /** Overwrite one episode's summary (re-embeds). */
  updateEpisode: (chatId: string, episodeId: string, summary: string) =>
    apiPatch(episodePatchResponseSchema, `${base(chatId)}/episodes/${episodeId}`, { summary }),
  /** Hard-delete one episode. */
  deleteEpisode: (chatId: string, episodeId: string) => apiDelete(`${base(chatId)}/episodes/${episodeId}`),
  /** Cosine-score every embedded episode against a test query (retrieval-quality probe). */
  scoreEpisodes: (chatId: string, q: string) =>
    apiGet(episodeScoresSchema, withQuery(`${base(chatId)}/episodes/score`, { q })),
  /** Overwrite the rolling summary's prose (watermark untouched). */
  updateSummary: (chatId: string, summary: string) =>
    apiPatch(inspectorSummarySchema, `${base(chatId)}/summary`, { summary }),
};
