import { randomUUID } from "node:crypto";
import type { ImageModel } from "@vesper/image-core";
import { CIVITAI_FLUX2_KLEIN4B_SLUG } from "@vesper/image-models";
import type { RegistryModelRequest, ReplicateImageResult } from "@vesper/image-replicate";
import { civitaiApiToken } from "../images/lora-credentials";
import { CivitaiError, civitaiAsyncFailure, civitaiGetRetryDelay, civitaiHttpFailure, civitaiInsufficientBuzzFailure, civitaiOutputFailure, civitaiReasonCodes, civitaiTransportFailure, civitaiValidationPaths } from "./civitai-errors";

/** A documented variant selector, not an immutable numeric checkpoint revision. */
export const CIVITAI_KLEIN_4B_VERSION_ID = "4b";
export const CIVITAI_LORA_VERSION_FIELD = "civitai_lora_version";
export const CIVITAI_LORA_STRENGTH_FIELD = "civitai_lora_strength";
export const CIVITAI_CFG_SCALE_FIELD = "cfgScale";
export const CIVITAI_STEPS_FIELD = "steps";

/**
 * The provider spells its negative prompt in camelCase, and DROPS any other
 * spelling without complaint.
 *
 * Migration 0145 declared `negative_prompt` for the retired website graph. A
 * 2026-09-16 probe sent both spellings to the v2 workflow endpoint: only
 * `negativePrompt` came back in the preflight echo, while `negative_prompt` was
 * discarded exactly as an invented field name was. A snake_case binding here
 * would therefore not error — it would render without the negative prompt the
 * operator configured, and the echo would look correct because the field simply
 * would not appear on either side.
 */
export const CIVITAI_NEGATIVE_PROMPT_FIELD = "negativePrompt";
const WORKFLOWS_URL = "https://orchestration.civitai.com/v2/consumer/workflows";
const MODEL_VERSIONS_URL = "https://civitai.com/api/v1/model-versions";
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_REFERENCES = 2;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const ALLOWED_CONTROLS = new Set([
  "seed", CIVITAI_LORA_VERSION_FIELD, CIVITAI_LORA_STRENGTH_FIELD,
  CIVITAI_CFG_SCALE_FIELD, CIVITAI_STEPS_FIELD, CIVITAI_NEGATIVE_PROMPT_FIELD,
]);

/**
 * The band each sampling control may be set to, refused rather than clamped.
 *
 * The ceilings are cost rails as much as quality rails: Civitai prices this
 * workflow off both knobs, and a 2026-09-16 measurement put an 832x1248 create
 * at 2 Buzz for 4 steps, 3 for 8, 6 for 20, and 12 for 20 steps at CFG 5 —
 * guidance above 1 runs a second unconditional pass and doubles the bill. A
 * typo'd 200 steps is a configuration mistake, and spending forty times the
 * intended Buzz on it is worse than refusing the render.
 */
const CIVITAI_CFG_SCALE_RANGE = { minimum: 1, maximum: 8 } as const;
const CIVITAI_STEPS_RANGE = { minimum: 1, maximum: 40 } as const;
const CIVITAI_MAX_NEGATIVE_PROMPT_CHARS = 1000;

/**
 * The sampling recipe the DISTILLED Klein 4B checkpoint was trained to expect.
 *
 * Klein 4B is a distilled model: it carries no `guidance_embeds` and reaches its
 * target distribution in a handful of steps. Black Forest Labs' own reference
 * usage for `Flux2KleinPipeline` is `guidance_scale=1.0, num_inference_steps=4`.
 *
 * Vesper originally sent a conventional non-distilled recipe (CFG 5 / 20 steps).
 * That over-drives a distilled model, and a 2026-09-16 controlled comparison —
 * identical seed, prompt, aspect and LoRA, varying only these two values —
 * produced visibly over-cooked output with a stippled, beaded skin texture that
 * was present with AND without the LoRA. The values below removed it.
 *
 * They are also what the provider prices against: Civitai billed the 20-step
 * render at 12 Buzz and the 4-step render at 2.
 *
 * DEFAULTS, not fixed policy. The same comparison found no single recipe that
 * suits every render — 8 steps resolves multi-subject anatomy that 4 mangles,
 * and a negative prompt does nothing below guidance 2 — so an operator overrides
 * these through the `guidance` and `steps` controls migration 0148 binds. What
 * stays fixed is that {@link validateCivitaiPreflightEcho} demands back exactly
 * what {@link resolveCivitaiKleinSampling} resolved, default or override, so the
 * preflight still refuses a silent provider substitution.
 */
