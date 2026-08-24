import { imageModelSchema, type ImageModel } from "@vesper/image-core";
import { describe, expect, it } from "vitest";
import {
  QWEN_MULTI_REFERENCE_IDENTITY_LOCK,
  QWEN_SINGLE_REFERENCE_IDENTITY_LOCK,
  qwenEditPromptDialect,
} from "./shared";

/**
 * The Qwen numbered-reference dialect.
 *
 * The behavior moved here from `@vesper/image-core`'s quality presets, where a
 * slug check decided whether to apply it; this suite proves the ADAPTER's copy,
 * which no longer needs one. Two defects it kills, both invisible in output:
 *
 * - **A non-idempotent rewrite.** `compileProfileRenderPlan` hashes the
 *   prepared prompt and the transport prepares again on the way out, so a
 *   second pass that changed the text makes a render refuse against its own
 *   compiled prompt. `replace` instead of `replaceAll` reintroduces exactly
 *   that: a doubled legacy lock keeps its second copy, and the next pass
 *   rewrites THAT one — one input, two answers.
 * - **A rewrite that fires when it should not.** A prompt carrying no legacy
 *   lock, or a render carrying no references, must come back byte-identical;
 *   otherwise a custom instruction silently acquires an identity claim its
 *   author did not write.
 */

const LEGACY_LOCK =
  "Generate a new image of the exact same person shown in the reference image. Preserve face, hair color and style, skin tone, body proportions, and apparent age.";

const model: ImageModel = imageModelSchema.parse({
  id: "model-qwen-edit",
  slug: "qwen/qwen-image-edit-2511",
  label: "Qwen Image Edit 2511",
  canGenerate: false,
  canEdit: true,
});

const prepare = qwenEditPromptDialect().preparePrompt;

describe("qwenEditPromptDialect", () => {
  it("numbers the identity reference and states the edit delta for a single reference", () => {
    const prompt = `${LEGACY_LOCK} Change the pose: standing by the window.`;
    const prepared = prepare?.(model, prompt, 1) ?? "";

    expect(prepared).toContain(QWEN_SINGLE_REFERENCE_IDENTITY_LOCK);
    expect(prepared).not.toContain(LEGACY_LOCK);
    expect(prepared).toContain("Change the pose: standing by the window.");
    // The edit path fits its prompt before the model is chosen, so preparation
    // may never re-expand it past the fitted budget.
    expect(prepared.length).toBeLessThanOrEqual(prompt.length);
  });

  it("uses the role-aware lock when several references are sent", () => {
    const prompt = `${LEGACY_LOCK} 3 reference images provided — image 1 is Mira; image 2 is Jo; image 3 is the cafe.`;
    const prepared = prepare?.(model, prompt, 3) ?? "";

    expect(prepared).toContain(QWEN_MULTI_REFERENCE_IDENTITY_LOCK);
    expect(prepared).toContain("image 1 is Mira");
    expect(prepared.length).toBeLessThanOrEqual(prompt.length);
  });

  it("rewrites EVERY copy of the legacy lock, so the rewrite is genuinely idempotent", () => {
    const doubled = `${LEGACY_LOCK} Then: ${LEGACY_LOCK} Change the setting.`;
    const once = prepare?.(model, doubled, 1) ?? "";

    expect(once).not.toContain(LEGACY_LOCK);
    expect(prepare?.(model, once, 1)).toBe(once);
  });

  it("leaves a referenceless render and a custom instruction alone", () => {
    const prompt = `${LEGACY_LOCK} Change the setting.`;
    expect(prepare?.(model, prompt, 0)).toBe(prompt);
    expect(prepare?.(model, "Repair the lettering only.", 1)).toBe("Repair the lettering only.");
  });
});
