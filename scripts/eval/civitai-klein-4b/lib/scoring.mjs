import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const SCORE_COLUMNS = ["identity", "anatomy", "pose", "object", "adherence", "quality", "mixing"];
export const HARD_FLAGS = [
  "extra_arm", "extra_leg", "extra_hand", "missing_limb", "duplicate_head", "fused_people", "severe_hand_failure",
  "identity_lost", "pose_wrong", "object_contact_wrong", "reference_identity_blend", "unwanted_nudity",
  "unexpected_clothing_change", "provider_block", "provider_unknown_failure",
];
const HEADER = ["phase", "arm", "test", "recipe", "seed", "output", "sha12", ...SCORE_COLUMNS, "flags", "notes"];

function csvEscape(value) {
  const text = value === undefined || value === null ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csvParseLine(line) {
  const out = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { field += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { out.push(field); field = ""; }
    else field += ch;
  }
  out.push(field);
  return out;
}

/**
 * Append rows for freshly delivered outputs to the phase's score sheet
 * without disturbing rows the grader already filled in.
 */
export function upsertScoreTemplate(outDir, phase, rows) {
  const dir = path.join(outDir, "scores");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${phase}.csv`);
  const existing = existsSync(file) ? readCsv(file) : [];
  const seen = new Set(existing.map((row) => row.output));
  const merged = [...existing];
  for (const row of rows) {
    if (seen.has(row.output)) continue;
    merged.push({ ...Object.fromEntries(HEADER.map((h) => [h, ""])), ...row });
  }
  const lines = [HEADER.join(","), ...merged.map((row) => HEADER.map((h) => csvEscape(row[h])).join(","))];
  writeFileSync(file, `${lines.join("\n")}\n`);
  return file;
}

/**
 * Repoint graded rows at the archived copy of a render that a rerun
 * superseded. The grades in a row describe specific bytes (`sha12`), so when
 * those bytes move out of the live output path the row moves with them; the
 * rerun's fresh bytes then get their own ungraded row at the live path
 * instead of inheriting the previous attempt's scores.
 */
export function repointScoreRows(outDir, phase, moves) {
  const file = path.join(outDir, "scores", `${phase}.csv`);
  if (!existsSync(file) || moves.length === 0) return null;
  const byFrom = new Map(moves.map((move) => [move.from, move.to]));
  const rows = readCsv(file);
  let changed = 0;
  for (const row of rows) {
    const to = byFrom.get(row.output);
    if (to === undefined) continue;
    row.output = to;
    changed += 1;
  }
  if (changed === 0) return null;
  const lines = [HEADER.join(","), ...rows.map((row) => HEADER.map((h) => csvEscape(row[h])).join(","))];
  writeFileSync(file, `${lines.join("\n")}\n`);
  return { file, rows: changed };
}

export function readCsv(file) {
  const lines = readFileSync(file, "utf8").split(/\r?\n/).filter((line) => line.trim() !== "");
  if (lines.length === 0) return [];
  const header = csvParseLine(lines[0]);
  return lines.slice(1).map((line) => {
    const cells = csvParseLine(line);
    return Object.fromEntries(header.map((h, i) => [h, cells[i] ?? ""]));
  });
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Aggregate graded rows per recipe against the RESULTS.md continuation gates.
 * Only rows with a numeric score in a column count toward that column.
 */
export function aggregateScores(rows) {
  const byRecipe = new Map();
  for (const row of rows) {
    const recipe = row.recipe || "(unlabelled)";
    if (!byRecipe.has(recipe)) byRecipe.set(recipe, []);
    byRecipe.get(recipe).push(row);
  }
  const summary = {};
  for (const [recipe, group] of byRecipe) {
    // Blank cells are ungraded, not zero: `Number("")` is 0, so filter the empties first.
    const numeric = (column) => group.map((row) => String(row[column] ?? "").trim()).filter((text) => text !== "").map(Number).filter((value) => Number.isFinite(value) && row_ok(value));
    const identity = numeric("identity");
    const anatomy = numeric("anatomy");
    const pose = numeric("pose");
    const object = numeric("object");
    const flagCounts = {};
    for (const row of group) {
      for (const flag of String(row.flags ?? "").split(/[;|\s]+/).filter(Boolean)) flagCounts[flag] = (flagCounts[flag] ?? 0) + 1;
    }
    const catastrophic = anatomy.filter((value) => value === 0).length;
    summary[recipe] = {
      graded: group.filter((row) => SCORE_COLUMNS.some((c) => row[c] !== "")).length,
      total: group.length,
      identity: { median: median(identity), shareAtLeast3: share(identity, 3) },
      anatomy: { median: median(anatomy), shareAtLeast3: share(anatomy, 3), catastrophicShare: anatomy.length ? catastrophic / anatomy.length : null },
      pose: { median: median(pose) },
      object: { median: median(object) },
      flagCounts,
      gates: {
        identityMedianAtLeast3: median(identity) !== null && median(identity) >= 3,
        identityShareAtLeast80: share(identity, 3) !== null && share(identity, 3) >= 0.8,
        anatomyShareAtLeast90: share(anatomy, 3) !== null && share(anatomy, 3) >= 0.9,
        anatomyCatastrophicAtMost5: anatomy.length > 0 && catastrophic / anatomy.length <= 0.05,
        poseMedianAtLeast3: median(pose) !== null && median(pose) >= 3,
        objectMedianAtLeast3: median(object) !== null && median(object) >= 3,
      },
    };
  }
  return summary;
}

function row_ok(value) {
  return value >= 0 && value <= 4;
}

function share(values, threshold) {
  if (values.length === 0) return null;
  return values.filter((value) => value >= threshold).length / values.length;
}
