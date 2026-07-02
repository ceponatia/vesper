import type { DiagnosticSink } from "@/contracts/diagnostics";
import { emptyIntentBrief, intentBriefSchema, type IntentBrief } from "@/contracts/turns/intent-brief";
import { agentModelId, generateChecked, isDemoMode, withGenerateTimeout } from "../ai";
import { INTAKE_MAX_OUTPUT_TOKENS, INTAKE_TIMEOUT_MS } from "./constants";
import { detectIntent, type SceneIntent } from "./intent";
import { buildIntakePrompt, INTAKE_SYSTEM, type IntakePromptInput } from "./prompts/intake";

/**
 * Pre-narrator intake agent (docs/developer-notes/pre-narrator-agents.spec.md).
 * Runs concurrent with retrieval, before narration: one fast `generateChecked`
 * call on the `tool` model that reads the player's input and reports an
 * `IntentBrief`. Never throws and never blocks the turn: it degrades to today's
 * regex `detectIntent` on timeout, failure, demo mode, or when disabled — so
 * "intake off" is exactly the engine's prior behavior.
 */

export interface IntakeInput extends IntakePromptInput {
  sink?: DiagnosticSink;
  /** The world's in-session agent-model override (World tab); "" / absent ⇒ default. */
  agentModel?: string;
}

/** Active unless explicitly disabled (the latency A/B switch); never in demo mode. */
export function intakeEnabled(): boolean {
  return !isDemoMode() && process.env.INTAKE_DISABLED !== "1";
}

export async function runIntake(input: IntakeInput): Promise<IntentBrief> {
  const fallback = (): IntentBrief =>
    intentBriefFromSceneIntent(detectIntent(input.playerInput, input.presentNpcNames, input.itemNames));

  // Demo mode / disabled: skip the LLM entirely, return the regex brief.
  if (!intakeEnabled()) return fallback();

  // The timeout aborts this call; an aborted generateChecked returns silently so
  // a slow tail can't write diagnostics onto a turn already running on the regex.
  const controller = new AbortController();
  const work = generateChecked<IntentBrief>({
    schema: intentBriefSchema,
    system: INTAKE_SYSTEM,
    prompt: buildIntakePrompt(input),
    modelId: agentModelId(input.agentModel),
    temperature: 0,
    maxOutputTokens: INTAKE_MAX_OUTPUT_TOKENS,
    code: "agent.intake",
    sink: input.sink,
    fallback,
    signal: controller.signal,
    // Intake is a fast, best-effort classifier: reasoning tokens blow the latency
    // budget, the repair round-trip would be discarded by the timeout anyway, and
    // a parse failure degrades cleanly to the regex (a warn, not an error).
    // lowLatencyRouting flattens the OpenRouter TTFT tail (the dominant cause of
    // budget overruns — see pre-narrator-agents.followups.md §2d).
    disableReasoning: true,
    lowLatencyRouting: true,
    repair: false,
    degradeSeverity: "warn",
  });

  // Race against the timeout (shared `withGenerateTimeout` — server/ai): a slow
  // model must not stall the critical path; on timeout the call is aborted (so its
  // orphaned tail emits no diagnostics) and the turn proceeds on the regex fallback.
  const { value } = await withGenerateTimeout(work, controller, INTAKE_TIMEOUT_MS, "agent.intake.timeout", input.sink);
  return value ?? fallback();
}

// ---------------------------------------------------------------------------
// Adapters: IntentBrief <-> SceneIntent
// ---------------------------------------------------------------------------

/**
 * The `SceneIntent` view the existing prompt builders (raiseExposureForIntent,
 * buildGlanceImpressions, buildAwarenessBlocks) and the continuity awareness
 * rebuild consume — a lossless copy of the five sense/target fields.
 */
export function sceneIntentFromBrief(brief: IntentBrief): SceneIntent {
  const intent: SceneIntent = {};
  if (brief.lookTarget) intent.lookTarget = brief.lookTarget;
  if (brief.touchTarget) intent.touchTarget = brief.touchTarget;
  if (brief.smellTarget) intent.smellTarget = brief.smellTarget;
  if (brief.tasteTarget) intent.tasteTarget = brief.tasteTarget;
  if (brief.examineItem) intent.examineItem = brief.examineItem;
  if (brief.enterLocation) intent.enterLocation = brief.enterLocation;
  return intent;
}

/**
 * The regex fallback brief: a faithful mirror of what `detectIntent` knows, no
 * more. The classification seams (actionType, movement, appointment, check) stay
 * at their defaults — the regex doesn't classify them — so the degraded brief
 * carries exactly today's information.
 */
export function intentBriefFromSceneIntent(intent: SceneIntent): IntentBrief {
  const brief = emptyIntentBrief();
  if (intent.lookTarget) brief.lookTarget = intent.lookTarget;
  if (intent.touchTarget) brief.touchTarget = intent.touchTarget;
  if (intent.smellTarget) brief.smellTarget = intent.smellTarget;
  if (intent.tasteTarget) brief.tasteTarget = intent.tasteTarget;
  if (intent.examineItem) brief.examineItem = intent.examineItem;
  if (intent.enterLocation) brief.enterLocation = intent.enterLocation;
  return brief;
}
