import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { isDemoMode } from "../../../src/server/ai";
import { CONTRAST_AXES, EVAL_SCENARIOS, type ContrastGroupId, type EvalScenario } from "./fixtures";
import {
  CANDIDATE_LABELS,
  JUDGE_DIMS,
  JUDGE_MODEL,
  judgeContrast,
  type CandidateLabel,
  type ContrastJudgement,
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
 *   pnpm eval:narration:compare --axis contrast       # blind-identify the §5 paired-contrast fixtures
 *   pnpm eval:narration:compare --limit 2 --dry-run   # inspect groups, no judge calls
 *
 * `--axis contrast` (character-chat-standalone.spec.md §5) pairs the `chat-contrast-*`
 * fixtures by their `contrast` metadata (group + flagged/control variant) within one
 * results.json, holding (model × profile × reasoning × seed) fixed. The blind judge
 * sees both replies unlabeled, must identify the flagged variant, and rates the
 * difference's visibility; the report scores identification accuracy per axis against
 * the ≥80% bar (below it the axis is declared NOT enacted) plus the deterministic
 * lexical-cue separation where the axis defines a cue list.
 *
 * Point EVAL_JUDGE_MODEL at a strong judge (e.g. google/gemini-3.5-pro) so it
 * out-classes the cast it scores.
 */

const MODEL_ALIASES: Record<string, string> = {
  "aion-labs/aion-2.0": "aion",
  "z-ai/glm-5.2": "glm",
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
  /** Replicate index (run.ts --seeds). Absent in pre-seed results files ⇒ treated as 0. */
  seed?: number;
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

type AxisName = "profile" | "reasoning" | "focus" | "contrast";
const ALL_AXES: AxisName[] = ["profile", "reasoning"]; // focus (needs --vs) and contrast are opt-in

/** Group key = everything that identifies a comparison EXCEPT the compared axis. */
function groupKeyFor(axis: AxisName, r: ResultRow): string {
  const seed = `s${r.seed ?? 0}`;
  switch (axis) {
    case "profile":
      return `${r.scenario}|${shortModel(r.model)}|${r.reasoning}|${seed}`;
    case "reasoning":
      return `${r.scenario}|${shortModel(r.model)}|${r.profile}|${seed}`;
    case "focus":
      return `${r.scenario}|${shortModel(r.model)}|${r.profile}|${r.reasoning}|${seed}`;
    case "contrast": {
      // Pair members are DIFFERENT scenarios sharing a contrast group — key on the group.
      const group = EVAL_SCENARIOS.find((s) => s.id === r.scenario)?.contrast?.group ?? "?";
      return `${group}|${shortModel(r.model)}|${r.profile}|${r.reasoning}|${seed}`;
    }
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

// ---------------------------------------------------------------------------
// Contrast axis — blind identification of the §5 paired fixtures.
// ---------------------------------------------------------------------------

interface ContrastPair {
  key: string;
  group: ContrastGroupId;
  /** The pair's shared player input (byte-identical across both variants). */
  playerInput: string;
  /** Exactly two, labeled A/B in the hash-shuffled order; `value` is "flagged" | "control". */
  candidates: GroupCandidate[];
}

interface ContrastSlot {
  group: ContrastGroupId;
  playerInput: string;
  variants: Partial<Record<"flagged" | "control", ResultRow>>;
}

/** Pair flagged vs control rows by contrast group within (model × profile × reasoning × seed). */
function buildContrastPairs(rows: ResultRow[]): ContrastPair[] {
  const byKey = new Map<string, ContrastSlot>();
  for (const r of rows.filter(isLive)) {
    const scenario = EVAL_SCENARIOS.find((s) => s.id === r.scenario);
    const contrast = scenario?.contrast;
    if (!scenario || !contrast) continue;
    const key = groupKeyFor("contrast", r);
    const slot = getOrInit(byKey, key, (): ContrastSlot => ({ group: contrast.group, playerInput: scenario.playerInput, variants: {} }));
    if (!slot.variants[contrast.variant]) slot.variants[contrast.variant] = r; // drop accidental dupes
  }
  const pairs: ContrastPair[] = [];
  for (const [key, slot] of byKey) {
    const flagged = slot.variants.flagged;
    const control = slot.variants.control;
    if (!flagged || !control) continue;
    const candidates = toCandidates(key, [
      ["flagged", flagged],
      ["control", control],
    ]);
    if (candidates.length === 2) pairs.push({ key, group: slot.group, playerInput: slot.playerInput, candidates });
  }
  return pairs;
}

/** The spec §5 acceptance bar: below this per-axis accuracy the axis is declared NOT enacted. */
const CONTRAST_BAR = 0.8;

interface ContrastAcc {
  pairs: number;
  identified: number;
  visSum: number;
  /** Pairs whose axis defines a lexical cue list. */
  cuePairs: number;
  /** …of those, pairs where the cue hit the flagged reply and NOT the control. */
  cueSeparated: number;
}
const emptyContrastAcc = (): ContrastAcc => ({ pairs: 0, identified: 0, visSum: 0, cuePairs: 0, cueSeparated: 0 });

interface ContrastVerdict {
  key: string;
  group: ContrastGroupId;
  candidates: Array<{ label: CandidateLabel; value: string; model: string }>;
  judgement: ContrastJudgement;
  correct: boolean;
  /** Lexical-cue hits (only when the axis defines a cue list). */
  flaggedCue?: boolean;
  controlCue?: boolean;
}

function printContrastTable(byGroup: Map<string, ContrastAcc>): void {
  console.log(
    `\n=== AXIS: contrast — blind pair identification, bar ≥${CONTRAST_BAR * 100}% correct per axis (judge: ${JUDGE_MODEL}) ===`,
  );
  console.log([pad("axis", 9), pad("pairs", 6), pad("correct", 8), pad("accuracy", 9), pad("bar", 5), pad("vis~", 5), "cueSep"].join(" "));
  for (const [group, a] of [...byGroup.entries()].sort((x, y) => x[0].localeCompare(y[0]))) {
    const pass = a.pairs === 0 ? "-" : a.identified / a.pairs >= CONTRAST_BAR ? "PASS" : "FAIL";
    console.log(
      [
        pad(group, 9),
        pad(a.pairs, 6),
        pad(a.identified, 8),
        pad(pct(a.identified, a.pairs), 9),
        pad(pass, 5),
        pad(a.pairs ? (a.visSum / a.pairs).toFixed(1) : "-", 5),
        a.cuePairs ? `${a.cueSeparated}/${a.cuePairs}` : "-",
      ].join(" "),
    );
  }
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

/** Per-model breakdown over a `model|value`-keyed accumulator map; `fmt` renders one cell. */
function printPerModel<T>(header: string, byModelValue: Map<string, T>, fmt: (acc: T) => string): void {
  console.log(header);
  const models = [...new Set([...byModelValue.keys()].map((k) => k.split("|")[0] ?? k))].sort();
  for (const m of models) {
    const parts = [...byModelValue.entries()]
      .filter(([k]) => k.startsWith(`${m}|`))
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([k, a]) => `${k.split("|")[1] ?? k}: ${fmt(a)}`);
    console.log(`  ${pad(m, 8)} ${parts.join("   ")}`);
  }
}

/**
 * The contrast axis end-to-end: pair, blind-judge, accumulate per axis + per model,
 * print the accuracy-vs-bar table. Returns null on dry-run (groups printed, no calls).
 */
async function runContrastAxis(
  rows: ResultRow[],
  args: CompareArgs,
): Promise<{ byGroup: Map<string, ContrastAcc>; verdicts: ContrastVerdict[] } | null> {
  let pairs = buildContrastPairs(rows);
  if (args.limit) pairs = pairs.slice(0, args.limit);
  console.log(`\naxis 'contrast': ${pairs.length} blind pairs (flagged vs control; ≥${CONTRAST_BAR * 100}% identification bar per axis)`);

  if (args.dryRun) {
    for (const p of pairs) console.log(`  ${pad(p.key, 40)} ${p.candidates.map((c) => `${c.label}=${c.value}`).join(" ")}`);
    return null;
  }

  const byGroup = new Map<string, ContrastAcc>();
  const byModelGroup = new Map<string, ContrastAcc>();
  const verdicts: ContrastVerdict[] = [];
  for (const p of pairs) {
    const axisSpec = CONTRAST_AXES[p.group];
    const a = p.candidates.find((c) => c.label === "A");
    const b = p.candidates.find((c) => c.label === "B");
    const flaggedCand = p.candidates.find((c) => c.value === "flagged");
    const controlCand = p.candidates.find((c) => c.value === "control");
    if (!a || !b || !flaggedCand || !controlCand) continue;
    process.stdout.write(`  judging ${p.key} …`);
    const judgement = await judgeContrast({
      playerInput: p.playerInput,
      flagged: axisSpec.flagged,
      control: axisSpec.control,
      a: a.narration,
      b: b.narration,
    });
    if (!judgement) {
      process.stdout.write(` (no verdict)\n`);
      continue;
    }
    const correct = judgement.flagged !== null && judgement.flagged === flaggedCand.label;
    const cueRe = axisSpec.cueRe;
    const flaggedCue = cueRe ? cueRe.test(flaggedCand.narration) : undefined;
    const controlCue = cueRe ? cueRe.test(controlCand.narration) : undefined;
    const accs = [getOrInit(byGroup, p.group, emptyContrastAcc), getOrInit(byModelGroup, `${flaggedCand.model}|${p.group}`, emptyContrastAcc)];
    for (const acc of accs) {
      acc.pairs += 1;
      if (correct) acc.identified += 1;
      acc.visSum += judgement.visibility;
      if (cueRe) {
        acc.cuePairs += 1;
        if (flaggedCue === true && controlCue === false) acc.cueSeparated += 1;
      }
    }
    verdicts.push({
      key: p.key,
      group: p.group,
      candidates: p.candidates.map((c) => ({ label: c.label, value: c.value, model: c.model })),
      judgement,
      correct,
      flaggedCue,
      controlCue,
    });
    process.stdout.write(` ${correct ? "correct" : judgement.flagged === null ? "unidentified" : "WRONG"} (vis ${judgement.visibility})\n`);
  }
  printContrastTable(byGroup);
  printPerModel(`\n--- contrast: per-model identification (correct / pairs) ---`, byModelGroup, (acc) => `${acc.identified}/${acc.pairs}`);
  return { byGroup, verdicts };
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
  let contrastResult: { byGroup: Map<string, ContrastAcc>; verdicts: ContrastVerdict[] } | null = null;

  for (const axis of args.axes) {
    if (axis === "contrast") {
      contrastResult = await runContrastAxis(rows, args);
      continue;
    }
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
    printPerModel(`\n--- ${axis}: per-model win-rate (wins / groups, Borda%) ---`, byModelValue, (a) => `${a.wins}/${a.groups} (${pct(a.borda, a.bordaMax)})`);
    summary[axis] = { byValue: Object.fromEntries(byValue), invalidOverall };
  }

  if (!args.dryRun) {
    await fs.mkdir(args.outDir, { recursive: true });
    const outPath = path.join(args.outDir, "comparison.json");
    const contrast = contrastResult
      ? { bar: CONTRAST_BAR, byGroup: Object.fromEntries(contrastResult.byGroup), verdicts: contrastResult.verdicts }
      : undefined;
    await fs.writeFile(outPath, `${JSON.stringify({ judge: JUDGE_MODEL, axes: args.axes, summary, contrast, verdicts }, null, 2)}\n`);
    console.log(`\nwrote ${verdicts.length + (contrastResult?.verdicts.length ?? 0)} group verdicts → ${outPath}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
