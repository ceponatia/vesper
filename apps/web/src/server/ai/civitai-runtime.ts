import { randomUUID } from "node:crypto";
import type { ImageModel } from "@vesper/image-core";
import { CIVITAI_FLUX2_KLEIN4B_SLUG } from "@vesper/image-models";
import type { RegistryModelRequest, ReplicateImageResult } from "@vesper/image-replicate";
import { civitaiApiToken } from "../images/lora-credentials";
import { CivitaiError, civitaiAsyncFailure, civitaiGetRetryDelay, civitaiHttpFailure, civitaiInsufficientBuzzFailure, civitaiReasonCodes, civitaiValidationPaths } from "./civitai-errors";

/** A documented variant selector, not an immutable numeric checkpoint revision. */
export const CIVITAI_KLEIN_4B_VERSION_ID = "4b";
export const CIVITAI_LORA_VERSION_FIELD = "civitai_lora_version";
export const CIVITAI_LORA_STRENGTH_FIELD = "civitai_lora_strength";
const WORKFLOWS_URL = "https://orchestration.civitai.com/v2/consumer/workflows";
const MODEL_VERSIONS_URL = "https://civitai.com/api/v1/model-versions";
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_REFERENCES = 2;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const ALLOWED_CONTROLS = new Set(["seed", CIVITAI_LORA_VERSION_FIELD, CIVITAI_LORA_STRENGTH_FIELD]);
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
        cfgScale: 5,
        steps: 20,
        sampleMethod: "euler",
        schedule: "simple",
        outputFormat: "jpeg",
        enablePromptExpansion: false,
        loras: loras ?? {},
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

async function waitForCivitaiGetRetry(attempt: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, civitaiGetRetryDelay(attempt)));
}

async function requestJson(url: string, init: RequestInit, token: string, stage: "lora_metadata" | "preflight" | "submit" | "workflow_status"): Promise<unknown> {
  const method = init.method ?? "GET";
  for (let attempt = 0; ; attempt += 1) {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token}`);
    headers.set("Content-Type", "application/json");
    const response = await fetch(url, {
      ...init,
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await response.text();
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
        await waitForCivitaiGetRetry(attempt);
        continue;
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
  try { parsed = new URL(url); } catch { throw new Error("Civitai returned an invalid output URL"); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || !isCivitaiHost(parsed.hostname)) {
    throw new Error("Civitai returned an output URL outside Vesper's trusted Civitai hosts");
  }
  const response = await fetch(parsed, { redirect: "error", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`Civitai output download failed (HTTP ${String(response.status)})`);
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_OUTPUT_BYTES) throw new Error("Civitai output exceeds 32 MiB");
  if (!response.body) throw new Error("Civitai returned an empty output body");
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_OUTPUT_BYTES) throw new Error("Civitai output exceeds 32 MiB");
      chunks.push(Buffer.from(chunk.value));
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  if (size === 0) throw new Error("Civitai returned an empty image");
  return Buffer.concat(chunks, size);
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
    const refusal = validateCivitaiPreflightEcho(preflight, preflightRequest);
    if (refusal) return { ok: false, error: refusal };

    // Reusing a what-if externalId can retrieve the unexecuted estimate. Only
    // this id changes: generation inputs and the payment policy stay identical.
    const submitted = await sendWorkflow({ ...preflightRequest, externalId: randomUUID() }, token, false);
    predictionId = asString(asRecord(submitted)?.id) ?? undefined;
    let result = parseCivitaiWorkflow(submitted, "Civitai generation submit");
    predictionId = result.id;
    const deadline = Date.now() + Math.max(30_000, request.timeoutMs ?? 300_000);
    while (PENDING_STATUSES.has(result.status)) {
      if (result.insufficient === true) throw civitaiInsufficientBuzzFailure();
      if (result.errors.length > 0) throw civitaiAsyncFailure(result.status, result.errors, result.blocked);
      if (Date.now() >= deadline) throw civitaiAsyncFailure("expired", ["timeout"]);
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(2000, Math.max(1, deadline - Date.now()))));
      result = parseCivitaiWorkflow(await requestJson(`${WORKFLOWS_URL}/${encodeURIComponent(predictionId)}`,
        { method: "GET" }, token, "workflow_status"));
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
