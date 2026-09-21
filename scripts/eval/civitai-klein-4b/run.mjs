#!/usr/bin/env node
/**
 * Civitai FLUX.2 Klein 4B qualification harness.
 *
 *   node scripts/eval/civitai-klein-4b/run.mjs run --manifest <file> [--only a,b] [--skip a,b]
 *        [--quote-only] [--paid --max-paid-runs N --max-yellow-buzz N] [--out dir]
 *        [--priority low] [--timeout-ms 900000] [--refresh-loras]
 *   node scripts/eval/civitai-klein-4b/run.mjs resolve-loras [--refresh-loras]
 *   node scripts/eval/civitai-klein-4b/run.mjs recent [--take 10] [--tags a,b]
 *   node scripts/eval/civitai-klein-4b/run.mjs reconcile --manifest <file> --arm <id> --workflow <id>
 *   node scripts/eval/civitai-klein-4b/run.mjs compare <a.jpg> <b.jpg>
 *   node scripts/eval/civitai-klein-4b/run.mjs sheet --manifest <file> (--test T2.4 | --arms a,b,c) [--columns 4] [--title ...]
 *   node scripts/eval/civitai-klein-4b/run.mjs promote --manifest <file> --arm <id> --as CHAR_B_FACE
 *   node scripts/eval/civitai-klein-4b/run.mjs aggregate --phase <phase>
 *
 * Spend gates (all default to zero-spend): CIVITAI_EVAL_DRY_RUN=false AND --paid AND
 * CIVITAI_EVAL_MAX_PAID_RUNS>0 AND CIVITAI_EVAL_MAX_YELLOW_BUZZ>0, checked against the
 * cumulative ledger in the output directory. Every paid submit is preceded by a
 * what-if of the identical body and is never retried.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { CivitaiClient, TERMINAL_STATUSES, pollWorkflow } from "./lib/civitai.mjs";
import { DEFAULT_OUT_DIR, REPO_ROOT, civitaiToken, resolveSpendGates } from "./lib/env.mjs";
import { compareImages, contactSheet, dhash, fileInfo, prepareReference } from "./lib/image.mjs";
import { buildWorkflow, composeInput, echoReport, loadManifest, loadShared, preflightVerdict, resolvePrompt } from "./lib/manifest.mjs";
import { redact, sha256Hex } from "./lib/redact.mjs";
import { aggregateScores, readCsv, repointScoreRows, upsertScoreTemplate } from "./lib/scoring.mjs";

const log = (line) => process.stdout.write(`${line}\n`);
const nowIso = () => new Date().toISOString();

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq > 0) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
        flags[arg.slice(2)] = argv[i + 1];
        i += 1;
      } else {
        flags[arg.slice(2)] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function readJsonIf(file, fallback) {
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : fallback;
}

function csv(value) {
  return typeof value === "string" && value !== "" ? value.split(",").map((s) => s.trim()).filter(Boolean) : [];
}

function safeExternalId(text) {
  return text.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 128);
}

function relOut(outDir, file) {
  return path.relative(outDir, file);
}

// ---------------------------------------------------------------- ledger

function loadLedger(outDir) {
  return readJsonIf(path.join(outDir, "ledger.json"), { paidRuns: 0, quotedBuzz: 0, settledBuzz: 0, entries: [] });
}

function saveLedger(outDir, ledger) {
  ledger.settledBuzz = ledger.entries.reduce((sum, entry) => sum + (typeof entry.settled === "number" ? entry.settled : 0), 0);
  writeJson(path.join(outDir, "ledger.json"), ledger);
}

// ---------------------------------------------------------------- LoRA resolution

async function resolveLora(client, key, registry, cache, refresh) {
  const spec = registry[key];
  if (!spec) throw new Error(`unknown LoRA key ${key}`);
  if (!refresh && cache[key]?.ok) return cache[key];
  const result = await client.getModelVersion(spec.versionId);
  if (!result.ok) throw new Error(`LoRA ${key}: metadata http ${result.status}`);
  const m = result.body;
  const primary = (m.files ?? []).find((f) => f.primary) ?? (m.files ?? [])[0] ?? null;
  const sha = primary?.hashes?.SHA256 ? String(primary.hashes.SHA256).toLowerCase() : null;
  const checks = {
    idMatches: m.id === spec.versionId,
    modelIdMatches: m.modelId === spec.modelId,
    isLora: m.model?.type === "LORA",
    published: m.status === "Published",
    baseModel: m.baseModel ?? null,
    baseMatches: spec.expectedBaseModel ? m.baseModel === spec.expectedBaseModel : null,
    shaMatches: spec.expectedSha256 ? sha === spec.expectedSha256.toLowerCase() : null,
    availability: m.availability ?? null,
  };
  const ok = checks.idMatches && checks.modelIdMatches && checks.isLora && checks.published && checks.baseMatches !== false && checks.shaMatches !== false;
  const resolved = {
    key,
    label: spec.label,
    modelId: m.modelId,
    versionId: m.id,
    versionName: m.name,
    modelName: m.model?.name ?? null,
    modelNsfw: m.model?.nsfw ?? null,
    baseModel: m.baseModel ?? null,
    publishedAt: m.publishedAt ?? null,
    trainedWords: m.trainedWords ?? [],
    file: primary ? { name: primary.name, sizeKB: primary.sizeKB, sha256: sha } : null,
    checks,
    ok,
    air: ok ? `urn:air:flux2:lora:civitai:${m.modelId}@${m.id}` : null,
    resolvedAt: nowIso(),
  };
  cache[key] = resolved;
  if (!ok) throw new Error(`LoRA ${key} failed live verification: ${JSON.stringify(checks)}`);
  return resolved;
}

async function loraMapFor(arm, ctx) {
  if (!Array.isArray(arm.loras) || arm.loras.length === 0) return null;
  const map = {};
  for (const entry of arm.loras) {
    let air = entry.air;
    if (!air) {
      const resolved = await resolveLora(ctx.client, entry.key, ctx.shared.loras, ctx.loraCache, ctx.refreshLoras);
      air = resolved.air;
    }
    if (typeof entry.strength !== "number") throw new Error(`arm ${arm.id}: LoRA ${entry.key ?? entry.air} needs a numeric strength`);
    map[air] = entry.strength;
  }
  writeJson(path.join(ctx.outDir, "lora-resolution.json"), ctx.loraCache);
  return map;
}

// ---------------------------------------------------------------- references

async function referencesFor(arm, ctx) {
  const keys = Array.isArray(arm.references) ? arm.references : [];
  const out = [];
  for (const key of keys) {
    if (!ctx.prepared.has(key)) {
      const spec = ctx.shared.fixtures[key];
      if (!spec || typeof spec.source !== "string") throw new Error(`arm ${arm.id}: unknown fixture ${key}`);
      if (!existsSync(spec.source)) throw new Error(`arm ${arm.id}: fixture ${key} source is missing: ${spec.source}`);
      const prepared = await prepareReference(key, spec, path.join(ctx.outDir, "inputs"));
      ctx.prepared.set(key, prepared);
      const index = readJsonIf(path.join(ctx.outDir, "inputs", "index.json"), {});
      const { dataUrl, ...record } = prepared;
      index[key] = record;
      writeJson(path.join(ctx.outDir, "inputs", "index.json"), index);
    }
    out.push(ctx.prepared.get(key));
  }
  return out;
}

// ---------------------------------------------------------------- one arm

function summarizeProblem(verdict) {
  const problem = verdict.problem;
  if (!problem) return null;
  if (problem.errors && typeof problem.errors === "object") {
    return Object.entries(problem.errors).map(([field, messages]) => `${field}: ${[].concat(messages).join("; ")}`).join(" | ");
  }
  if (problem.title || problem.detail) return [problem.title, problem.detail].filter(Boolean).join(" — ");
  if (problem.transport) return `transport ${problem.transport.name}: ${problem.transport.message}`;
  return JSON.stringify(problem).slice(0, 300);
}

function timing(workflow) {
  const step = workflow?.steps?.[0] ?? null;
  const t = (value) => (value ? Date.parse(value) : null);
  const created = t(workflow?.createdAt);
  const stepStarted = t(step?.startedAt);
  const stepCompleted = t(step?.completedAt);
  const completed = t(workflow?.completedAt);
  return {
    createdAt: workflow?.createdAt ?? null,
    stepStartedAt: step?.startedAt ?? null,
    stepCompletedAt: step?.completedAt ?? null,
    completedAt: workflow?.completedAt ?? null,
    queueSeconds: created && stepStarted ? (stepStarted - created) / 1000 : null,
    renderSeconds: stepStarted && stepCompleted ? (stepCompleted - stepStarted) / 1000 : null,
    wallSeconds: created && completed ? (completed - created) / 1000 : null,
  };
}

function settledBuzz(workflow) {
  const list = Array.isArray(workflow?.transactions?.list) ? workflow.transactions.list : [];
  let debit = 0;
  let credit = 0;
  for (const t of list) {
    if (t?.type === "debit") debit += t.amount ?? 0;
    if (t?.type === "credit") credit += t.amount ?? 0;
  }
  return { debit, credit, net: debit - credit, costTotal: workflow?.cost?.total ?? null, list: list.map((t) => ({ type: t.type, amount: t.amount, accountType: t.accountType })) };
}

async function finishPaidArm(ctx, manifest, arm, armDir, workflow, timeline) {
  const phase = manifest.phase;
  writeJson(path.join(armDir, "workflow.json"), redact(workflow));
  if (timeline) writeJson(path.join(armDir, "timeline.json"), timeline);
  const step = workflow?.steps?.[0] ?? null;
  const images = Array.isArray(step?.output?.images) ? step.output.images : [];
  const outputs = [];
  for (const [index, image] of images.entries()) {
    const record = {
      index,
      blobId: image?.id ?? null,
      available: image?.available === true,
      nsfwLevel: image?.nsfwLevel ?? null,
      blockedReason: image?.blockedReason ?? null,
      width: image?.width ?? null,
      height: image?.height ?? null,
    };
    if (image?.url && image.available && !image.blockedReason) {
      try {
        let download;
        try {
          download = await ctx.client.downloadOutput(image.url);
        } catch (urlError) {
          // Mature-rated blobs 403 behind the signed URL's redirect; the blob endpoint with the token serves them.
          if (!image.id) throw urlError;
          download = await ctx.client.downloadBlob(image.id);
          record.urlDownloadError = String(urlError.message).slice(0, 200);
        }
        const { bytes, hosts, contentType } = download;
        if (download.via) record.downloadedVia = download.via;
        const suffix = images.length > 1 ? `-${index + 1}` : "";
        const file = path.join(ctx.outDir, "images", phase, `${arm.id}${suffix}.jpg`);
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, bytes);
        const info = await fileInfo(file);
        Object.assign(record, { file: relOut(ctx.outDir, file), hosts, contentType, sha256: info.sha256, bytes: info.bytes, width: info.width, height: info.height, dhash: await dhash(bytes) });
      } catch (error) {
        record.downloadError = String(error.message).slice(0, 300);
      }
    }
    outputs.push(record);
  }
  const result = {
    workflowId: workflow?.id ?? null,
    status: workflow?.status ?? null,
    stepStatus: step?.status ?? null,
    errors: [...(Array.isArray(workflow?.errors) ? workflow.errors : []), ...(Array.isArray(step?.errors) ? step.errors : []), ...(Array.isArray(step?.output?.errors) ? step.output.errors : [])],
    jobs: Array.isArray(step?.jobs) ? step.jobs.map((job) => ({ status: job?.status, reason: job?.reason ?? null, blockedReason: job?.blockedReason ?? null })) : null,
    nsfwLevel: workflow?.nsfwLevel ?? null,
    timing: timing(workflow),
    settled: settledBuzz(workflow),
    outputs,
  };
  writeJson(path.join(armDir, "output.json"), result);
  const ledger = loadLedger(ctx.outDir);
  const entry = ledger.entries.find((e) => e.workflowId === result.workflowId);
  if (entry) {
    entry.status = result.status;
    entry.settled = result.settled.net;
    entry.completedAt = nowIso();
  }
  saveLedger(ctx.outDir, ledger);
  const delivered = outputs.filter((o) => o.file);
  if (delivered.length > 0) {
    upsertScoreTemplate(ctx.outDir, phase, delivered.map((o) => ({
      phase, arm: arm.id, test: arm.test, recipe: arm.recipe ?? "", seed: arm.seed ?? "", output: o.file, sha12: o.sha256.slice(0, 12),
    })));
  }
  return result;
}

/**
 * A rerun of an arm must not land on top of the previous attempt. The score
 * sheet keys its rows by output path, so overwriting the render in place
 * would leave the grader's scores and the old sha attached to bytes nobody
 * graded; and a rerun that fails after this point would otherwise leave the
 * previous attempt's `output.json` for `sheet`, `promote` and
 * `continuation.mjs` to read as if it described the new one.
 *
 * Everything the prior attempt produced therefore moves under
 * `runs/<phase>/<arm>/superseded/<prior workflow>/` and
 * `images/<phase>/superseded/` before the new paid submit, and the graded
 * rows move with the bytes they describe.
 */
