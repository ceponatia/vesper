import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { isDemoMode } from "../../../src/server/ai";
import { EVAL_SCENARIOS, type EvalScenario } from "./fixtures";
import {
  CANDIDATE_LABELS,
  JUDGE_DIMS,
  JUDGE_MODEL,
  type CandidateLabel,
  type JudgeDim,
  type Ranking,
  type RankCandidate,
  rankNarrations,
} from "./judge";

/**
 * Pairwise / ranking comparison over an existing narration-eval results.json
 * (narrator-prompt-focus.eval-results.md §Methodology follow-ups). Run 1's absolute
 * judge compressed to 4.4–5.0; a relative judge that ranks candidates which differ on
 * ONE axis discriminates far better. This **re-judges saved narrations** — no
 * regeneration — and reports per-axis win-rate + Borda + per-dimension wins.
 *
 *   pnpm eval:narration:compare                       # axes profile,reasoning over the default results.json
 *   pnpm eval:narration:compare --axis profile        # just the profile decision
 *   pnpm eval:narration:compare --axis focus --vs data/eval/narration/results-nofocus.json
 *   pnpm eval:narration:compare --limit 2 --dry-run   # inspect groups, no judge calls
 *
 * Point EVAL_JUDGE_MODEL at a strong judge (e.g. google/gemini-3.5-pro) so it
 * out-classes the cast it scores.
 */

const MODEL_ALIASES: Record<string, string> = {
  "aion-labs/aion-2.0": "aion",
  "z-ai/glm-5.2": "glm",
  "openrouter/owl-alpha": "owl",
  "deepseek/deepseek-v4-flash": "deepseek",
  "google/gemini-3.5-flash": "gemini",
};
const shortModel = (id: string): string => MODEL_ALIASES[id] ?? id;

interface CellMetrics {
  outputTokens: number;
}
interface ResultRow {
  scenario: string;
  lane: string;
  model: string;
  profile: string; // "concise" | "aggressive"
  reasoning: string; // "default" | "off" | "low"
  metrics: CellMetrics;
  narration: string;
  error?: string;
}

const isLive = (r: ResultRow): boolean => !r.error && r.narration.trim().length > 0 && r.metrics.outputTokens > 0;

/** Map get-or-create without a non-null assertion. */
function getOrInit<K, V>(m: Map<K, V>, k: K, init: () => V): V {
  const existing = m.get(k);
  if (existing !== undefined) return existing;
  const created = init();
  m.set(k, created);
  return created;
}

type AxisName = "profile" | "reasoning" | "focus";
const ALL_AXES: AxisName[] = ["profile", "reasoning"]; // focus needs --vs and is opt-in

/** Group key = everything that identifies a comparison EXCEPT the compared axis. */
function groupKeyFor(axis: AxisName, r: ResultRow): string {
  switch (axis) {
    case "profile":
      return `${r.scenario}|${shortModel(r.model)}|${r.reasoning}`;
    case "reasoning":
      return `${r.scenario}|${shortModel(r.model)}|${r.profile}`;
    case "focus":
      return `${r.scenario}|${shortModel(r.model)}|${r.profile}|${r.reasoning}`;
  }
}
const axisValueOf = (axis: AxisName, r: ResultRow): string => (axis === "profile" ? r.profile : axis === "reasoning" ? r.reasoning : "");

// FNV-1a — a stable, varied label order so the same axis value is not always "A".
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

interface GroupCandidate extends RankCandidate {
  value: string; // axis value (concise / default / focus-on …)
  model: string; // short model
}
interface Group {
  key: string;
  scenarioId: string;
  scenario: EvalScenario;
  candidates: GroupCandidate[];
}

/** Assign A/B/C labels to the value→row pairs in a stable, position-varied order. */
function toCandidates(key: string, pairs: Array<[string, ResultRow]>): GroupCandidate[] {
  const ordered = [...pairs].sort((a, b) => hash(`${key}::${a[0]}`) - hash(`${key}::${b[0]}`)).slice(0, CANDIDATE_LABELS.length);
  const candidates: GroupCandidate[] = [];
  ordered.forEach(([value, row], i) => {
    const label = CANDIDATE_LABELS[i];
    if (label) candidates.push({ label, narration: row.narration, value, model: shortModel(row.model) });
  });
  return candidates;
}

