import { describe, expect, it } from "vitest";
import {
  imageModelProfileSchema,
  imageModelSchema,
  qwenImageEdit2511Dialect,
  registerImageNegativePack,
  registerImagePositivePack,
  registerImagePromptBinding,
  registerImagePromptDialect,
  type ImageNegativePackVersion,
  type ImagePositivePackVersion,
  type ImageProfileOperation,
  type ImageProfileTask,
  type ImagePromptDialectDefinition,
  type ImagePromptStrategy,
  type ImageRenderReference,
  type ResolvedImageProfile,
} from "@vesper/image-core";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import {
  LANE_PROBE_NAME,
  LANE_PROBE_SUBJECT_ID,
  laneProbeAvatarSegments,
  laneProbeCastMember,
  laneProbeDressedExposure,
  laneProbeMarkedProfile,
  laneProbeScenePlan,
  laneProbeShadowInput,
  laneProbeVariantSegments,
  laneProbeWardrobe,
} from "@/server/test-support";
import {
  avatarShadowMeta,
  chatLookShadowMeta,
  IMAGE_SHADOW_BINDING_MISSING,
  IMAGE_SHADOW_LORA_ROUTE,
  IMAGE_SHADOW_MULTI_SUBJECT,
  sceneShadowMeta,
  shadowFactName,
  variantShadowMeta,
  type CharacterSceneShadow,
} from "./character-shadow";
import { buildChatLookSegments } from "./chat-look-segments";
import { qwenImageEdit2511NegativePack, qwenImageEdit2511PositivePack } from "./packs-qwen-2511";
import { applySceneSubjectVisual } from "./scene-subject-visual";
import {
  IMAGE_SHADOW_COMPARISON_META_KEY,
  IMAGE_SHADOW_FACT_LEAKED,
  IMAGE_SHADOW_TRANSPORT_MISMATCH,
  parseImageShadowComparison,
  type ImageShadowComparison,
} from "./shadow-comparison";

/**
 * THE ROUND 2 SHADOW WIRING (issue #256): each character lane's entry, run over
 * the same probe fixture the characterization freeze and the cutover comparison
 * use, must produce a meta fragment whose verdict parses — and must produce
 * NOTHING else. Two invariants carry the whole file:
 *
 * - **A verdict lands.** The full chain — world-digest assembly over the lane's
 *   realized cut, binding resolution on the lane's own model, the prompt-program
 *   compile, both transport captures, the structural comparison — runs to a
 *   MEASURED verdict on the seeded qwen bindings. Kills a wiring seam that
 *   throws, silently skips, or loses the digest between the lane and the
 *   comparator; the deliberate-refusal cases pin their own codes instead.
 * - **Observation only.** Every lane input is deep-frozen before the call: a
 *   shadow that wrote into the assembly, the references, or the profile — the
 *   objects production sends from — would throw inside and surface as the
 *   contained `error` verdict, which the measured-verdict assertion refuses.
 *   With the freeze pins already proving the production strings, this is the
 *   cheap spelling of "the sent payload is byte-identical with shadow present":
 *   the shadow's entire output is the one meta key asserted below.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * One resolved profile on a REAL seeded slug, so binding resolution is live.
 * `negativeField` declares a working negative-prompt input on the model — the
 * synthetic-endpoint case the compiled-negative seam test needs; the Qwen
 * fixtures leave it off, exactly like the probed endpoints.
 */
function shadowProfile(over: {
  slug: string;
  key: string;
  task: ImageProfileTask;
  operation: ImageProfileOperation;
  promptStrategy: ImagePromptStrategy;
  negativeField?: boolean;
}): ResolvedImageProfile {
  const model = imageModelSchema.parse({
    id: `mdl-shadow-${over.task}`,
    slug: over.slug,
    label: "Shadow Fixture",
    canGenerate: true,
    canEdit: true,
    referenceField: "image",
    referenceArity: "array",
    maxReferences: 3,
    supportedAspects: ["3:4"],
    ...(over.negativeField === true
      ? {
          advancedCapabilities: {
            controls: { negativePrompt: { field: "negative_prompt", type: "string" } },
            knownInputFields: ["negative_prompt"],
          },
        }
      : {}),
  });
  const profile = imageModelProfileSchema.parse({
    id: `prf-shadow-${over.key}`,
    imageModelId: model.id,
    key: over.key,
    label: "Shadow Fixture",
    task: over.task,
    operation: over.operation,
    promptStrategy: over.promptStrategy,
  });
  return { model, profile };
}