function supersedePriorAttempt(ctx, manifest, arm, armDir, priorFiles) {
  const priorFile = path.join(armDir, "output.json");
  if (!existsSync(priorFile)) return null;
  const prior = readJsonIf(priorFile, null);
  const stamp = prior?.workflowId ? `wf-${prior.workflowId}` : `at-${nowIso().replace(/[:.]/g, "-")}`;
  const archive = path.join(armDir, "superseded", stamp);
  mkdirSync(archive, { recursive: true });
  const moved = [];
  for (const output of Array.isArray(prior?.outputs) ? prior.outputs : []) {
    if (typeof output.file !== "string") continue;
    const from = path.join(ctx.outDir, output.file);
    if (!existsSync(from)) continue;
    const to = path.join(ctx.outDir, "images", manifest.phase, "superseded", `${path.basename(output.file, ".jpg")}-${stamp}.jpg`);
    mkdirSync(path.dirname(to), { recursive: true });
    renameSync(from, to);
    const relocated = relOut(ctx.outDir, to);
    moved.push({ from: output.file, to: relocated });
    output.file = relocated;
  }
  const repointed = repointScoreRows(ctx.outDir, manifest.phase, moved);
  // `run` has already overwritten request/whatif/echo for the new attempt and
  // hands their prior contents in; `reconcile` writes none of them, so there
  // the files themselves belong to the attempt being archived.
  for (const [name, text] of Object.entries(priorFiles ?? {})) writeFileSync(path.join(archive, name), text);
  const carried = ["workflow.json", "timeline.json", "submit.json", "record.json"];
  if (priorFiles === null) carried.push("request.json", "whatif.json", "echo.json");
  for (const name of carried) {
    const from = path.join(armDir, name);
    if (existsSync(from)) renameSync(from, path.join(archive, name));
  }
  writeJson(path.join(archive, "output.json"), { ...prior, supersededAt: nowIso() });
  rmSync(priorFile);
  log(`    superseded prior attempt ${stamp}: ${moved.length} render(s) archived${repointed ? `, ${repointed.rows} graded row(s) repointed` : ""}`);
  return { stamp, moved: moved.length };
}