const CIVITAI_KLEIN_CFG_SCALE = 1;
const CIVITAI_KLEIN_STEPS = 4;

/**
 * How long a submitted workflow is waited on before Vesper gives up.
 *
 * This budget is spent on QUEUE time, not just render time. Civitai schedules
 * submits from the shared `low` priority pool Vesper does not pay to leave, and
 * measured waits on 2026-09-16 ranged from 3 s to 348 s for identical requests —
 * the render itself was 36-43 s. Abandoning the poll does not cancel or refund
 * the workflow, so a deadline shorter than the queue throws away an image the
 * account has already been billed for; one observed run succeeded at 390 s,
 * ninety seconds after the previous 300 s default had already reported a
 * `civitai_async_timeout`.
 *
 * Raised to outlast the provider's own lifecycle rather than race it. A caller
 * with a tighter budget still passes `timeoutMs` explicitly.
 */
const CIVITAI_DEFAULT_TIMEOUT_MS = 900_000;
const PENDING_STATUSES = new Set(["unassigned", "preparing", "scheduled", "processing"]);
const FAILED_STATUSES = new Set(["failed", "expired", "canceled"]);

type JsonRecord = Record<string, unknown>;
type KleinRequest = Pick<RegistryModelRequest, "prompt" | "aspect" | "controlInput" | "versionId">;

export interface CivitaiKleinWorkflow {
  externalId: string;
  allowMatureContent: true;
  currencies: readonly ["yellow"];
  upgradeMode: "manual";
  tags: readonly ["vesper", "image-generator"];
  steps: readonly [{ $type: "imageGen"; input: JsonRecord }];
}

export interface CivitaiWorkflowResult {
  id: string;
  status: string;
  errors: string[];
  blocked: boolean;
  insufficient: boolean | null;
  mature: boolean | null;
  currencies: string[] | null;
  upgradeMode: string | null;
  input: JsonRecord | null;
  images: { url: string | null; available: boolean; hidden: boolean; blocked: string | null }[];
}

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isCivitaiHost(host: string): boolean {
  return host === "civitai.com" || host.endsWith(".civitai.com");
}

export function civitaiKleinDimensions(aspect: string | null | undefined): { width: number; height: number } {
  switch (aspect ?? "1:1") {
    case "1:1": return { width: 1024, height: 1024 };
    case "2:3": return { width: 832, height: 1248 };
    case "3:2": return { width: 1248, height: 832 };
    default: throw new Error("Civitai Klein supports only aspect ratios 1:1, 2:3, and 3:2");
  }
}

function loraVersionId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (/^[1-9]\d*$/.test(trimmed) && Number.isSafeInteger(Number(trimmed))) return trimmed;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" || !isCivitaiHost(url.hostname) || url.username || url.password) return null;
    const version = url.pathname.match(/^\/api\/download\/models\/([1-9]\d*)\/?$/)?.[1];
    return version && Number.isSafeInteger(Number(version)) ? version : null;
  } catch {
    return null;
  }
}

function selectedLora(controls: KleinRequest["controlInput"]): { version: string; strength: number } | null {
  const locator = controls?.[CIVITAI_LORA_VERSION_FIELD];
  const strength = controls?.[CIVITAI_LORA_STRENGTH_FIELD];
  if (locator === undefined && strength === undefined) return null;
  const version = loraVersionId(locator);
  if (!version) throw new Error("Civitai LoRA selection did not resolve to a model-version id");
  if (typeof strength !== "number" || !Number.isFinite(strength)) {
    throw new Error("Civitai LoRA selection requires a finite numeric strength");
  }
  return { version, strength };
}

