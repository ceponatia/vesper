import { describe, expect, it } from "vitest";
import { evaluateIdentityLoraBinding, type IdentityLoraBindingState } from "./identity-lora-bindings";

/**
 * **An unpromoted character LoRA is usable, and a superseded one is not.**
 *
 * Those two sentences are the whole decision, and each kills a different bad
 * implementation that a reasonable person would write:
 *
 * 1. `state === "active"` as the usability test. It reads perfectly natural and
 *    it breaks Stage 4 outright: rank 8 and rank 16 both land as `experimental`
 *    precisely so they can be RENDERED and compared, and a rule that refused an
 *    unpromoted binding would make promotion impossible — nothing could ever be
 *    graded into being the winner.
 * 2. Judging supersession before retirement. A losing trial arm stays refused
 *    however the pack moves; an implementation that checked the pack first would
 *    report a retired binding as merely superseded, and a caller acting on the
 *    reason would "fix" it by re-cropping the character.
 * 3. Treating a missing current pack as fresh. A character with no current pack
 *    has no canonical face, so nothing can claim to be a likeness of it — and
 *    the failure is silent: renders keep working and slowly stop being the
 *    character.
 *
 * Table-driven because the rule is one function of two inputs, and the table is
 * the specification.
 */

const PACK = "pack-current";

const cases: readonly {
  readonly name: string;
  readonly state: IdentityLoraBindingState;
  readonly identityPackId: string;
  readonly currentIdentityPackId: string | null;
  readonly expected: string;
}[] = [
  {
    name: "an experimental binding on the current pack",
    state: "experimental",
    identityPackId: PACK,
    currentIdentityPackId: PACK,
    expected: "usable",
  },
  {
    name: "the promoted binding on the current pack",
    state: "active",
    identityPackId: PACK,
    currentIdentityPackId: PACK,
    expected: "usable",
  },
  {
    name: "a retired binding on the current pack",
    state: "retired",
    identityPackId: PACK,
    currentIdentityPackId: PACK,
    expected: "retired",
  },
  {
    name: "a retired binding whose pack was also superseded",
    state: "retired",
    identityPackId: "pack-old",
    currentIdentityPackId: PACK,
    expected: "retired",
  },
  {
    name: "an active binding on a superseded pack revision",
    state: "active",
    identityPackId: "pack-old",
    currentIdentityPackId: PACK,
    expected: "identity_pack_superseded",
  },
  {
    name: "any binding when the character has no current pack",
    state: "active",
    identityPackId: PACK,
    currentIdentityPackId: null,
    expected: "identity_pack_superseded",
  },
];

describe("evaluateIdentityLoraBinding", () => {
  it.each(cases)("$name is $expected", ({ state, identityPackId, currentIdentityPackId, expected }) => {
    const usability = evaluateIdentityLoraBinding({ binding: { identityPackId, state }, currentIdentityPackId });
    expect(usability.usable ? "usable" : usability.reason).toBe(expected);
  });
});