/** Deep-freeze every plain object and array; typed arrays stay as they are. */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || ArrayBuffer.isView(value) || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const member of Object.values(value)) deepFreeze(member);
  return value;
}

/** The one identity reference an edit lane sends, buffer included. */
function identityReference(): ImageRenderReference {
  return { role: "identity", buffer: Buffer.from("identity-anchor"), name: LANE_PROBE_NAME };
}

/** The parsed verdict a lane's meta fragment carries — and the ONLY key it carries. */
function verdictOf(meta: Record<string, unknown> | undefined): ImageShadowComparison {
  expect(meta).toBeDefined();
  expect(Object.keys(meta ?? {})).toEqual([IMAGE_SHADOW_COMPARISON_META_KEY]);
  const parsed = parseImageShadowComparison(meta?.[IMAGE_SHADOW_COMPARISON_META_KEY]);
  expect(parsed).not.toBeNull();
  return parsed as ImageShadowComparison;
}

/** A verdict the full chain measured — parity or divergence, never contained failure. */
function expectMeasured(verdict: ImageShadowComparison): void {
  expect(["parity", "divergence"]).toContain(verdict.verdict);
  expect(verdict.coverage.matches).not.toBeNull();
  expect(verdict.payload.compiledChars).toBeGreaterThan(0);
}

const VARIANT_INSTRUCTION = "wearing a floor-length wine-red silk kimono";

function variantInput(): Parameters<typeof variantShadowMeta>[0] {
  return {
    characterId: LANE_PROBE_SUBJECT_ID,
    characterName: LANE_PROBE_NAME,
    revision: "2026-08-30T00:00:00.000Z",
    extraRevisions: [],
    kind: "outfit",
    instruction: VARIANT_INSTRUCTION,
    assembly: laneProbeVariantSegments("outfit", VARIANT_INSTRUCTION),
    profile: shadowProfile({
      slug: "qwen/qwen-image-edit-2511",
      key: "variant-standard",
      task: "variant",
      operation: "edit",
      promptStrategy: "instruction_edit",
    }),
    references: [identityReference()],
  };
}

// ---------------------------------------------------------------------------
// The lanes
// ---------------------------------------------------------------------------

