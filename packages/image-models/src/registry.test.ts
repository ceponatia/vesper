import { describe, expect, it } from "vitest";
import { qwenImage2512, qwenImageEdit2511 } from "./families";
import { adapterForImageModel } from "./registry";

/**
 * Adapter resolution.
 *
 * The defect worth a permanent test is the version pin. A registry row's slug
 * may carry an `owner/name:version` suffix — every community checkpoint's row
 * does, because the bare-slug endpoint is official-models-only — and a lookup
 * keyed on the raw slug would return nothing for exactly the rows that were
 * pinned for reproducibility: no error, no diagnostic, just the family's prompt
 * dialect and cold-start budget quietly gone. The prefix cases guard the same
 * lookup from both of the other directions: a differently-named sibling endpoint
 * must not inherit an adapter because its slug EXTENDS a registered one
 * (`qwen/qwen-image-edit-2511-turbo`), and must not inherit one because a
 * registered slug extends IT (`qwen/qwen-image-2`, which every character of
 * `qwen/qwen-image-2512` begins with). Exact-key lookup is what answers both,
 * pinned or bare.
 *
 * Null is asserted as the ORDINARY answer, not an error path: most registered
 * models have no adapter and must keep rendering exactly as they do today.
 */
describe("adapterForImageModel", () => {
  it("resolves every registered Qwen endpoint, pinned or bare", () => {
    expect(adapterForImageModel("qwen/qwen-image-edit-2511")).toBe(qwenImageEdit2511);
    expect(adapterForImageModel("qwen/qwen-image-2512")).toBe(qwenImage2512);
    // The pin is a slug SHAPE the registry must survive, not a claim that this
    // row is stored pinned today: any row may be re-registered against a fixed
    // provider version, and the family's behavior does not change when it is.
    expect(
      adapterForImageModel(
        "qwen/qwen-image-edit-2511:2ef4a1e6dbbd5b8f0d8f3cbbd3a1cbee0b1d4c0f6ee1c8ad5b7f2e0c9a3d4b1e",
      ),
    ).toBe(qwenImageEdit2511);
  });

  it("declares runtime LoRA capability on the edit endpoint and not the generator", () => {
    // Replicate's current 2511 schema exposes lora_weights + lora_scale. The
    // adapter is the family-level semantic claim; the probed registry row still
    // decides whether a concrete version has the two provider bindings at render
    // time.
    expect(qwenImageEdit2511.capabilities).toContain("lora");
    expect(qwenImage2512.capabilities).not.toContain("lora");
  });

  it.each([
    "bytedance/seedream-4.5",
    "qwen/qwen-image-edit-2511-turbo",
    // Replicate's unified generate+edit endpoint, seeded by
    // drizzle/0133_qwen-image-2.sql. It shares the `qwen/qwen-image-` prefix with
    // the registered 2512 generator — 2512's whole slug starts with this one —
    // and it must NOT borrow that family's prompt dialect or execution hints:
    // nobody has written down behavior for this endpoint, so the generic path is
    // the deliberate answer, not a gap. Both the bare slug and the pinned form
    // the admin add path would store must answer the same.
    "qwen/qwen-image-2",
    "qwen/qwen-image-2:266e594fa007032292c211586354fe193d7aa4e675a1eeb0aef0c6a424468ddd",
    "",
  ])("answers null for %s, which is the ordinary no-special-behavior case", (slug) => {
    expect(adapterForImageModel(slug)).toBeNull();
  });
});
