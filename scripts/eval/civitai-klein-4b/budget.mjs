#!/usr/bin/env node
/**
 * Sum the what-if quotes recorded in summaries/phase-*.json into a budget
 * table per phase, per test, and per §26 "highest-value" tranche.
 *
 *   node scripts/eval/civitai-klein-4b/budget.mjs [--out eval-images/civitai-klein-4b]
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DEFAULT_OUT_DIR } from "./lib/env.mjs";

const outDir = path.resolve(process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1] : DEFAULT_OUT_DIR);
const summariesDir = path.join(outDir, "summaries");

/** §26 highest-value execution order, expressed as test ids per tranche. */
const TRANCHES = [
  { name: "T1 — determinism, no-ref baseline, R1/R3/[R1,R3], order reversal, step + cfg sweeps", tests: ["T1.0", "T1.1", "T1.2", "T1.3", "T2.1", "T2.2", "T2.3", "T2.4", "T3.1", "T3.2"] },
  { name: "T2 — LoRA on/off (L1, L2, L3), pairs, full stack, map-order reversal", tests: ["T4.0", "T4.L0", "T4.1", "T4.2", "T4.3", "T5.1", "T5.2", "T5.3", "T5.4", "T5.5"] },
  { name: "T3 — 4b-base baseline + best compatible LoRA, native edit vs createVariant", tests: ["T6.1", "T6.5", "T6.7", "T7.1", "T7.2"] },
  { name: "T4 — everything else before Phase 10", tests: ["T2.5", "T2.6", "T2.7", "T2.8", "T2.9", "T3.3", "T3.4", "T3.5", "T3.6", "T3.7", "T3.8", "T3.9", "T3.10", "T4.5", "T5.6", "T5.7", "T5.8", "T6.2", "T6.3", "T6.4", "T6.6", "T7.3", "T7.4", "T7.5", "T8.1", "T8.2", "T8.3", "T8.4", "T8.5", "T9", "T9.seeds"] },
  { name: "T5 — Phase 10 five-seed robustness matrix", tests: ["T10"] },
];

const phases = [];
for (const file of readdirSync(summariesDir).filter((f) => /^phase-\d+-.*\.json$/.test(f)).sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]))) {
  const summary = JSON.parse(readFileSync(path.join(summariesDir, file), "utf8"));
  const arms = summary.records ?? [];
  const paid = arms.filter((r) => r.mode === "paid");
  const quoted = paid.reduce((sum, r) => sum + (typeof r.whatif?.quotedBuzz === "number" ? r.whatif.quotedBuzz : 0), 0);
  const problems = arms.filter((r) => r.failure || r.whatif?.http !== 200 || r.echo?.missing || (r.echo?.dropped?.length ?? 0) > 0 || Object.keys(r.echo?.changed ?? {}).length > 0);
  const byTest = {};
  for (const r of paid) {
    byTest[r.test] ??= { arms: 0, buzz: 0 };
    byTest[r.test].arms += 1;
    byTest[r.test].buzz += r.whatif?.quotedBuzz ?? 0;
  }
  phases.push({ phase: summary.phase, title: summary.title, arms: arms.length, paidArms: paid.length, quoted, problems: problems.map((r) => `${r.arm}: ${r.failure ?? r.whatif?.problem ?? `http ${r.whatif?.http}; dropped ${r.echo?.dropped?.join(",")}; changed ${Object.keys(r.echo?.changed ?? {}).join(",")}`}`), byTest });
}

const lines = ["# Budget from what-if quotes", "", `Generated ${new Date().toISOString()} from ${summariesDir}.`, "", "## Per phase", "", "| Phase | Arms | Paid arms | Quoted Buzz | Problems |", "| --- | ---: | ---: | ---: | ---: |"];
let totalArms = 0;
let totalBuzz = 0;
for (const p of phases) {
  lines.push(`| ${p.phase} | ${p.arms} | ${p.paidArms} | ${p.quoted} | ${p.problems.length} |`);
  totalArms += p.paidArms;
  totalBuzz += p.quoted;
}
lines.push(`| **total** | | **${totalArms}** | **${totalBuzz}** | |`, "", "## Per test", "", "| Phase | Test | Arms | Quoted Buzz |", "| --- | --- | ---: | ---: |");
const testTotals = {};
for (const p of phases) for (const [test, v] of Object.entries(p.byTest)) {
  lines.push(`| ${p.phase} | ${test} | ${v.arms} | ${v.buzz} |`);
  testTotals[test] = v;
}
lines.push("", "## §26 tranches (cumulative)", "", "| Tranche | Arms | Quoted Buzz | Cumulative Buzz |", "| --- | ---: | ---: | ---: |");
let cumulative = 0;
for (const tranche of TRANCHES) {
  const arms = tranche.tests.reduce((sum, t) => sum + (testTotals[t]?.arms ?? 0), 0);
  const buzz = tranche.tests.reduce((sum, t) => sum + (testTotals[t]?.buzz ?? 0), 0);
  cumulative += buzz;
  lines.push(`| ${tranche.name} | ${arms} | ${buzz} | ${cumulative} |`);
}
const covered = new Set(TRANCHES.flatMap((t) => t.tests));
const uncovered = Object.keys(testTotals).filter((t) => !covered.has(t));
if (uncovered.length) lines.push("", `Tests not in any tranche: ${uncovered.join(", ")}`);
const problems = phases.flatMap((p) => p.problems.map((x) => `- ${p.phase} ${x}`));
lines.push("", "## Arms with a what-if problem or an inexact echo", "", ...(problems.length ? problems : ["none"]));
const text = `${lines.join("\n")}\n`;
if (existsSync(summariesDir)) writeFileSync(path.join(summariesDir, "budget.md"), text);
process.stdout.write(text);
