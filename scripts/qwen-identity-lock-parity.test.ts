import {
  QWEN_2511_MULTI_REFERENCE_IDENTITY_LOCK,
  QWEN_2511_SINGLE_REFERENCE_IDENTITY_LOCK,
} from "@vesper/image-core";
import { QWEN_MULTI_REFERENCE_IDENTITY_LOCK, QWEN_SINGLE_REFERENCE_IDENTITY_LOCK } from "@vesper/image-models";
import { describe, expect, it } from "vitest";

/**
 * Tripwire: the Qwen identity-lock sentences exist in TWO peer packages and
 * must stay byte-identical.
 *
 * `@vesper/image-models` owns the render kernel's `qwen.numbered-reference-dialect`
 * quirk, which rewrites the legacy identity sentence into these locks on the
 * shipping edit path. `@vesper/image-core` owns the `qwen_2511_delta_edit`
 * prompt-program dialect, which compiles the same sentences from the
 * `subject.identity` claim (owner ruling 2026-08-29) so a shadow compile is
 * byte-checkable against the quirk's output. The packages are peers and may not
 * import each other, so each carries its own literal — a byte contract with no
 * code dependency to enforce it.
 *
 * Nothing else notices when the copies drift. Typecheck compares nothing across
 * the packages, and a one-word paraphrase in either copy would make every
 * shadow comparison quietly report a diff (or worse, make the cutover change
 * prompt bytes the trial never graded) while both packages keep passing their
 * own suites. The root suite is the one layer allowed to import both, which is
 * why this lives in `scripts/` — the same reason `sd-deployment-recipes.test.ts`
 * does.
 *
 * When the kernel quirk retires at cutover and `@vesper/image-models` stops
 * exporting its constants, delete this file with them.
 */

describe("the Qwen identity-lock byte contract across peer packages", () => {
  it("keeps the single-reference lock byte-identical in image-core and image-models", () => {
    expect(QWEN_2511_SINGLE_REFERENCE_IDENTITY_LOCK).toBe(QWEN_SINGLE_REFERENCE_IDENTITY_LOCK);
  });

  it("keeps the multi-reference lock byte-identical in image-core and image-models", () => {
    expect(QWEN_2511_MULTI_REFERENCE_IDENTITY_LOCK).toBe(QWEN_MULTI_REFERENCE_IDENTITY_LOCK);
  });
});
