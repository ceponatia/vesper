import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { MANIFEST_DIR } from "./env.mjs";

/**
 * Which renders are adult, decided from the committed manifests.
 *
 * A file name cannot answer it: `images/phase-4-loras/T4.L0-A1.jpg` is an
 * explicit arm whose phase and id both read as ordinary LoRA work, and a
 * contact sheet of test `T4.1` mixes clothed and nude arms under one name.
 * Every manifest therefore declares `adult`, and inside an SFW manifest the
 * adult arms are the ones on an adult prompt family: A* (nude / genitalia),
 * S* (sexual scenes), the owner's two-women pose prompts. An arm may also
 * declare `adult: true` for itself.
 *
 * Everything here is a lookup over committed JSON, so a bundle's contents are
 * reproducible from the repository alone.
 */
export const ADULT_PROMPT_KEY = /^(A[0-9]|A_|S[0-9]|OWNER_FF_POSE|POSE_COPY_FF)/;

export function loadAdultIndex(manifestDir = MANIFEST_DIR) {
  const index = { phases: new Set(), adultPhases: new Set(), arms: new Set(), adultArms: new Set(), tests: new Set(), adultTests: new Set() };
  for (const file of readdirSync(manifestDir).filter((f) => /^(phase|gate)-.*\.json$/.test(f))) {
    const manifest = JSON.parse(readFileSync(path.join(manifestDir, file), "utf8"));
    if (typeof manifest.adult !== "boolean") throw new Error(`manifests/${file}: every manifest must declare "adult": true|false before anything generated from it can be published`);
    index.phases.add(manifest.phase);
    if (manifest.adult) index.adultPhases.add(manifest.phase);
    for (const arm of manifest.arms ?? []) {
      index.arms.add(`${manifest.phase}/${arm.id}`);
      index.tests.add(`${manifest.phase}/${arm.test}`);
      if (manifest.adult || arm.adult === true || ADULT_PROMPT_KEY.test(String(arm.prompt ?? ""))) {
        index.adultArms.add(`${manifest.phase}/${arm.id}`);
        index.adultTests.add(`${manifest.phase}/${arm.test}`);
      }
    }
  }
  return index;
}

/**
 * `render`, `cell` and `sheet` return `true`, `false`, or `null` when the item
 * cannot be placed at all; every `null` is also appended to `unclassified`
 * with the reason, so a caller can refuse the whole bundle rather than publish
 * something it could not classify.
 */
export function createAdultClassifier(outDir, index = loadAdultIndex()) {
  const unclassified = [];
  const unknown = (what, why) => {
    unclassified.push(`${what}: ${why}`);
    return null;
  };

  /** `images/<phase>/<arm>.jpg`, or `<arm>-2.jpg` when one workflow returned several images. */
  function render(phase, file) {
    const name = file.replace(/\.jpg$/, "");
    if (!index.phases.has(phase)) return unknown(`images/${phase}/${file}`, `phase "${phase}" is in no committed manifest`);
    const arm = index.arms.has(`${phase}/${name}`) ? name : name.replace(/-\d+$/, "");
    if (!index.arms.has(`${phase}/${arm}`)) return unknown(`images/${phase}/${file}`, `arm "${arm}" is in no manifest for ${phase}`);
    return index.adultArms.has(`${phase}/${arm}`);
  }

  /**
   * A grid spec cell: a render resolves through the manifests, the owner's
   * pose sources are adult by definition, a promoted fixture inherits the arm
   * its `promote` sidecar records, and the prepared reference pack is the
   * clothed identity set.
   */
  function cell(file) {
    if (typeof file !== "string" || file === "") return unknown("spec cell", "cell names no file");
    const parts = file.split("/");
    if (parts[0] === "images" && parts.length === 3) return render(parts[1], parts[2]);
    if (parts[0] === "inputs" && parts[1] === "owner-poses") return true;
    if (parts[0] === "inputs" && parts[1] === "promoted") {
      const sidecar = path.join(outDir, `${file}.json`);
      if (!existsSync(sidecar)) return unknown(file, "promoted fixture has no promote sidecar to trace it to an arm");
      const from = JSON.parse(readFileSync(sidecar, "utf8")).promotedFrom ?? {};
      if (!from.phase || !from.arm) return unknown(file, "promote sidecar names no phase/arm");
      if (!index.arms.has(`${from.phase}/${from.arm}`)) return unknown(file, `promoted from ${from.phase}/${from.arm}, which is in no manifest`);
      return index.adultArms.has(`${from.phase}/${from.arm}`);
    }
    if (parts[0] === "inputs") return false;
    return unknown(file, "cell is outside images/ and inputs/");
  }

  /**
   * A sheet is adult when anything on it is. A grid spec names its cells
   * exactly; a `sheet --manifest --test` sheet is named `<phase>-<test>`,
   * which names its arms; anything else cannot be placed.
   */
  function sheet(name) {
    const specFile = path.join(outDir, "contact-sheets", "specs", `${name}.json`);
    if (existsSync(specFile)) {
      const spec = JSON.parse(readFileSync(specFile, "utf8"));
      if (!Array.isArray(spec.cells)) return unknown(`sheets/${name}`, "grid spec has no cells[]");
      const before = unclassified.length;
      const adult = spec.cells.map((entry) => cell(entry.file)).some((value) => value === true);
      return unclassified.length > before ? null : adult;
    }
    for (const phase of index.phases) {
      if (!name.startsWith(`${phase}-`)) continue;
      const rest = name.slice(phase.length + 1);
      if (index.tests.has(`${phase}/${rest}`)) return index.adultTests.has(`${phase}/${rest}`);
      if (index.adultPhases.has(phase)) return true;
    }
    return unknown(`sheets/${name}`, "no grid spec, and the name resolves to no <phase>-<test>");
  }

  return { index, render, cell, sheet, unclassified };
}