describe("character-lane shadow wiring", () => {
  it("variant: a measured, deterministic verdict from frozen production inputs", () => {
    const first = verdictOf(variantShadowMeta(deepFreeze(variantInput())));
    expect(first.lane).toBe("variant");
    expectMeasured(first);
    // Determinism is the retry contract: two shadows of one request are one
    // verdict, or the stored record could not be trusted against a re-run.
    expect(verdictOf(variantShadowMeta(deepFreeze(variantInput())))).toEqual(first);
  });

  /**
   * The emission-ledger property (owner correction 2026-08-29 #3): legacy fact
   * coverage measures what the builder ACTUALLY emitted, so a builder that
   * silently drops a digest-selected fact — no suppression record, no
   * missing-required entry — yields a coverage divergence, never parity. The
   * old digest-minus-suppressions derivation could not fail this way: it would
   * count the dropped fact as present, the compiled side comes from the same
   * digest, and the record would read as false parity.
   *
   * Simulated at the seam the bug class lives on: the ledger alone loses the
   * fixture's cataloged distinctive mark (a fact deliberately OUTSIDE the
   * lane's named delta allowlist, so nothing forgives it) while the digest and
   * the compiled program still carry it. The divergence surfaces under the
   * comparator's directional vocabulary as the compiled side stating a fact
   * the legacy build never emitted.
   */
  it("variant: a builder emission that omits a digest-selected fact is a divergence, not parity", () => {
    const assembly = laneProbeVariantSegments(
      "outfit",
      VARIANT_INSTRUCTION,
      laneProbeWardrobe(),
      laneProbeMarkedProfile(),
    );
    const markKey = assembly.emittedFactKeys.find(
      (key) => shadowFactName(key, LANE_PROBE_SUBJECT_ID) === "nose/shape",
    );
    expect(markKey).toBeDefined();
    if (markKey === undefined) throw new Error("the marked fixture emitted no nose/shape fact");
    const inputWith = (emittedFactKeys: readonly string[]): Parameters<typeof variantShadowMeta>[0] => ({
      ...variantInput(),
      assembly: { ...assembly, emittedFactKeys },
    });

    // Intact ledger: the mark is stated on BOTH sides — neither lost by the
    // compiled program nor unexplained on it — which is what makes the
    // tampered run below a test of the ledger rather than of the mark.
    const intact = verdictOf(variantShadowMeta(deepFreeze(inputWith(assembly.emittedFactKeys))));
    expectMeasured(intact);
    expect(intact.coverage.unexpected).not.toContain("nose/shape");
    expect(intact.coverage.missing).not.toContain("nose/shape");

    // The ledger loses the mark — the silent-builder-drop simulation.
    const tampered = verdictOf(
      variantShadowMeta(deepFreeze(inputWith(assembly.emittedFactKeys.filter((key) => key !== markKey)))),
    );
    expect(tampered.verdict).toBe("divergence");
    expect(tampered.codes).toContain(IMAGE_SHADOW_FACT_LEAKED);
    expect(tampered.coverage.unexpected).toContain("nose/shape");
  });

  it("avatar: binds per profile key, and records the miss for a key with no row", () => {
    const assembly = laneProbeAvatarSegments(laneProbeWardrobe());
    const shared = {
      characterId: LANE_PROBE_SUBJECT_ID,
      characterName: LANE_PROBE_NAME,
      revision: "2026-08-30T00:00:00.000Z",
      extraRevisions: [],
      assembly,
    } as const;
    const bound = verdictOf(
      avatarShadowMeta(
        deepFreeze({
          ...shared,
          profile: shadowProfile({
            slug: "qwen/qwen-image-2512",
            key: "portrait-standard",
            task: "portrait",
            operation: "generate",
            promptStrategy: "text_to_image_description",
          }),
        }),
      ),
    );
    expect(bound.lane).toBe("avatar");
    expectMeasured(bound);

    // The strict half of profile-keyed resolution, through the lane entry: a
    // profile key with no binding row records the refusal rather than borrowing
    // a sibling portrait profile's packs — and rather than failing anything.
    const sink = new DiagnosticCollector();
    const missed = verdictOf(
      avatarShadowMeta({
        // The collector must stay writable, so it joins after the freeze.
        ...deepFreeze({
          ...shared,
          profile: shadowProfile({
            slug: "qwen/qwen-image-2512",
            key: "portrait-unbound",
            task: "portrait",
            operation: "generate",
            promptStrategy: "text_to_image_description",
          }),
        }),
        sink,
      }),
    );
    expect(missed.verdict).toBe("unmeasured");
    expect(missed.codes).toEqual([IMAGE_SHADOW_BINDING_MISSING]);
    expect(sink.items.some((entry) => entry.code === IMAGE_SHADOW_BINDING_MISSING)).toBe(true);
  });

  it("chat look: a measured verdict from the committed cut, and nothing from the degraded mint", () => {
    const assembly = buildChatLookSegments({
      outfit: VARIANT_INSTRUCTION,
      outfitExposed: false,
      shadow: laneProbeShadowInput(),
      exposure: laneProbeDressedExposure(),
    });
    expect(assembly.refusal).toBeNull();
    const verdict = verdictOf(
      chatLookShadowMeta(
        deepFreeze({
          characterId: LANE_PROBE_SUBJECT_ID,
          cutId: "lane-probe-cut",
          outfit: VARIANT_INSTRUCTION,
          outfitExposed: false,
          assembly,
          profile: shadowProfile({
            slug: "qwen/qwen-image-edit-2511",
            key: "chat-look-standard",
            task: "chat_look",
            operation: "edit",
            promptStrategy: "instruction_edit",
          }),
          references: [identityReference()],
        }),
      ),
    );
    expect(verdict.lane).toBe("chat_look");
    expectMeasured(verdict);

    // The route-only mint realized no cut: there is no digest to compile a
    // program over, and a shadow that fabricated one anyway would be comparing
    // prompts nobody derives from world state.
    const degraded = buildChatLookSegments({ outfit: "", outfitExposed: false });
    expect(
      chatLookShadowMeta({
        characterId: LANE_PROBE_SUBJECT_ID,
        cutId: "lane-probe-cut",
        outfit: "",
        outfitExposed: false,
        assembly: degraded,
        profile: shadowProfile({
          slug: "qwen/qwen-image-edit-2511",
          key: "chat-look-standard",
          task: "chat_look",
          operation: "edit",
          promptStrategy: "instruction_edit",
        }),
        references: [],
      }),
    ).toBeUndefined();
  });

  it("scene: measures the single-subject cut, and records the designed refusals", () => {
    const member = laneProbeCastMember();
    const applied = applySceneSubjectVisual({
      plan: laneProbeScenePlan(member),
      member,
      shadow: laneProbeShadowInput(),
    });
    expect(applied.refusal).toBeNull();
    const slice = applied.visuals[0];
    expect(slice).toBeDefined();
    if (slice === undefined) throw new Error("the scene fixture produced no visual slice");
    const single: CharacterSceneShadow = { kind: "single", slice };
    const profile = shadowProfile({
      slug: "qwen/qwen-image-edit-2511",
      key: "scene-standard",
      task: "scene",
      operation: "edit",
      promptStrategy: "instruction_edit",
    });
    const shared = {
      profile,
      loraRoute: false,
      primaryAttempt: "edit",
      legacyPrompt: "the probe scene prompt, as the reserve-time row records it",
      references: [identityReference()],
    } as const;

    const measured = verdictOf(sceneShadowMeta(deepFreeze({ ...shared, shadow: single })));
    expect(measured.lane).toBe("scene");
    expectMeasured(measured);

    // A cast of two has no frozen comparison row BY DESIGN, and the intimate
    // LoRA slug carries no dialect: both are recorded refusals — observation
    // notes, never render failures — each under its own code.
    const multi = verdictOf(
      sceneShadowMeta({
        ...shared,
        shadow: { kind: "multi_subject", subjectIds: [LANE_PROBE_SUBJECT_ID, "probe-character-second"] },
      }),
    );
    expect(multi.verdict).toBe("unmeasured");
    expect(multi.codes).toEqual([IMAGE_SHADOW_MULTI_SUBJECT]);

    const lora = verdictOf(sceneShadowMeta({ ...shared, shadow: single, loraRoute: true }));
    expect(lora.verdict).toBe("unmeasured");
    expect(lora.codes).toEqual([IMAGE_SHADOW_LORA_ROUTE]);

    // Demo mode and a chain with no rung record nothing at all.
    expect(sceneShadowMeta({ ...shared, shadow: single, primaryAttempt: "demo" })).toBeUndefined();
    expect(sceneShadowMeta({ ...shared, shadow: single, profile: null })).toBeUndefined();
  });

  /**
   * The compiled-negative seam's INERT half (owner correction 2026-08-29 #5):
   * on the Qwen endpoints the program compiles no negative — 2511 exposes no
   * field, 2512's is ignored and its dialect declares unsupported — so the
   * seam must change nothing there: full transport parity, negative hash
   * included, on both an edit lane and the portrait lane. Falsified against a
   * seam that injects a negative control (a droppedControls or negativeHash
   * mismatch would break parity) or otherwise perturbs the constructed intent.
   */
  it("keeps the compiled-negative seam behaviorally inert on the Qwen lanes", () => {
    const variant = verdictOf(variantShadowMeta(deepFreeze(variantInput())));
    expect(variant.transport.parity).toBe(true);
    expect(variant.transport.firstMismatch).toBeNull();

    const avatar = verdictOf(
      avatarShadowMeta(
        deepFreeze({
          characterId: LANE_PROBE_SUBJECT_ID,
          characterName: LANE_PROBE_NAME,
          revision: "2026-08-30T00:00:00.000Z",
          extraRevisions: [],
          assembly: laneProbeAvatarSegments(laneProbeWardrobe()),
          profile: shadowProfile({
            slug: "qwen/qwen-image-2512",
            key: "portrait-standard",
            task: "portrait",
            operation: "generate",
            promptStrategy: "text_to_image_description",
          }),
        }),
      ),
    );
    expect(avatar.transport.parity).toBe(true);
    expect(avatar.transport.firstMismatch).toBeNull();
  });

  /**
   * The compiled-negative seam's ARMED half (owner correction 2026-08-29 #5):
   * on an endpoint whose dialect compiles a negative into a WORKING field, the
   * shadow's compiled-side intent must carry it, so `negativeHash` on that
   * capture hashes the program's negative instead of whatever
   * `planImageRender` resolves for the legacy profile. Proven end to end with
   * a synthetic dialect registered under a declared-but-unimplemented id: the
   * legacy side resolves no negative, the compiled side carries the program's,
   * and the verdict records exactly that transport divergence — firstMismatch
   * is `negativeHash`, the field the old seam could never move. Falsified
   * against the pre-correction wiring, where both captures planned the same
   * negative-free intent and this comparison read parity.
   */
  it("carries the program's compiled negative into the compiled-side capture", () => {
    const SLUG = "vesper-test/negative-probe";
    const DIALECT_ID = "seedream_45_prose" as const;
    // The 2511 dialect's positive compile, with a negative channel that
    // actually produces dedicated-field text — the endpoint shape Qwen lacks.
    registerImagePromptDialect({
      ...qwenImageEdit2511Dialect,
      id: DIALECT_ID,
      negativeSyntax: "natural_language",
      negativeTransport: "dedicated_field",
      compileNegative: (negativeInput) => ({
        text: "synthetic exclusions for the negative field",
        replacementClaims: [],
        inlineText: [],
        outcomes: negativeInput.constraints.map((constraint) => ({
          constraintId: constraint.id,
          transport: { kind: "dedicated_field", text: "synthetic exclusions for the negative field" },
        })),
      }),
    } satisfies ImagePromptDialectDefinition);
    const positivePack: ImagePositivePackVersion = {
      ...qwenImageEdit2511PositivePack,
      id: "pack-synthetic-negative-positive-v1",
      packId: "pack-synthetic-negative-positive",
      dialectId: DIALECT_ID,
    };
    const negativePack: ImageNegativePackVersion = {
      ...qwenImageEdit2511NegativePack,
      id: "pack-synthetic-negative-negative-v1",
      packId: "pack-synthetic-negative-negative",
      dialectId: DIALECT_ID,
    };
    registerImagePositivePack(positivePack);
    registerImageNegativePack(negativePack);
    registerImagePromptBinding({
      id: "binding-synthetic-negative-v1",
      profileKey: "variant-standard",
      profileId: null,
      modelId: null,
      modelSlug: SLUG,
      versionId: null,
      task: "variant",
      promptStrategy: "instruction_edit",
      promptDialectId: DIALECT_ID,
      positivePackVersionId: positivePack.id,
      negativePackVersionId: negativePack.id,
      status: "candidate",
    });

    const verdict = verdictOf(
      variantShadowMeta(
        deepFreeze({
          ...variantInput(),
          profile: shadowProfile({
            slug: SLUG,
            key: "variant-standard",
            task: "variant",
            operation: "edit",
            promptStrategy: "instruction_edit",
            negativeField: true,
          }),
        }),
      ),
    );
    expect(verdict.verdict).toBe("divergence");
    expect(verdict.codes).toContain(IMAGE_SHADOW_TRANSPORT_MISMATCH);
    expect(verdict.transport.parity).toBe(false);
    expect(verdict.transport.firstMismatch).toBe("negativeHash");
  });
});
