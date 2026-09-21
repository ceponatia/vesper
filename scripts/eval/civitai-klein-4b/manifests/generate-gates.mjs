#!/usr/bin/env node
/**
 * Emits the ADAPTIVE plan's gate manifests (gate-1 … gate-4) from
 * decisions.json. Arm ids reuse the original suite's ids wherever the arm is
 * the same experiment, so evidence lines up across the two plans. Arms whose
 * evidence already exists from phase-1 are omitted here and listed in the
 * continuation ledger instead.
 *
 *   node scripts/eval/civitai-klein-4b/manifests/generate-gates.mjs
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const D = JSON.parse(readFileSync(path.join(here, "decisions.json"), "utf8"));
const R = D.revised;
const W = D.loraWeights;
const SEED = D.seeds[0];
const MORE_SEEDS = D.seeds.slice(1);

const DEFAULTS = {
  engine: "flux2", model: "klein", modelVersion: "4b",
  width: D.size.width, height: D.size.height, quantity: 1,
  cfgScale: D.distilled.cfgScale, steps: D.distilled.steps,
  sampleMethod: "euler", schedule: "simple", outputFormat: "jpeg", enablePromptExpansion: false,
};
const BEST = { cfgScale: D.distilledBest.cfgScale, steps: D.distilledBest.steps };
const BASE = { modelVersion: "4b-base", cfgScale: D.base.cfgScale, steps: D.base.steps };
const REFS = R.bestReferences;

const L = (key, strength = W[key]) => ({ key, strength });
const loras = (list) => list.map((l) => (typeof l === "string" ? L(l) : L(l.key, l.strength ?? W[l.key])));

function label({ input = {}, references = [], lorasList = [] }) {
  const variant = input.modelVersion ?? "4b";
  const engine = input.engine === "sdcpp" ? `sdcpp:${input.operation}@${input.strength}` : null;
  const refs = references.length ? references.join("+") : "noref";
  const ls = lorasList.length ? lorasList.map((l) => `${l.key}@${l.strength}`).join("+") : "noLoRA";
  return [variant, engine, `cfg${input.cfgScale ?? DEFAULTS.cfgScale}`, `s${input.steps ?? DEFAULTS.steps}`, refs, ls].filter(Boolean).join("|");
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

const PLAN = "adaptive-2026-09-17";

/**
 * `adult` is what `publish.mjs` reads to keep explicit renders out of the
 * default share bundle. It is stated per gate rather than inferred from a
 * name, because neither a phase name nor an arm id says whether the render is
 * explicit; inside an SFW gate the adult arms are recognized by their prompt
 * family (A*, S*, the two-women pose prompts).
 */
function write(name, phase, title, arms, reuse, adult) {
  if (typeof adult !== "boolean") throw new Error(`${name}: declare whether the gate is adult`);
  const value = { phase, title, adult, plan: PLAN, generated: { by: "manifests/generate-gates.mjs", at: new Date().toISOString(), decisions: D.version }, reuse, defaults: DEFAULTS, arms };
  writeFileSync(path.join(here, name), `${JSON.stringify(value, null, 2)}\n`);
  process.stdout.write(`${name}: ${arms.length} arms\n`);
}