/**
 * The sampling settings this render will actually use: the operator's controls
 * where present, the distilled defaults where absent.
 *
 * Resolved in ONE place because three callers must agree on the answer — the
 * workflow builder, the preview, and {@link validateCivitaiPreflightEcho}, which
 * refuses a provider substitution by comparing the echo field by field. A
 * builder that defaulted independently of the echo check could send one recipe
 * and demand another.
 */
export interface CivitaiKleinSampling {
  cfgScale: number;
  steps: number;
  negativePrompt: string | null;
}

export function resolveCivitaiKleinSampling(controls: KleinRequest["controlInput"]): CivitaiKleinSampling {
  const cfgScale = controls?.[CIVITAI_CFG_SCALE_FIELD] ?? CIVITAI_KLEIN_CFG_SCALE;
  const steps = controls?.[CIVITAI_STEPS_FIELD] ?? CIVITAI_KLEIN_STEPS;
  const negativePrompt = controls?.[CIVITAI_NEGATIVE_PROMPT_FIELD];

  if (typeof cfgScale !== "number" || !Number.isFinite(cfgScale) ||
      cfgScale < CIVITAI_CFG_SCALE_RANGE.minimum || cfgScale > CIVITAI_CFG_SCALE_RANGE.maximum) {
    throw new Error(`Civitai Klein cfgScale must be a number between ${String(CIVITAI_CFG_SCALE_RANGE.minimum)} and ${String(CIVITAI_CFG_SCALE_RANGE.maximum)}`);
  }
  if (typeof steps !== "number" || !Number.isSafeInteger(steps) ||
      steps < CIVITAI_STEPS_RANGE.minimum || steps > CIVITAI_STEPS_RANGE.maximum) {
    throw new Error(`Civitai Klein steps must be an integer between ${String(CIVITAI_STEPS_RANGE.minimum)} and ${String(CIVITAI_STEPS_RANGE.maximum)}`);
  }
  if (negativePrompt !== undefined) {
    if (typeof negativePrompt !== "string") throw new Error("Civitai Klein negative prompt must be a string");
    if (negativePrompt.length > CIVITAI_MAX_NEGATIVE_PROMPT_CHARS) {
      throw new Error(`Civitai Klein negative prompts are limited to ${String(CIVITAI_MAX_NEGATIVE_PROMPT_CHARS)} characters`);
    }
  }

  // A negative prompt is INERT at guidance 1: with no unconditional branch there
  // is nothing to steer away from. Measured on 2026-09-16 — the same seed with
  // and without a negative prompt at cfgScale 1 produced pixel-identical output
  // while the provider echoed the field back both times. Accepting it here would
  // bill for a setting that demonstrably does nothing and report success, so the
  // combination is refused and names the fix.
  const trimmedNegative = typeof negativePrompt === "string" && negativePrompt.trim() !== "" ? negativePrompt : null;
  if (trimmedNegative !== null && cfgScale <= 1) {
    throw new Error("Civitai Klein ignores a negative prompt at cfgScale 1; raise cfgScale above 1 or clear the negative prompt");
  }

  return { cfgScale, steps, negativePrompt: trimmedNegative };
}

export function validateCivitaiKleinRequest(model: Pick<ImageModel, "slug">, request: KleinRequest): void {
  if (model.slug !== CIVITAI_FLUX2_KLEIN4B_SLUG) throw new Error("Unsupported Civitai image model");
  if (request.versionId !== undefined && request.versionId !== CIVITAI_KLEIN_4B_VERSION_ID) {
    throw new Error("Civitai Klein uses the documented 4b variant; the requested version does not match");
  }
  if (request.prompt.length > 1000) throw new Error("Civitai Klein prompts are limited to 1000 characters");
  for (const key of Object.keys(request.controlInput ?? {})) {
    if (!ALLOWED_CONTROLS.has(key)) throw new Error("Civitai Klein received an unsupported control");
  }
  const seed = request.controlInput?.seed;
  if (seed !== undefined && (typeof seed !== "number" || !Number.isSafeInteger(seed))) {
    throw new Error("Civitai Klein seed must be a safe integer");
  }
  selectedLora(request.controlInput);
  resolveCivitaiKleinSampling(request.controlInput);
  civitaiKleinDimensions(request.aspect);
}

