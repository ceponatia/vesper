import { deliberatorResponseSchema } from "@vesper/simulation-core/contracts/deliberation";
import {
  narratorResultSchema,
  soloNarrationSchema,
  type NarrativeCut,
  type NarratorResult,
  type PresentationAudit,
} from "@vesper/simulation-core/contracts/narrative";
import type { SoftCanonProposal } from "@vesper/simulation-core/contracts/soft-canon";
import { simulationHash } from "@vesper/simulation-core/hash";
import { auditPresentation, parseNarratorResult } from "@vesper/simulation-core/presentation";
import {
  chatNarrativeModelId,
  collapseRepeatedBlocks,
  generateChecked,
  narrativeProviderOptions,
  stripNarratorArtifacts,
} from "@/server/ai";
import { db, type Db } from "@/server/db";
import { NARRATIVE_TEMPERATURE } from "./constants";
import {
  beatHandlesForCut,
  buildSimHandleMap,
  buildSimRenderPrompt,
  type SimRenderContext,
  type SimRenderCorrection,
} from "./prompts/sim-render";
import {
  latestCutIdForEngagement,
  loadPersistedCut,
  submitDurableConfirmNarratorResult,
  type PrepareTurnDeliberation,
} from "./simulation";

export type { SimRenderContext, SimRenderCorrection } from "./prompts/sim-render";

/**
 * R2 (engine.rollout.plan.md) — the live narrator over one committed cut:
 * the first real model call in the successor lane. The flow is exactly the
 * §22–23 law made live:
 *
 *   load the persisted cut → render (one model call, Aion 3.0 default via the
 *   shared picker) → §23.1 trust boundary → §23.2 structural audit →
 *   ruling-8 hidden retry from the SAME cut → on ≥1 enacted effect or
 *   proposal, `confirm_narrator_result` (system principal) arms real effects.
 *
 * A render that still fails after the retry WITHHOLDS: the committed advance
 * stays committed, nothing is presented, nothing reverts (ruling 8). The
 * model seam is injectable so every test runs zero live calls; demo mode
 * (AI_FAKE) degrades to a deterministic compliant render built from the cut's
 * own beat summaries.
 */

export interface RenderCutInput {
  branchId: string;
  engagementId: string;
  /** Render this cut; absent = the engagement's newest persisted cut. */
  cutId?: string;
  /** Curated-list model id; unknown/absent resolves to the chat default (Aion 3.0). */
  modelId?: string;
  /** Total attempts including the ruling-8 hidden retry. Default 2. */
  maxAttempts?: number;
  /** Presentation-lane input — the player's turn, authored canon, projections, dialogue tail. */
  conversation?: SimRenderContext;
}

export type RenderSeam = (args: {
  system: string;
  prompt: string;
  modelId: string;
  attempt: number;
}) => Promise<{ raw: unknown; provider?: string | null; latencyMs?: number; degraded: boolean }>;

export interface RenderCutOptions {
  database?: Db;
  /** Injected model seam — tests stub this; omitting it calls the live model. */
  render?: RenderSeam;
  /**
   * Injected cut loader — a pure test supplies a fixture; omitting reads the
   * persisted, hash-verified row (ruling 8: every attempt re-reads the SAME cut).
   */
  loadCut?: (branchId: string, cutId: string) => Promise<NarrativeCut>;
}

export interface RenderedCut {
  status: "rendered" | "withheld";
  cutId: string;
  modelId: string;
  attempts: number;
  /** Present iff status is "rendered": audited prose incl. any bridge. */
  prose?: string;
  audit?: PresentationAudit;
  result?: NarratorResult;
  /** The confirm command's outcome when ≥1 effect/proposal landed. */
  confirmStatus?: string;
  degraded: boolean;
  provider?: string | null;
  latencyMs?: number;
  diagnostics: string[];
}

