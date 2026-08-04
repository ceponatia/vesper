import { APICallError, generateText, RetryError, type JSONValue } from "ai";
import { z, type ZodType } from "zod";
import { diag, type DiagnosticSink } from "@/contracts/diagnostics";
import { recordAgentFailure, type AgentTelemetry } from "./agent-failures";
import { classifyProviderError } from "./errors";
import { isDemoMode, openrouter, providerRouting, routedProvider, stateModelId } from "./provider";

/** An image handed to a vision-capable model alongside the prompt text. */
export interface GenerateImagePart {
  /** Raw bytes or a base64 string. */
  data: Uint8Array | string;
  /** e.g. "image/webp". */
  mediaType: string;
}

export interface GenerateCheckedOptions<T> {
  schema: ZodType<T>;
  system: string;
  prompt: string;
  /**
   * Images the model should look at (vision models only — pair with
   * `visionModelId()`). The prompt text follows the images in one user
   * message; everything else on the resilience ladder is unchanged.
   */
  images?: readonly GenerateImagePart[];
  /** OpenRouter model id; defaults to the state model. */
  modelId?: string;
  temperature?: number;
  maxOutputTokens?: number;
  /** Diagnostic code prefix, e.g. "agent.simulant". */
  code: string;
  sink?: DiagnosticSink;
  /** Demo-mode / total-failure fallback. Omit to get null on failure. */
  fallback?: () => T;
  /**
   * Abort the in-flight (and any repair) call. When a caller-side timeout has
   * already moved on (intake), aborting stops the request mid-flight and the
   * call returns **silently** — no diagnostics — because the caller owns the
   * degrade it already logged. Prevents an orphaned call polluting the turn.
   */
  signal?: AbortSignal;
  /**
   * Run the one repair round-trip on a parse failure (default true). Best-effort,
   * latency-critical callers (intake) set this false: the repair is a second
   * sequential LLM call whose result a tight timeout would discard anyway.
   */
  repair?: boolean;
  /**
   * Send OpenRouter `reasoning:{enabled:false}`. For fast classifiers (intake)
   * where reasoning tokens blow the latency + output-token budget (the cause of
   * the intake timeout/truncation flood — pre-narrator-agents.followups.md).
   * Default false; the post-turn agents reason over the narration and keep it.
   * Reliable on the curated agent models (deepseek-v4-flash, glm-5.2); a model
   * that *mandates* reasoning (gemini-3.5-flash, aion-2.0) rejects it and the
   * call degrades to the fallback — those are not in the agent-model list.
   */
  disableReasoning?: boolean;
  /**
   * Route via OpenRouter `provider:{sort:"latency"}` — pick the lowest-latency
   * provider endpoint for the model. For latency-critical callers (intake): the
   * model's *median* TTFT is fine (~0.7s) but default routing intermittently
   * lands a cold/slow endpoint (TTFT spiking to 3–13s), which blew the intake
   * budget; latency-sorted routing flattened the tail to <0.8s in probes
   * (pre-narrator-agents.followups.md §2d). `allow_fallbacks` stays on, so this
   * only reorders preference — no reliability loss. Default false.
   */
  lowLatencyRouting?: boolean;
  /**
   * Severity for the post-degrade `*.parse_failed` diagnostic (default "error").
   * Best-effort agents that degrade cleanly to a live path (intake → regex) use
   * "warn": a fallback is not a turn failure.
   */
  degradeSeverity?: "warn" | "error";
  /**
   * Extra OpenRouter provider options merged as the BASE for the per-call
   * routing/reasoning knobs below (the narrator lanes pass
   * `narrativeProviderOptions(modelId)` for the eval-ruled reasoning knob).
   * Additive: absent ⇒ byte-identical behaviour for every existing caller.
   */
  providerOptions?: { openrouter?: Record<string, JSONValue> };
  /**
   * Where this call lives (chat / session, which conversation, which exchange), so a
   * failure can be RECORDED and tallied rather than only logged
   * (`./agent-failures.ts`). Optional: without it the failure is still recorded, just
   * without the chat/session anchor — `legId` falls back to `code`, which every caller
   * already passes.
   */
  telemetry?: Partial<AgentTelemetry>;
}

