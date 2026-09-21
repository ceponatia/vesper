#!/usr/bin/env node
/**
 * Human-readable ledger for the evaluation: spend from ledger.json (the
 * machine file the spend caps read — keep it), every executed paid arm with
 * its workflow, timing and image, and the classification of every arm in
 * every manifest (COMPLETE_USABLE, COMPLETE_BUT_PROBLEMATIC, PENDING,
 * SUPERSEDED). Writes eval-images/civitai-klein-4b/ledger.md.
 *
 *   node scripts/eval/civitai-klein-4b/continuation.mjs
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DEFAULT_OUT_DIR, MANIFEST_DIR } from "./lib/env.mjs";

const outDir = DEFAULT_OUT_DIR;
const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const ledger = existsSync(path.join(outDir, "ledger.json")) ? readJson(path.join(outDir, "ledger.json")) : { entries: [] };

const manifests = readdirSync(MANIFEST_DIR)
  .filter((f) => /^(phase|gate)-.*\.json$/.test(f))
  .map((f) => readJson(path.join(MANIFEST_DIR, f)))
  .sort((a, b) => (a.phase.startsWith("gate") ? 1 : 0) - (b.phase.startsWith("gate") ? 1 : 0) || a.phase.localeCompare(b.phase, undefined, { numeric: true }));
const adaptive = manifests.filter((m) => m.plan === "adaptive-2026-09-17");
const adaptiveIds = new Set(adaptive.flatMap((m) => m.arms.map((a) => a.id)));

function armState(phase, arm) {
  const dir = path.join(outDir, "runs", phase, arm.id);
  const record = existsSync(path.join(dir, "record.json")) ? readJson(path.join(dir, "record.json")) : null;
  const output = existsSync(path.join(dir, "output.json")) ? readJson(path.join(dir, "output.json")) : null;
  const image = output?.outputs?.find((o) => o.file) ?? null;
  const imageExists = image ? existsSync(path.join(outDir, image.file)) : false;
  if ((arm.mode ?? "whatif") === "whatif") return { status: record?.whatif?.http === 200 ? "COMPLETE_USABLE" : record ? "COMPLETE_BUT_PROBLEMATIC" : "PENDING", record, output, image, imageExists };
  if (output) return { status: output.status === "succeeded" && imageExists ? "COMPLETE_USABLE" : "COMPLETE_BUT_PROBLEMATIC", record, output, image, imageExists };
  if (record?.paid?.submitted) return { status: "COMPLETE_BUT_PROBLEMATIC", record, output, image, imageExists, note: "submitted but no terminal output — reconcile" };
  if (phase.startsWith("gate-")) return { status: "PENDING", record, output, image, imageExists };
  return { status: adaptiveIds.has(arm.id) ? "PENDING" : "SUPERSEDED", record, output, image, imageExists };
}

const settled = ledger.entries.reduce((s, e) => s + (typeof e.settled === "number" ? e.settled : 0), 0);
const refunded = ledger.entries.reduce((s, e) => s + (typeof e.quoted === "number" && typeof e.settled === "number" ? Math.max(0, e.quoted - e.settled) : 0), 0);
const perPhase = {};
for (const e of ledger.entries) {
  perPhase[e.phase] ??= { runs: 0, quoted: 0, settled: 0 };
  perPhase[e.phase].runs += 1;
  perPhase[e.phase].quoted += e.quoted ?? 0;
  perPhase[e.phase].settled += e.settled ?? 0;
}

const lines = [
  "# Ledger — Civitai FLUX.2 Klein 4B qualification",
  "",
  `Generated ${new Date().toISOString()} by \`scripts/eval/civitai-klein-4b/continuation.mjs\` from \`ledger.json\` (the machine ledger the spend caps read) and the per-arm records under \`runs/\`.`,
  "",
  "## Spend",
  "",
  `Paid workflows: **${ledger.paidRuns ?? 0}** · quoted **${ledger.quotedBuzz ?? 0}** Buzz · settled **${settled}** Buzz · refunded ${refunded} Buzz · non-terminal entries: ${ledger.entries.filter((e) => e.settled === null).length}.`,
  "",
  "| Phase / gate | Paid runs | Quoted | Settled |",
  "| --- | ---: | ---: | ---: |",
  ...Object.entries(perPhase).map(([p, v]) => `| ${p} | ${v.runs} | ${v.quoted} | ${v.settled} |`),
  "",
  "## Executed paid arms",
  "",
  "| Phase | Arm | Recipe | Seed | Workflow | Status | Buzz | Wall s (queue / render) | Image |",
  "| --- | --- | --- | ---: | --- | --- | ---: | --- | --- |",
];
const counts = {};
const executed = [];
for (const m of manifests) for (const arm of m.arms) {
  const s = armState(m.phase, arm);
  counts[m.phase] ??= {};
  counts[m.phase][s.status] = (counts[m.phase][s.status] ?? 0) + 1;
  if (s.output) executed.push({ phase: m.phase, arm, s });
}
for (const { phase, arm, s } of executed) {
  const t = s.output.timing ?? {};
  const img = s.image ? `${s.image.file}${s.image.downloadedVia ? " (blob endpoint)" : ""}` : "—";
  lines.push(`| ${phase} | ${arm.id} | ${arm.recipe ?? ""} | ${arm.seed ?? ""} | ${s.output.workflowId ?? ""} | ${s.output.status}${s.status !== "COMPLETE_USABLE" ? ` (${s.status})` : ""} | ${s.output.settled?.net ?? ""} | ${t.wallSeconds ?? ""} (${t.queueSeconds ?? ""} / ${t.renderSeconds ?? ""}) | ${img} |`);
}
lines.push("", "## Classification of every manifest arm", "", "| Manifest | Usable | Problematic | Pending | Superseded |", "| --- | ---: | ---: | ---: | ---: |");
for (const m of manifests) {
  const c = counts[m.phase] ?? {};
  lines.push(`| ${m.phase}${m.plan === "adaptive-2026-09-17" ? " (adaptive)" : " (library)"} | ${c.COMPLETE_USABLE ?? 0} | ${c.COMPLETE_BUT_PROBLEMATIC ?? 0} | ${c.PENDING ?? 0} | ${c.SUPERSEDED ?? 0} |`);
}
lines.push("", "Library phases (phase-1 … phase-10) are the original 553-arm suite, quoted but superseded by the adaptive gates; phase-0 is the free capability table. Reused evidence per gate is listed in each gate manifest's `reuse` field.");
const problems = executed.filter(({ s }) => s.status !== "COMPLETE_USABLE");
lines.push("", "## Problematic executed arms", "", ...(problems.length ? problems.map(({ phase, arm, s }) => `- ${phase}/${arm.id}: ${s.output?.status ?? "?"} ${s.note ?? ""}`) : ["none"]));
writeFileSync(path.join(outDir, "ledger.md"), `${lines.join("\n")}\n`);
process.stdout.write(`ledger.md: ${executed.length} executed arms across ${manifests.length} manifests\n`);