/** Demo/no-key fallback: a compliant render from the cut's own beat summaries. */
function deterministicFallbackResult(cut: NarrativeCut): NarratorResult {
  return narratorResultSchema.parse({
    prose:
      cut.mustEnact.length > 0
        ? cut.mustEnact.map((beat) => beat.summary).join(" ")
        : "The moment passes quietly.",
    enactedBeatEventIds: cut.mustEnact.map((beat) => beat.eventId),
    enactedArmedEffectIds: [],
    proposedSoftCanon: [],
  });
}

function liveRenderSeam(cut: NarrativeCut): RenderSeam {
  return async ({ system, prompt, modelId }) => {
    // Provider parity with the legacy narrator lane (presentation-charter §3):
    // NARRATIVE_TEMPERATURE + the eval-ruled per-model reasoning/routing knobs.
    const providerOptions = narrativeProviderOptions(modelId);
    const generated = await generateChecked({
      schema: narratorResultSchema,
      system,
      prompt,
      modelId,
      temperature: NARRATIVE_TEMPERATURE,
      ...(providerOptions === undefined ? {} : { providerOptions }),
      maxOutputTokens: 2_000,
      code: "sim.narrator",
      fallback: () => deterministicFallbackResult(cut),
    });
    return {
      raw: generated.value,
      provider: generated.provider ?? null,
      ...(generated.latencyMs === undefined ? {} : { latencyMs: generated.latencyMs }),
      degraded: generated.degraded,
    };
  };
}

/**
 * Normalize raw model prose BEFORE the audit (presentation-charter §3, run in
 * `sim-narrator` because lib cannot import server modules): strip the narrator
 * artifact tags, collapse tandem repeats, then peel a stray wrapping code fence
 * or quote pair. The auditor then reads the same clean text the user would see.
 */
