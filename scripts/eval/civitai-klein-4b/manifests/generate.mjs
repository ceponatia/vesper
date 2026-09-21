#!/usr/bin/env node
/**
 * Emits the paid-phase manifests (phase-1 … phase-10) from decisions.json.
 * Phase 0 is hand-written. Re-run after editing decisions.json.
 *
 *   node scripts/eval/civitai-klein-4b/manifests/generate.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const D = JSON.parse(readFileSync(path.join(here, "decisions.json"), "utf8"));
const SEEDS = D.seeds;
const STRESS = D.seedsStress;
const W = D.loraWeights;

const DEFAULTS = {
  engine: "flux2",
  model: "klein",
  modelVersion: "4b",
  width: D.size.width,
  height: D.size.height,
  quantity: 1,
  cfgScale: D.distilled.cfgScale,
  steps: D.distilled.steps,
  sampleMethod: "euler",
  schedule: "simple",
  outputFormat: "jpeg",
  enablePromptExpansion: false,
};

const L = (key, strength = W[key]) => ({ key, strength });
const loras = (list) => list.map((l) => (typeof l === "string" ? L(l) : L(l.key, l.strength ?? W[l.key])));

function label({ input = {}, references = [], lorasList = [] }) {
  const variant = input.modelVersion ?? "4b";
  const engine = input.engine === "sdcpp" ? `sdcpp:${input.operation}@${input.strength}` : null;
  const cfg = input.cfgScale ?? DEFAULTS.cfgScale;
  const steps = input.steps ?? DEFAULTS.steps;
  const refs = references.length ? references.join("+") : "noref";
  const ls = lorasList.length ? lorasList.map((l) => `${l.key}@${l.strength}`).join("+") : "noLoRA";
  return [variant, engine, `cfg${cfg}`, `s${steps}`, refs, ls].filter(Boolean).join("|");
}

function arm(id, test, fields) {
  const lorasList = fields.loras ? loras(fields.loras) : [];
  const references = fields.references ?? [];
  const entry = { id, test, mode: "paid", ...fields, references, loras: lorasList };
  entry.recipe = fields.recipe ?? label({ input: fields.input, references, lorasList });
  if (lorasList.length === 0) delete entry.loras;
  if (references.length === 0) delete entry.references;
  return entry;
}

function manifest(phase, title, arms, extra = {}) {
  return { phase, title, generated: { by: "manifests/generate.mjs", at: new Date().toISOString(), decisions: D.version }, defaults: DEFAULTS, ...extra, arms };
}

function write(name, value) {
  writeFileSync(path.join(here, name), `${JSON.stringify(value, null, 2)}\n`);
  process.stdout.write(`${name}: ${value.arms.length} arms\n`);
}

const R13 = ["R1_FACE", "R3_FULL_BODY"];
const BEST = { cfgScale: D.distilledBest.cfgScale, steps: D.distilledBest.steps };
const BASE = { modelVersion: "4b-base", cfgScale: D.base.cfgScale, steps: D.base.steps };
const BASE_BEST = { modelVersion: "4b-base", cfgScale: D.baseBest.cfgScale, steps: D.baseBest.steps };

// ------------------------------------------------------------ Phase 1
{
  const arms = [];
  arms.push(arm("T1.0-charB", "T1.0", { prompt: "CHAR_B_SEED", seed: 424242, input: { width: 1024, height: 1024 }, notes: "second synthetic identity for T2.7/P11; promote its output as CHAR_B_FACE" }));
  for (const n of [1, 2, 3]) arms.push(arm(`T1.1-repeat-${n}`, "T1.1", { prompt: "P2", seed: 424242, notes: "exact-repeat determinism: identical request, separate paid workflows" }));
  for (const seed of SEEDS) for (const p of ["P2", "P3", "P4", "P5", "P10"]) arms.push(arm(`T1.2-${p}-${seed}`, "T1.2", { prompt: p, seed }));
  arms.push(arm("T1.3-B-cfg5-s20", "T1.3", { prompt: "P2", seed: 424242, input: { cfgScale: 5, steps: 20 }, notes: "old Vesper settings; A is T1.1-repeat-1" }));
  write("phase-1-baseline.json", manifest("phase-1-baseline", "Phase 1 — determinism and prompt-only baseline (distilled 4b, no references, no LoRA)", arms));
}

// ------------------------------------------------------------ Phase 2
{
  const arms = [];
  for (const seed of SEEDS) for (const p of ["P1", "P2", "P5", "P7", "P8", "P9"]) arms.push(arm(`T2.1-${p}-${seed}`, "T2.1", { prompt: p, seed, references: ["R1_FACE"] }));
  for (const seed of SEEDS) for (const p of ["P2", "P3", "P4", "P5"]) arms.push(arm(`T2.2-${p}-${seed}`, "T2.2", { prompt: p, seed, references: ["R3_FULL_BODY"] }));
  for (const seed of SEEDS) for (const p of ["P2", "P3", "P5", "P8"]) arms.push(arm(`T2.3-${p}-${seed}`, "T2.3", { prompt: p, seed, references: R13 }));
  for (const seed of SEEDS) for (const p of ["P2", "P5"]) arms.push(arm(`T2.4-${p}-${seed}-rev`, "T2.4", { prompt: p, seed, references: ["R3_FULL_BODY", "R1_FACE"], notes: "reference order reversed; A is T2.3" }));
  for (const p of ["P2", "P5"]) arms.push(arm(`T2.5-${p}-424242-dup`, "T2.5", { prompt: p, seed: 424242, references: ["R1_FACE", "R1_FACE"], notes: "duplicate reference weighting probe; A is T2.1" }));
  for (const seed of SEEDS) for (const p of ["P8", "P9"]) arms.push(arm(`T2.6-${p}-${seed}`, "T2.6", { prompt: p, seed, references: ["R1_FACE", "R2_THREE_QUARTER"] }));
  for (const seed of SEEDS.slice(0, 2)) arms.push(arm(`T2.7-P1-${seed}-conflict`, "T2.7", { prompt: "P1", seed, references: ["R1_FACE", "CHAR_B_FACE"], notes: "conflicting identities; requires CHAR_B_FACE promoted from T1.0-charB" }));
  arms.push(arm("T2.8-P1-424242-1024", "T2.8", { prompt: "P1", seed: 424242, references: ["R1_FACE_1024"], notes: "reference long edge 1024; native (1184) is T2.1-P1-424242" }));
  arms.push(arm("T2.8-P1-424242-2048", "T2.8", { prompt: "P1", seed: 424242, references: ["R1_FACE_2048"], notes: "reference upscaled to 2048" }));
  arms.push(arm("T2.9-P2-424242-3refs", "T2.9", { prompt: "P2", seed: 424242, references: ["R1_FACE", "R3_FULL_BODY", "R2_THREE_QUARTER"], notes: "Phase 0 accepted and priced 3 references; does the worker use them?" }));
  write("phase-2-references.json", manifest("phase-2-references", "Phase 2 — reference conditioning (distilled recipe from Phase 1, no LoRA)", arms));
}

// ------------------------------------------------------------ Phase 3
{
  const arms = [];
  for (const p of ["P5", "P4"]) for (const steps of [4, 6, 8, 12]) arms.push(arm(`T3.1-${p}-s${steps}`, "T3.1", { prompt: p, seed: 424242, references: R13, input: { cfgScale: 1, steps } }));
  for (const p of ["P5", "P4"]) for (const cfg of [1.5, 2.0, 2.5]) arms.push(arm(`T3.2-${p}-cfg${cfg}`, "T3.2", { prompt: p, seed: 424242, references: R13, input: { cfgScale: cfg, steps: BEST.steps }, notes: `cfg 1.0 is T3.1-${p}-s${BEST.steps}` }));
  for (const p of ["P5", "P4"]) arms.push(arm(`T3.3-${p}-neg`, "T3.3", { prompt: p, seed: 424242, references: R13, negativePrompt: "NEG1", input: { cfgScale: 2.5, steps: BEST.steps }, notes: `A is T3.2-${p}-cfg2.5` }));
  for (const p of ["P5", "P4"]) arms.push(arm(`T3.4-${p}-anatomy-positive`, "T3.4", { prompt: `${p}+ANATOMY_POSITIVE`, seed: 424242, references: R13, input: BEST, notes: `A is T3.1-${p}-s${BEST.steps}` }));
  arms.push(arm("T3.5-P12-verbose", "T3.5", { prompt: "P12", seed: 424242, references: R13, input: BEST, notes: `concise is T3.1-P5-s${BEST.steps}` }));
  for (const order of ["A", "B"]) arms.push(arm(`T3.6-P5-order-${order}`, "T3.6", { prompt: `P5_ORDER_${order}`, seed: 424242, references: R13, input: BEST }));
  arms.push(arm("T3.7-P5-roles", "T3.7", { prompt: "P5_ROLES", seed: 424242, references: R13, input: BEST }));
  for (const p of ["P5", "P4"]) arms.push(arm(`T3.8-${p}-expansion-true`, "T3.8", { prompt: p, seed: 424242, references: R13, input: { ...BEST, enablePromptExpansion: true } }));
  for (const p of ["P2", "P5"]) for (const [w, h] of [[832, 1248], [1024, 1024], [1024, 1536]]) {
    if (p === "P5" && w === 832) continue;
    arms.push(arm(`T3.9-${p}-${w}x${h}`, "T3.9", { prompt: p, seed: 424242, references: R13, input: { ...BEST, width: w, height: h } }));
  }
  for (const seed of SEEDS.slice(1)) for (const p of ["P5", "P4"]) arms.push(arm(`T3.10-${p}-${seed}-best`, "T3.10", { prompt: p, seed, references: R13, input: BEST, notes: "winning distilled recipe over the remaining seeds (decisions.distilledBest)" }));
  write("phase-3-sampling.json", manifest("phase-3-sampling", "Phase 3 — sampling and prompt strategy on P5/P4 + [R1,R3]", arms));
}

// ------------------------------------------------------------ Phase 4
{
  const arms = [];
  arms.push(arm("T4.0-canary-A", "T4.0", { prompt: "P2", seed: 424242, input: BEST, notes: "Gate A: no LoRA, no trigger" }));
  arms.push(arm("T4.0-canary-B", "T4.0", { prompt: "P2", seed: 424242, promptPrefix: "Simple_Fine_Vector. ", loras: [L("L4", 0.75)], input: BEST, notes: "Gate A: canary LoRA 0.75 + trigger" }));
  arms.push(arm("T4.0-canary-C", "T4.0", { prompt: "P2", seed: 424242, loras: [L("L4", 0.75)], input: BEST, notes: "Gate A: canary LoRA 0.75, trigger absent" }));
  for (const p of ["P1", "P2", "P7", "P8", "P9", "P10", "A1"]) arms.push(arm(`T4.L0-${p}`, "T4.L0", { prompt: p, seed: 424242, references: R13, input: BEST, notes: "no-LoRA control at the Phase 4 recipe (P4/P5 controls are T3.1 at the best step count)" }));
  for (const w of [0.5, 0.75, 1.0, 1.25]) for (const p of ["P1", "P2", "P5"]) arms.push(arm(`T4.1-L1-w${w}-${p}`, "T4.1", { prompt: p, seed: 424242, references: R13, loras: [L("L1", w)], input: BEST }));
  for (const w of [0.75, 1.0]) arms.push(arm(`T4.1-L1-w${w}-A1`, "T4.1", { prompt: "A1", seed: 424242, references: R13, loras: [L("L1", w)], input: BEST, notes: "adult functional check of the pilot LoRA" }));
  for (const w of [2.0, 2.5, 3.0]) for (const p of ["P2", "P4", "P5", "P10"]) arms.push(arm(`T4.2-L2-w${w}-${p}`, "T4.2", { prompt: p, seed: 424242, references: R13, loras: [L("L2", w)], input: BEST }));
  for (const w of [0.5, 0.6, 0.75]) for (const p of ["P5", "P7", "P8", "P9"]) arms.push(arm(`T4.3-L3-w${w}-${p}`, "T4.3", { prompt: p, seed: 424242, references: R13, loras: [L("L3", w)], input: BEST }));
  for (const p of ["P5", "P8"]) arms.push(arm(`T4.3-L3-w0.6-${p}-trigger`, "T4.3", { prompt: p, seed: 424242, references: R13, loras: [L("L3", 0.6)], input: BEST, promptSuffix: " Transform the image to realistic photograph.", notes: "author's suggested trigger sentence appended" }));
  if (D.includeOptional) {
    for (const w of [0.6, 0.8, 1.0]) arms.push(arm(`T4.5-L5-w${w}-A_MALE`, "T4.5", { prompt: "A_MALE", seed: 424242, loras: [L("L5_V2", w)], input: BEST, notes: "optional male anatomy control (no reference)" }));
    arms.push(arm("T4.5-L0-A_MALE", "T4.5", { prompt: "A_MALE", seed: 424242, input: BEST }));
  }
  write("phase-4-loras.json", manifest("phase-4-loras", "Phase 4 — single-LoRA qualification (Gate A canary first)", arms));
}

// ------------------------------------------------------------ Phase 5
{
  const arms = [];
  for (const p of ["P2", "P4", "P5", "P8"]) arms.push(arm(`T5.1-${p}-L2+L3`, "T5.1", { prompt: p, seed: 424242, references: R13, loras: ["L2", "L3"], input: BEST }));
  for (const p of ["P2", "P5", "A1"]) arms.push(arm(`T5.2-${p}-L2+L1`, "T5.2", { prompt: p, seed: 424242, references: R13, loras: ["L2", "L1"], input: BEST }));
  for (const p of ["P1", "P5", "P8", "A1"]) arms.push(arm(`T5.3-${p}-L3+L1`, "T5.3", { prompt: p, seed: 424242, references: R13, loras: ["L3", "L1"], input: BEST }));
  for (const p of ["P2", "P5", "P8", "A1"]) arms.push(arm(`T5.4-${p}-L2+L3+L1`, "T5.4", { prompt: p, seed: 424242, references: R13, loras: ["L2", "L3", "L1"], input: BEST }));
  for (const p of ["P2", "P5"]) {
    arms.push(arm(`T5.5-${p}-order-A-repeat`, "T5.5", { prompt: p, seed: 424242, references: R13, loras: ["L2", "L3", "L1"], input: BEST, notes: "exact repeat of T5.4 (order A) to separate order effects from nondeterminism" }));
    arms.push(arm(`T5.5-${p}-order-B`, "T5.5", { prompt: p, seed: 424242, references: R13, loras: ["L1", "L3", "L2"], input: BEST, notes: "NSFW-first serialized order" }));
  }
  for (const p of ["P2", "P5"]) arms.push(arm(`T5.6-${p}-L4+L3`, "T5.6", { prompt: p, seed: 424242, references: R13, promptPrefix: "Simple_Fine_Vector. ", loras: [L("L4", 0.75), "L3"], input: BEST }));
  arms.push(arm("T5.7-P2-L3", "T5.7", { prompt: "P2", seed: 424242, references: R13, loras: ["L3"], input: BEST, notes: "matrix cell missing from Phase 4 (L3 alone on P2)" }));
  arms.push(arm("T5.7-P2-L3+L1", "T5.7", { prompt: "P2", seed: 424242, references: R13, loras: ["L3", "L1"], input: BEST, notes: "matrix cell missing from T5.3 (P2)" }));
  for (const stack of D.bestStacks) for (const seed of SEEDS.slice(1)) for (const p of ["P2", "P5"]) arms.push(arm(`T5.8-${p}-${seed}-${stack.label}`, "T5.8", { prompt: p, seed, references: R13, loras: stack.loras, input: BEST, notes: "best four matrix configurations over the remaining seeds (decisions.bestStacks)" }));
  write("phase-5-stacks.json", manifest("phase-5-stacks", "Phase 5 — LoRA stacking and order", arms));
}

// ------------------------------------------------------------ Phase 6
{
  const arms = [];
  for (const seed of SEEDS) for (const p of ["P1", "P2", "P4", "P5", "P8"]) arms.push(arm(`T6.1-${p}-${seed}`, "T6.1", { prompt: p, seed, input: BASE }));
  for (const steps of [20, 30, 40]) arms.push(arm(`T6.2-P2-s${steps}`, "T6.2", { prompt: "P2", seed: 424242, input: { ...BASE, steps }, notes: "s50 is T6.1-P2-424242" }));
  for (const cfg of [3.0, 3.5, 4.5]) arms.push(arm(`T6.3-P2-cfg${cfg}`, "T6.3", { prompt: "P2", seed: 424242, input: { ...BASE_BEST, cfgScale: cfg }, notes: `cfg 4 is T6.2-P2-s${BASE_BEST.steps}` }));
  const refSets = { R1: ["R1_FACE"], R3: ["R3_FULL_BODY"], "R1+R3": R13, "R3+R1": ["R3_FULL_BODY", "R1_FACE"] };
  for (const [name, refs] of Object.entries(refSets)) for (const p of ["P2", "P5", "P8"]) arms.push(arm(`T6.4-${p}-${name}`, "T6.4", { prompt: p, seed: 424242, references: refs, input: BASE_BEST }));
  for (const p of ["P2", "P4", "P5"]) arms.push(arm(`T6.5-${p}-L2`, "T6.5", { prompt: p, seed: 424242, references: R13, loras: ["L2"], input: BASE_BEST }));
  for (const w of [0.5, 0.6, 0.75]) for (const p of ["P5", "P8"]) arms.push(arm(`T6.6-${p}-L3-w${w}`, "T6.6", { prompt: p, seed: 424242, references: R13, loras: [L("L3", w)], input: BASE_BEST }));
  for (const p of ["P2", "P5", "P8"]) arms.push(arm(`T6.7-${p}-L2+L3`, "T6.7", { prompt: p, seed: 424242, references: R13, loras: ["L2", "L3"], input: BASE_BEST }));
  for (const p of ["P2", "P5", "A1"]) arms.push(arm(`T6.7-${p}-L2+L3+L1`, "T6.7", { prompt: p, seed: 424242, references: R13, loras: ["L2", "L3", "L1"], input: BASE_BEST, notes: "cross-pairing: L1 is trained on distilled 4B; acceptance is not compatibility" }));
  write("phase-6-base.json", manifest("phase-6-base", "Phase 6 — distilled 4b versus 4b-base (BFL recipe cfg 4 / 50 steps, then decisions.baseBest)", arms));
}

// ------------------------------------------------------------ Phase 7
{
  const arms = [];
  const variant = (strength, extra = {}) => ({ engine: "sdcpp", ecosystem: "flux2Klein", operation: "createVariant", strength, modelVersion: "4b", ...BEST, ...extra });
  for (const p of ["P7", "P8"]) for (const s of [0.25, 0.4, 0.55, 0.7, 0.85]) arms.push(arm(`T7.1-${p}-str${s}`, "T7.1", { prompt: p, seed: 424242, references: ["R3_FULL_BODY"], input: variant(s) }));
  for (const seed of SEEDS) for (const p of ["P7", "P8"]) {
    arms.push(arm(`T7.2-${p}-${seed}-native-edit`, "T7.2", { prompt: p, seed, references: ["R3_FULL_BODY"], input: BEST }));
    arms.push(arm(`T7.2-${p}-${seed}-variant`, "T7.2", { prompt: p, seed, references: ["R3_FULL_BODY"], input: variant(D.variantStrength) }));
  }
  for (const p of ["P2", "P5"]) {
    arms.push(arm(`T7.3-${p}-variant-L2`, "T7.3", { prompt: p, seed: 424242, references: ["R3_FULL_BODY"], loras: ["L2"], input: variant(D.variantStrength) }));
    arms.push(arm(`T7.4-${p}-variant-L3`, "T7.4", { prompt: p, seed: 424242, references: ["R3_FULL_BODY"], loras: ["L3"], input: variant(D.variantStrength) }));
    arms.push(arm(`T7.5-${p}-variant-L2+L3`, "T7.5", { prompt: p, seed: 424242, references: ["R3_FULL_BODY"], loras: ["L2", "L3"], input: variant(D.variantStrength) }));
  }
  write("phase-7-variant.json", manifest("phase-7-variant", "Phase 7 — native editImage versus sdcpp createVariant (single R3 source)", arms));
}

// ------------------------------------------------------------ Phase 8
{
  const arms = [];
  for (const seed of SEEDS) arms.push(arm(`T8.1-pose-copy-${seed}`, "T8.1", { prompt: "POSE_COPY", seed, references: ["R1_FACE", "R5_TARGET_POSE"], input: BEST }));
  for (const seed of SEEDS) arms.push(arm(`T8.2-pose-conflict-${seed}`, "T8.2", { prompt: "P4_POSE_CONFLICT", seed, references: ["R3_FULL_BODY"], input: BEST, notes: "standing reference, seated cross-leg prompt" }));
  for (const seed of STRESS) for (const p of ["P5", "P6"]) arms.push(arm(`T8.3-${p}-${seed}`, "T8.3", { prompt: p, seed, references: R13, input: BEST }));
  for (const seed of SEEDS) arms.push(arm(`T8.4-occlusion-${seed}`, "T8.4", { prompt: "P3_OCCLUSION", seed, references: R13, input: BEST }));
  for (const seed of STRESS) arms.push(arm(`T8.5-P11-${seed}`, "T8.5", { prompt: "P11", seed, references: R13, input: BEST }));
  write("phase-8-stress.json", manifest("phase-8-stress", "Phase 8 — pose and structural stress at the best distilled recipe", arms));
}

// ------------------------------------------------------------ Phase 9
{
  const arms = [];
  const configs = { none: [], L1: ["L1"], L2: ["L2"], "L2+L1": ["L2", "L1"], "L3+L1": ["L3", "L1"], "L2+L3+L1": ["L2", "L3", "L1"] };
  for (const p of ["A1", "A2", "A3"]) for (const [name, ls] of Object.entries(configs)) arms.push(arm(`T9.${p}-${name}`, "T9", { prompt: p, seed: 424242, references: R13, ...(ls.length ? { loras: ls } : {}), input: BEST }));
  for (const seed of STRESS.slice(1)) for (const p of ["A1", "A2", "A3"]) arms.push(arm(`T9.${p}-${seed}-${D.bestAdultStack.label}`, "T9.seeds", { prompt: p, seed, references: R13, loras: D.bestAdultStack.loras, input: BEST, notes: "winning adult stack over the remaining seeds (decisions.bestAdultStack)" }));
  write("phase-9-adult.json", manifest("phase-9-adult", "Phase 9 — adult-content functional suite (kept separate from SFW grading)", arms));
}

// ------------------------------------------------------------ Phase 10
{
  const arms = [];
  const candidates = [
    ...D.phase10.distilled.map((c) => ({ ...c, input: { ...BEST, ...c.input } })),
    ...D.phase10.base.map((c) => ({ ...c, input: { ...BASE_BEST, ...c.input } })),
  ];
  for (const c of candidates) for (const seed of STRESS) for (const p of ["P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8", "P9", "P10", "P11"]) {
    arms.push(arm(`T10-${c.label}-${p}-${seed}`, "T10", { prompt: p, seed, references: R13, ...(c.loras.length ? { loras: c.loras } : {}), input: c.input, recipe: c.label }));
  }
  write("phase-10-robustness.json", manifest("phase-10-robustness", "Phase 10 — five-seed robustness matrix for the final candidates (decisions.phase10)", arms));
}

writeFileSync(path.join(here, "index.json"), `${JSON.stringify({
  order: ["phase-0-capability", "phase-1-baseline", "phase-2-references", "phase-3-sampling", "phase-4-loras", "phase-5-stacks", "phase-6-base", "phase-7-variant", "phase-8-stress", "phase-9-adult", "phase-10-robustness"],
  gates: {
    "phase-4-loras": "Gate A: run T4.0 first; if B is not obviously different from A, stop and investigate LoRA application.",
    "phase-3-sampling": "Gate B: if two-reference identity (Phase 2) is not materially better than prompt-only over seeds, prefer Phase 6/7 over more CFG tuning.",
    "phase-6-base": "Gate D: if 4b-base wins clearly with acceptable cost/latency, stop optimizing distilled 4b.",
    "phase-7-variant": "Gate E: if createVariant beats editImage on the identity/edit trade-off, the operation choice is the limitation.",
    "phase-10-robustness": "Gate F: acceptance thresholds in RESULTS.md §21; do not invent new settings once this phase begins.",
  },
}, null, 2)}\n`);