async function runArm(ctx, manifest, arm, options) {
  const phase = manifest.phase;
  const armDir = path.join(ctx.outDir, "runs", phase, arm.id);
  mkdirSync(armDir, { recursive: true });
  // This invocation overwrites request/whatif/echo in place; if a prior
  // attempt already delivered an output, keep its copies for the archive.
  const priorFiles = existsSync(path.join(armDir, "output.json"))
    ? Object.fromEntries(["request.json", "whatif.json", "echo.json"]
        .filter((name) => existsSync(path.join(armDir, name)))
        .map((name) => [name, readFileSync(path.join(armDir, name), "utf8")]))
    : null;
  const prompt = resolvePrompt(arm, ctx.shared.prompts);
  const negative = arm.negativePrompt === undefined ? undefined : (ctx.shared.prompts[arm.negativePrompt] ?? arm.negativePrompt);
  const references = await referencesFor(arm, ctx);
  const loraMap = await loraMapFor(arm, ctx);
  const input = composeInput(manifest, { ...arm, negativePrompt: negative }, { prompt, references, loraMap });
  const labels = new Map(references.map((r) => [r.dataUrl, r.key]));
  const priority = arm.priority ?? options.priority ?? "low";
  const externalId = safeExternalId(`vk4b-${phase}-${arm.id}-${randomUUID().slice(0, 8)}`);
  const tags = ["vesper", "klein-qualification", phase, `arm:${arm.id}`, `test:${arm.test}`].map((tag) => tag.slice(0, 200));
  const metadata = { harness: "scripts/eval/civitai-klein-4b", phase, arm: arm.id, test: arm.test };
  const workflow = buildWorkflow({ externalId, tags, priority, input, metadata });
  writeJson(path.join(armDir, "request.json"), redact(workflow, labels));

  const record = {
    arm: arm.id,
    test: arm.test,
    mode: arm.mode ?? "whatif",
    notes: arm.notes ?? null,
    recipe: arm.recipe ?? null,
    at: nowIso(),
    priority,
    prompt: { key: arm.prompt ?? "(inline)", chars: prompt.length, sha256: sha256Hex(prompt).slice(0, 16) },
    negativePrompt: negative === undefined ? null : { chars: negative.length },
    references: references.map((r) => ({ key: r.key, sha256: r.sha256, width: r.width, height: r.height, bytes: r.bytes })),
    loras: loraMap,
    input: redact({ ...input, images: undefined, image: undefined }, labels),
  };

  const whatif = await ctx.client.whatif(workflow);
  writeJson(path.join(armDir, "whatif.json"), redact(whatif, labels));
  const verdict = preflightVerdict(whatif);
  const echoed = whatif.ok ? whatif.body?.steps?.[0]?.input ?? null : null;
  const echo = echoReport(input, echoed);
  writeJson(path.join(armDir, "echo.json"), { verdict: redact(verdict), echo });
  record.whatif = {
    http: verdict.http,
    accepted: verdict.accepted,
    status: verdict.status,
    quotedBuzz: verdict.quotedBuzz,
    costBase: verdict.cost?.base ?? null,
    costFactors: verdict.cost?.factors ?? null,
    insufficientBuzz: verdict.insufficientBuzz,
    allowMatureContent: verdict.allowMatureContent,
    currencies: verdict.currencies,
    upgradeMode: verdict.upgradeMode,
    errors: verdict.errors,
    warnings: verdict.warnings,
    problem: summarizeProblem(verdict),
    elapsedMs: whatif.elapsedMs,
  };
  record.echo = {
    preserved: echo.preserved,
    changed: echo.changed,
    dropped: echo.dropped,
    expectedDrops: echo.expectedDrops,
    renamed: echo.renamed,
    added: echo.added,
    referenceCount: echo.referenceCount,
    loraOrder: echo.loraOrder,
    operationInferred: echo.operationInferred,
    missing: echo.missing ?? false,
  };
  const echoOk = !echo.missing && echo.dropped.length === 0 && Object.keys(echo.changed).length === 0;
  log(`  ${arm.id}: whatif http ${verdict.http} status=${verdict.status ?? "-"} quote=${verdict.quotedBuzz ?? "-"} buzz echo=${echoOk ? "exact" : `dropped[${echo.dropped.join(",")}] changed[${Object.keys(echo.changed).join(",")}]`}${record.whatif.problem ? ` PROBLEM: ${record.whatif.problem}` : ""}`);

  if ((arm.mode ?? "whatif") !== "paid" || options.quoteOnly) {
    record.paid = { attempted: false, reason: options.quoteOnly ? "quote-only" : "whatif arm" };
    // Re-quoting an arm that already ran spends nothing and must not erase
    // what that paid attempt recorded; record.json is the arm's state, not
    // this invocation's log.
    const prior = readJsonIf(path.join(armDir, "record.json"), null);
    if (prior?.paid?.submitted === true) {
      record.paid = { ...prior.paid, requotedAt: record.at, requotedBuzz: verdict.quotedBuzz };
      if (prior.result) record.result = prior.result;
    }
    writeJson(path.join(armDir, "record.json"), record);
    return record;
  }

  // ---- paid path
  const gates = options.gates;
  const ledger = loadLedger(ctx.outDir);
  const refusal = (() => {
    if (!gates.paidAllowed) return `spend gates closed: ${gates.reasons.join("; ")}`;
    if (!verdict.accepted) return "what-if was not accepted";
    if (verdict.errors.length > 0) return `what-if reported errors: ${verdict.errors.join(", ")}`;
    if (verdict.insufficientBuzz !== false) return "what-if did not confirm sufficient yellow Buzz";
    if (verdict.allowMatureContent !== true || verdict.upgradeMode !== "manual" || !Array.isArray(verdict.currencies) || verdict.currencies.join() !== "yellow") return "what-if did not preserve mature/yellow/manual policy";
    if (!echoOk && arm.allowEchoMismatch !== true) return "what-if echo differs from the request";
    if (typeof verdict.quotedBuzz !== "number") return "no cost quote";
    if (ledger.paidRuns + 1 > gates.maxPaidRuns) return `cap: ${ledger.paidRuns} paid runs already, max ${gates.maxPaidRuns}`;
    if (ledger.quotedBuzz + verdict.quotedBuzz > gates.maxYellowBuzz) return `cap: ${ledger.quotedBuzz} + ${verdict.quotedBuzz} quoted Buzz would exceed max ${gates.maxYellowBuzz}`;
    return null;
  })();
  if (refusal) {
    record.paid = { attempted: false, reason: refusal };
    log(`    paid submit refused: ${refusal}`);
    writeJson(path.join(armDir, "record.json"), record);
    return record;
  }

  supersedePriorAttempt(ctx, manifest, arm, armDir, priorFiles);
  const submitBody = { ...workflow, externalId: safeExternalId(`${externalId}-p${randomUUID().slice(0, 6)}`) };
  ledger.entries.push({ at: nowIso(), phase, arm: arm.id, externalId: submitBody.externalId, workflowId: null, quoted: verdict.quotedBuzz, settled: null, status: "submitting" });
  ledger.paidRuns += 1;
  ledger.quotedBuzz += verdict.quotedBuzz;
  saveLedger(ctx.outDir, ledger);
  const submit = await ctx.client.submit(submitBody);
  writeJson(path.join(armDir, "submit.json"), redact(submit, labels));
  const entry = ledger.entries[ledger.entries.length - 1];
  if (!submit.ok) {
    entry.status = submit.status === 0 ? "ambiguous" : `http ${submit.status}`;
    saveLedger(ctx.outDir, ledger);
    record.paid = { attempted: true, submitted: false, http: submit.status, problem: summarizeProblem(preflightVerdict(submit)) };
    writeJson(path.join(armDir, "record.json"), record);
    if (submit.status === 0) {
      throw new Error(`arm ${arm.id}: paid submit was transport-ambiguous. Reconcile with 'recent --tags arm:${arm.id}' then 'reconcile' before any further paid run.`);
    }
    log(`    paid submit http ${submit.status}: ${record.paid.problem}`);
    return record;
  }
  const workflowId = submit.body?.id ?? null;
  entry.workflowId = workflowId;
  entry.status = submit.body?.status ?? "submitted";
  saveLedger(ctx.outDir, ledger);
  log(`    submitted workflow ${workflowId} (quoted ${verdict.quotedBuzz} Buzz)`);
  record.paid = { attempted: true, submitted: true, workflowId, externalId: submitBody.externalId, quoted: verdict.quotedBuzz };

  const { workflow: terminal, timeline, timedOut } = await pollWorkflow(ctx.client, workflowId, { timeoutMs: options.timeoutMs, intervalMs: options.pollMs, log });
  if (timedOut || !terminal || !TERMINAL_STATUSES.has(terminal.status)) {
    record.paid.pending = true;
    writeJson(path.join(armDir, "timeline.json"), timeline);
    writeJson(path.join(armDir, "record.json"), record);
    log(`    workflow ${workflowId} still ${terminal?.status ?? "unknown"} after ${options.timeoutMs} ms; reconcile later (it is NOT cancelled and NOT refunded by abandoning the poll)`);
    return record;
  }
  record.result = await finishPaidArm(ctx, manifest, arm, armDir, terminal, timeline);
  log(`    ${terminal.status} in ${record.result.timing.wallSeconds ?? "?"} s (queue ${record.result.timing.queueSeconds ?? "?"} s, render ${record.result.timing.renderSeconds ?? "?"} s), settled ${record.result.settled.net} Buzz, outputs ${record.result.outputs.filter((o) => o.file).length}`);
  writeJson(path.join(armDir, "record.json"), record);
  return record;
}