// ------------------------------------------------------------ Gate 1
{
  const arms = [];
  arms.push(arm("T1.2-P1-424242", "G1.noref", { prompt: "P1", seed: SEED, notes: "no-reference baseline for P1 (P2/P5 exist in phase-1)" }));
  for (const p of ["P1", "P2", "P5"]) arms.push(arm(`T2.1-${p}-${SEED}`, "G1.R1", { prompt: p, seed: SEED, references: ["R1_FACE"] }));
  for (const p of ["P2", "P5"]) arms.push(arm(`T2.2-${p}-${SEED}`, "G1.R3", { prompt: p, seed: SEED, references: ["R3_FULL_BODY"] }));
  for (const p of ["P2", "P5", "P8"]) arms.push(arm(`T2.3-${p}-${SEED}`, "G1.R1R3", { prompt: p, seed: SEED, references: ["R1_FACE", "R3_FULL_BODY"] }));
  for (const p of ["P2", "P5"]) arms.push(arm(`T2.4-${p}-${SEED}-rev`, "G1.R3R1", { prompt: p, seed: SEED, references: ["R3_FULL_BODY", "R1_FACE"], notes: "reference order reversed" }));
  arms.push(arm("T3.1-P5-s8", "G1.sampling", { prompt: "P5", seed: SEED, references: ["R1_FACE", "R3_FULL_BODY"], input: { cfgScale: 1, steps: 8 }, notes: "cfg 1 / 4 steps is T2.3-P5-424242" }));
  arms.push(arm("T3.2-P5-cfg2.5", "G1.sampling", { prompt: "P5", seed: SEED, references: ["R1_FACE", "R3_FULL_BODY"], input: { cfgScale: 2.5, steps: 8 } }));
  arms.push(arm("T3.5-P12-verbose", "G1.prompt-length", { prompt: "P12", seed: SEED, references: ["R1_FACE", "R3_FULL_BODY"], input: { cfgScale: 1, steps: 8 }, notes: "Vesper-length prompt; concise is T3.1-P5-s8" }));
  for (const w of R.gate1Winners) for (const seed of MORE_SEEDS) {
    arms.push(arm(`G1b-${w.label}-${seed}`, "G1.repeat", { prompt: w.prompt, seed, references: w.references ?? [], input: w.input ?? {}, notes: "escalation: promising Gate 1 condition over two more seeds" }));
  }
  write("gate-1-distilled.json", "gate-1-distilled", "Gate 1 — distilled 4b viability: references, order, minimal sampling, prompt length", arms, {
    "no-ref P2": "phase-1-baseline/T1.1-repeat-1 (+ T1.2-P2-424242)",
    "no-ref P5": "phase-1-baseline/T1.2-P5-424242",
    "no-ref anatomy P3/P4/P10 ×2 seeds": "phase-1-baseline/T1.2-*",
    determinism: "phase-1-baseline/T1.1-repeat-1..3 (pixel-identical)",
  }, false);
}

