import { readFileSync } from "node:fs";
import path from "node:path";
import { MANIFEST_DIR } from "./env.mjs";

export function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

export function loadShared() {
  return {
    prompts: readJson(path.join(MANIFEST_DIR, "prompts.json")),
    fixtures: readJson(path.join(MANIFEST_DIR, "fixtures.json")),
    loras: readJson(path.join(MANIFEST_DIR, "loras.json")),
  };
}

export function loadManifest(file) {
  const manifest = readJson(file);
  if (!manifest.phase || !Array.isArray(manifest.arms)) throw new Error(`${file}: manifest needs phase and arms[]`);
  const ids = new Set();
  for (const arm of manifest.arms) {
    if (!arm.id || !arm.test) throw new Error(`${file}: every arm needs id and test`);
    if (ids.has(arm.id)) throw new Error(`${file}: duplicate arm id ${arm.id}`);
    ids.add(arm.id);
    if (arm.mode !== undefined && arm.mode !== "whatif" && arm.mode !== "paid") throw new Error(`${file}: arm ${arm.id} mode must be whatif or paid`);
  }
  return manifest;
}

/** Resolve a prompt reference (`P5`, `P5+ANATOMY`, or inline text). */
export function resolvePrompt(arm, prompts) {
  if (typeof arm.promptText === "string") return arm.promptText;
  const key = arm.prompt;
  if (typeof key !== "string") throw new Error(`arm ${arm.id}: prompt or promptText required`);
  const parts = key.split("+").map((part) => part.trim());
  const text = parts.map((part) => {
    const value = prompts[part];
    if (typeof value !== "string") throw new Error(`arm ${arm.id}: unknown prompt key ${part}`);
    return value;
  }).join(" ");
  const composed = `${arm.promptPrefix ?? ""}${text}${arm.promptSuffix ?? ""}`;
  if (composed.length > 1000 && arm.allowLongPrompt !== true) throw new Error(`arm ${arm.id}: prompt is ${composed.length} chars; Civitai caps Klein prompts at 1000 (set allowLongPrompt: true on the arm to probe the API with a longer one)`);
  return composed;
}

/**
 * Compose the provider `input` for one arm. Order of precedence: manifest
 * defaults, then arm.input, then the derived operation/images/loras/seed.
 */
export function composeInput(manifest, arm, { prompt, references, loraMap }) {
  const input = { ...(manifest.defaults ?? {}), ...(arm.input ?? {}) };
  input.prompt = prompt;
  const engine = input.engine ?? "flux2";
  if (engine === "flux2") {
    input.model = input.model ?? "klein";
    delete input.ecosystem;
  } else if (engine === "sdcpp" || engine === "comfy") {
    input.ecosystem = input.ecosystem ?? "flux2Klein";
    delete input.model;
  }
  if (input.operation === "createVariant") {
    if (references.length !== 1) throw new Error(`arm ${arm.id}: createVariant needs exactly one reference`);
    input.image = references[0].dataUrl;
    delete input.images;
  } else if (references.length > 0) {
    input.operation = input.operation ?? "editImage";
    input.images = references.map((reference) => reference.dataUrl);
    delete input.image;
  } else {
    input.operation = input.operation ?? "createImage";
    delete input.images;
    delete input.image;
  }
  if (loraMap !== null) input.loras = loraMap;
  else if (input.loras === undefined) input.loras = {};
  if (arm.seed !== undefined) input.seed = arm.seed;
  if (arm.negativePrompt !== undefined) input.negativePrompt = arm.negativePrompt;
  for (const [key, value] of Object.entries(input)) if (value === undefined || value === null) delete input[key];
  return input;
}