// ---------------------------------------------------------------- summaries

function writeSummary(outDir, manifest, records) {
  const file = path.join(outDir, "summaries", `${manifest.phase}.json`);
  const existing = readJsonIf(file, { phase: manifest.phase, title: manifest.title, records: [] });
  const byArm = new Map(existing.records.map((r) => [r.arm, r]));
  for (const record of records) byArm.set(record.arm, record);
  const merged = { phase: manifest.phase, title: manifest.title, updatedAt: nowIso(), records: manifest.arms.map((arm) => byArm.get(arm.id)).filter(Boolean) };
  writeJson(file, merged);
  const lines = [
    `# ${manifest.title ?? manifest.phase}`,
    "",
    `Updated ${merged.updatedAt}. Raw request/what-if/echo/output JSON per arm under runs/${manifest.phase}/<arm>/.`,
    "",
    "| Arm | Test | Mode | HTTP | Quote (Buzz) | Echo | Paid | Result | Notes |",
    "| --- | --- | --- | ---: | ---: | --- | --- | --- | --- |",
  ];
  for (const r of merged.records) {
    const echo = r.echo?.missing ? "missing" : (r.echo?.dropped?.length === 0 && Object.keys(r.echo?.changed ?? {}).length === 0) ? "exact" : `dropped: ${r.echo?.dropped?.join(", ") || "-"}; changed: ${Object.keys(r.echo?.changed ?? {}).join(", ") || "-"}`;
    const paid = r.paid?.submitted ? `${r.paid.workflowId}` : r.paid?.attempted === false ? "no" : `no (${r.paid?.problem ?? r.paid?.reason ?? "?"})`;
    const result = r.result ? `${r.result.status}; ${r.result.settled?.net ?? "?"} Buzz; ${r.result.outputs?.filter((o) => o.file).length ?? 0} img; wall ${r.result.timing?.wallSeconds ?? "?"} s` : r.paid?.pending ? "pending" : "";
    const notes = [r.whatif?.problem, r.notes].filter(Boolean).join(" — ").replace(/\|/g, "\\|");
    lines.push(`| ${r.arm} | ${r.test} | ${r.mode} | ${r.whatif?.http ?? ""} | ${r.whatif?.quotedBuzz ?? ""} | ${echo} | ${paid} | ${result} | ${notes} |`);
  }
  writeFileSync(path.join(outDir, "summaries", `${manifest.phase}.md`), `${lines.join("\n")}\n`);
  return file;
}

