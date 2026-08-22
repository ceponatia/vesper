import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { DiagnosticCollector, type Diagnostic } from "@/contracts/diagnostics";
import { currentEmbedder, embedTexts, isDemoMode } from "@/server/ai";
import {
  addFacts,
  appendEpisode,
  chatScope,
  cosineSimilarity,
  deleteEpisodesForScope,
  deleteFactsForScope,
  EPISODE_MIN_SCORE,
  EPISODE_RETRIEVAL_LIMIT,
  EPISODE_WINDOW,
  FACT_MIN_SCORE,
  FACT_RETRIEVAL_LIMIT,
  retrieveEpisodes,
  retrieveEpisodesFused,
  retrieveFacts,
  retrieveFactsFused,
  RRF_K,
  type FactDraftInput,
  type MemoryScope,
} from "@/server/memory";
import { RETRIEVAL_FIXTURES, type RetrievalFixture } from "./fixtures";

/**
 * Retrieval eval harness (character-chat-standalone.spec.md §6.3 #6) — the
 * measurement precondition for the §6.3 retrieval-quality work and the
 * permanent regression harness for retrieval changes. For each fixture it
 * mints a throwaway chat memory group ("eval-retrieval-…"), seeds it through
 * the REAL `addFacts`/`appendEpisode`, retrieves through the REAL
 * `retrieveFactsFused`/`retrieveEpisodesFused`, scores precision/recall
 * against the fixture's expectations plus floor behavior (a distractor
 * passing FACT_MIN_SCORE is a failure), and ALWAYS deletes the scope again.
 *
 * A "joined baseline" (all queries newline-joined into ONE retrieveFacts /
 * retrieveEpisodes call) runs per fixture; the fused-vs-joined recall delta is
 * the honest measure of what per-query embedding + RRF fusion (§6.3 #2)
 * bought.
 *
 *   pnpm eval:retrieval                      # all fixtures (needs DATABASE_URL)
 *   pnpm eval:retrieval --fixture pinned     # substring match on fixture id
 *   pnpm eval:retrieval --dry-run            # print fixtures + plan, no DB
 *
 * The harness MEASURES — a poor score is a signal to tune the floors/fusion,
 * never a build failure. It is deliberately not wired into CI.
 * Without OPENROUTER_API_KEY (or with AI_FAKE=1) the app embeds with
 * hash-based pseudo-vectors whose similarity is noise — the run still works
 * as a structural smoke test (pinned force-include, recency window, cleanup)
 * but every score/recall number is meaningless; the harness banners this.
 */

const OUT = process.env.EVAL_OUT ?? "data/eval/retrieval";

interface Args {
  dryRun: boolean;
  fixtures: RetrievalFixture[];
}

function parseArgs(argv: string[]): Args {
  let dryRun = false;
  let wanted: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const tok = argv[i];
    if (tok === "--dry-run") dryRun = true;
    else if (tok === "--fixture") {
      wanted = argv[i + 1];
      i += 1;
    }
  }
  const fixtures = wanted ? RETRIEVAL_FIXTURES.filter((f) => f.id.includes(wanted)) : RETRIEVAL_FIXTURES;
  return { dryRun, fixtures };
}

/** One retrieved hit mapped back to fixture vocabulary. */
interface HitReport {
  key: string;
  channel: "fact" | "episode";
  /** Best raw cosine across queries (0 = force-included pinned row no query found). */
  score: number;
  pinned: boolean;
  /** Queries that retrieved the hit (fused path only). */
  sources?: string[];
}

/** Client-side best-cosine per seeded doc — the floor-tuning payload. */
interface ScoreEntry {
  key: string;
  channel: "fact" | "episode";
  bestCosine: number;
  bestQuery: string;
  expected: boolean;
  excluded: boolean;
}

interface FixtureResult {
  id: string;
  title: string;
  covers: string;
  groupId: string;
  seeded: { facts: number; episodes: number; supersededDuringSeed: number };
  fused: {
    hits: HitReport[];
    recall: number;
    precision: number;
    misses: string[];
    /** expectExcluded keys that were retrieved anyway — floor/window failures. */
    distractorsPassed: { key: string; reason: "floor" | "window" }[];
    /** true/false when the fixture has pinned facts; null when it has none. */
    pinnedIncluded: boolean | null;
  };
  joined: { hits: HitReport[]; recall: number };
  /** fused recall − joined recall: what §6.3 #2 bought on this fixture. */
  recallDelta: number;
  scoreMatrix: ScoreEntry[];
  diagnostics: Diagnostic[];
  error?: string;
}