/** Build comparison groups from a flat row list, holding all axes fixed but `axis`. */
function buildGroups(axis: AxisName, rows: ResultRow[]): Group[] {
  const byKey = new Map<string, ResultRow[]>();
  for (const r of rows.filter(isLive)) getOrInit(byKey, groupKeyFor(axis, r), () => []).push(r);

  const groups: Group[] = [];
  for (const [key, members] of byKey) {
    const sample = members[0];
    if (!sample) continue;
    // one candidate per distinct axis value (drop accidental dupes), need ≥2 to compare
    const byValue = new Map<string, ResultRow>();
    for (const m of members) if (!byValue.has(axisValueOf(axis, m))) byValue.set(axisValueOf(axis, m), m);
    if (byValue.size < 2) continue;
    const scenario = EVAL_SCENARIOS.find((s) => s.id === sample.scenario);
    if (!scenario) continue;
    const candidates = toCandidates(key, [...byValue.entries()]);
    if (candidates.length >= 2) groups.push({ key, scenarioId: sample.scenario, scenario, candidates });
  }
  return groups;
}

/** Pair a focus-on file against a focus-off file by (scenario, model, profile, reasoning). */
function buildFocusGroups(on: ResultRow[], off: ResultRow[]): Group[] {
  const offByKey = new Map(off.filter(isLive).map((r) => [groupKeyFor("focus", r), r]));
  const groups: Group[] = [];
  for (const r of on.filter(isLive)) {
    const key = groupKeyFor("focus", r);
    const offRow = offByKey.get(key);
    if (!offRow) continue;
    const scenario = EVAL_SCENARIOS.find((s) => s.id === r.scenario);
    if (!scenario) continue;
    const candidates = toCandidates(key, [
      ["focus-on", r],
      ["focus-off", offRow],
    ]);
    if (candidates.length >= 2) groups.push({ key, scenarioId: r.scenario, scenario, candidates });
  }
  return groups;
}

interface Acc {
  groups: number;
  wins: number;
  borda: number;
  bordaMax: number;
  dimWins: Record<JudgeDim, number>;
}
const emptyAcc = (): Acc => ({ groups: 0, wins: 0, borda: 0, bordaMax: 0, dimWins: { answeredFirst: 0, proportionate: 0, onBeat: 0, noUnrequestedLogistics: 0, voice: 0 } });

interface GroupVerdict {
  axis: AxisName;
  key: string;
  scenario: string;
  candidates: Array<{ label: CandidateLabel; value: string; model: string }>;
  ranking: Ranking;
}

/** Fold one ranking into the per-value accumulators. Returns whether `overall` was usable. */
function accumulate(group: Group, ranking: Ranking, byValue: Map<string, Acc>, byModelValue: Map<string, Acc>): boolean {
  const valueOf = new Map(group.candidates.map((c) => [c.label, c.value]));
  const n = group.candidates.length;
  const labels = group.candidates.map((c) => c.label);
  const overallValid = ranking.overall.length === n && new Set(ranking.overall).size === n && ranking.overall.every((l) => labels.includes(l));

  for (const c of group.candidates) {
    const acc = getOrInit(byValue, c.value, emptyAcc);
    const macc = getOrInit(byModelValue, `${c.model}|${c.value}`, emptyAcc);
    acc.groups += 1;
    macc.groups += 1;
    if (overallValid) {
      const rank = ranking.overall.indexOf(c.label); // 0 = best
      acc.borda += n - 1 - rank;
      acc.bordaMax += n - 1;
      macc.borda += n - 1 - rank;
      macc.bordaMax += n - 1;
      if (rank === 0) {
        acc.wins += 1;
        macc.wins += 1;
      }
    }
  }
  for (const dim of JUDGE_DIMS) {
    const winner = ranking.dimWinners[dim];
    if (winner === "tie") continue;
    const value = valueOf.get(winner);
    if (!value) continue;
    const acc = byValue.get(value);
    if (acc) acc.dimWins[dim] += 1;
  }
  return overallValid;
}

function pad(v: string | number, w: number): string {
  return String(v).padEnd(w);
}
const pct = (num: number, den: number): string => (den === 0 ? "  -  " : `${((num / den) * 100).toFixed(0)}%`);

function printAxisTable(axis: AxisName, byValue: Map<string, Acc>): void {
  console.log(`\n=== AXIS: ${axis} — win-rate + Borda + per-dimension wins (sharper pairwise judge: ${JUDGE_MODEL}) ===`);
  console.log([pad("value", 12), pad("groups", 7), pad("winRate", 8), pad("borda%", 7), ...JUDGE_DIMS.map((d) => pad(d.slice(0, 7), 8))].join(" "));
  for (const [v, a] of [...byValue.entries()].sort((x, y) => x[0].localeCompare(y[0]))) {
    console.log(
      [pad(v, 12), pad(a.groups, 7), pad(pct(a.wins, a.groups), 8), pad(pct(a.borda, a.bordaMax), 7), ...JUDGE_DIMS.map((d) => pad(a.dimWins[d], 8))].join(" "),
    );
  }
}

