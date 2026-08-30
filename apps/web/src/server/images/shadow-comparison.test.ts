import { describe, expect, it } from "vitest";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import type { RenderIntentCapture } from "./render-intent-capture";
import {
  compareShadowRender,
  compareShadowTransport,
  IMAGE_SHADOW_COMPARATOR_FAILED,
  IMAGE_SHADOW_COMPARISON_META_KEY,
  IMAGE_SHADOW_COVERAGE_UNMEASURED,
  IMAGE_SHADOW_FACT_DUPLICATED,
  IMAGE_SHADOW_FACT_LEAKED,
  IMAGE_SHADOW_FACT_LOST,
  IMAGE_SHADOW_MANDATORY_LOST,
  IMAGE_SHADOW_STALE_ALLOWLIST,
  IMAGE_SHADOW_TRANSPORT_MISMATCH,
  parseImageShadowComparison,
  shadowComparisonMeta,
  shadowUnmeasuredComparison,
  type ShadowRenderComparisonInput,
} from "./shadow-comparison";

/**
 * The shadow comparator — the production form of the cutover comparison's
 * rules, so a shadow verdict on a live render means what a suite failure means
 * at the fixtures. Each case names the cutover failure mode it detects: a lost
 * fact, a new leak, a duplicated fact, a stale allowlist entry hiding drift, a
 * transport field the migration was not allowed to move, and a lost mandatory
 * anchor. The comparator is also an instrument riding beside real renders, so
 * its own failure mode is tested: it must degrade to an `error` verdict with a
 * diagnostic, never throw into the render path.
 */

const PROBES = [
  { key: "horns", tokens: ["spiraled"] },
  { key: "garment", tokens: ["kimono"] },
  { key: "toenails", tokens: ["painted"] },
] as const;

const NO_DELTA = { removed: [], added: [] } as const;

function capture(over: Partial<RenderIntentCapture> = {}): RenderIntentCapture {
  return {
    task: "variant",
    profileId: "prf-variant",
    promptStrategy: "instruction_edit",
    modelSlug: "qwen/qwen-image-edit-2511",
    requestedVersionId: null,
    requestedOperation: "edit",
    promptHash: "a".repeat(64),
    negativeHash: null,
    referenceRoles: ["identity"],
    targetAspect: 0.75,
    subjectIds: ["probe-character"],
    requiredFactKeys: ["probe-character/face/apparent_age"],
    cameraFingerprint: "cam-1",
    appliedControls: {},
    droppedControls: [],
    ...over,
  };
}

function compared(over: Partial<ShadowRenderComparisonInput>): ReturnType<typeof compareShadowRender> {
  return compareShadowRender({
    lane: "variant",
    legacy: { prompt: "spiraled horns, painted toenails" },
    compiled: { prompt: "spiraled horns and a wine-red kimono", missingRequired: [] },
    probes: [...PROBES],
    allowlist: { removed: ["toenails"], added: ["garment"] },
    ...over,
  });
}

describe("fact coverage", () => {
  /**
   * The full parity shape over a REAL delta: the covered-toenail removal and
   * the garment gain are named, so nothing diverges, and the payload lengths
   * are the two prompts' own. Kills a comparator that treats any wording
   * change as failure — normalizing intentional deltas is the entire point.
   */
  it("passes when legacy ± the named allowlist is exactly the compiled fact set", () => {
    const verdict = compared({});
    expect(verdict.verdict).toBe("parity");
    expect(verdict.codes).toEqual([]);
    expect(verdict.coverage.matches).toBe(true);
    expect(verdict.payload).toEqual({
      legacyChars: "spiraled horns, painted toenails".length,
      compiledChars: "spiraled horns and a wine-red kimono".length,
    });
  });

  /**
   * Both divergence directions plus duplication, each as its own code: a lost
   * fact (horns gone), a leak (kimono with no allowlist), a duplicate (horns
   * twice). Kills the quiet cutover failure the tests upstream exist for — a
   * changed fact set hiding behind a wording diff.
   */
  it("fails on lost, leaked and duplicated facts with their own codes", () => {
    const lost = compared({ compiled: { prompt: "a wine-red kimono", missingRequired: [] } });
    expect(lost.verdict).toBe("divergence");
    expect(lost.codes).toContain(IMAGE_SHADOW_FACT_LOST);
    expect(lost.coverage.missing).toEqual(["horns"]);

    const leaked = compared({
      allowlist: { removed: ["toenails"], added: [] },
    });
    expect(leaked.codes).toContain(IMAGE_SHADOW_FACT_LEAKED);
    expect(leaked.coverage.unexpected).toEqual(["garment"]);

    const duplicated = compared({
      compiled: { prompt: "spiraled horns, spiraled horns, a kimono", missingRequired: [] },
    });
    expect(duplicated.codes).toContain(IMAGE_SHADOW_FACT_DUPLICATED);
    expect(duplicated.coverage.duplicated).toEqual(["horns"]);
  });

  /**
   * A stale allowlist is drift with a permission slip: a "removed" key the
   * legacy build never stated, an "added" key it already had, or a key no
   * probe can read. All three fail. Kills an allowlist that quietly outlives
   * the delta it named.
   */
  it("fails a stale or unreadable allowlist entry", () => {
    const sink = new DiagnosticCollector();
    const verdict = compared({
      legacy: { prompt: "spiraled horns" },
      compiled: { prompt: "spiraled horns", missingRequired: [] },
      allowlist: { removed: ["toenails"], added: ["unknowable"] },
      sink,
    });
    expect(verdict.verdict).toBe("divergence");
    expect(verdict.codes).toContain(IMAGE_SHADOW_STALE_ALLOWLIST);
    expect(verdict.coverage.staleAllowlist).toEqual(["toenails", "unknowable"]);
    expect(sink.items.some((entry) => entry.code === IMAGE_SHADOW_STALE_ALLOWLIST)).toBe(true);
  });
});

