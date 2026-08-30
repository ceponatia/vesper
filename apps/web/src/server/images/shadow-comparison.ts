import { stableJson } from "@vesper/image-core";
import { z } from "zod";
import { diag, type DiagnosticSink } from "@/contracts/diagnostics";
import type { RenderIntentCapture } from "./render-intent-capture";

/**
 * THE SHADOW-COMPARISON ENGINE — the production form of the semantics
 * `lane-cutover-comparison.test.ts` proves at the fixtures, for Round 1 of the
 * character-lane cutover (issue #256).
 *
 * A character lane in shadow builds the compiled prompt program BESIDE its
 * legacy string and ships the legacy string unchanged (owner ruling 2026-08-29:
 * the shadow phase is non-destructive). What it records is this module's
 * verdict: did the compiled side state the same character facts modulo the
 * lane's NAMED delta allowlist, configure the same transport, keep every
 * mandatory anchor, and at what payload cost. The comparison rules are the test
 * suite's, verbatim in spirit:
 *
 * - **Fact coverage** — legacy facts ± the named allowlist must be exactly the
 *   compiled facts, the allowlist entries must be REAL (a "removed" key the
 *   legacy build never stated, or an "added" key it already had, is a stale
 *   allowlist hiding drift), and no fact may be stated twice.
 * - **Transport parity** — everything a provider is configured with must be
 *   equal; only the prompt hash may move, because moving the prompt is the
 *   migration. The digest-only provenance fields (`requiredFactKeys`,
 *   `cameraFingerprint`) are excluded from parity and checked separately.
 * - **Mandatory survival** — the compiled assembly lost no required anchor.
 *
 * Probes are DATA the lane supplies, exactly as the delta allowlist is: a probe
 * names a fact and the words that prove it reached a prompt, so any wording of
 * the fact matches and a dropped fact does not. The engine never invents
 * probes — deriving "which word proves this fact" from a digest would be the
 * engine guessing semantics, which is the adapter stack's job.
 *
 * **A shadow failure never fails the render** (docs/resilience.md): the
 * comparator is total over its inputs, returns an `error` verdict with a
 * diagnostic instead of throwing, and everything it produces is observational.
 * The compact verdict rides `image.meta` under
 * {@link IMAGE_SHADOW_COMPARISON_META_KEY}, beside the `promptProgram` and
 * `worldState` provenance keys — no schema change; full diagnostics stay on the
 * sink, log-only.
 */

// ---------------------------------------------------------------------------
// Diagnostic codes
// ---------------------------------------------------------------------------

const PATH = "images.shadow_comparison";

/** A fact the legacy prompt states that the compiled prompt lost. */
export const IMAGE_SHADOW_FACT_LOST = "image_shadow.fact_lost";
/** A fact the compiled prompt states that neither legacy nor the allowlist explains. */
export const IMAGE_SHADOW_FACT_LEAKED = "image_shadow.fact_leaked";
/** A fact the compiled prompt states more than once. */
export const IMAGE_SHADOW_FACT_DUPLICATED = "image_shadow.fact_duplicated";
/** An allowlist entry that is not real — stale deltas hide drift. */
export const IMAGE_SHADOW_STALE_ALLOWLIST = "image_shadow.stale_allowlist";
/** The two captures disagree on something a provider is configured with. */
export const IMAGE_SHADOW_TRANSPORT_MISMATCH = "image_shadow.transport_mismatch";
/** A side carried no capture — parity was not measured. Log-only, never a divergence. */
export const IMAGE_SHADOW_TRANSPORT_UNCAPTURED = "image_shadow.transport_uncaptured";
/** The compiled assembly lost a mandatory anchor. */
export const IMAGE_SHADOW_MANDATORY_LOST = "image_shadow.mandatory_lost";
/** The compiled capture carries no digest provenance — the shadow never read the digest. */
export const IMAGE_SHADOW_PROVENANCE_MISSING = "image_shadow.provenance_missing";
/** The comparator itself failed; the render is unaffected. */
export const IMAGE_SHADOW_COMPARATOR_FAILED = "image_shadow.comparator_failed";

// ---------------------------------------------------------------------------
// The compact stored verdict (owner ruling 2026-08-29)
// ---------------------------------------------------------------------------

/** Where the verdict rides on `image.meta`, beside `promptProgram`/`worldState`. */
export const IMAGE_SHADOW_COMPARISON_META_KEY = "shadowComparison";

