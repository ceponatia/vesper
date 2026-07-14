import { diag, type DiagnosticSink } from "@/contracts/diagnostics";
import { EPISODE_RETRIEVAL_LIMIT, FACT_RETRIEVAL_LIMIT } from "./constants";
import { retrieveEpisodesFused } from "./episodes";
import { retrieveFactsFused } from "./facts";
import { nonBlankQueries } from "./fusion";
import { QueryEmbeddings } from "./query-embeddings";
import { sessionScope } from "./scope";
import {
  eligibleRetrievalChunks,
  loadWorldLoreChunks,
  retrieveLoreChunks,
  type LoreHit,
  type SceneContext,
} from "./lore";

export interface PreTurnRetrieveInput {
  session: { id: string };
  world: { id: string };
  /** Previous turn's `brief.memoryQueries`. */
  queries: readonly string[];
  /** The player input for this turn. */
  input: string;
  sceneCtx: SceneContext;
  /** `session.runtime.unlockedLoreIds`. */
  unlockedIds: readonly string[];
  sink?: DiagnosticSink;
}

export interface PreTurnRetrieval {
  episodeHits: string[];
  factHits: string[];
  loreHits: { title: string; body: string }[];
}

/**
 * Pre-turn retrieval fan-out (docs/turn-engine.md step 3a–c): the three legs
 * run in parallel and fail independently — a failed leg degrades to [] with a
 * diagnostic, never a failed turn. Episodes + facts run the fused multi-query
 * path (spec §6.3 #2 — one list per memory query + the player input); lore
 * stays single-query over the joined text.
 */
export async function preTurnRetrieve(input: PreTurnRetrieveInput): Promise<PreTurnRetrieval> {
  const queries = nonBlankQueries([...input.queries, input.input]);
  if (queries.length === 0) return { episodeHits: [], factHits: [], loreHits: [] };
  const queryText = queries.join("\n");

  const scope = sessionScope(input.session.id);
  // One embed for the whole turn (chat-agent-improvements slice 3): the episode and fact
  // legs search the SAME queries, and each used to batch-embed them independently — two
  // round-trips for one set of texts, on the pre-narration path. (Lore stays single-query
  // over the joined text, a different string, so it embeds its own.)
  const embeddings = await QueryEmbeddings.embed(queries, input.sink);
  const [episodesResult, factsResult, loreResult] = await Promise.allSettled([
    retrieveEpisodesFused(scope, queries, EPISODE_RETRIEVAL_LIMIT, input.sink, embeddings),
    retrieveFactsFused(scope, queries, FACT_RETRIEVAL_LIMIT, input.sink, embeddings),
    retrieveLoreLeg(input, queryText),
  ]);

  return {
    episodeHits: settle(episodesResult, "episodes", input.sink).map((h) => h.summary),
    factHits: settle(factsResult, "facts", input.sink).map((h) => h.text),
    loreHits: settle(loreResult, "lore", input.sink).map((h) => ({ title: h.title, body: h.body })),
  };
}

async function retrieveLoreLeg(input: PreTurnRetrieveInput, queryText: string): Promise<LoreHit[]> {
  const chunks = await loadWorldLoreChunks(input.world.id, input.sink);
  const eligible = eligibleRetrievalChunks(chunks, input.sceneCtx, input.unlockedIds);
  if (eligible.length === 0) return [];
  return retrieveLoreChunks(
    input.world.id,
    queryText,
    eligible.map((c) => c.id),
    { sessionId: input.session.id, sink: input.sink },
  );
}

function settle<T>(result: PromiseSettledResult<T[]>, leg: string, sink?: DiagnosticSink): T[] {
  if (result.status === "fulfilled") return result.value;
  sink?.push(
    diag("error", `memory.retrieval.${leg}_failed`, `${leg} retrieval failed: ${errorText(result.reason)}`),
  );
  return [];
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