// ------------------------------------------------------------ Gate 2
{
  const arms = [];
  const configs = { L0: [], L1: ["L1"], L2: ["L2"], L3: ["L3"], "L2+L3": ["L2", "L3"], "L2+L1": ["L2", "L1"], "L3+L1": ["L3", "L1"], "L2+L3+L1": ["L2", "L3", "L1"] };
  const reuseL0 = BEST.cfgScale === 1 && BEST.steps === 4;
  for (const p of ["P2", "P5"]) for (const [name, ls] of Object.entries(configs)) {
    if (name === "L0" && reuseL0) continue;
    arms.push(arm(`G2-${p}-${name}`, "G2.matrix", { prompt: p, seed: SEED, references: REFS, ...(ls.length ? { loras: ls } : {}), input: BEST, recipe: name }));
  }
  arms.push(arm("G2-P5-L2+L3+L1-order-A-repeat", "G2.order", { prompt: "P5", seed: SEED, references: REFS, loras: ["L2", "L3", "L1"], input: BEST, recipe: "L2+L3+L1", notes: "exact repeat of G2-P5-L2+L3+L1 (determinism under LoRAs)" }));
  for (const p of ["P2", "P5"]) arms.push(arm(`G2-${p}-L1+L3+L2-order-B`, "G2.order", { prompt: p, seed: SEED, references: REFS, loras: ["L1", "L3", "L2"], input: BEST, recipe: "L1+L3+L2", notes: "reversed serialized key order" }));
  for (const t of R.gate2Targeted ?? []) {
    arms.push(arm(`G2-targeted-${t.base}-L2`, "G2.targeted", { prompt: t.prompt, seed: SEED, references: t.references, loras: ["L2"], input: t.input ?? {}, recipe: "L2", notes: `${t.why}; no-LoRA counterpart is gate-1-distilled/${t.base}` }));
  }
  if (R.gate2AnatomyFollowUp) {
    // Owner questions (2026-09-17): does a higher fixer weight act, and is the third hand seed-bound?
    for (const t of R.gate2Targeted ?? []) {
      arms.push(arm(`G2-targeted-${t.base}-L2w3`, "G2.anatomy-followup", { prompt: t.prompt, seed: SEED, references: t.references, loras: [L("L2", 3.0)], input: t.input ?? {}, recipe: "L2@3.0", notes: "author's upper weight; watch identity" }));
    }
    const failing = (R.gate2Targeted ?? []).find((t) => t.base === "T2.2-P5-424242");
    if (failing) for (const seed of MORE_SEEDS) {
      arms.push(arm(`G2-targeted-T2.2-P5-${seed}-L0`, "G2.anatomy-followup", { prompt: failing.prompt, seed, references: failing.references, input: failing.input ?? {}, recipe: "L0", notes: "is the third hand seed-bound? same config as the failing seed 424242, no LoRA" }));
    }
  }
  if (R.gate2Canary) {
    arms.push(arm("G2-canary-A", "G2.canary", { prompt: "P2", seed: SEED, input: BEST, notes: "no LoRA, no trigger" }));
    arms.push(arm("G2-canary-B", "G2.canary", { prompt: "P2", seed: SEED, promptPrefix: "Simple_Fine_Vector. ", loras: [L("L4", 0.75)], input: BEST, notes: "canary LoRA + trigger" }));
  }
  for (const best of R.gate2Best) for (const seed of MORE_SEEDS) for (const p of ["P2", "P5"]) {
    arms.push(arm(`G2b-${best.label}-${p}-${seed}`, "G2.repeat", { prompt: p, seed, references: REFS, ...(best.loras?.length ? { loras: best.loras } : {}), input: { ...BEST, ...(best.input ?? {}) }, recipe: best.label }));
  }
  write("gate-2-loras.json", "gate-2-loras", "Gate 2 — LoRA triage: 8-config interference matrix on P2/P5, map-order reversal, best-config repeats", arms, reuseL0 ? { "L0 cells": "gate-1-distilled/T2.3-P2-424242 and T2.3-P5-424242 (same recipe)" } : {}, false);
}

// ------------------------------------------------------------ Gate 3
{
  const arms = [];
  for (const p of ["P1", "P2", "P5"]) arms.push(arm(`G3-base-${p}`, "G3.base", { prompt: p, seed: SEED, references: REFS, input: BASE, notes: "4b-base first look, BFL recipe, no LoRA" }));
  if (R.gate3BaseFollowUp) {
    for (const p of ["P2", "P5"]) arms.push(arm(`G3-base-${p}-L2`, "G3.base-lora", { prompt: p, seed: SEED, references: REFS, loras: ["L2"], input: BASE }));
    for (const best of R.gate2Best.slice(0, 1)) for (const p of ["P2", "P5"]) arms.push(arm(`G3-base-${p}-${best.label}`, "G3.base-lora", { prompt: p, seed: SEED, references: REFS, loras: best.loras, input: BASE, recipe: `base+${best.label}` }));
    arms.push(arm("G3-base-P5-s30", "G3.base-steps", { prompt: "P5", seed: SEED, references: REFS, input: { ...BASE, steps: 30 }, notes: "cost-reduction check: 30 vs 50 steps" }));
  }
  const variant = (strength) => ({ engine: "sdcpp", ecosystem: "flux2Klein", operation: "createVariant", strength, modelVersion: "4b", ...BEST });
  for (const p of ["P5", "P8"]) for (const s of [0.4, 0.6, 0.8]) arms.push(arm(`G3-variant-${p}-str${s}`, "G3.variant", { prompt: p, seed: SEED, references: ["R3_FULL_BODY"], input: variant(s), notes: "compare against the native editImage result from the same single source (P5: gate-1 T2.2-P5-424242; P8: G3-native-P8-R3)" }));
  arms.push(arm("G3-native-P8-R3", "G3.variant-control", { prompt: "P8", seed: SEED, references: ["R3_FULL_BODY"], input: { cfgScale: 1, steps: 4 }, notes: "fair comparator for the P8 createVariant arms: native editImage from the same single R3 source (Gate 1's P8 used [R1,R3])" }));
  write("gate-3-challenge.json", "gate-3-challenge", "Gate 3 — challenge distilled with 4b-base (first look) and sdcpp createVariant (strength 0.4/0.6/0.8)", arms, {}, false);
}

