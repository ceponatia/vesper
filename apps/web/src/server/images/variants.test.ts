import { describe, expect, it } from "vitest";
import type { ImageLoraRenderBinding } from "@vesper/image-core";
import { IMAGE_SUBJECT_INTIMATE_ANATOMY_CONCEPT } from "@/contracts/images/subject-reveal";
import type { PortraitVariantKind } from "@/contracts/images/portrait-variant";
import {
  attr,
  identityCandidateFixture as candidate,
  identityProvenanceFixture as record,
  LANE_PROBE_NAME,
  LANE_PROBE_SUBJECT_ID,
  laneProbeProfile,
  laneProbeVariantCut,
  resolvedImageProfileFixture,
} from "@/server/test-support";
import { isCharacterPromptCompiled, type CharacterPromptProgram } from "./character-prompt-program";
import type { IdentityPackRenderReferencesResult } from "./identity-pack-consume";
import { activeVariantProgram, NSFW_TEST_VARIANT_KIND } from "./variants";

/**
 * THE `nsfw_test` BENCH'S MISSING INPUT (issue #430).
 *
 * `activeVariantProgram` compiled the bench kind through the shared character
 * seam without ever passing `intimateReveal`, so a successfully paired
 * anatomy-LoRA route stated coverage exactly like an ordinary variant and
 * never asked the compiled prompt for the exposed anatomy the LoRA test
 * exists to evaluate. The fix threads `intimateReveal: true` through the seam
 * only for a SUCCESSFULLY resolved `nsfw_test` route
 * (`inputs.nsfwRoute?.ok`), which projects the cut's applicable exposed
 * anatomy as typed `subject.intimate_anatomy` facts
 * (`subjectIntimateRevealFacts`, `contracts/images/subject-reveal.ts`) beside
 * the compiled text — the same mechanism the scene lane
 * (`scene.ts` `intimateReveal: allowIntimateFor(id)`) and the staged bench
 * (`image-lab-staged.ts`) already use. The cut's own `intimateAllowed` stays
 * `false` throughout (docs/images/pipelines/portrait-variants.md §The cut) —
 * this is a route-level projection beside the digest, never a change to what
 * the digest itself may carry.
 *
 * `activeVariantProgram` is exported (module-private otherwise) so this suite
 * can call it directly with hand-built `VariantProgramInputs`: pure data in,
 * a `CharacterPromptProgramResult` out, no database and nothing mocked.
 * Binding resolution runs on the REAL production Qwen 2511 `variant-standard`
 * row (`packs-qwen-2511.ts`, imported for its registration side effect by
 * `character-prompt-program.ts`), exactly as `character-prompt-program.test.ts`
 * resolves the variant lane.
 */

/** The resolved profile every case compiles on — the real bound Qwen 2511 variant row. */
const RESOLVED_PROFILE = resolvedImageProfileFixture({
  slug: "qwen/qwen-image-edit-2511",
  task: "variant",
  key: "variant-standard",
});

/** A paired LoRA binding, shaped as `pairProfileWithNsfwLora` hands one back. */
const NSFW_LORA_BINDING: ImageLoraRenderBinding = {
  id: "imglorqwennsfwallinclv20",
  label: "Qwen Image Edit 2511 NSFW all inclusive v2.0",
  locator: "https://civitai.com/api/download/models/3160956?type=Model&format=SafeTensor",
  scale: 1,
  promptPrefix: null,
  promptSuffix: null,
  triggerWords: [],
};

/**
 * The probe sheet plus the three re-tiered surface facts, in disjoint words —
 * the same fixture `character-prompt-program.test.ts`'s "breast detail a
 * covered torso cannot show" suite builds, reused here rather than
 * re-authored.
 */
const SURFACE_PROFILE = laneProbeProfile({
  attributes: [
    ...laneProbeProfile().attributes,
    attr("breasts.shape", "teardrop", "base"),
    attr("breasts.augmentation", "obviously_augmented", "base"),
    attr("breasts.fullness", "plump", "base"),
  ],
});