export function civitaiKleinWorkflow(
  model: Pick<ImageModel, "slug">,
  request: KleinRequest,
  references: readonly string[] = [],
  loras?: Readonly<Record<string, number>>,
): CivitaiKleinWorkflow {
  validateCivitaiKleinRequest(model, request);
  if (references.length > MAX_REFERENCES) throw new Error("Civitai Klein accepts at most 2 reference images");
  const seed = request.controlInput?.seed;
  const sampling = resolveCivitaiKleinSampling(request.controlInput);
  return {
    externalId: randomUUID(),
    allowMatureContent: true,
    currencies: ["yellow"],
    upgradeMode: "manual",
    tags: ["vesper", "image-generator"],
    steps: [{
      $type: "imageGen",
      input: {
        engine: "flux2",
        model: "klein",
        modelVersion: CIVITAI_KLEIN_4B_VERSION_ID,
        operation: references.length > 0 ? "editImage" : "createImage",
        prompt: request.prompt,
        ...civitaiKleinDimensions(request.aspect),
        quantity: 1,
        cfgScale: sampling.cfgScale,
        steps: sampling.steps,
        sampleMethod: "euler",
        schedule: "simple",
        outputFormat: "jpeg",
        enablePromptExpansion: false,
        loras: loras ?? {},
        ...(sampling.negativePrompt === null ? {} : { [CIVITAI_NEGATIVE_PROMPT_FIELD]: sampling.negativePrompt }),
        ...(seed === undefined ? {} : { seed }),
        ...(references.length === 0 ? {} : { images: references }),
      },
    }],
  };
}

/** Metadata lookup happens only at send; previews identify that unresolved AIR dependency. */
export function previewCivitaiKleinRequest(
  model: Pick<ImageModel, "slug">,
  request: KleinRequest,
  referenceCount = 0,
): JsonRecord {
  validateCivitaiKleinRequest(model, request);
  if (!Number.isInteger(referenceCount) || referenceCount < 0 || referenceCount > MAX_REFERENCES) {
    throw new Error("Civitai Klein accepts zero, one, or two reference images");
  }
  const selected = selectedLora(request.controlInput);
  const references = Array.from({ length: referenceCount }, (_unused, index) =>
    `https://placeholder.invalid/reference-${String(index + 1)}`);
  return {
    ...civitaiKleinWorkflow(model, request, references),
    externalId: "generated-for-each-request",
    ...(selected ? { loraAirResolution: { modelVersionId: selected.version, strength: selected.strength } } : {}),
  };
}

export function hasCivitai(): boolean {
  return civitaiApiToken() !== null;
}

/** Retain only documented provider tokens, never echoed prompts or signed URLs. */
function errorCodes(value: unknown): string[] {
  return civitaiReasonCodes(value);
}

const MAX_GET_RETRIES = 2;

async function waitForCivitaiGetRetry(attempt: number, deadline?: number): Promise<boolean> {
  const delay = deadline === undefined ? civitaiGetRetryDelay(attempt) : Math.min(civitaiGetRetryDelay(attempt), deadline - Date.now());
  if (delay <= 0) return false;
  await new Promise<void>((resolve) => setTimeout(resolve, delay));
  return deadline === undefined || Date.now() < deadline;
}