// ------------------------------------------------------------ Gate 4
{
  const arms = [];
  for (const f of R.finalists) for (const seed of D.seeds) for (const p of ["P1", "P2", "P4", "P5", "P8", "P10"]) {
    arms.push(arm(`G4-${f.label}-${p}-${seed}`, "G4.reliability", { prompt: p, seed, references: f.references ?? REFS, ...(f.loras?.length ? { loras: f.loras } : {}), input: f.input ?? BEST, recipe: f.label }));
  }
  const adult = R.adultFinalist;
  if (adult) {
    for (const p of ["A1", "A2"]) for (const seed of D.seeds) arms.push(arm(`G4-adult-${adult.label}-${p}-${seed}`, "G4.adult", { prompt: p, seed, references: adult.references ?? REFS, loras: adult.loras, input: adult.input ?? BEST, recipe: adult.label }));
    if (!R.adultClothedControlsReused) {
      for (const p of ["P2", "P5"]) arms.push(arm(`G4-adult-${adult.label}-${p}-loaded`, "G4.adult-sfw", { prompt: p, seed: SEED, references: adult.references ?? REFS, loras: adult.loras, input: adult.input ?? BEST, recipe: adult.label, notes: "does loading the adult LoRA harm an ordinary clothed scene?" }));
    }
  }
  write("gate-4-reliability.json", "gate-4-reliability", "Gate 4 — three-seed reliability pass on the finalist(s) + winner-only adult validation", arms, R.adultClothedControlsReused ? { "clothed scenes with the adult LoRA loaded": R.adultClothedControlsReused } : {}, false);
}

// ------------------------------------------------------------ Gate 5 (owner-proposed face-lock wording)
if (R.faceLock) {
  const arms = [];
  const seeds = D.seeds.slice(0, 2);
  for (const seed of seeds) arms.push(arm(`G5-P7-plain-${seed}`, "G5.baseline", { prompt: "P7", seed, references: REFS, input: BEST, recipe: "plain", notes: "plain P7 wardrobe edit (never run before); P8 plain baselines are gate-1 T2.3-P8-424242 and gate-4 P8-717171" }));
  for (const p of ["P7", "P8"]) for (const v of ["A", "B", "C"]) for (const seed of seeds) {
    arms.push(arm(`G5-${p}-FL${v}-${seed}`, "G5.facelock", { prompt: `${p}_FL_${v}`, seed, references: REFS, input: BEST, recipe: `facelock-${v}`, notes: { A: "roles up front (Image 1 = exact face, Image 2 = body only), outfit exclusion named", B: "edit first, face features named, identity instruction last", C: "minimal: same woman as the face photo, keep exact face, change only clothes/scene" }[v] }));
  }
  write("gate-5-facelock.json", "gate-5-facelock", "Gate 5 — owner-proposed face-lock role wording on native editImage: P7 (wardrobe) and P8 (scene) × 3 phrasings × 2 seeds, [R1,R3], cfg 1 / 4", arms, { "P8 plain baselines": "gate-1-distilled/T2.3-P8-424242, gate-4-reliability/G4-distilled-noLoRA-P8-717171" }, false);
}

