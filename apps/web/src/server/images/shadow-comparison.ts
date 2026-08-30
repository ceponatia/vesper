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
/**
 * A side carried no capture — transport parity was not measured. Never a
 * divergence by itself, but it FORBIDS the parity claim: with nothing else
 * diverged the verdict is `unmeasured` and this code rides the stored record,
 * because `parity` is a cutover go-ahead and a record with no transport
 * evidence has not earned one.
 */
export const IMAGE_SHADOW_TRANSPORT_UNCAPTURED = "image_shadow.transport_uncaptured";
/**
 * The lane supplied neither a structural fact list nor probes — coverage was not
 * measured. Never a divergence: the record says "no evidence", not "drift". The
 * verdict is `unmeasured` unless some OTHER check diverged.
 */
export const IMAGE_SHADOW_COVERAGE_UNMEASURED = "image_shadow.coverage_unmeasured";
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
  /**
   * `parity` = cut over safely on this render's evidence; `divergence` = do
   * not; `unmeasured` = a half of the evidence is missing (a deliberate
   * refusal — no binding, a multi-subject cast, the LoRA route — a lane with
   * no usable fact list, or a transport capture that refused to plan);
   * `error` = the comparator itself failed. Parity requires EVERY half
   * measured: coverage, transport and mandatory survival.
   */
  verdict: z.enum(["parity", "divergence", "unmeasured", "error"]),
  /** Every divergence (plus any unmeasured-half reason) — empty exactly when the verdict is `parity`. */
  codes: z.array(z.string()).default((): string[] => []),
  coverage: z.object({
    /** Null when coverage was not measured — the transport-parity null pattern. */
    matches: z.boolean().nullable(),
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
    /** Null when mandatory survival was not measured (an unmeasured verdict). */
    survived: z.boolean().nullable(),
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

/**
 * Structural fact lists — the PRODUCTION coverage source. A lane's legacy
 * segments are built from the same visual digest the compiled program consumes,
 * so both sides can NAME the facts they stated (canonical shadow fact names,
 * `character-shadow.ts`) instead of proving them with prose probes; probes stay
 * the fixture-side spelling, where a curated token table exists.
 */
export interface ShadowFactSets {
  /** Fact names the lane's own segment build stated. */
  readonly legacy: readonly string[];
  /** Fact names the compiled program kept, in claim order — duplicates count. */
  readonly compiled: readonly string[];
}

/**
 * The same fact-set rules as {@link compareShadowFactCoverage}, over named sets
 * instead of probed prompts: legacy ± the named allowlist must be exactly the
 * compiled facts, the allowlist must be real over THIS render, and nothing may
 * be stated twice. Every named fact is readable by definition, so the probe-key
 * readability clause of the stale check has no structural counterpart.
 */
export function compareShadowFactSets(input: {
  readonly facts: ShadowFactSets;
  readonly allowlist: ShadowCoverageAllowlist;
}): ShadowCoverageComparison {
  const legacy = new Set(input.facts.legacy);
  const compiledCounts = new Map<string, number>();
  for (const name of input.facts.compiled) compiledCounts.set(name, (compiledCounts.get(name) ?? 0) + 1);
  const compiledPresent = [...compiledCounts.keys()];

  const staleAllowlist = [
    ...input.allowlist.removed.filter((name) => !legacy.has(name)),
    ...input.allowlist.added.filter((name) => legacy.has(name)),
  ];
  const universe = [...new Set([...input.facts.legacy, ...compiledPresent, ...input.allowlist.added])];
  const expected = new Set(
    universe.filter(
      (name) =>
        input.allowlist.added.includes(name) || (legacy.has(name) && !input.allowlist.removed.includes(name)),
    ),
  );
  const missing = [...expected].filter((name) => !compiledCounts.has(name));
  const unexpected = compiledPresent.filter((name) => !expected.has(name));
  const duplicated = compiledPresent.filter((name) => (compiledCounts.get(name) ?? 0) > 1);

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
  /**
   * Prose probes — the fixture-side coverage source. Omit (or pass empty) when
   * the lane has no curated token table; with no `facts` either, coverage reads
   * unmeasured rather than being invented.
   */
  readonly probes?: readonly ShadowFactProbe[];
  /**
   * Structural fact lists — the production coverage source, taking precedence
   * over probes when both are supplied.
   */
  readonly facts?: ShadowFactSets | null;
  readonly allowlist: ShadowCoverageAllowlist;
  readonly sink?: DiagnosticSink;
}

function capped(list: readonly string[]): string[] {
  return list.slice(0, SHADOW_LIST_LIMIT);
}

function promptChars(side: { readonly prompt?: unknown } | undefined): number {
  return typeof side?.prompt === "string" ? side.prompt.length : 0;
}

/** A coverage comparison whose `matches` may honestly be "not measured". */
type ShadowCoverageOutcome = Omit<ShadowCoverageComparison, "matches"> & { readonly matches: boolean | null };

/** The unmeasured-coverage placeholder — the transport-parity null pattern. */
const COVERAGE_UNMEASURED: ShadowCoverageOutcome = {
  matches: null,
  missing: [],
  unexpected: [],
  duplicated: [],
  staleAllowlist: [],
};

/**
 * The coverage half's source resolution: structural fact lists first (the
 * production source), prose probes second (the fixture source), and honesty
 * third — a lane that can supply neither gets `matches: null` and a diagnostic,
 * never probes invented on its behalf. A `probes` value that is present but not
 * a usable array (hostile input) falls through to the prose path and fails into
 * the comparator's own `error` containment.
 */
function resolvedShadowCoverage(input: ShadowRenderComparisonInput): {
  coverage: ShadowCoverageOutcome;
  unmeasured: boolean;
} {
  if (input.facts !== undefined && input.facts !== null) {
    return { coverage: compareShadowFactSets({ facts: input.facts, allowlist: input.allowlist }), unmeasured: false };
  }
  if (input.probes === undefined || (Array.isArray(input.probes) && input.probes.length === 0)) {
    return { coverage: COVERAGE_UNMEASURED, unmeasured: true };
  }
  return {
    coverage: compareShadowFactCoverage({
      legacyPrompt: input.legacy.prompt,
      compiledPrompt: input.compiled.prompt,
      probes: input.probes,
      allowlist: input.allowlist,
    }),
    unmeasured: false,
  };
}

function comparedShadowRender(input: ShadowRenderComparisonInput): ImageShadowComparison {
  const codes: string[] = [];
  const report = (code: string, message: string, context: Record<string, unknown>): void => {
    codes.push(code);
    input.sink?.push(diag("warn", code, message, { path: PATH, context: { lane: input.lane, ...context } }));
  };

  const { coverage, unmeasured: coverageUnmeasured } = resolvedShadowCoverage(input);
  if (coverageUnmeasured) {
    input.sink?.push(
      diag("info", IMAGE_SHADOW_COVERAGE_UNMEASURED, "no fact list and no probes — coverage unmeasured", {
        path: PATH,
        context: { lane: input.lane },
      }),
    );
  }
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

  // A real divergence outranks an unmeasured half; with no divergence an
  // unmeasured half forbids the parity claim — parity is a cutover go-ahead,
  // and a record missing coverage evidence (no fact list, no probes) OR
  // transport evidence (a side's capture refused to plan) has not earned one.
  // The unmeasured-half codes are stored whatever the verdict, so the record
  // always says which halves this render actually measured.
  const transportUnmeasured = transport.parity === null;
  const verdict =
    codes.length > 0 ? "divergence" : coverageUnmeasured || transportUnmeasured ? "unmeasured" : "parity";
  if (coverageUnmeasured) codes.push(IMAGE_SHADOW_COVERAGE_UNMEASURED);
  if (transportUnmeasured) codes.push(IMAGE_SHADOW_TRANSPORT_UNCAPTURED);
  return {
    version: 1,
    lane: input.lane,
    verdict,
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
    return shadowErrorComparison({
      lane: typeof input.lane === "string" && input.lane.length > 0 ? input.lane : "unknown",
      error,
      payload: { legacyChars: promptChars(input.legacy), compiledChars: promptChars(input.compiled) },
      ...(input.sink === undefined ? {} : { sink: input.sink }),
    });
  }
}

/**
 * A DELIBERATE shadow refusal as a stored record: no binding for this model and
 * task, a compile the program refused, a multi-subject cast with no frozen row,
 * the intimate-LoRA route. The verdict claims nothing about the lane — this
 * render produced no coverage evidence either way — and the reason rides both
 * the record's `codes` and the sink. Refusals are shadow OUTCOMES, never render
 * failures; the render this record rides beside is untouched.
 */
export function shadowUnmeasuredComparison(input: {
  readonly lane: string;
  readonly code: string;
  readonly message: string;
  readonly context?: Record<string, unknown>;
  readonly sink?: DiagnosticSink;
  readonly payload?: { legacyChars: number; compiledChars: number };
}): ImageShadowComparison {
  try {
    input.sink?.push(
      diag("info", input.code, input.message, {
        path: PATH,
        context: { lane: input.lane, ...(input.context ?? {}) },
      }),
    );
  } catch {
    // A sink that throws must not turn a recorded refusal into a render failure.
  }
  return {
    version: 1,
    lane: input.lane,
    verdict: "unmeasured",
    codes: [input.code],
    coverage: { matches: null, missing: [], unexpected: [], duplicated: [], staleAllowlist: [] },
    transport: { parity: null, firstMismatch: null },
    mandatory: { survived: null, missing: [] },
    payload: input.payload ?? { legacyChars: 0, compiledChars: 0 },
  };
}

/**
 * The comparator-failed record: the shadow instrument itself broke, the render
 * is unaffected, and the record says "no evidence" rather than pretending to a
 * verdict. Shared by {@link compareShadowRender}'s own containment and the lane
 * wiring's (`character-shadow.ts`), so the two spellings cannot drift.
 */
export function shadowErrorComparison(input: {
  readonly lane: string;
  readonly error: unknown;
  readonly sink?: DiagnosticSink;
  readonly payload?: { legacyChars: number; compiledChars: number };
}): ImageShadowComparison {
  try {
    input.sink?.push(
      diag("warn", IMAGE_SHADOW_COMPARATOR_FAILED, "the shadow comparator failed; the render is unaffected", {
        path: PATH,
        context: {
          lane: input.lane,
          error: input.error instanceof Error ? input.error.message : String(input.error),
        },
      }),
    );
  } catch {
    // A sink that throws must not resurrect the failure this factory exists to bury.
  }
  return {
    version: 1,
    lane: input.lane,
    verdict: "error",
    codes: [IMAGE_SHADOW_COMPARATOR_FAILED],
    coverage: { matches: false, missing: [], unexpected: [], duplicated: [], staleAllowlist: [] },
    transport: { parity: null, firstMismatch: null },
    mandatory: { survived: false, missing: [] },
    payload: input.payload ?? { legacyChars: 0, compiledChars: 0 },
  };
}