function printPerModel(axis: AxisName, byModelValue: Map<string, Acc>): void {
  console.log(`\n--- ${axis}: per-model win-rate (wins / groups, Borda%) ---`);
  const models = [...new Set([...byModelValue.keys()].map((k) => k.split("|")[0] ?? k))].sort();
  for (const m of models) {
    const parts = [...byModelValue.entries()]
      .filter(([k]) => k.startsWith(`${m}|`))
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([k, a]) => `${k.split("|")[1] ?? k}: ${a.wins}/${a.groups} (${pct(a.borda, a.bordaMax)})`);
    console.log(`  ${pad(m, 8)} ${parts.join("   ")}`);
  }
}

interface CompareArgs {
  axes: AxisName[];
  inPath: string;
  vsPath?: string;
  outDir: string;
  limit?: number;
  dryRun: boolean;
}

function parseArgs(argv: string[]): CompareArgs {
  const flags = new Map<string, string>();
  const bools = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const tok = argv[i];
    if (!tok?.startsWith("--")) continue;
    const key = tok.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      flags.set(key, next);
      i += 1;
    } else bools.add(key);
  }
  const axes = (flags.get("axis")?.split(",").map((s) => s.trim()) as AxisName[] | undefined) ?? ALL_AXES;
  const limitRaw = flags.get("limit");
  return {
    axes,
    inPath: flags.get("in") ?? "data/eval/narration/results.json",
    vsPath: flags.get("vs"),
    outDir: flags.get("out") ?? "data/eval/narration",
    limit: limitRaw ? Number(limitRaw) : undefined,
    dryRun: bools.has("dry-run"),
  };
}

async function loadRows(p: string): Promise<ResultRow[]> {
  const parsed = JSON.parse(await fs.readFile(p, "utf8")) as { rows: ResultRow[] };
  return parsed.rows;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.dryRun && isDemoMode()) {
    console.error("OPENROUTER_API_KEY is not set (demo mode). Set it to re-judge live, or use --dry-run to inspect groups.");
    process.exit(1);
  }
  const rows = await loadRows(args.inPath);
  console.log(`loaded ${rows.length} rows (${rows.filter(isLive).length} live) from ${args.inPath}`);

  const verdicts: GroupVerdict[] = [];
  const summary: Record<string, { byValue: Record<string, Acc>; invalidOverall: number }> = {};

  for (const axis of args.axes) {
    let groups: Group[];
    if (axis === "focus") {
      if (!args.vsPath) {
        console.error(`--axis focus needs --vs <focus-off results.json> (a --no-focus run). Skipping.`);
        continue;
      }
      groups = buildFocusGroups(rows, await loadRows(args.vsPath));
    } else {
      groups = buildGroups(axis, rows);
    }
    if (args.limit) groups = groups.slice(0, args.limit);
    console.log(`\naxis '${axis}': ${groups.length} comparison groups (${groups.reduce((n, g) => n + g.candidates.length, 0)} candidates)`);

    if (args.dryRun) {
      for (const g of groups) console.log(`  ${pad(g.key, 40)} ${g.candidates.map((c) => `${c.label}=${c.value}`).join(" ")}`);
      continue;
    }

    const byValue = new Map<string, Acc>();
    const byModelValue = new Map<string, Acc>();
    let invalidOverall = 0;
    for (const g of groups) {
      process.stdout.write(`  ranking ${g.key} …`);
      const ranking = await rankNarrations(g.scenario, g.candidates);
      if (!ranking) {
        process.stdout.write(` (no verdict)\n`);
        continue;
      }
      if (!accumulate(g, ranking, byValue, byModelValue)) invalidOverall += 1;
      verdicts.push({ axis, key: g.key, scenario: g.scenarioId, candidates: g.candidates.map((c) => ({ label: c.label, value: c.value, model: c.model })), ranking });
      process.stdout.write(` ${ranking.overall.map((l) => g.candidates.find((c) => c.label === l)?.value).join(" > ")}\n`);
    }
    if (invalidOverall) console.log(`  (${invalidOverall} group(s) returned an unusable overall ordering — counted for dimension wins only)`);
    printAxisTable(axis, byValue);
    printPerModel(axis, byModelValue);
    summary[axis] = { byValue: Object.fromEntries(byValue), invalidOverall };
  }

  if (!args.dryRun) {
    await fs.mkdir(args.outDir, { recursive: true });
    const outPath = path.join(args.outDir, "comparison.json");
    await fs.writeFile(outPath, `${JSON.stringify({ judge: JUDGE_MODEL, axes: args.axes, summary, verdicts }, null, 2)}\n`);
    console.log(`\nwrote ${verdicts.length} group verdicts → ${outPath}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