function normalizeSimProse(raw: string): string {
  const collapsed = collapseRepeatedBlocks(stripNarratorArtifacts(raw));
  let trimmed = collapsed.trim();
  const fence = /^```[A-Za-z]*\r?\n([\s\S]*?)\r?\n?```$/.exec(trimmed);
  if (fence?.[1] !== undefined) trimmed = fence[1].trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("“") && trimmed.endsWith("”")))
  ) {
    trimmed = trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

/**
 * One confirm per cut (presentation-charter hazard fix): the idempotencyKey is
 * keyed on the cutId ALONE, so the FIRST accepted confirm for a cut wins and any
 * retake — whose fresh render may enact a DIFFERENT armed-effect subset — dedupes
 * to it. Armed truth from the first accepted telling stands; a retake replaces
 * presentation, never truth. The command `id` stays per-submission for a clean
 * duplicate-id path; only the idempotencyKey collapses.
 */
export function buildConfirmCommand(args: {
  branchId: string;
  engagementId: string;
  cutId: string;
  enacted: readonly string[];
  proposals: readonly SoftCanonProposal[];
}) {
  const { branchId, engagementId, cutId, enacted, proposals } = args;
  return {
    id: `sim-narrator-confirm-${simulationHash({ cutId, enacted, proposals })}`,
    branchId,
    expectedVersion: 0,
    idempotencyKey: `sim-narrator-confirm-${simulationHash({ cutId })}`,
    principal: { kind: "system" as const, principalId: "sim-narrator", controlledActorIds: [] },
    submittedAtWallClock: new Date().toISOString(),
    correlationId: `sim-narrator-${simulationHash({ cutId })}`,
    type: "confirm_narrator_result" as const,
    schemaVersion: 2 as const,
    payload: {
      engagementId,
      cutId,
      enactedArmedEffectIds: [...enacted],
      softCanonProposals: [...proposals],
    },
  };
}

/** Build the attempt-≥2 correction from the previous attempt's audit (missing beats + prose faults). */
function correctionFromAudit(cut: NarrativeCut, audit: PresentationAudit): SimRenderCorrection {
  const handleByEvent = new Map(beatHandlesForCut(cut).map((beat) => [beat.eventId, beat]));
  const missingBeats = audit.missingBeatEventIds
    .map((eventId) => handleByEvent.get(eventId))
    .filter((beat): beat is { handle: string; eventId: string; summary: string } => beat !== undefined)
    .map((beat) => ({ handle: beat.handle, summary: beat.summary }));
  const diagnostics = new Set(audit.diagnostics);
  return {
    ...(missingBeats.length > 0 ? { missingBeats } : {}),
    ...(diagnostics.has("presentation.id_leak") ? { leaked: true } : {}),
    ...(diagnostics.has("presentation.contract_echo") ? { contractEcho: true } : {}),
    ...(audit.proseEmpty || diagnostics.has("presentation.placeholder_echo") ? { emptyProse: true } : {}),
  };
}

export async function renderCommittedCut(
  input: RenderCutInput,
  options: RenderCutOptions = {},
): Promise<RenderedCut> {
  const database = options.database ?? db();
  const modelId = chatNarrativeModelId(input.modelId);
  const maxAttempts = input.maxAttempts ?? 2;
  const diagnostics: string[] = [];

  const cutId =
    input.cutId ?? (await latestCutIdForEngagement(database, input.branchId, input.engagementId));
  if (!cutId) {
    return {
      status: "withheld",
      cutId: "",
      modelId,
      attempts: 0,
      degraded: false,
      diagnostics: ["sim.narrator.no_cut_for_engagement"],
    };
  }
  // Ruling 8: every attempt re-reads the SAME persisted, hash-verified cut.
  const loadCut =
    options.loadCut ?? ((branchId: string, id: string) => loadPersistedCut(branchId, id, { database }));
  const cut = await loadCut(input.branchId, cutId);
  const context = input.conversation ?? {};
  const render = options.render ?? liveRenderSeam(cut);
  // The handle vocabulary is deterministic per cut — the trust boundary maps the
  // model's declared B/E handles back to real ids, and the audit forbids either in prose.
  const handleMap = buildSimHandleMap(cut);
  const leakTokens = Object.keys(handleMap);
  const hadUtterance = (context.playerUtterance ?? "").trim().length > 0;

  let attempts = 0;
  let degraded = false;
  let provider: string | null | undefined;
  let latencyMs: number | undefined;
  // The targeted retry (presentation-charter §3): each attempt rebuilds the prompt,
  // and attempt ≥2 carries a CORRECTION naming exactly what the last audit rejected.
  let correction: SimRenderCorrection | undefined;
  for (; attempts < maxAttempts; ) {
    attempts += 1;
    const { system, prompt } = buildSimRenderPrompt(cut, context, {
      attempt: attempts,
      ...(correction === undefined ? {} : { correction }),
    });
    const attempt = await render({ system, prompt, modelId, attempt: attempts });
    degraded = degraded || attempt.degraded;
    provider = attempt.provider ?? provider;
    latencyMs = attempt.latencyMs ?? latencyMs;

    const parsed = parseNarratorResult(attempt.raw ?? {}, cut, undefined, handleMap);
    // Normalize BEFORE audit — the auditor reads the clean text the user would see.
    const result: NarratorResult = { ...parsed.result, prose: normalizeSimProse(parsed.result.prose) };
    const audit = auditPresentation(cut, result, {
      attempt: attempts,
      maxAttempts,
      hadUtterance,
      leakTokens,
    });
    diagnostics.push(...audit.diagnostics.map((code) => `attempt${attempts}.${code}`));
    if (audit.verdict === "rerender") {
      correction = correctionFromAudit(cut, audit);
      continue;
    }

    // Accepted (possibly with a deterministic bridge — demoted to last resort, so it
    // only lands after the feedback retry). Arm what actually landed: unknown ids were
    // flagged by the audit and dropped — the confirm re-validates against the row anyway.
    const armedIds = new Set(cut.armedEffects.map((effect) => effect.id));
    const enacted = result.enactedArmedEffectIds.filter((id) => armedIds.has(id));
    let confirmStatus: string | undefined;
    if (enacted.length > 0 || parsed.proposals.length > 0) {
      const confirm = await submitDurableConfirmNarratorResult(
        buildConfirmCommand({
          branchId: input.branchId,
          engagementId: input.engagementId,
          cutId,
          enacted,
          proposals: parsed.proposals,
        }),
        { database, admitAtLockedVersion: true },
      );
      confirmStatus = confirm.status;
      if (confirm.status === "rejected") {
        diagnostics.push(`sim.narrator.confirm_rejected:${confirm.code}`);
      }
    }

    // A bridge lands as its own paragraph, never glued mid-sentence (§3).
    const prose = audit.bridgeProse ? `${result.prose.trimEnd()}\n\n${audit.bridgeProse}` : result.prose;
    return {
      status: "rendered",
      cutId,
      modelId,
      attempts,
      prose,
      audit,
      result,
      ...(confirmStatus === undefined ? {} : { confirmStatus }),
      degraded,
      provider: provider ?? null,
      ...(latencyMs === undefined ? {} : { latencyMs }),
      diagnostics,
    };
  }

  // Ruling 8: the failed render is HIDDEN — the committed advance stands,
  // nothing is presented, nothing is reverted. The caller may retry later
  // from the very same cut.
  diagnostics.push("sim.narrator.withheld_after_retry");
  return {
    status: "withheld",
    cutId,
    modelId,
    attempts,
    degraded,
    provider: provider ?? null,
    ...(latencyMs === undefined ? {} : { latencyMs }),
    diagnostics,
  };
}

// ---------------------------------------------------------------------------
// Solo-cut render (world-ui.plan.md slice 0, ruling 21)
// ---------------------------------------------------------------------------

/** The injected model seam for a solo render — a stub in tests, the live model otherwise. */
export type SoloRenderSeam = (args: {
  system: string;
  prompt: string;
  modelId: string;
  attempt: number;
}) => Promise<{ prose: string; provider?: string | null; latencyMs?: number; degraded: boolean }>;

export interface RenderSoloInput {
  system: string;
  prompt: string;
  modelId?: string;
  /** Total attempts before falling back to the deterministic prose. Default 2. */
  maxAttempts?: number;
  /**
   * The deterministic minimal narration this render degrades to on total model
   * failure (docs/resilience.md, §18.5). MUST be non-empty so a solo turn never
   * dead-ends — the whole point of the solo cut is "never a failed turn".
   */
  fallbackProse: string;
}

export interface RenderedSolo {
  status: "rendered" | "withheld";
  modelId: string;
  attempts: number;
  /** Present iff status is "rendered": the audited, normalized prose. */
  prose?: string;
  degraded: boolean;
  provider?: string | null;
  latencyMs?: number;
  diagnostics: string[];
}

/** Live seam: one `generateChecked` call under narrator provider parity, degrading to the fallback prose. */
function liveSoloSeam(fallbackProse: string): SoloRenderSeam {
  return async ({ system, prompt, modelId }) => {
    const providerOptions = narrativeProviderOptions(modelId);
    const generated = await generateChecked({
      schema: soloNarrationSchema,
      system,
      prompt,
      modelId,
      temperature: NARRATIVE_TEMPERATURE,
      ...(providerOptions === undefined ? {} : { providerOptions }),
      maxOutputTokens: 2_000,
      code: "sim.narrator.solo",
      fallback: () => ({ prose: fallbackProse }),
    });
    return {
      prose: generated.value?.prose ?? fallbackProse,
      provider: generated.provider ?? null,
      ...(generated.latencyMs === undefined ? {} : { latencyMs: generated.latencyMs }),
      degraded: generated.degraded,
    };
  };
}

/**
 * Render one solo cut's dual-block prose. There is no committed NarrativeCut and
 * no armed effect, so this is a lean loop: render → normalize → accept if
 * non-empty, retry once, and — because a solo turn must NEVER dead-end — degrade
 * to the caller's deterministic `fallbackProse` rather than withholding. The
 * withheld branch is reachable only if even the fallback is empty (a caller bug).
 */
export async function renderSoloNarration(
  input: RenderSoloInput,
  options: { render?: SoloRenderSeam } = {},
): Promise<RenderedSolo> {
  const modelId = chatNarrativeModelId(input.modelId);
  const maxAttempts = input.maxAttempts ?? 2;
  const render = options.render ?? liveSoloSeam(input.fallbackProse);
  const diagnostics: string[] = [];

  let attempts = 0;
  let degraded = false;
  let provider: string | null | undefined;
  let latencyMs: number | undefined;
  for (; attempts < maxAttempts; ) {
    attempts += 1;
    const attempt = await render({ system: input.system, prompt: input.prompt, modelId, attempt: attempts });
    degraded = degraded || attempt.degraded;
    provider = attempt.provider ?? provider;
    latencyMs = attempt.latencyMs ?? latencyMs;
    const prose = normalizeSimProse(attempt.prose);
    if (prose.length > 0) {
      return {
        status: "rendered",
        modelId,
        attempts,
        prose,
        degraded,
        provider: provider ?? null,
        ...(latencyMs === undefined ? {} : { latencyMs }),
        diagnostics,
      };
    }
    diagnostics.push(`attempt${attempts}.sim.narrator.solo.empty`);
  }

  // Never a dead chat: the deterministic fallback stands in for a failed render.
  const fallback = normalizeSimProse(input.fallbackProse);
  if (fallback.length > 0) {
    diagnostics.push("sim.narrator.solo.degraded_to_fallback");
    return {
      status: "rendered",
      modelId,
      attempts,
      prose: fallback,
      degraded: true,
      provider: provider ?? null,
      ...(latencyMs === undefined ? {} : { latencyMs }),
      diagnostics,
    };
  }
  diagnostics.push("sim.narrator.solo.withheld_empty_fallback");
  return {
    status: "withheld",
    modelId,
    attempts,
    degraded,
    provider: provider ?? null,
    ...(latencyMs === undefined ? {} : { latencyMs }),
    diagnostics,
  };
}

/**
 * R3 (the R2 leftover) — the live §19.3 deliberator behind its budget and
 * deterministic fallback. The arbiter admits deliberation only for a rare,
 * consequential, ambiguous departure (score gap under the threshold); this
 * factory supplies the one bounded model call. A timeout, budget exhaustion,
 * or malformed reply all fall back to the deterministic policy inside the
 * arbiter — this seam can never fail a turn.
 */
export function buildLiveDeliberation(options: {
  modelId?: string;
  timeoutMs?: number;
  modelBudget?: number;
  scoreGapThresholdFixedPoint?: number;
} = {}): PrepareTurnDeliberation {
  const modelId = chatNarrativeModelId(options.modelId);
  const timeoutMs = options.timeoutMs ?? 4_000;
  return {
    scoreGapThresholdFixedPoint: options.scoreGapThresholdFixedPoint ?? 10_000,
    modelBudgetRemaining: options.modelBudget ?? 1,
    timeout: new Promise((resolve) => {
      setTimeout(() => resolve(undefined), timeoutMs).unref?.();
    }),
    deliberate: async (request) => {
      const generated = await generateChecked({
        schema: deliberatorResponseSchema,
        system:
          "You choose ONE option for a character in a simulation. Reply with strict JSON " +
          '{"chosenCandidateId": "<one of the given ids>", "rationaleSummary": "<one short sentence>"} ' +
          "and nothing else. You cannot invent options.",
        prompt: [
          `CANDIDATES: ${request.candidateIds.join(" | ")}`,
          request.evidence.length > 0 ? `EVIDENCE:\n${request.evidence.map((line) => `- ${line}`).join("\n")}` : "",
          "Pick the candidate the evidence best supports.",
        ]
          .filter(Boolean)
          .join("\n"),
        modelId,
        temperature: 0.2,
        maxOutputTokens: 300,
        code: "sim.deliberator",
      });
      return generated.value;
    },
  };
}