/**
 * The stored record is compact BY CAP: each list keeps its first entries up to
 * this limit and the full list goes to the sink. Sixteen covers every curated
 * probe table today; a production probe set large enough to overflow it is
 * telling the operator to read the log, not the row.
 */
const SHADOW_LIST_LIMIT = 16;

export const imageShadowComparisonSchema = z.object({
  version: z.literal(1),
  /** The lane that ran the shadow — `avatar`, `variant`, `scene`, `chat_look`. */
  lane: z.string().min(1),
  /** `parity` = cut over safely on this render's evidence; `divergence` = do not. */
  verdict: z.enum(["parity", "divergence", "error"]),
  /** Every divergence, as diagnostic codes — empty exactly when the verdict is `parity`. */
  codes: z.array(z.string()).default((): string[] => []),
  coverage: z.object({
    matches: z.boolean(),
    /** Probe keys expected on the compiled side and absent — lost facts. */
    missing: z.array(z.string()),
    /** Probe keys present on the compiled side that nothing explains — new leaks. */
    unexpected: z.array(z.string()),
    /** Probe keys the compiled prompt states more than once. */
    duplicated: z.array(z.string()),
    /** Allowlist entries that are not real deltas over this render. */
    staleAllowlist: z.array(z.string()),
  }),
  transport: z.object({
    /** Null when either side carried no capture — unmeasured, not passing. */
    parity: z.boolean().nullable(),
    /** The first differing transport field, in declaration order. */
    firstMismatch: z.string().nullable(),
  }),
  mandatory: z.object({
    survived: z.boolean(),
    /** The compiled assembly's missing required keys, sorted. */
    missing: z.array(z.string()),
  }),
  payload: z.object({
    legacyChars: z.number().int().min(0),
    compiledChars: z.number().int().min(0),
  }),
});
export type ImageShadowComparison = z.infer<typeof imageShadowComparisonSchema>;

/** The meta fragment a lane merges onto the image row. */
export function shadowComparisonMeta(comparison: ImageShadowComparison): Record<string, unknown> {
  return { [IMAGE_SHADOW_COMPARISON_META_KEY]: comparison };
}

/** Parse a stored verdict defensively — old rows and foreign writers degrade to null. */
export function parseImageShadowComparison(value: unknown): ImageShadowComparison | null {
  const parsed = imageShadowComparisonSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

// ---------------------------------------------------------------------------
// Fact coverage
// ---------------------------------------------------------------------------

/**
 * One character fact and the words that prove it reached a prompt. Tokens are
 * matched case-insensitively over whitespace-collapsed text; a probe counts the
 * total across its tokens, so a fact stated twice reads as 2 whichever synonym
 * each site chose. Same semantics as the test-side probe table, so a verdict
 * here means what a suite failure there means.
 */
export interface ShadowFactProbe {
  readonly key: string;
  readonly tokens: readonly string[];
}

/** The lane's NAMED intentional deltas — the only divergences that do not fail. */
export interface ShadowCoverageAllowlist {
  /** Probe keys the legacy build states that the compiled build deliberately does not. */
  readonly removed: readonly string[];
  /** Probe keys the compiled build states that the legacy build never did. */
  readonly added: readonly string[];
}

export interface ShadowCoverageComparison {
  readonly matches: boolean;
  readonly missing: readonly string[];
  readonly unexpected: readonly string[];
  readonly duplicated: readonly string[];
  readonly staleAllowlist: readonly string[];
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return count;
    count += 1;
    from = at + needle.length;
  }
}

/** How many times one probe's fact appears in a prompt. */
function observedCount(prompt: string, probe: ShadowFactProbe): number {
  const text = prompt.replace(/\s+/gu, " ").toLowerCase();
  return probe.tokens.reduce((total, token) => total + countOccurrences(text, token.toLowerCase()), 0);
}

/**
 * The fact-set comparison: legacy facts ± the named allowlist must be exactly
 * the compiled facts, the allowlist must be real, and nothing may be stated
 * twice on the compiled side. An allowlist key no probe can read is stale by
 * definition — an unverifiable delta is no assertion at all.
 */