function round(n: number, decimals = 3): number {
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

/** Recency-window cutoff for a fixture's episodes (max turn − EPISODE_WINDOW). */
function episodeCutoff(fixture: RetrievalFixture): number | null {
  if (fixture.episodes.length === 0) return null;
  return Math.max(...fixture.episodes.map((e) => e.turnNumber)) - EPISODE_WINDOW;
}

/** Why an expectExcluded key should stay out: in-window episode ⇒ "window", everything else ⇒ "floor". */
function exclusionReason(fixture: RetrievalFixture, key: string): "floor" | "window" {
  const ep = fixture.episodes.find((e) => e.key === key);
  const cutoff = episodeCutoff(fixture);
  if (ep && cutoff !== null && ep.turnNumber > cutoff) return "window";
  return "floor";
}

/** Embed queries + every seeded doc client-side and report each doc's best cosine — the floor-tuning matrix. */
async function buildScoreMatrix(fixture: RetrievalFixture): Promise<ScoreEntry[]> {
  const docs = [
    ...fixture.facts.map((f) => ({ key: f.key, channel: "fact" as const, text: f.text })),
    ...fixture.episodes.map((e) => ({ key: e.key, channel: "episode" as const, text: e.summary })),
  ];
  if (docs.length === 0 || fixture.queries.length === 0) return [];
  const [queryEmb, docEmb] = await Promise.all([
    embedTexts(fixture.queries),
    embedTexts(docs.map((d) => d.text)),
  ]);
  return docs.map((doc, i) => {
    const dv = docEmb[i];
    let bestCosine = -1;
    let bestQuery = "";
    queryEmb.forEach((q, j) => {
      const score = dv ? cosineSimilarity(q.vector, dv.vector) : 0;
      if (score > bestCosine) {
        bestCosine = score;
        bestQuery = fixture.queries[j] ?? "";
      }
    });
    return {
      key: doc.key,
      channel: doc.channel,
      bestCosine: round(bestCosine),
      bestQuery,
      expected: fixture.expectRelevant.includes(doc.key),
      excluded: fixture.expectExcluded.includes(doc.key),
    };
  });
}

interface KeyedHits {
  hits: HitReport[];
  retrievedKeys: Set<string>;
}

function mapHits(
  factHits: readonly { id: string; score: number; pinned: boolean; sources?: string[] }[],
  episodeHits: readonly { id: string; score: number; sources?: string[] }[],
  factIdToKey: ReadonlyMap<string, string>,
  episodeIdToKey: ReadonlyMap<string, string>,
): KeyedHits {
  const hits: HitReport[] = [
    ...factHits.map(
      (h): HitReport => ({
        key: factIdToKey.get(h.id) ?? `unknown:${h.id}`,
        channel: "fact",
        score: round(h.score),
        pinned: h.pinned,
        sources: h.sources,
      }),
    ),
    ...episodeHits.map(
      (h): HitReport => ({
        key: episodeIdToKey.get(h.id) ?? `unknown:${h.id}`,
        channel: "episode",
        score: round(h.score),
        pinned: false,
        sources: h.sources,
      }),
    ),
  ];
  return { hits, retrievedKeys: new Set(hits.map((h) => h.key)) };
}

function recallOf(fixture: RetrievalFixture, retrievedKeys: ReadonlySet<string>): number {
  if (fixture.expectRelevant.length === 0) return 1;
  const found = fixture.expectRelevant.filter((k) => retrievedKeys.has(k)).length;
  return found / fixture.expectRelevant.length;
}

async function evalFixture(fixture: RetrievalFixture): Promise<FixtureResult> {
  const groupId = `eval-retrieval-${fixture.id}-${Date.now().toString(36)}`;
  const scope: MemoryScope = chatScope(groupId);
  const sink = new DiagnosticCollector();
  const base: Pick<FixtureResult, "id" | "title" | "covers" | "groupId"> = {
    id: fixture.id,
    title: fixture.title,
    covers: fixture.covers,
    groupId,
  };

  try {
    // Seed through the real write path.
    const drafts: FactDraftInput[] = fixture.facts.map((f) => ({
      kind: f.kind ?? "knowledge",
      subjectName: f.subjectName,
      subjectKind: f.subjectKind,
      text: f.text,
      tags: (f.tags ?? []).map((t) => t.toLowerCase()),
      confidence: 0.9,
      pinned: f.pinned ?? false,
      origin: f.pinned ? "player" : "extracted",
    }));
    const added = await addFacts(scope, drafts, null, sink);
    const factIdToKey = new Map<string, string>();
    added.insertedIds.forEach((id, i) => {
      const key = fixture.facts[i]?.key;
      if (key) factIdToKey.set(id, key);
    });
    if (added.supersededIds.length > 0) {
      console.warn(
        `  [${fixture.id}] WARNING: ${added.supersededIds.length} fixture fact(s) superseded each other during seeding — expectations may be invalid; make the colliding texts more distinct.`,
      );
    }
    const episodeIdToKey = new Map<string, string>();
    for (const ep of fixture.episodes) {
      const id = await appendEpisode(scope, ep.turnNumber, ep.summary, [], sink);
      episodeIdToKey.set(id, ep.key);
    }

    // Fused retrieval — the path under test.
    const fusedFactHits = await retrieveFactsFused(scope, fixture.queries, FACT_RETRIEVAL_LIMIT, sink);
    const fusedEpisodeHits = await retrieveEpisodesFused(scope, fixture.queries, EPISODE_RETRIEVAL_LIMIT, sink);
    const fused = mapHits(fusedFactHits, fusedEpisodeHits, factIdToKey, episodeIdToKey);

    // Joined baseline — all queries as ONE query string.
    const joinedQuery = fixture.queries.join("\n");
    const joinedFactHits = await retrieveFacts(scope, joinedQuery, FACT_RETRIEVAL_LIMIT, sink);
    const joinedEpisodeHits = await retrieveEpisodes(scope, joinedQuery, { sink });
    const joined = mapHits(joinedFactHits, joinedEpisodeHits, factIdToKey, episodeIdToKey);

    const scoreMatrix = await buildScoreMatrix(fixture);

    const fusedRecall = recallOf(fixture, fused.retrievedKeys);
    const joinedRecall = recallOf(fixture, joined.retrievedKeys);
    const relevantRetrieved = fixture.expectRelevant.filter((k) => fused.retrievedKeys.has(k)).length;
    const precision = fused.retrievedKeys.size === 0 ? 1 : relevantRetrieved / fused.retrievedKeys.size;
    const misses = fixture.expectRelevant.filter((k) => !fused.retrievedKeys.has(k));
    const distractorsPassed = fixture.expectExcluded
      .filter((k) => fused.retrievedKeys.has(k))
      .map((key) => ({ key, reason: exclusionReason(fixture, key) }));
    const pinnedKeys = fixture.facts.filter((f) => f.pinned).map((f) => f.key);
    const pinnedIncluded = pinnedKeys.length === 0 ? null : pinnedKeys.every((k) => fused.retrievedKeys.has(k));

    return {
      ...base,
      seeded: {
        facts: added.insertedIds.length,
        episodes: fixture.episodes.length,
        supersededDuringSeed: added.supersededIds.length,
      },
      fused: {
        hits: fused.hits,
        recall: round(fusedRecall),
        precision: round(precision),
        misses,
        distractorsPassed,
        pinnedIncluded,
      },
      joined: { hits: joined.hits, recall: round(joinedRecall) },
      recallDelta: round(fusedRecall - joinedRecall),
      scoreMatrix,
      diagnostics: sink.items,
    };
  } catch (err) {
    return {
      ...base,
      seeded: { facts: 0, episodes: 0, supersededDuringSeed: 0 },
      fused: { hits: [], recall: 0, precision: 0, misses: [...fixture.expectRelevant], distractorsPassed: [], pinnedIncluded: null },
      joined: { hits: [], recall: 0 },
      recallDelta: 0,
      scoreMatrix: [],
      diagnostics: sink.items,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    // ALWAYS purge the throwaway scope — pass or fail.
    try {
      await deleteFactsForScope(scope);
      await deleteEpisodesForScope(scope);
    } catch (err) {
      console.error(`  [${fixture.id}] cleanup FAILED for memory group ${groupId}:`, err);
    }
  }
}

function pad(value: string | number, width: number): string {
  return String(value).padEnd(width);
}

function printTable(results: readonly FixtureResult[]): void {
  const header = [
    pad("fixture", 24),
    pad("facts", 6),
    pad("eps", 4),
    pad("fusedR", 7),
    pad("prec", 6),
    pad("joinR", 6),
    pad("Δrec", 6),
    pad("floor✗", 7),
    pad("pinned", 7),
    "notes",
  ].join(" ");
  console.log(`\n${header}`);
  console.log("-".repeat(header.length + 8));
  for (const r of results) {
    if (r.error) {
      console.log(`${pad(r.id, 24)} ERROR: ${r.error}`);
      continue;
    }
    const delta = r.recallDelta >= 0 ? `+${r.recallDelta.toFixed(2)}` : r.recallDelta.toFixed(2);
    const notes = [
      r.fused.misses.length > 0 ? `missed ${r.fused.misses.join(",")}` : "",
      r.fused.distractorsPassed.length > 0
        ? `LEAKED ${r.fused.distractorsPassed.map((d) => `${d.key}(${d.reason})`).join(",")}`
        : "",
    ]
      .filter(Boolean)
      .join("; ");
    console.log(
      [
        pad(r.id, 24),
        pad(r.seeded.facts, 6),
        pad(r.seeded.episodes, 4),
        pad(r.fused.recall.toFixed(2), 7),
        pad(r.fused.precision.toFixed(2), 6),
        pad(r.joined.recall.toFixed(2), 6),
        pad(delta, 6),
        pad(r.fused.distractorsPassed.length, 7),
        pad(r.fused.pinnedIncluded === null ? "-" : r.fused.pinnedIncluded ? "yes" : "NO", 7),
        notes,
      ].join(" "),
    );
  }
}

function printDryRun(fixtures: readonly RetrievalFixture[]): void {
  for (const f of fixtures) {
    console.log(`\n${"=".repeat(80)}\n### ${f.id} — ${f.title}\n    covers: ${f.covers}\n${"=".repeat(80)}`);
    console.log(`facts (${f.facts.length}):`);
    for (const fact of f.facts) {
      console.log(`  [${fact.key}]${fact.pinned ? " (pinned)" : ""} ${fact.subjectName}: ${fact.text}`);
    }
    const cutoff = episodeCutoff(f);
    console.log(`episodes (${f.episodes.length})${cutoff === null ? "" : ` — RAG cutoff: turn ≤ ${cutoff}`}:`);
    for (const ep of f.episodes) {
      const windowed = cutoff !== null && ep.turnNumber > cutoff ? " (in recency window — excluded from RAG)" : "";
      console.log(`  [${ep.key}] turn ${ep.turnNumber}${windowed}: ${ep.summary}`);
    }
    console.log(`queries: ${f.queries.map((q) => JSON.stringify(q)).join(" · ")}`);
    console.log(`expectRelevant: ${f.expectRelevant.join(", ")}`);
    console.log(`expectExcluded: ${f.expectExcluded.join(", ")}`);
  }
  console.log(
    `\n[dry-run] would seed each fixture into a throwaway chat memory group (prefix "eval-retrieval-"), run fused + joined-baseline retrieval, score, and delete the scope. No DB touched.`,
  );
}

function pseudoBanner(): void {
  console.log(`\n${"!".repeat(80)}`);
  console.log("!! PSEUDO-EMBEDDINGS (demo mode: no OPENROUTER_API_KEY, or AI_FAKE=1).");
  console.log("!! Hash-based vectors make similarity NOISE — recall/precision/floor numbers");
  console.log("!! below are MEANINGLESS. This run is a structural smoke test only (seeding,");
  console.log("!! pinned force-include, recency window, cleanup). Set OPENROUTER_API_KEY");
  console.log("!! for a real measurement.");
  console.log("!".repeat(80));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.fixtures.length === 0) {
    console.error(`no fixture id matches; known ids: ${RETRIEVAL_FIXTURES.map((f) => f.id).join(", ")}`);
    process.exit(1);
  }
  console.log(
    `retrieval eval — ${args.fixtures.length}/${RETRIEVAL_FIXTURES.length} fixtures${args.dryRun ? " [dry-run]" : ""} ` +
      `(FACT_MIN_SCORE=${FACT_MIN_SCORE}, EPISODE_MIN_SCORE=${EPISODE_MIN_SCORE}, RRF_K=${RRF_K}, ` +
      `factLimit=${FACT_RETRIEVAL_LIMIT}, episodeLimit=${EPISODE_RETRIEVAL_LIMIT}, window=${EPISODE_WINDOW})`,
  );

  if (args.dryRun) {
    printDryRun(args.fixtures);
    return;
  }

  if (!process.env.DATABASE_URL) {
    console.error(
      "DATABASE_URL is not set — the retrieval eval seeds and reads a real Postgres (throwaway scopes, always cleaned up). Set it in .env or the environment, or use --dry-run to inspect the fixtures.",
    );
    process.exit(1);
  }

  const pseudo = isDemoMode();
  if (pseudo) pseudoBanner();
  console.log(`embedder: ${currentEmbedder()}`);

  const results: FixtureResult[] = [];
  for (const fixture of args.fixtures) {
    process.stdout.write(`running ${fixture.id} …`);
    const result = await evalFixture(fixture);
    results.push(result);
    if (result.error) process.stdout.write(` ERROR: ${result.error}\n`);
    else
      process.stdout.write(
        ` recall ${result.fused.recall.toFixed(2)} (joined ${result.joined.recall.toFixed(2)}), floor✗ ${result.fused.distractorsPassed.length}\n`,
      );
  }

  printTable(results);

  const ok = results.filter((r) => !r.error);
  const mean = (xs: number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);
  const summary = {
    fixtures: results.length,
    errors: results.length - ok.length,
    meanFusedRecall: round(mean(ok.map((r) => r.fused.recall))),
    meanJoinedRecall: round(mean(ok.map((r) => r.joined.recall))),
    meanRecallDelta: round(mean(ok.map((r) => r.recallDelta))),
    meanPrecision: round(mean(ok.map((r) => r.fused.precision))),
    totalDistractorsPassed: ok.reduce((n, r) => n + r.fused.distractorsPassed.length, 0),
    pinnedAllIncluded: ok.every((r) => r.fused.pinnedIncluded !== false),
  };
  console.log(
    `\nsummary: fused recall ${summary.meanFusedRecall.toFixed(2)} vs joined ${summary.meanJoinedRecall.toFixed(2)} ` +
      `(Δ ${summary.meanRecallDelta >= 0 ? "+" : ""}${summary.meanRecallDelta.toFixed(2)}) · precision ${summary.meanPrecision.toFixed(2)} · ` +
      `floor failures ${summary.totalDistractorsPassed} · pinned force-include ${summary.pinnedAllIncluded ? "OK" : "FAILED"}` +
      `${summary.errors > 0 ? ` · ${summary.errors} fixture error(s)` : ""}`,
  );

  const warnings = results.flatMap((r) => r.diagnostics.filter((d) => d.severity !== "info"));
  for (const d of warnings) console.log(`  diagnostic [${d.severity}] ${d.code}: ${d.message}`);

  await fs.mkdir(OUT, { recursive: true });
  const outPath = path.join(OUT, "results.json");
  await fs.writeFile(
    outPath,
    `${JSON.stringify(
      {
        ranAt: new Date().toISOString(),
        embedder: currentEmbedder(),
        pseudoEmbeddings: pseudo,
        ...(pseudo ? { caveat: "pseudo-embeddings — structural smoke only; similarity numbers are noise" } : {}),
        constants: {
          factMinScore: FACT_MIN_SCORE,
          episodeMinScore: EPISODE_MIN_SCORE,
          rrfK: RRF_K,
          factRetrievalLimit: FACT_RETRIEVAL_LIMIT,
          episodeRetrievalLimit: EPISODE_RETRIEVAL_LIMIT,
          episodeWindow: EPISODE_WINDOW,
        },
        summary,
        fixtures: results,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`\nwrote ${results.length} fixture results → ${outPath}`);
  if (pseudo) console.log('NOTE: results are labeled "pseudo-embeddings — structural smoke only".');
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