// ---------------------------------------------------------------- commands

async function commandRun(flags) {
  if (!flags.manifest) throw new Error("--manifest is required");
  const manifestFile = path.resolve(flags.manifest);
  const manifest = loadManifest(manifestFile);
  const outDir = path.resolve(flags.out ?? DEFAULT_OUT_DIR);
  mkdirSync(outDir, { recursive: true });
  const only = new Set(csv(flags.only));
  const skip = new Set(csv(flags.skip));
  const testFilter = new Set(csv(flags.test));
  const gates = resolveSpendGates(flags);
  const options = {
    gates,
    quoteOnly: flags["quote-only"] === true,
    priority: typeof flags.priority === "string" ? flags.priority : "low",
    timeoutMs: Number(flags["timeout-ms"] ?? 900_000),
    pollMs: Number(flags["poll-ms"] ?? 4000),
  };
  const ctx = {
    client: new CivitaiClient(civitaiToken(), { log }),
    shared: loadShared(),
    outDir,
    prepared: new Map(),
    loraCache: readJsonIf(path.join(outDir, "lora-resolution.json"), {}),
    refreshLoras: flags["refresh-loras"] === true,
  };
  const arms = manifest.arms.filter((arm) => (only.size === 0 || only.has(arm.id)) && !skip.has(arm.id) && (testFilter.size === 0 || testFilter.has(arm.test)));
  log(`${manifest.phase}: ${arms.length} arm(s); paid ${gates.paidAllowed ? `ALLOWED (max ${gates.maxPaidRuns} runs / ${gates.maxYellowBuzz} Buzz, cumulative)` : `closed (${gates.reasons.join("; ")})`}${options.quoteOnly ? "; quote-only" : ""}`);
  const records = [];
  for (const arm of arms) {
    try {
      records.push(await runArm(ctx, manifest, arm, options));
    } catch (error) {
      const message = String(error.message).slice(0, 500);
      log(`  ${arm.id}: FAILED — ${message}`);
      records.push({ arm: arm.id, test: arm.test, mode: arm.mode ?? "whatif", at: nowIso(), failure: message, notes: arm.notes ?? null });
      if (/transport-ambiguous/.test(message)) break;
    }
  }
  const summary = writeSummary(outDir, manifest, records);
  log(`summary: ${relOut(REPO_ROOT, summary)} (+ .md)`);
}