// ------------------------------------------------------------ Gate 6 (adult follow-up, HANDOFF §next-1)
if (R.adultFollowUp) {
  const A = R.adultFollowUp;
  const arms = [];
  for (const p of A.prompts) for (const seed of D.seeds) {
    arms.push(arm(`G6-${p.key}-${seed}`, "G6.adult", { prompt: p.key, seed, references: REFS, loras: A.loras, input: BEST, recipe: p.recipe, notes: p.notes }));
  }
  write("gate-6-adult.json", "gate-6-adult", "Gate 6 — adult follow-up on the finalist + L1 NippleDiffusion 0.75: A1 in the LoRA vocabulary (± face-lock A), A2 + face-lock A, A3 floor pose in the vocabulary + face-lock A; 3 seeds each", arms, {
    "A1 'nude' without the vocabulary (clothed 3/3)": "gate-4-reliability/G4-adult-distilled-L1-A1-*",
    "A2 'topless' without face-lock (worked 3/3)": "gate-4-reliability/G4-adult-distilled-L1-A2-*",
    "L1 on clothed scenes": "gate-2-loras/G2-P2-L1, G2-P5-L1",
  }, true);
}

// ------------------------------------------------------------ Gate 7 (face-lock robustness, HANDOFF §next-2)
if (R.faceLockRobustness) {
  const F = R.faceLockRobustness;
  const arms = [];
  for (const p of ["P7", "P8"]) for (const v of F.phrasings) {
    arms.push(arm(`G7-${p}-FL${v}-${F.thirdSeed}`, "G7.facelock-seed3", { prompt: `${p}_FL_${v}`, seed: F.thirdSeed, references: REFS, input: BEST, recipe: `facelock-${v}`, notes: `phrasing ${v} at a third seed (Gate 5 ran 424242/717171)` }));
  }
  for (const seed of F.trousers.seeds) {
    arms.push(arm(`G7-P8-FLA-trousers-${seed}`, "G7.facelock-trousers", { prompt: F.trousers.prompt, seed, references: REFS, input: BEST, recipe: "facelock-A-trousers", notes: "phrasing A with the trousers and boots named — does naming the wardrobe stop R3's beige trousers leaking under the coat?" }));
  }
  write("gate-7-facelock-robustness.json", "gate-7-facelock-robustness", "Gate 7 — face-lock robustness: phrasings A/B on P7 and P8 at a third seed, plus phrasing A with trousers named on P8 at the leaking seed and the third seed", arms, {
    "P7/P8 phrasings A/B at 424242 and 717171": "gate-5-facelock/G5-*-FLA-*, G5-*-FLB-*",
    "P8 plain baselines": "gate-1-distilled/T2.3-P8-424242, gate-4-reliability/G4-distilled-noLoRA-P8-717171 and -990099",
  }, false);
}