export function buildWorkflow({ externalId, tags, priority, input, metadata }) {
  return {
    externalId,
    allowMatureContent: true,
    currencies: ["yellow"],
    upgradeMode: "manual",
    tags,
    metadata,
    steps: [{ $type: "imageGen", priority, input }],
  };
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Known, measured differences between a request and its what-if echo
 * (Phase 0, 2026-09-17). They are neither substitutions nor drops:
 *
 * - the native `flux2` engine echoes `model: "klein"` as `modelVariant`;
 * - the `sdcpp` engine omits `operation` from its echo (the operation is
 *   implied by `image`+`strength` versus `images`) and drops
 *   `enablePromptExpansion`, which its schema does not declare.
 */
export function echoExpectations(input) {
  if (input.engine === "sdcpp") return { renamed: {}, expectedDrops: ["operation", "enablePromptExpansion"] };
  return { renamed: { model: "modelVariant" }, expectedDrops: [] };
}

function inferOperation(echoed) {
  if (typeof echoed.image === "string" && echoed.strength !== undefined) return "createVariant";
  if (Array.isArray(echoed.images) && echoed.images.length > 0) return "editImage";
  return "createImage";
}

/**
 * Field-by-field comparison between what was requested and what the provider
 * echoed back in the what-if. Reference images are compared by count (the
 * echo carries ingested blob URLs, not the bytes), and the LoRA map by exact
 * entries plus the serialized key order on both sides. Known renames and
 * expected omissions ({@link echoExpectations}) are reported separately from
 * genuine drops so that a paid arm is not refused for them.
 */
export function echoReport(requested, echoed, expectations = echoExpectations(requested)) {
  const report = { preserved: [], changed: {}, dropped: [], expectedDrops: [], renamed: [], added: [], loraOrder: null, referenceCount: null, operationInferred: null };
  if (!echoed || typeof echoed !== "object") return { ...report, missing: true };
  const renamedTargets = new Set(Object.values(expectations.renamed ?? {}));
  report.operationInferred = inferOperation(echoed);
  for (const [key, wanted] of Object.entries(requested)) {
    const target = expectations.renamed?.[key] ?? key;
    if (!(target in echoed)) {
      if ((expectations.expectedDrops ?? []).includes(key)) {
        report.expectedDrops.push(key);
        if (key === "operation" && report.operationInferred !== wanted) report.changed.operation = { requested: wanted, inferredFromEcho: report.operationInferred };
      } else {
        report.dropped.push(key);
      }
      continue;
    }
    if (target !== key) report.renamed.push(`${key}->${target}`);
    const got = echoed[target];
    if (key === "images") {
      const requestedCount = Array.isArray(wanted) ? wanted.length : 0;
      const echoedCount = Array.isArray(got) ? got.length : null;
      report.referenceCount = { requested: requestedCount, echoed: echoedCount, echoedAs: Array.isArray(got) ? got.map((item) => (typeof item === "string" ? item.slice(0, 5) : typeof item)) : null };
      if (requestedCount === echoedCount) report.preserved.push(`images[${requestedCount}]`);
      else report.changed.images = report.referenceCount;
      continue;
    }
    if (key === "image") {
      report.preserved.push("image");
      continue;
    }
    if (key === "loras") {
      const requestedEntries = Object.entries(wanted ?? {});
      const echoedEntries = got && typeof got === "object" ? Object.entries(got) : [];
      const sameEntries = requestedEntries.length === echoedEntries.length && requestedEntries.every(([air, strength]) => got?.[air] === strength);
      report.loraOrder = { requested: requestedEntries.map(([air]) => air), echoed: echoedEntries.map(([air]) => air) };
      report.loraOrder.sameOrder = deepEqual(report.loraOrder.requested, report.loraOrder.echoed);
      if (sameEntries) report.preserved.push(`loras[${requestedEntries.length}]`);
      else report.changed.loras = { requested: wanted, echoed: got };
      continue;
    }
    if (deepEqual(wanted, got)) report.preserved.push(key);
    else report.changed[key] = { requested: wanted, echoed: got };
  }
  for (const key of Object.keys(echoed)) if (!(key in requested) && !renamedTargets.has(key)) report.added.push(key);
  return report;
}

/**
 * The quoted price, or `null` when the response carries no billing data at
 * all. Absent billing is NOT free: a zero here would satisfy the paid path's
 * `typeof quotedBuzz === "number"` check and then consume none of the
 * cumulative Buzz cap, so an unpriced submit must stay unquoted and be
 * refused. Debit rows are summed only when every row states a numeric amount.
 */
function quotedBuzzOf(cost, transactions) {
  if (typeof cost?.total === "number") return cost.total;
  const debits = Array.isArray(transactions?.list) ? transactions.list.filter((t) => t?.type === "debit") : [];
  if (debits.length === 0 || !debits.every((t) => typeof t.amount === "number")) return null;
  return debits.reduce((sum, t) => sum + t.amount, 0);
}

/** What the what-if said about policy, payment and validity. */
export function preflightVerdict(result) {
  const body = result.ok ? result.body : null;
  const step = body?.steps?.[0] ?? null;
  const transactions = body?.transactions ?? null;
  const cost = body?.cost ?? null;
  const quotedBuzz = quotedBuzzOf(cost, transactions);
  return {
    http: result.status,
    accepted: result.ok === true,
    status: body?.status ?? null,
    stepStatus: step?.status ?? null,
    workflowId: body?.id ?? null,
    quotedBuzz,
    quoteSource: quotedBuzz === null ? null : typeof cost?.total === "number" ? "cost.total" : "transactions.debits",
    cost,
    transactions,
    insufficientBuzz: typeof transactions?.insufficientBuzz === "boolean" ? transactions.insufficientBuzz : null,
    allowMatureContent: body?.allowMatureContent ?? null,
    currencies: body?.currencies ?? null,
    upgradeMode: body?.upgradeMode ?? null,
    warnings: step?.warnings ?? null,
    errors: [...(Array.isArray(body?.errors) ? body.errors : []), ...(Array.isArray(step?.errors) ? step.errors : [])],
    problem: result.ok ? null : result.body ?? result.transport ?? null,
  };
}