async function commandResolveLoras(flags) {
  const outDir = path.resolve(flags.out ?? DEFAULT_OUT_DIR);
  const shared = loadShared();
  const client = new CivitaiClient(civitaiToken(), { log });
  const cache = readJsonIf(path.join(outDir, "lora-resolution.json"), {});
  for (const key of Object.keys(shared.loras).filter((k) => !k.startsWith("_"))) {
    try {
      const r = await resolveLora(client, key, shared.loras, cache, flags["refresh-loras"] === true);
      log(`${key}: ${r.air} base="${r.baseModel}" ${r.versionName} sha=${r.file?.sha256?.slice(0, 12) ?? "?"} words=${JSON.stringify(r.trainedWords)}`);
    } catch (error) {
      log(`${key}: REFUSED — ${error.message}`);
    }
  }
  writeJson(path.join(outDir, "lora-resolution.json"), cache);
}

async function commandRecent(flags) {
  const client = new CivitaiClient(civitaiToken(), { log });
  const result = await client.listWorkflows({ take: Number(flags.take ?? 10), tags: csv(flags.tags) });
  if (!result.ok) throw new Error(`list http ${result.status}`);
  for (const w of result.body?.items ?? []) {
    const i = w.steps?.[0]?.input ?? {};
    const tx = (w.transactions?.list ?? []).map((t) => `${t.type}:${t.amount}${t.accountType?.[0] ?? ""}`).join(",");
    const out = (w.steps?.[0]?.output?.images ?? []).map((img) => `${img.available ? "avail" : "unavail"}${img.blockedReason ? `/blocked:${img.blockedReason}` : ""}`).join(",");
    log(`${w.id} ${w.status} ${w.createdAt} tags=${JSON.stringify(w.tags)} tx=[${tx}] ${i.engine ?? "?"}/${i.modelVersion ?? "?"}/${i.operation ?? "?"} cfg=${i.cfgScale ?? "?"} steps=${i.steps ?? "?"} ${i.width ?? "?"}x${i.height ?? "?"} refs=${(i.images ?? []).length}${i.image ? "+1" : ""} loras=${Object.keys(i.loras ?? {}).length} out=[${out}]`);
  }
}

/**
 * Whether the fetched workflow is the one this arm submitted, and which
 * ledger entry it already has.
 *
 * A reconcile attributes a paid render to an arm, so a valid but mistyped
 * workflow id must be refused rather than downloaded, scored and published
 * under the wrong arm. Every workflow this harness submits carries the
 * `arm:<id>` and phase tags plus `metadata.{phase,arm}`, and an ambiguous
 * submit leaves a ledger entry holding its `externalId` — so identity is
 * checkable from the fetched workflow itself.
 *
 * `pending` is that ambiguous-submit entry: it already counted the paid run
 * and its quote against the caps, so reconciliation updates it in place
 * instead of appending a second entry for the same paid workflow.
 */