export function compareShadowFactCoverage(input: {
  readonly legacyPrompt: string;
  readonly compiledPrompt: string;
  readonly probes: readonly ShadowFactProbe[];
  readonly allowlist: ShadowCoverageAllowlist;
}): ShadowCoverageComparison {
  const probeKeys = new Set(input.probes.map((probe) => probe.key));
  const legacyPresent = new Set(
    input.probes.filter((probe) => observedCount(input.legacyPrompt, probe) > 0).map((probe) => probe.key),
  );
  const compiledCounts = new Map(
    input.probes.map((probe) => [probe.key, observedCount(input.compiledPrompt, probe)]),
  );

  const staleAllowlist = [
    ...input.allowlist.removed.filter((key) => !probeKeys.has(key) || !legacyPresent.has(key)),
    ...input.allowlist.added.filter((key) => !probeKeys.has(key) || legacyPresent.has(key)),
  ];
  const expected = new Set(
    input.probes
      .map((probe) => probe.key)
      .filter(
        (key) =>
          input.allowlist.added.includes(key) ||
          (legacyPresent.has(key) && !input.allowlist.removed.includes(key)),
      ),
  );
  const compiledPresent = input.probes
    .map((probe) => probe.key)
    .filter((key) => (compiledCounts.get(key) ?? 0) > 0);
  const missing = [...expected].filter((key) => !compiledPresent.includes(key));
  const unexpected = compiledPresent.filter((key) => !expected.has(key));
  const duplicated = input.probes
    .filter((probe) => (compiledCounts.get(probe.key) ?? 0) > 1)
    .map((probe) => probe.key);

  return {
    matches:
      missing.length === 0 && unexpected.length === 0 && duplicated.length === 0 && staleAllowlist.length === 0,
    missing,
    unexpected,
    duplicated,
    staleAllowlist,
  };
}

// ---------------------------------------------------------------------------
// Transport parity
// ---------------------------------------------------------------------------

/**
 * Everything a cutover is NOT allowed to move, in declaration order. The three
 * absent capture fields are the allowed movers: `promptHash` (moving the prompt
 * is the migration) and the digest-only `requiredFactKeys`/`cameraFingerprint`
 * (which a legacy build by definition cannot carry).
 */
const SHADOW_TRANSPORT_FIELDS: readonly (keyof RenderIntentCapture)[] = [
  "task",
  "profileId",
  "promptStrategy",
  "modelSlug",
  "requestedVersionId",
  "requestedOperation",
  "negativeHash",
  "referenceRoles",
  "targetAspect",
  "subjectIds",
  "appliedControls",
  "droppedControls",
];

export interface ShadowTransportComparison {
  readonly parity: boolean;
  readonly firstMismatch: string | null;
}

/** Field-by-field parity over the comparable transport record; first mismatch named. */
export function compareShadowTransport(
  legacy: RenderIntentCapture,
  compiled: RenderIntentCapture,
): ShadowTransportComparison {
  for (const field of SHADOW_TRANSPORT_FIELDS) {
    if (stableJson(legacy[field]) !== stableJson(compiled[field])) {
      return { parity: false, firstMismatch: field };
    }
  }
  return { parity: true, firstMismatch: null };
}

// ---------------------------------------------------------------------------
// The per-render verdict
// ---------------------------------------------------------------------------

export interface ShadowRenderComparisonInput {
  readonly lane: string;
  readonly legacy: {
    readonly prompt: string;
    /** The transport capture, when the lane took one. Omit and parity reads unmeasured. */
    readonly capture?: RenderIntentCapture | null;
  };
  readonly compiled: {
    readonly prompt: string;
    readonly capture?: RenderIntentCapture | null;
    /** The assembly's aggregated missing mandatory keys. */
    readonly missingRequired?: readonly string[];
  };
  readonly probes: readonly ShadowFactProbe[];
  readonly allowlist: ShadowCoverageAllowlist;
  readonly sink?: DiagnosticSink;
}

function capped(list: readonly string[]): string[] {
  return list.slice(0, SHADOW_LIST_LIMIT);
}

function promptChars(side: { readonly prompt?: unknown } | undefined): number {
  return typeof side?.prompt === "string" ? side.prompt.length : 0;
}

