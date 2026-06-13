import { diag, type DiagnosticSink } from "@/contracts/diagnostics";
import { FACT_RETRIEVAL_LIMIT } from "./constants";
import { retrieveEpisodes } from "./episodes";
import { retrieveFacts } from "./facts";
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
 * diagnostic, never a failed turn.
 */
export async function preTurnRetrieve(input: PreTurnRetrieveInput): Promise<PreTurnRetrieval> {
  const queryText = [...input.queries, input.input]
    .map((q) => q.trim())
    .filter(Boolean)
    .join("\n");
  if (!queryText) return { episodeHits: [], factHits: [], loreHits: [] };

  const [episodesResult, factsResult, loreResult] = await Promise.allSettled([
    retrieveEpisodes(input.session.id, queryText, { sink: input.sink }),
    retrieveFacts(input.session.id, queryText, FACT_RETRIEVAL_LIMIT, input.sink),
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