function reconcileIdentity(workflow, manifest, arm, ledger) {
  const tags = Array.isArray(workflow?.tags) ? workflow.tags : [];
  const metadata = workflow?.metadata ?? {};
  const externalId = typeof workflow?.externalId === "string" ? workflow.externalId : null;
  const mine = (entry) => entry.arm === arm.id && entry.phase === manifest.phase;
  const byExternalId = externalId === null ? null : ledger.entries.find((e) => e.externalId === externalId) ?? null;
  const openForArm = ledger.entries.filter((e) => e.workflowId === null && mine(e));
  const foreignLedger = byExternalId !== null && !mine(byExternalId);
  const byTag = tags.includes(`arm:${arm.id}`) && tags.includes(manifest.phase);
  const byMetadata = metadata.arm === arm.id && metadata.phase === manifest.phase;
  const byLedger = byExternalId !== null && mine(byExternalId);
  const pending = byLedger && byExternalId.workflowId === null ? byExternalId
    : byExternalId === null && externalId === null && openForArm.length > 0 ? openForArm[openForArm.length - 1]
    : null;
  return {
    tags, metadata, externalId, byTag, byMetadata, byLedger, foreignLedger, pending,
    existing: ledger.entries.find((e) => e.workflowId === workflow?.id) ?? null,
    matches: !foreignLedger && (byTag || byMetadata || byLedger),
  };
}

async function commandReconcile(flags) {
  if (!flags.manifest || !flags.arm || !flags.workflow) throw new Error("--manifest, --arm and --workflow are required");
  const manifest = loadManifest(path.resolve(flags.manifest));
  const arm = manifest.arms.find((a) => a.id === flags.arm);
  if (!arm) throw new Error(`arm ${flags.arm} not in manifest`);
  const outDir = path.resolve(flags.out ?? DEFAULT_OUT_DIR);
  const ctx = { client: new CivitaiClient(civitaiToken(), { log }), outDir };
  const result = await ctx.client.getWorkflow(String(flags.workflow));
  if (!result.ok) throw new Error(`workflow http ${result.status}`);
  const workflow = result.body;
  if (!TERMINAL_STATUSES.has(workflow.status)) {
    log(`workflow ${workflow.id} is ${workflow.status}; not terminal yet`);
    return;
  }
  const ledger = loadLedger(outDir);
  const identity = reconcileIdentity(workflow, manifest, arm, ledger);
  if (!identity.matches) {
    throw new Error(`workflow ${workflow.id} does not identify as ${manifest.phase}/${arm.id}: tags ${JSON.stringify(identity.tags)}, metadata ${JSON.stringify(identity.metadata)}, externalId ${identity.externalId ?? "-"}${identity.foreignLedger ? " (that externalId belongs to another arm in the ledger)" : ""}. Refusing to attribute it; find the right workflow with: recent --tags arm:${arm.id}`);
  }
  if (identity.existing) {
    identity.existing.status = workflow.status;
    saveLedger(outDir, ledger);
  } else if (identity.pending) {
    // The ambiguous submit already charged this workflow against both caps.
    identity.pending.workflowId = workflow.id;
    identity.pending.status = workflow.status;
    identity.pending.reconciled = true;
    if (typeof workflow.cost?.total === "number" && typeof identity.pending.quoted === "number" && workflow.cost.total !== identity.pending.quoted) {
      ledger.quotedBuzz += workflow.cost.total - identity.pending.quoted;
      identity.pending.quotedAtSubmit = identity.pending.quoted;
      identity.pending.quoted = workflow.cost.total;
    }
    saveLedger(outDir, ledger);
    log(`ledger: resolved the pending entry (externalId ${identity.pending.externalId ?? "-"}) — no second paid run counted`);
  } else {
    ledger.entries.push({ at: nowIso(), phase: manifest.phase, arm: arm.id, externalId: workflow.externalId ?? null, workflowId: workflow.id, quoted: workflow.cost?.total ?? null, settled: null, status: workflow.status, reconciled: true });
    ledger.paidRuns += 1;
    ledger.quotedBuzz += workflow.cost?.total ?? 0;
    saveLedger(outDir, ledger);
  }
  const armDir = path.join(outDir, "runs", manifest.phase, arm.id);
  const priorOutput = readJsonIf(path.join(armDir, "output.json"), null);
  if (priorOutput && priorOutput.workflowId !== workflow.id) supersedePriorAttempt(ctx, manifest, arm, armDir, null);
  const finished = await finishPaidArm(ctx, manifest, arm, armDir, workflow, null);
  const recordFile = path.join(armDir, "record.json");
  const record = readJsonIf(recordFile, { arm: arm.id, test: arm.test, mode: "paid" });
  record.result = finished;
  record.paid = { ...(record.paid ?? {}), attempted: true, submitted: true, workflowId: workflow.id, pending: false, reconciled: true };
  writeJson(recordFile, record);
  writeSummary(outDir, manifest, [record]);
  log(`${arm.id}: ${finished.status}, settled ${finished.settled.net} Buzz, outputs ${finished.outputs.filter((o) => o.file).length}`);
}

async function commandCompare(positional) {
  const [a, b] = positional;
  if (!a || !b) throw new Error("compare <a> <b>");
  const result = await compareImages(path.resolve(a), path.resolve(b));
  log(JSON.stringify(result, null, 2));
}