function comparedShadowRender(input: ShadowRenderComparisonInput): ImageShadowComparison {
  const codes: string[] = [];
  const report = (code: string, message: string, context: Record<string, unknown>): void => {
    codes.push(code);
    input.sink?.push(diag("warn", code, message, { path: PATH, context: { lane: input.lane, ...context } }));
  };

  const coverage = compareShadowFactCoverage({
    legacyPrompt: input.legacy.prompt,
    compiledPrompt: input.compiled.prompt,
    probes: input.probes,
    allowlist: input.allowlist,
  });
  if (coverage.missing.length > 0) {
    report(IMAGE_SHADOW_FACT_LOST, "the compiled prompt lost character facts the legacy prompt states", {
      missing: coverage.missing,
    });
  }
  if (coverage.unexpected.length > 0) {
    report(IMAGE_SHADOW_FACT_LEAKED, "the compiled prompt states facts nothing explains", {
      unexpected: coverage.unexpected,
    });
  }
  if (coverage.duplicated.length > 0) {
    report(IMAGE_SHADOW_FACT_DUPLICATED, "the compiled prompt states a fact more than once", {
      duplicated: coverage.duplicated,
    });
  }
  if (coverage.staleAllowlist.length > 0) {
    report(IMAGE_SHADOW_STALE_ALLOWLIST, "a delta allowlist entry is not a real delta over this render", {
      staleAllowlist: coverage.staleAllowlist,
    });
  }

  const legacyCapture = input.legacy.capture ?? null;
  const compiledCapture = input.compiled.capture ?? null;
  let transport: ShadowTransportComparison | { parity: null; firstMismatch: null };
  if (legacyCapture === null || compiledCapture === null) {
    transport = { parity: null, firstMismatch: null };
    input.sink?.push(
      diag("info", IMAGE_SHADOW_TRANSPORT_UNCAPTURED, "a side carried no transport capture; parity unmeasured", {
        path: PATH,
        context: { lane: input.lane, legacy: legacyCapture !== null, compiled: compiledCapture !== null },
      }),
    );
  } else {
    transport = compareShadowTransport(legacyCapture, compiledCapture);
    if (!transport.parity) {
      report(IMAGE_SHADOW_TRANSPORT_MISMATCH, "the compiled render would configure the provider differently", {
        firstMismatch: transport.firstMismatch,
      });
    }
  }
  if (compiledCapture !== null && compiledCapture.requiredFactKeys.length === 0) {
    report(IMAGE_SHADOW_PROVENANCE_MISSING, "the compiled capture carries no digest provenance", {});
  }

  const mandatoryMissing = [...(input.compiled.missingRequired ?? [])].sort();
  if (mandatoryMissing.length > 0) {
    report(IMAGE_SHADOW_MANDATORY_LOST, "the compiled assembly lost mandatory anchors", {
      missing: mandatoryMissing,
    });
  }

  return {
    version: 1,
    lane: input.lane,
    verdict: codes.length === 0 ? "parity" : "divergence",
    codes,
    coverage: {
      matches: coverage.matches,
      missing: capped(coverage.missing),
      unexpected: capped(coverage.unexpected),
      duplicated: capped(coverage.duplicated),
      staleAllowlist: capped(coverage.staleAllowlist),
    },
    transport: { parity: transport.parity, firstMismatch: transport.firstMismatch },
    mandatory: { survived: mandatoryMissing.length === 0, missing: capped(mandatoryMissing) },
    payload: { legacyChars: promptChars(input.legacy), compiledChars: promptChars(input.compiled) },
  };
}

/**
 * Compare one shadow render and produce the compact stored verdict.
 *
 * Total over its inputs: any internal failure — malformed probes, a hostile
 * capture, anything — degrades to an `error` verdict with
 * {@link IMAGE_SHADOW_COMPARATOR_FAILED} on the record and the sink, because a
 * diagnostic instrument that could fail the render it observes would be worse
 * than no instrument. The `error` verdict claims nothing about the lane: it
 * says this render produced no evidence either way.
 */
export function compareShadowRender(input: ShadowRenderComparisonInput): ImageShadowComparison {
  try {
    return comparedShadowRender(input);
  } catch (error) {
    const lane = typeof input.lane === "string" && input.lane.length > 0 ? input.lane : "unknown";
    try {
      input.sink?.push(
        diag("warn", IMAGE_SHADOW_COMPARATOR_FAILED, "the shadow comparator failed; the render is unaffected", {
          path: PATH,
          context: { lane, error: error instanceof Error ? error.message : String(error) },
        }),
      );
    } catch {
      // A sink that throws must not resurrect the failure this catch exists to bury.
    }
    return {
      version: 1,
      lane,
      verdict: "error",
      codes: [IMAGE_SHADOW_COMPARATOR_FAILED],
      coverage: { matches: false, missing: [], unexpected: [], duplicated: [], staleAllowlist: [] },
      transport: { parity: null, firstMismatch: null },
      mandatory: { survived: false, missing: [] },
      payload: { legacyChars: promptChars(input.legacy), compiledChars: promptChars(input.compiled) },
    };
  }
}