describe("structural fact lists and unmeasured coverage", () => {
  /**
   * The production coverage source: both sides NAME their facts, and the rules
   * are the probe mode's — legacy ± the named allowlist is exactly the compiled
   * set, the allowlist must be real, nothing stated twice. One walk through
   * every failure direction over sets kills a structural mode whose semantics
   * quietly diverged from the probe mode it mirrors.
   */
  it("applies the same coverage rules to named fact sets", () => {
    const allowlist = { removed: ["toenails"], added: ["garment"] };
    const parity = compared({
      facts: { legacy: ["horns", "toenails"], compiled: ["horns", "garment"] },
      allowlist,
    });
    expect(parity.verdict).toBe("parity");
    expect(parity.coverage.matches).toBe(true);

    const diverged = compared({
      facts: { legacy: ["horns", "toenails"], compiled: ["garment", "garment", "wings", "toenails"] },
      allowlist,
    });
    expect(diverged.verdict).toBe("divergence");
    expect(diverged.coverage.missing).toEqual(["horns"]);
    expect(diverged.coverage.unexpected).toEqual(["wings", "toenails"]);
    expect(diverged.coverage.duplicated).toEqual(["garment"]);
    expect(diverged.codes).toContain(IMAGE_SHADOW_FACT_LOST);
    expect(diverged.codes).toContain(IMAGE_SHADOW_FACT_LEAKED);
    expect(diverged.codes).toContain(IMAGE_SHADOW_FACT_DUPLICATED);

    const stale = compared({
      facts: { legacy: ["horns", "garment"], compiled: ["horns", "garment"] },
      allowlist,
    });
    expect(stale.codes).toContain(IMAGE_SHADOW_STALE_ALLOWLIST);
    expect(stale.coverage.staleAllowlist).toEqual(["toenails", "garment"]);
  });

  /**
   * A lane with neither a fact list nor probes gets `matches: null` and the
   * `unmeasured` verdict — never a parity claim, because parity is a cutover
   * go-ahead and this record holds no coverage evidence. A real divergence in
   * another half (a lost mandatory anchor) still outranks it. Kills a
   * comparator that reads "nothing to compare" as "nothing diverged".
   */
  it("reads absent coverage sources as unmeasured, never as parity", () => {
    const sink = new DiagnosticCollector();
    const unmeasured = compareShadowRender({
      lane: "variant",
      legacy: { prompt: "spiraled horns" },
      compiled: { prompt: "spiraled horns", missingRequired: [] },
      allowlist: NO_DELTA,
      sink,
    });
    expect(unmeasured.verdict).toBe("unmeasured");
    expect(unmeasured.codes).toEqual([IMAGE_SHADOW_COVERAGE_UNMEASURED]);
    expect(unmeasured.coverage.matches).toBeNull();
    expect(sink.items.some((entry) => entry.code === IMAGE_SHADOW_COVERAGE_UNMEASURED)).toBe(true);

    const diverged = compareShadowRender({
      lane: "variant",
      legacy: { prompt: "spiraled horns" },
      compiled: { prompt: "spiraled horns", missingRequired: ["subject.probe.apparent_age"] },
      allowlist: NO_DELTA,
    });
    expect(diverged.verdict).toBe("divergence");
    expect(diverged.codes).toContain(IMAGE_SHADOW_MANDATORY_LOST);
  });

  /**
   * The recorded-refusal factory: a deliberate shadow refusal (no binding, a
   * multi-subject cast, the LoRA route) must survive its own trip through the
   * defensive parser, or every refusal record would vanish at the gallery
   * reader that goes looking for it.
   */
  it("round-trips a recorded refusal through the meta parser", () => {
    const sink = new DiagnosticCollector();
    const refusal = shadowUnmeasuredComparison({
      lane: "scene",
      code: "image_shadow.multi_subject",
      message: "no frozen row for a cast of two",
      sink,
    });
    expect(parseImageShadowComparison(shadowComparisonMeta(refusal)[IMAGE_SHADOW_COMPARISON_META_KEY])).toEqual(
      refusal,
    );
    expect(refusal.verdict).toBe("unmeasured");
    expect(refusal.mandatory.survived).toBeNull();
    expect(sink.items.some((entry) => entry.code === "image_shadow.multi_subject")).toBe(true);
  });
});