async function commandSheet(flags) {
  if (!flags.manifest) throw new Error("--manifest is required");
  const manifest = loadManifest(path.resolve(flags.manifest));
  const outDir = path.resolve(flags.out ?? DEFAULT_OUT_DIR);
  const armIds = csv(flags.arms);
  const arms = manifest.arms.filter((arm) => (armIds.length > 0 ? armIds.includes(arm.id) : flags.test ? arm.test === flags.test : true));
  const cells = [];
  for (const arm of arms) {
    const output = readJsonIf(path.join(outDir, "runs", manifest.phase, arm.id, "output.json"), null);
    const delivered = output?.outputs?.find((o) => o.file) ?? null;
    cells.push({ file: delivered ? path.join(outDir, delivered.file) : null, label: `${arm.id}\n${(arm.label ?? arm.notes ?? output?.status ?? "no output").slice(0, 44)}` });
  }
  if (cells.length === 0) throw new Error("no arms matched");
  const name = flags.name ?? (flags.test ? `${manifest.phase}-${flags.test}` : `${manifest.phase}-selection`);
  const out = path.join(outDir, "contact-sheets", `${name}.png`);
  const result = await contactSheet({ cells, out, columns: Number(flags.columns ?? Math.min(4, cells.length)), title: flags.title ?? name });
  log(`${relOut(REPO_ROOT, result.out)} (${result.cells} cells)`);
}

/**
 * Contact sheet from a JSON spec: { title, columns, name, cells: [{ file, label }] }
 * with `file` relative to the output directory (or absolute). Lets one sheet
 * mix phases, gates and the reference fixtures themselves.
 */
async function commandGrid(flags) {
  if (!flags.spec) throw new Error("--spec is required");
  const outDir = path.resolve(flags.out ?? DEFAULT_OUT_DIR);
  const spec = readJsonIf(path.resolve(flags.spec), null);
  if (!spec || !Array.isArray(spec.cells)) throw new Error("spec needs cells[]");
  const cells = spec.cells.map((cell) => ({
    file: cell.file ? (path.isAbsolute(cell.file) ? cell.file : path.join(outDir, cell.file)) : null,
    label: cell.label ?? path.basename(cell.file ?? ""),
    crop: cell.crop ?? spec.crop ?? null,
  }));
  const out = path.join(outDir, "contact-sheets", `${spec.name ?? path.basename(flags.spec, ".json")}.png`);
  const result = await contactSheet({ cells, out, columns: Number(spec.columns ?? 4), title: spec.title ?? "", cellWidth: spec.cellWidth, cellHeight: spec.cellHeight });
  log(`${relOut(REPO_ROOT, result.out)} (${result.cells} cells)`);
}

function commandPromote(flags) {
  if (!flags.manifest || !flags.arm || !flags.as) throw new Error("--manifest, --arm and --as are required");
  const manifest = loadManifest(path.resolve(flags.manifest));
  const outDir = path.resolve(flags.out ?? DEFAULT_OUT_DIR);
  const output = readJsonIf(path.join(outDir, "runs", manifest.phase, flags.arm, "output.json"), null);
  const delivered = output?.outputs?.find((o) => o.file);
  if (!delivered) throw new Error(`arm ${flags.arm} has no delivered output`);
  const target = path.join(outDir, "inputs", "promoted", `${flags.as}.jpg`);
  mkdirSync(path.dirname(target), { recursive: true });
  copyFileSync(path.join(outDir, delivered.file), target);
  writeJson(`${target}.json`, { promotedFrom: { phase: manifest.phase, arm: flags.arm, workflowId: output.workflowId, sha256: delivered.sha256 }, at: nowIso() });
  log(`promoted ${delivered.file} -> ${relOut(REPO_ROOT, target)}`);
}

/** Rebuild summaries/<phase>.{json,md} from the per-arm record.json files (after an interrupted run). */
function commandSummarize(flags) {
  if (!flags.manifest) throw new Error("--manifest is required");
  const manifest = loadManifest(path.resolve(flags.manifest));
  const outDir = path.resolve(flags.out ?? DEFAULT_OUT_DIR);
  const records = [];
  for (const arm of manifest.arms) {
    const record = readJsonIf(path.join(outDir, "runs", manifest.phase, arm.id, "record.json"), null);
    if (record) records.push(record);
  }
  const file = writeSummary(outDir, manifest, records);
  log(`${manifest.phase}: ${records.length} record(s) -> ${relOut(REPO_ROOT, file)} (+ .md)`);
}

function commandAggregate(flags) {
  if (!flags.phase) throw new Error("--phase is required");
  const outDir = path.resolve(flags.out ?? DEFAULT_OUT_DIR);
  const file = path.join(outDir, "scores", `${flags.phase}.csv`);
  const rows = readCsv(file);
  const summary = aggregateScores(rows);
  writeJson(path.join(outDir, "summaries", `${flags.phase}-scores.json`), summary);
  log(JSON.stringify(summary, null, 2));
}

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const command = positional.shift() ?? "run";
  switch (command) {
    case "run": return commandRun(flags);
    case "resolve-loras": return commandResolveLoras(flags);
    case "recent": return commandRecent(flags);
    case "reconcile": return commandReconcile(flags);
    case "compare": return commandCompare(positional);
    case "sheet": return commandSheet(flags);
    case "promote": return commandPromote(flags);
    case "grid": return commandGrid(flags);
    case "aggregate": return commandAggregate(flags);
    case "summarize": return commandSummarize(flags);
    default: throw new Error(`unknown command ${command}`);
  }
}

main().catch((error) => {
  process.stderr.write(`error: ${String(error?.message ?? error)}\n`);
  process.exitCode = 1;
});