// ------------------------------------------------------------ Gates 8–12: the adult LoRA program (owner direction 2026-09-17)
if (R.adultProgram) {
  const P = R.adultProgram;
  const keyOf = (l) => (typeof l === "string" ? l : l.key);
  const prefixFor = (list) => { const parts = [...new Set(list.map(keyOf))].map((k) => P.promptPrefixByLora?.[k]).filter(Boolean); return parts.length ? { promptPrefix: parts.join("") } : {}; };
  const lorasOf = (list) => list.map((l) => (typeof l === "string" ? { key: l } : l));
  const base = lorasOf(P.scenes.adultBase);

  // Gate 8 — each LoRA alone, three seeds
  { const arms = [];
    for (const key of P.solo.loras) for (const seed of D.seeds) arms.push(arm(`G8-${key}-${seed}`, "G8.solo", { prompt: P.solo.prompt, seed, references: REFS, loras: [key], input: BEST, recipe: `${key}-alone`, ...prefixFor([key]), notes: key === "L1" ? "baseline: the current adult lane (breasts only)" : `candidate alone at ${W[key]}` }));
    write("gate-8-adult-solo.json", "gate-8-adult-solo", "Gate 8 — each nudity / genitalia LoRA alone (L1 baseline, L7–L12) on the standing full-nude reference edit with face-lock A and genitalia vocabulary, three seeds", arms, { "no-genitalia baseline": "gate-6-adult/G6-A1_VOCAB_FL-* (L1, same recipe, no genitalia vocabulary)" }, true); }

  // Gate 9 — stacks, three seeds
  { const arms = [];
    for (const st of P.stacks.list) for (const seed of D.seeds) arms.push(arm(`G9-${st.label}-${seed}`, "G9.stack", { prompt: st.prompt ?? P.stacks.prompt, seed, references: st.references ?? REFS, loras: lorasOf(st.loras), input: BEST, recipe: st.label, ...prefixFor(st.loras), notes: st.why }));
    write("gate-9-adult-stacks.json", "gate-9-adult-stacks", "Gate 9 — stacks: verified LoRAs (NippleDiffusion, anatomy fixer) and skin LoRAs with one or more nudity LoRAs, on the standing full-nude reference edit, three seeds (prune after Gate 8)", arms, { "members alone": "gate-8-adult-solo", "L2 alone on clothed scenes": "gate-2-loras" }, true); }

  // Gate 10 — sexual scenes; core configs three seeds, just-in-case configs one seed
  { const arms = [];
    for (const sc of P.scenes.list) for (const cfg of sc.configs) for (const seed of cfg.seeds ?? D.seeds) {
      const loras = [...base, ...lorasOf(cfg.extra)];
      arms.push(arm(`G10-${sc.key}-${cfg.label}-${seed}`, cfg.seeds ? "G10.justincase" : "G10.scene", { prompt: sc.prompt, seed, references: sc.references ?? REFS, loras, input: BEST, recipe: `${sc.key}:${cfg.label}`, ...prefixFor(loras), notes: [sc.label, cfg.why].filter(Boolean).join(" — ") }));
    }
    // owner-supplied pose sources (Seedream renders) — one seed, both mechanisms, skipped while the file is missing
    const FX = JSON.parse(readFileSync(path.join(here, "fixtures.json"), "utf8"));
    for (const ps of P.poseSources?.list ?? []) {
      // The pose sources are owner fixtures under gitignored eval-images/, so
      // their presence is a property of one machine. The manifest is not: the
      // same committed decisions must emit the same experiment everywhere, so
      // these arms are always written and a missing file fails that arm at
      // execution time (referencesFor() names the fixture and its path).
      if (typeof FX[ps.fixture]?.source !== "string") throw new Error(`gate-10: pose source ${ps.key} names fixture ${ps.fixture}, which fixtures.json does not define`);
      const loras = [...base, ...lorasOf(ps.extra ?? [])];
      arms.push(arm(`G10-${ps.key}-edit3ref-${P.poseSources.seed}`, "G10.posesource", { prompt: ps.scenePrompt, seed: P.poseSources.seed, references: [...REFS, ps.fixture], loras, input: BEST, recipe: `${ps.key}:edit3ref`, ...prefixFor(loras), notes: "owner pose source as Image 3, native editImage + nudity stack" }));
      if (ps.copyPrompt) arms.push(arm(`G10-${ps.key}-copypose-${P.poseSources.seed}`, "G10.posesource", { prompt: ps.copyPrompt, seed: P.poseSources.seed, references: ["R3_FULL_BODY", ps.fixture], loras: [...base, { key: "L18" }], input: BEST, recipe: `${ps.key}:copypose`, notes: "owner pose source as Image 2 for the Copy Pose LoRA + nudity stack (single-subject tool — just in case)" }));
    }
    write("gate-10-adult-scenes.json", "gate-10-adult-scenes", "Gate 10 — sexual scenes with the nudity stack: woman + man (missionary, cowgirl), two women (prompt-only partner; third-reference partner), woman alone; scene LoRAs where Klein 4B has them, the other NSFW LoRAs 'just in case' where it does not", arms, { "solo nude baseline": "gate-8-adult-solo", "two-hand / floor-pose failures without LoRAs": "gate-4-reliability P4/P5/P10, gate-6-adult A3" }, true);
    const confirm = [];
    for (const c of P.scenes.confirm ?? []) { const sc = P.scenes.list.find((s) => s.key === c.scene); const cfg = sc?.configs.find((x) => x.label === c.label); if (!sc || !cfg) throw new Error(`confirm: unknown ${c.scene}/${c.label}`);
      for (const seed of D.seeds.filter((s) => !(cfg.seeds ?? []).includes(s))) { const loras = [...base, ...lorasOf(cfg.extra)]; confirm.push(arm(`G10b-${sc.key}-${cfg.label}-${seed}`, "G10b.confirm", { prompt: sc.prompt, seed, references: sc.references ?? REFS, loras, input: BEST, recipe: `${sc.key}:${cfg.label}`, ...prefixFor(loras) })); } }
    if (confirm.length) write("gate-10b-adult-scenes-confirm.json", "gate-10b-adult-scenes-confirm", "Gate 10b — one-seed scene configs that worked, over the remaining seeds", confirm, { screen: "gate-10-adult-scenes" }, true);
    else process.stdout.write("gate-10b-adult-scenes-confirm.json: not generated (decisions.revised.adultProgram.scenes.confirm is empty)\n"); }

  // Gate 11 — pose transfer with the Copy Pose LoRA vs a no-LoRA control
  { const arms = [];
    for (const pose of P.poseCopy.poses) for (const cfg of ["noLoRA", ...P.poseCopy.loras]) for (const seed of D.seeds) {
      arms.push(arm(`G11-${pose.key}-${cfg}-${seed}`, cfg === "noLoRA" ? "G11.control" : "G11.posecopy", { prompt: pose.prompt, seed, references: [P.poseCopy.imageOne, pose.pose], ...(cfg === "noLoRA" ? {} : { loras: [cfg] }), input: BEST, recipe: `posecopy-${pose.key}-${cfg}`, notes: cfg === "noLoRA" ? "control: identical prompt and references, no LoRA — does the base edit model copy a pose from Image 2 on its own?" : "Copy Pose LoRA (trigger sentence leads the prompt)" }));
    }
    write("gate-11-pose-copy.json", "gate-11-pose-copy", "Gate 11 — pose transfer: Copy Pose LoRA vs no-LoRA control, [R3 body (Image 1), promoted pose reference (Image 2)], seated and floor poses, three seeds", arms, { "text-only pose failures": "gate-4-reliability G4-*-P4-*, G4-*-P10-*" }, false); }

  // Gate 12 — weight sweep for the Gate 8/9 winners
  { const arms = [];
    for (const key of P.weightSweep.winners) for (const s of P.weightSweep.strengths) for (const seed of D.seeds) arms.push(arm(`G12-${key}@${s}-${seed}`, "G12.weight", { prompt: P.weightSweep.prompt, seed, references: REFS, loras: [{ key, strength: s }], input: BEST, recipe: `${key}@${s}`, ...prefixFor([key]) }));
    if (arms.length) write("gate-12-adult-weights.json", "gate-12-adult-weights", "Gate 12 — weight sweep around 0.9 for the winning nudity LoRAs", arms, { "0.9 cells": "gate-8-adult-solo" }, true);
    else process.stdout.write("gate-12-adult-weights.json: not generated (decisions.revised.adultProgram.weightSweep.winners is empty)\n"); }
}