describe("transport and mandatory survival", () => {
  /**
   * The migration may move the prompt and nothing else: a changed prompt hash
   * alone keeps parity, a changed reference roster fails it and names the
   * FIRST offending field. Kills a cutover that quietly reconfigures the
   * provider while everyone reads the wording diff.
   */
  it("allows only the prompt hash to move", () => {
    const legacy = capture({ requiredFactKeys: [], cameraFingerprint: null });
    expect(compareShadowTransport(legacy, capture({ promptHash: "b".repeat(64) }))).toEqual({
      parity: true,
      firstMismatch: null,
    });
    const verdict = compared({
      legacy: { prompt: "spiraled horns", capture: legacy },
      compiled: {
        prompt: "spiraled horns",
        capture: capture({ promptHash: "b".repeat(64), referenceRoles: [] }),
        missingRequired: [],
      },
      allowlist: NO_DELTA,
    });
    expect(verdict.transport).toEqual({ parity: false, firstMismatch: "referenceRoles" });
    expect(verdict.codes).toContain(IMAGE_SHADOW_TRANSPORT_MISMATCH);
  });

  /**
   * A lost mandatory anchor is the one divergence that would have REFUSED a
   * bound lane, so the shadow must say so: survived false, the keys recorded,
   * the verdict divergence. Kills a shadow that reports parity for a compile
   * that silently dropped the age anchor.
   */
  it("fails mandatory survival on the assembly's missing required keys", () => {
    const verdict = compared({
      compiled: {
        prompt: "spiraled horns and a wine-red kimono",
        missingRequired: ["subject.probe.apparent_age"],
      },
    });
    expect(verdict.verdict).toBe("divergence");
    expect(verdict.mandatory).toEqual({ survived: false, missing: ["subject.probe.apparent_age"] });
    expect(verdict.codes).toContain(IMAGE_SHADOW_MANDATORY_LOST);
  });
});

describe("degradation and storage", () => {
  /**
   * docs/resilience.md, applied to an instrument: a comparator handed garbage
   * returns the `error` verdict WITH its diagnostic code and never throws —
   * a shadow failure must never fail the render it observes. Fallback and
   * code asserted together, per the degradation-test rule.
   */
  it("degrades to an error verdict instead of throwing", () => {
    const sink = new DiagnosticCollector();
    const verdict = compared({
      probes: null as unknown as ShadowRenderComparisonInput["probes"],
      sink,
    });
    expect(verdict.verdict).toBe("error");
    expect(verdict.codes).toEqual([IMAGE_SHADOW_COMPARATOR_FAILED]);
    expect(sink.items.some((entry) => entry.code === IMAGE_SHADOW_COMPARATOR_FAILED)).toBe(true);
  });

  /**
   * The verdict rides `image.meta` beside the provenance keys and must come
   * back out: the meta fragment round-trips through the defensive parser, and
   * a foreign or legacy value degrades to null rather than a throw at a
   * gallery reader.
   */
  it("round-trips through the meta fragment and parses defensively", () => {
    const verdict = compared({});
    const meta = shadowComparisonMeta(verdict);
    expect(parseImageShadowComparison(meta[IMAGE_SHADOW_COMPARISON_META_KEY])).toEqual(verdict);
    expect(parseImageShadowComparison({ verdict: "parity" })).toBeNull();
  });
});
