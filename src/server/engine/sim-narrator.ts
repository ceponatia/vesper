import { deliberatorResponseSchema } from "@/contracts/simulation/deliberation";
import {
  narratorResultSchema,
  type NarrativeCut,
  type NarratorResult,
  type PresentationAudit,
} from "@/contracts/simulation/narrative";
import { resolveChatModelId } from "@/lib/narrative-models";
import {
  auditPresentation,
  buildCutRenderPrompt,
  parseNarratorResult,
  simulationHash,
  type CutRenderConversation,
} from "@/lib/simulation";
import { generateChecked } from "@/server/ai";
import { db, type Db } from "@/server/db";
import {
  latestCutIdForEngagement,
  loadPersistedCut,
  submitDurableConfirmNarratorResult,
  type PrepareTurnDeliberation,
} from "./simulation";

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
  /** Presentation-lane conversational input — the player's turn + dialogue tail. */
  conversation?: CutRenderConversation;
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
    const generated = await generateChecked({
      schema: narratorResultSchema,
      system,
      prompt,
      modelId,
      temperature: 0.8,
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

export async function renderCommittedCut(
  input: RenderCutInput,
  options: RenderCutOptions = {},
): Promise<RenderedCut> {
  const database = options.database ?? db();
  const modelId = resolveChatModelId(input.modelId);
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
  const cut = await loadPersistedCut(input.branchId, cutId, { database });
  const { system, prompt } = buildCutRenderPrompt(cut, input.conversation ?? {});
  const render = options.render ?? liveRenderSeam(cut);

  let attempts = 0;
  let degraded = false;
  let provider: string | null | undefined;
  let latencyMs: number | undefined;
  for (; attempts < maxAttempts; ) {
    attempts += 1;
    const attempt = await render({ system, prompt, modelId, attempt: attempts });
    degraded = degraded || attempt.degraded;
    provider = attempt.provider ?? provider;
    latencyMs = attempt.latencyMs ?? latencyMs;

    const parsed = parseNarratorResult(attempt.raw ?? {}, cut);
    const audit = auditPresentation(cut, parsed.result);
    diagnostics.push(...audit.diagnostics.map((code) => `attempt${attempts}.${code}`));
    if (audit.verdict === "rerender") continue;

    // Accepted (possibly with a deterministic bridge). Arm what actually
    // landed: unknown ids were flagged by the audit and are simply dropped —
    // the confirm command re-validates against the persisted row anyway.
    const armedIds = new Set(cut.armedEffects.map((effect) => effect.id));
    const enacted = parsed.result.enactedArmedEffectIds.filter((id) => armedIds.has(id));
    let confirmStatus: string | undefined;
    if (enacted.length > 0 || parsed.proposals.length > 0) {
      const confirm = await submitDurableConfirmNarratorResult(
        {
          id: `sim-narrator-confirm-${simulationHash({ cutId, enacted, proposals: parsed.proposals })}`,
          branchId: input.branchId,
          expectedVersion: 0,
          idempotencyKey: `sim-narrator-confirm-${simulationHash({ cutId, enacted })}`,
          principal: { kind: "system" as const, principalId: "sim-narrator", controlledActorIds: [] },
          submittedAtWallClock: new Date().toISOString(),
          correlationId: `sim-narrator-${simulationHash({ cutId })}`,
          type: "confirm_narrator_result",
          schemaVersion: 2,
          payload: {
            engagementId: input.engagementId,
            cutId,
            enactedArmedEffectIds: enacted,
            softCanonProposals: parsed.proposals,
          },
        },
        { database, admitAtLockedVersion: true },
      );
      confirmStatus = confirm.status;
      if (confirm.status === "rejected") {
        diagnostics.push(`sim.narrator.confirm_rejected:${confirm.code}`);
      }
    }

    const prose = audit.bridgeProse
      ? `${parsed.result.prose.trimEnd()} ${audit.bridgeProse}`
      : parsed.result.prose;
    return {
      status: "rendered",
      cutId,
      modelId,
      attempts,
      prose,
      audit,
      result: parsed.result,
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
  const modelId = resolveChatModelId(options.modelId);
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