export interface GenerateCheckedResult<T> {
  value: T | null;
  degraded: boolean;
  /**
   * Upstream provider OpenRouter routed the (last completed) call to — null in
   * demo mode or when no call completed (network error before a response). Fed
   * to the Inspector's per-leg provider attribution.
   */
  provider?: string | null;
  /** Wall-clock latency of the last completed model call, ms (undefined if none completed). */
  latencyMs?: number;
}

/**
 * Structured generation with the resilience ladder (docs/resilience.md §3):
 * typed output → one repair round-trip with the validation issues → degraded
 * fallback. Never throws into the pipeline.
 */
export async function generateChecked<T>(opts: GenerateCheckedOptions<T>): Promise<GenerateCheckedResult<T>> {
  if (isDemoMode()) {
    return degrade(opts, "demo mode");
  }

  // Plain text + local parse, NOT provider-side constrained decoding
  // (`Output.object` / response_format json_schema): constrained decoding
  // degenerates on some models — Gemini 2.5 Flash returned hollow-but-valid
  // objects that all-defaulted schemas accepted without ever tripping repair
  // (followups.phase2.md #20). The model sees the JSON Schema as text; the
  // resilience ladder below does the enforcement.
  const schemaText = jsonSchemaText(opts.schema);
  // OpenRouter per-call routing/decoding knobs (see the option docs above).
  // providerRouting also applies any per-model provider exclusions (e.g. drop
  // DeepInfra for GLM 5.2), so it runs regardless of lowLatencyRouting.
  const orOptions: Record<string, JSONValue> = { ...(opts.providerOptions?.openrouter ?? {}) };
  if (opts.disableReasoning) orOptions.reasoning = { enabled: false };
  const routing = providerRouting(opts.modelId ?? stateModelId(), { sortLatency: opts.lowLatencyRouting });
  if (routing) orOptions.provider = routing;
  const providerOptions = Object.keys(orOptions).length > 0 ? { openrouter: orOptions } : undefined;
  // Provider + latency of the last *completed* call (set even when the response
  // then fails to parse): the Inspector reports them so a slow endpoint shows up.
  let provider: string | null = null;
  let latencyMs: number | undefined;
  const attempt = async (prompt: string): Promise<T> => {
    const start = Date.now();
    const base = {
      model: openrouter().chat(opts.modelId ?? stateModelId()),
      temperature: opts.temperature ?? 0,
      maxOutputTokens: opts.maxOutputTokens ?? 4096,
      abortSignal: opts.signal,
      providerOptions,
      system: [
        opts.system,
        "",
        "Respond with ONLY a single JSON object — no markdown fences, no commentary." +
          (schemaText ? ` It must conform to this JSON Schema:\n${schemaText}` : ""),
      ].join("\n"),
    };
    // Images require the messages form; the plain-prompt path stays byte-identical.
    const result =
      opts.images && opts.images.length > 0
        ? await generateText({
            ...base,
            messages: [
              {
                role: "user",
                content: [
                  ...opts.images.map((img) => ({ type: "image" as const, image: img.data, mediaType: img.mediaType })),
                  { type: "text" as const, text: prompt },
                ],
              },
            ],
          })
        : await generateText({ ...base, prompt });
    latencyMs = Date.now() - start;
    provider = routedProvider(result.providerMetadata);
    return opts.schema.parse(JSON.parse(extractJsonObject(result.text)));
  };

  // The caller aborted (e.g. its timeout fired and it already degraded): return
  // silently so the orphaned tail adds no diagnostics to a turn it no longer owns.
  // (It records nothing either — the caller's watchdog owns that failure and records
  // the `timeout` itself; a second `api_error` row for the same miss would double-count.)
  const abandoned = () => opts.signal?.aborted ?? false;

  let firstError = "";
  let lastErr: unknown = null;
  try {
    return { value: await attempt(opts.prompt), degraded: false, provider, latencyMs };
  } catch (err) {
    if (abandoned()) return { value: null, degraded: true, provider, latencyMs };
    firstError = errorText(err);
    lastErr = err;
  }

  const repair = opts.repair ?? true;
  if (repair) {
    try {
      const value = await attempt(
        [
          opts.prompt,
          "",
          "Your previous response failed validation with these issues:",
          firstError.slice(0, 2000),
          "Respond again with a valid object. Fix only the listed issues.",
        ].join("\n"),
      );
      // info, not warn: the repair *succeeded* — the user has nothing to act on.
      opts.sink?.push(diag("info", `${opts.code}.repaired`, "structured output needed one repair round-trip"));
      return { value, degraded: false, provider, latencyMs };
    } catch (err) {
      if (abandoned()) return { value: null, degraded: true, provider, latencyMs };
      firstError = errorText(err);
      lastErr = err;
    }
  }

  // A TRANSPORT failure is not a schema failure. Everything used to land as
  // `${code}.parse_failed` — actively mislabeling a 429 / 402 / network drop as "the model
  // can't produce JSON" (chat-reply-failures.plan.md §Follow-ups). Classify once and let the
  // diagnostic, the log, and the recorded failure all tell the same true story.
  const isTransport = APICallError.isInstance(lastErr) || RetryError.isInstance(lastErr);
  const providerClassification = isTransport ? classifyProviderError(lastErr) : null;
  const failureCode = isTransport ? `${opts.code}.api_error` : `${opts.code}.parse_failed`;

  opts.sink?.push(
    diag(
      opts.degradeSeverity ?? "error",
      failureCode,
      isTransport
        ? `provider call failed (${providerClassification?.code}): ${(providerClassification?.detail ?? firstError).slice(0, 500)}`
        : `structured output failed${repair ? " after repair" : ""}: ${firstError.slice(0, 500)}`,
    ),
  );
  // Durable, tallied, with a suspected cause — a failing leg must not be invisible outside
  // a `fly logs` grep (contracts/turns/agent-failure.ts). Fire-and-forget.
  recordAgentFailure({
    legId: opts.telemetry?.legId ?? opts.code,
    chatId: opts.telemetry?.chatId,
    messageId: opts.telemetry?.messageId,
    kind: isTransport ? "api_error" : "parse_failed",
    providerCode: providerClassification?.code,
    httpStatus: providerClassification?.status,
    modelId: opts.modelId ?? stateModelId(),
    provider,
    latencyMs,
    promptChars: opts.system.length + opts.prompt.length,
    maxOutputTokens: opts.maxOutputTokens ?? 4096,
    reasoningProfile: opts.telemetry?.reasoningProfile,
    reasoningEnabled: opts.telemetry?.reasoningEnabled,
    detail: providerClassification?.detail ?? firstError,
  });
  return { ...degrade(opts, repair ? "validation failed twice" : "validation failed"), provider, latencyMs };
}

function degrade<T>(opts: GenerateCheckedOptions<T>, reason: string): GenerateCheckedResult<T> {
  if (opts.fallback) {
    opts.sink?.push(diag("info", `${opts.code}.degraded`, `using degraded fallback (${reason})`));
    return { value: opts.fallback(), degraded: true };
  }
  const empty = opts.schema.safeParse({});
  if (empty.success) {
    opts.sink?.push(diag("info", `${opts.code}.degraded`, `using schema defaults (${reason})`));
    return { value: empty.data, degraded: true };
  }
  return { value: null, degraded: true };
}

/**
 * Pure: pull the JSON object out of a model response that may carry markdown
 * fences or stray prose. First "{" to last "}" — models that chat around the
 * object still parse; genuinely malformed JSON throws into the repair ladder.
 */
export function extractJsonObject(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) throw new Error("response contained no JSON object");
  return text.slice(start, end + 1);
}

/** JSON Schema rendering of the zod schema for the prompt; "" when the schema can't be serialized (worked examples carry the shape then). */
function jsonSchemaText(schema: ZodType<unknown>): string {
  try {
    return JSON.stringify(z.toJSONSchema(schema as never, { io: "input" }));
  } catch {
    return "";
  }
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