async function requestJson(url: string, init: RequestInit, token: string, stage: "lora_metadata" | "preflight" | "submit" | "workflow_status", deadline?: number): Promise<unknown> {
  const method = init.method ?? "GET";
  for (let attempt = 0; ; attempt += 1) {
    if (deadline !== undefined && Date.now() >= deadline) throw civitaiAsyncFailure("expired", ["timeout"]);
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token}`);
    headers.set("Content-Type", "application/json");
    let response: Response;
    let text: string;
    try {
      response = await fetch(url, {
        ...init,
        headers,
        redirect: "error",
        signal: AbortSignal.timeout(deadline === undefined ? REQUEST_TIMEOUT_MS : Math.max(1, Math.min(REQUEST_TIMEOUT_MS, deadline - Date.now()))),
      });
      text = await response.text();
    } catch {
      const failure = civitaiTransportFailure(stage, method === "GET", attempt >= MAX_GET_RETRIES);
      if (method === "GET" && failure.retry === "automatic" && attempt < MAX_GET_RETRIES) {
        if (await waitForCivitaiGetRetry(attempt, deadline)) continue;
        throw civitaiAsyncFailure("expired", ["timeout"]);
      }
      throw failure;
    }
    let value: unknown;
    try {
      value = JSON.parse(text) as unknown;
    } catch {
      if (response.ok) throw new CivitaiError({ code: "civitai_malformed_response", retry: "never", stage });
      value = null;
    }
    if (!response.ok) {
      const failure = civitaiHttpFailure(
        response.status, stage, method === "GET", civitaiValidationPaths(value), attempt >= MAX_GET_RETRIES,
      );
      if (method === "GET" && failure.retry === "automatic" && attempt < MAX_GET_RETRIES) {
        if (await waitForCivitaiGetRetry(attempt, deadline)) continue;
        throw civitaiAsyncFailure("expired", ["timeout"]);
      }
      throw failure;
    }
    return value;
  }
}

export function parseCivitaiWorkflow(value: unknown, context = "Civitai workflow"): CivitaiWorkflowResult {
  const body = asRecord(value);
  const status = asString(body?.status);
  const id = asString(body?.id);
  if (!body || !id || !status || (!PENDING_STATUSES.has(status) && !FAILED_STATUSES.has(status) && status !== "succeeded")) {
    throw new Error(`${context} returned an invalid workflow identity or status`);
  }
  const steps = asArray(body.steps);
  const step = asRecord(steps[0]);
  if (!step || steps.length !== 1 || step.$type !== "imageGen") throw new Error(`${context} returned an unexpected workflow step`);
  const output = asRecord(step.output);
  const jobs = asArray(step.jobs).map(asRecord);
  const transactions = asRecord(body.transactions);
  const currencies = body.currencies;
  return {
    id,
    status,
    errors: [...new Set([
      ...errorCodes(body.errors), ...errorCodes(step.errors), ...errorCodes(step.error),
      ...errorCodes(step.reason), ...errorCodes(output?.errors),
      ...jobs.flatMap((job) => [
        ...errorCodes(job?.reason), ...errorCodes(job?.blockedReason), ...errorCodes(job?.errors),
      ]),
    ])],
    blocked: jobs.some((job) => job?.reason === "blocked" || (typeof job?.blockedReason === "string" && job.blockedReason.trim() !== "")),
    insufficient: typeof transactions?.insufficientBuzz === "boolean" ? transactions.insufficientBuzz : null,
    mature: typeof body.allowMatureContent === "boolean" ? body.allowMatureContent : null,
    currencies: Array.isArray(currencies) && currencies.every((currency): currency is string => typeof currency === "string")
      ? currencies : null,
    upgradeMode: asString(body.upgradeMode),
    input: asRecord(step.input),
    images: asArray(output?.images).map((value) => {
      const image = asRecord(value);
      return {
        url: asString(image?.url),
        available: image?.available === true,
        hidden: image?.hidden === true,
        blocked: typeof image?.blockedReason === "string" ? errorCodes(image.blockedReason).join(", ") : null,
      };
    }),
  };
}

export function validateCivitaiPreflightEcho(actual: CivitaiWorkflowResult, expected: CivitaiKleinWorkflow): string | null {
  if (actual.insufficient === true) return "Civitai billing: insufficient yellow Buzz; generation was not submitted";
  if (actual.insufficient === null) return "Civitai preflight did not confirm sufficient yellow Buzz; generation was not submitted";
  if (FAILED_STATUSES.has(actual.status) || actual.errors.length > 0) {
    return `Civitai preflight refused the workflow: ${actual.errors.join(", ") || actual.status}`;
  }
  if (actual.mature !== true || actual.currencies?.length !== 1 || actual.currencies[0] !== "yellow" || actual.upgradeMode !== "manual") {
    return "Civitai preflight did not confirm explicit mature-content permission, yellow-only payment, and manual upgrade policy";
  }
  const wanted = expected.steps[0].input;
  const echoed = actual.input;
  if (!echoed || (echoed.modelVariant ?? echoed.model) !== "klein") {
    return "Civitai preflight did not echo the requested Klein variant";
  }
  for (const key of ["engine", "modelVersion", "operation", "width", "height", "quantity", "cfgScale", "steps", "sampleMethod", "schedule", "outputFormat", "enablePromptExpansion"] as const) {
    if (echoed[key] !== wanted[key]) return `Civitai preflight changed or omitted requested field ${key}`;
  }
  if (wanted.seed !== undefined && echoed.seed !== wanted.seed) return "Civitai preflight changed the requested seed";
  // Checked by presence as well as value: the provider discards a negative
  // prompt it does not recognize instead of rejecting it, so an omission here is
  // the failure mode this guard exists for.
  if (echoed[CIVITAI_NEGATIVE_PROMPT_FIELD] !== wanted[CIVITAI_NEGATIVE_PROMPT_FIELD]) {
    return "Civitai preflight dropped or changed the requested negative prompt";
  }
  if (asArray(echoed.images).length !== asArray(wanted.images).length) return "Civitai preflight did not preserve the reference-image count";
  const expectedLoras = asRecord(wanted.loras) ?? {};
  const actualLoras = asRecord(echoed.loras);
  if (!actualLoras || Object.keys(actualLoras).length !== Object.keys(expectedLoras).length ||
      Object.entries(expectedLoras).some(([key, strength]) => actualLoras[key] !== strength)) {
    return "Civitai preflight did not echo the requested LoRA AIR map";
  }
  return null;
}

async function resolveLoras(request: KleinRequest, token: string): Promise<Record<string, number> | undefined> {
  const selected = selectedLora(request.controlInput);
  if (!selected) return undefined;
  const value = await requestJson(`${MODEL_VERSIONS_URL}/${selected.version}`, { method: "GET" }, token, "lora_metadata");
  const metadata = asRecord(value);
  const model = asRecord(metadata?.model);
  const modelId = metadata?.modelId;
  if (!metadata || metadata.id !== Number(selected.version) || metadata.baseModel !== "Flux.2 Klein 4B" ||
      model?.type !== "LORA" || typeof modelId !== "number" || !Number.isSafeInteger(modelId) || modelId < 1) {
    throw new Error("Civitai LoRA metadata is not the requested Flux.2 Klein 4B LoRA; refusing before spend");
  }
  return { [`urn:air:flux2:lora:civitai:${String(modelId)}@${selected.version}`]: selected.strength };
}

async function sendWorkflow(body: CivitaiKleinWorkflow, token: string, whatif: boolean): Promise<unknown> {
  return requestJson(`${WORKFLOWS_URL}?whatif=${String(whatif)}&wait=0`, {
    method: "POST",
    body: JSON.stringify(body),
  }, token, whatif ? "preflight" : "submit");
}

async function downloadOutput(url: string): Promise<Buffer> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw civitaiOutputFailure("civitai_output_invalid", "never");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || !isCivitaiHost(parsed.hostname)) {
    throw civitaiOutputFailure("civitai_output_invalid", "never");
  }
  let response: Response;
  try {
    response = await fetch(parsed, { redirect: "error", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch {
    throw civitaiOutputFailure("civitai_output_transport_failure", "deliberate");
  }
  if (!response.ok) {
    const code = `civitai_output_http_${String(response.status)}` as `civitai_output_http_${number}`;
    throw civitaiOutputFailure(code, "deliberate");
  }
  try {
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_OUTPUT_BYTES) {
      throw civitaiOutputFailure("civitai_output_too_large", "never");
    }
    if (!response.body) throw civitaiOutputFailure("civitai_output_empty", "deliberate");
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > MAX_OUTPUT_BYTES) throw civitaiOutputFailure("civitai_output_too_large", "never");
        chunks.push(Buffer.from(chunk.value));
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    if (size === 0) throw civitaiOutputFailure("civitai_output_empty", "deliberate");
    return Buffer.concat(chunks, size);
  } catch (error) {
    if (error instanceof CivitaiError) throw error;
    throw civitaiOutputFailure("civitai_output_transport_failure", "deliberate");
  }
}

export async function runCivitaiKleinImageModel(model: ImageModel, request: RegistryModelRequest): Promise<ReplicateImageResult> {
  const token = civitaiApiToken();
  if (!token) return { ok: false, error: "Civitai API token is not configured" };
  let predictionId: string | undefined;
  try {
    validateCivitaiKleinRequest(model, request);
    if ((request.controlReferences?.length ?? 0) > 0) throw new Error("Civitai Klein does not expose dedicated structural image inputs");
    if ((request.references?.length ?? 0) > MAX_REFERENCES) throw new Error("Civitai Klein accepts at most 2 reference images");
    const references = (request.references ?? []).map((reference) =>
      `data:${reference.mediaType};base64,${reference.bytes.toString("base64")}`);
    const loras = await resolveLoras(request, token);
    const preflightRequest = civitaiKleinWorkflow(model, request, references, loras);
    const preflight = parseCivitaiWorkflow(await sendWorkflow(preflightRequest, token, true), "Civitai generation preflight");
    if (preflight.insufficient === true) throw civitaiInsufficientBuzzFailure();
    if (FAILED_STATUSES.has(preflight.status) || preflight.errors.length > 0) {
      throw civitaiAsyncFailure(preflight.status, preflight.errors, preflight.blocked);
    }
    const refusal = validateCivitaiPreflightEcho(preflight, preflightRequest);
    if (refusal) return { ok: false, error: refusal };

    // Reusing a what-if externalId can retrieve the unexecuted estimate. Only
    // this id changes: generation inputs and the payment policy stay identical.
    const submitted = await sendWorkflow({ ...preflightRequest, externalId: randomUUID() }, token, false);
    predictionId = asString(asRecord(submitted)?.id) ?? undefined;
    let result = parseCivitaiWorkflow(submitted, "Civitai generation submit");
    predictionId = result.id;
    const deadline = Date.now() + Math.max(30_000, request.timeoutMs ?? CIVITAI_DEFAULT_TIMEOUT_MS);
    while (PENDING_STATUSES.has(result.status)) {
      if (result.insufficient === true) throw civitaiInsufficientBuzzFailure();
      if (result.errors.length > 0) throw civitaiAsyncFailure(result.status, result.errors, result.blocked);
      if (Date.now() >= deadline) throw civitaiAsyncFailure("expired", ["timeout"]);
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(2000, Math.max(1, deadline - Date.now()))));
      result = parseCivitaiWorkflow(await requestJson(`${WORKFLOWS_URL}/${encodeURIComponent(predictionId)}`,
        { method: "GET" }, token, "workflow_status", deadline));
      if (result.id !== predictionId) throw new Error("Civitai returned a different workflow while polling");
    }
    if (result.insufficient === true) throw civitaiInsufficientBuzzFailure();
    if (result.mature !== true || result.currencies?.length !== 1 || result.currencies[0] !== "yellow") {
      throw new Error("Civitai workflow did not retain mature-content permission and yellow-only payment");
    }
    if (result.status !== "succeeded" || result.errors.length > 0) {
      throw civitaiAsyncFailure(result.status, result.errors, result.blocked);
    }
    const image = result.images.find((candidate) => candidate.available && !candidate.hidden && !candidate.blocked && candidate.url);
    if (!image?.url) {
      const blocked = result.images.find((candidate) => candidate.blocked)?.blocked;
      throw blocked
        ? civitaiAsyncFailure(result.status, [blocked], true)
        : new CivitaiError({ code: "civitai_output_unavailable", retry: "deliberate", stage: "workflow_terminal" });
    }
    return {
      ok: true,
      image: await downloadOutput(image.url),
      predictionId,
      executedVersionId: CIVITAI_KLEIN_4B_VERSION_ID,
      sentReferenceCount: references.length,
    };
  } catch (error) {
    return { ok: false, ...(predictionId ? { predictionId } : {}), error: error instanceof Error ? error.message : "Civitai generation failed" };
  }
}
