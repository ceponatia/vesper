#!/usr/bin/env node
/**
 * Offline self-test for the harness's pure decisions. It imports no
 * application code, starts no service, makes no external call and writes
 * nothing outside a temporary directory, so it can be run anywhere:
 *
 *   node scripts/eval/civitai-klein-4b/selftest.mjs
 *
 * It covers the two rules that are expensive to get wrong — what the default
 * share bundle treats as adult, and what the spend gates treat as a quote —
 * against the committed manifests themselves. (Vitest collects only
 * `scripts/**\/*.test.ts`, so this is not part of CI.)
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAdultClassifier } from "./lib/adult.mjs";
import { preflightVerdict } from "./lib/manifest.mjs";

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  process.stdout.write(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}\n`);
}

// ---------------------------------------------------------------- adult classification
{
  const { render, sheet, unclassified } = createAdultClassifier(mkdtempSync(path.join(tmpdir(), "klein-selftest-")));

  // The nude arm inside an SFW LoRA phase: nothing in the phase or the file
  // name says "adult" — only the manifest's prompt key does.
  check("render phase-4-loras/T4.L0-A1.jpg is adult", render("phase-4-loras", "T4.L0-A1.jpg"), true);
  check("render phase-4-loras/T4.0-canary-A.jpg is not adult", render("phase-4-loras", "T4.0-canary-A.jpg"), false);
  check("render gate-8-adult-solo arm is adult", render("gate-8-adult-solo", "G8-L1-424242.jpg"), true);
  check("render gate-1-distilled arm is not adult", render("gate-1-distilled", "T2.3-P2-424242.jpg"), false);
  // Multi-image workflows suffix the arm id; seeds in an id must survive it.
  check("render gate-10 pose-source arm keeps its seed", render("gate-10-adult-scenes", "G10-S2P-standing-edit3ref-424242.jpg"), true);

  // A contact sheet of a mixed test is adult if any arm on it is.
  check("sheet phase-4-loras-T4.1 is adult", sheet("phase-4-loras-T4.1"), true);
  check("sheet phase-4-loras-T4.0 is not adult", sheet("phase-4-loras-T4.0"), false);
  check("sheet gate-6-adult-G6.A1 is adult", sheet("gate-6-adult-G6.A1"), true);
  check("classified everything so far", unclassified, []);

  // Anything the manifests cannot place is refused, not published.
  check("unknown render is unclassified", render("phase-4-loras", "handmade-crop.jpg"), null);
  check("unknown sheet is unclassified", sheet("scratch-comparison"), null);
  check("both refusals were recorded", unclassified.length, 2);
}

// ---------------------------------------------------------------- what counts as a quote
{
  const verdict = (body) => preflightVerdict({ ok: true, status: 200, body });
  check("cost.total is the quote", verdict({ cost: { total: 12 }, transactions: { insufficientBuzz: false } }).quotedBuzz, 12);
  check("debit rows are summed", verdict({ transactions: { insufficientBuzz: false, list: [{ type: "debit", amount: 7 }, { type: "credit", amount: 3 }] } }).quotedBuzz, 7);
  check("no billing data is not a quote of zero", verdict({ transactions: { insufficientBuzz: false } }).quotedBuzz, null);
  check("a debit without an amount is not a quote", verdict({ transactions: { insufficientBuzz: false, list: [{ type: "debit" }] } }).quotedBuzz, null);
  check("a free arm still quotes zero", verdict({ cost: { total: 0 }, transactions: { insufficientBuzz: false } }).quotedBuzz, 0);
}

process.stdout.write(failures === 0 ? "\nall checks passed\n" : `\n${failures} check(s) FAILED\n`);
process.exitCode = failures === 0 ? 0 : 1;