// ------------------------------------------------------------ index.json — the execution order
/**
 * The index names the CURRENT plan: the adaptive gate suite, headed by the
 * free phase-0 capability table. The phase-1 … phase-10 library is the
 * original 553-arm suite those gates superseded; it is recorded under
 * `archive` so that the index cannot be read as an instruction to spend on it
 * (continuation.mjs classifies its arms as SUPERSEDED, and each gate cites the
 * library evidence it reuses in its own `reuse` field).
 */
{
  const gateSort = (file) => { const m = /^gate-(\d+)([a-z]?)/.exec(file); return Number(m[1]) * 100 + (m[2] ? m[2].charCodeAt(0) - 96 : 0); };
  const read = (file) => JSON.parse(readFileSync(path.join(here, file), "utf8"));
  const current = [
    { file: "phase-0-capability.json", manifest: read("phase-0-capability.json") },
    ...readdirSync(here)
      .filter((f) => /^gate-.*\.json$/.test(f))
      .map((file) => ({ file, manifest: read(file) }))
      .filter(({ manifest }) => manifest.plan === PLAN)
      .sort((a, b) => gateSort(a.file) - gateSort(b.file) || a.file.localeCompare(b.file)),
  ];
  const archive = readdirSync(here)
    .filter((f) => /^phase-\d+-.*\.json$/.test(f) && f !== "phase-0-capability.json")
    .map((file) => ({ file, manifest: read(file) }))
    .sort((a, b) => Number(/^phase-(\d+)/.exec(a.file)[1]) - Number(/^phase-(\d+)/.exec(b.file)[1]));
  const value = {
    plan: PLAN,
    note: "Execution order of the CURRENT plan. Written by manifests/generate-gates.mjs — do not hand-edit.",
    order: current.map(({ manifest }) => manifest.phase),
    titles: Object.fromEntries(current.map(({ manifest }) => [manifest.phase, manifest.title])),
    adult: current.filter(({ manifest }) => manifest.adult).map(({ manifest }) => manifest.phase),
    notes: {
      "phase-0-capability": "Free: every arm is whatif=true. Re-run it before any paid gate to confirm the provider still accepts the recipe.",
      "gate-11-pose-source": "Produces the POSE_FLOOR fixture that gate-11-pose-copy consumes — run it first.",
      spend: "Gates are adaptive: grade a gate and update decisions.json before generating and running the next one. Price any gate without spending with `run --manifest <file> --quote-only`.",
    },
    archive: {
      note: "The original 553-arm library suite (manifests/generate.mjs). SUPERSEDED by the gates above — it is not an execution plan, and continuation.mjs classifies its unrun arms as SUPERSEDED. Its executed arms are reused as evidence through each gate's `reuse` field. The committed files are frozen at the decisions version that produced them; re-running generate.mjs rewrites them against today's decisions.json, which changes the archive rather than restoring it.",
      order: archive.map(({ manifest }) => manifest.phase),
      gates: {
        "phase-4-loras": "Gate A: run T4.0 first; if B is not obviously different from A, stop and investigate LoRA application.",
        "phase-3-sampling": "Gate B: if two-reference identity (Phase 2) is not materially better than prompt-only over seeds, prefer Phase 6/7 over more CFG tuning.",
        "phase-6-base": "Gate D: if 4b-base wins clearly with acceptable cost/latency, stop optimizing distilled 4b.",
        "phase-7-variant": "Gate E: if createVariant beats editImage on the identity/edit trade-off, the operation choice is the limitation.",
        "phase-10-robustness": "Gate F: acceptance thresholds in RESULTS.md (not tracked in git); do not invent new settings once this phase begins.",
      },
    },
  };
  writeFileSync(path.join(here, "index.json"), `${JSON.stringify(value, null, 2)}\n`);
  process.stdout.write(`index.json: ${value.order.length} current manifest(s), ${value.archive.order.length} archived\n`);
}