const SURFACE_WORDS = [/teardrop/i, /augment/i, /plump/i];

/** The bare-torso variant cut — wardrobe `[]` — over the surface profile above. */
const BARE_TORSO_CUT = laneProbeVariantCut([], SURFACE_PROFILE);

const CHARACTER = { name: LANE_PROBE_NAME, updatedAt: new Date("2026-08-30T00:00:00.000Z") };

const PACK_BUFFER = Buffer.from("lane-probe-identity-bytes");

/** One resolved identity-pack selection — the only pack shape `activeVariantProgram` reads. */
function packSelection(): Extract<IdentityPackRenderReferencesResult, { ok: true }> {
  return {
    ok: true,
    references: [
      {
        reference: {
          role: "identity",
          required: true,
          priority: 1,
          sourceImageId: "img-probe-nyx",
          buffer: PACK_BUFFER,
        },
        provenance: record("canonical_identity", "img-probe-nyx"),
        candidate: candidate("canonical_identity", true, "img-probe-nyx"),
        source: "uploaded",
      },
    ],
    provenance: [record("canonical_identity", "img-probe-nyx")],
  };
}

/**
 * One `activeVariantProgram` call over the shared bare-torso cut, varying only
 * the variant kind and the bench route's answer — the two inputs the seam's
 * `intimateReveal` decision is gated on.
 */
function programFor(
  kind: PortraitVariantKind,
  nsfwRoute: null | { readonly ok: true } | { readonly ok: false; readonly error: string },
) {
  return activeVariantProgram({
    character: CHARACTER,
    resolved: RESOLVED_PROFILE,
    cut: BARE_TORSO_CUT,
    nsfwRoute:
      nsfwRoute === null
        ? null
        : nsfwRoute.ok
          ? { ok: true, profile: RESOLVED_PROFILE, binding: NSFW_LORA_BINDING }
          : { ok: false, error: nsfwRoute.error },
    packSelection: packSelection(),
    input: {
      characterId: LANE_PROBE_SUBJECT_ID,
      userId: "user-probe",
      kind,
      instruction: "the studio's fixed bench instruction",
    },
    revisions: [],
  });
}

function compiled(result: ReturnType<typeof programFor>): CharacterPromptProgram {
  if (result === null || !isCharacterPromptCompiled(result)) {
    throw new Error(`expected a compiled program, got ${result === null ? "null" : result.kind}`);
  }
  return result;
}

describe("the nsfw_test bench asks the seam for the anatomy it tests (#430)", () => {
  it("compiles typed subject.intimate_anatomy facts and the surface words over a bare-torso cut", () => {
    const program = compiled(programFor(NSFW_TEST_VARIANT_KIND, { ok: true }));

    const facts = program.subjects.flatMap((subject) => subject.facts);
    expect(facts.some((fact) => fact.concept === IMAGE_SUBJECT_INTIMATE_ANATOMY_CONCEPT)).toBe(true);
    for (const word of SURFACE_WORDS) expect(program.prompt).toMatch(word);
  });

  it("leaves an ordinary pose variant over the SAME cut with no intimate facts or surface words", () => {
    const program = compiled(programFor("pose", null));

    const facts = program.subjects.flatMap((subject) => subject.facts);
    expect(facts.some((fact) => fact.concept === IMAGE_SUBJECT_INTIMATE_ANATOMY_CONCEPT)).toBe(false);
    for (const word of SURFACE_WORDS) expect(program.prompt).not.toMatch(word);
    // The ordinary-route exception: breast SIZE reads through clothing (and
    // through no clothing) regardless of the bench route — only the surface
    // detail above is gated on it.
    expect(program.prompt).toMatch(/an ample bust/i);
  });

  it("returns null for a FAILED bench route, unchanged from before this fix", () => {
    const program = programFor(NSFW_TEST_VARIANT_KIND, {
      ok: false,
      error: "the NSFW test LoRA is unavailable (model): no active row",
    });

    expect(program).toBeNull();
  });
});
