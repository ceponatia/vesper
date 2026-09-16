import { randomUUID } from "node:crypto";
import type { ImageModel } from "@vesper/image-core";
import { CIVITAI_FLUX2_KLEIN4B_SLUG } from "@vesper/image-models";
import type { RegistryModelRequest, ReplicateImageResult } from "@vesper/image-replicate";
import { civitaiApiToken } from "../images/lora-credentials";

/**
 * Native Civitai generation for the one reviewed open-weight lane Vesper uses
 * today: FLUX.2 Klein 4B distilled + an optional Civitai LoRA resource.
 *
 * Civitai's current generation graph (civitai/civitai,
 * `flux2-klein-graph.ts`) pins distilled 4B to model-version 2612557 and its
 * orchestrator handler explicitly turns every selected LoRA resource into the
 * `loras` map sent to the Flux2 Klein engine. We use that graph directly rather
 * than handing a download URL to another provider.
 *
 * Every paid submit is preceded by the provider's `whatIfFromGraph` query. That
 * path spends no Buzz and tells us whether the resources are READY, whether the
 * account permits mature generation, and whether Civitai intends to substitute
 * the checkpoint. A failed preflight therefore costs nothing; a substitution is
 * refused rather than grading a different model under this row's name.
 */

export const CIVITAI_KLEIN_4B_VERSION_ID = "2612557";
export const CIVITAI_KLEIN_4B_ECOSYSTEM = "Flux2Klein_4B";
export const CIVITAI_LORA_VERSION_FIELD = "civitai_lora_version";
export const CIVITAI_LORA_STRENGTH_FIELD = "civitai_lora_strength";

const CIVITAI_BASE_URL = "https://civitai.com";
const WHAT_IF_PATH = "/api/trpc/orchestrator.whatIfFromGraph";
const GENERATE_PATH = "/api/trpc/orchestrator.generateFromGraph";
const GET_WORKFLOW_PATH = "/api/trpc/orchestrator.getWorkflow";
const REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_GENERATION_TIMEOUT_MS = 5 * 60_000;
const POLL_INTERVAL_MS = 2_000;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

interface CivitaiResource {
  id: number;
  model?: { type: "LORA" };
  strength?: number;
}

export interface CivitaiGenerationGraph {
  workflow: "txt2img";
  ecosystem: typeof CIVITAI_KLEIN_4B_ECOSYSTEM;
  prompt: string;
  negativePrompt?: string;
  quantity: 1;
  aspectRatio: string;
  model: { id: number };
  resources?: CivitaiResource[];
  seed?: number;
}

interface WhatIfResult {
  ready: boolean;
  allowMatureContent?: boolean;
  modelSubstitutions: unknown[];
}

interface SubmitResult {
  id: string;
  status: string;
  modelSubstitutions: unknown[];
}

interface WorkflowBlob {
  url: string;
  available: boolean;
  blockedReason: string | null;
  hidden: boolean;
}

interface WorkflowResult {
  id: string;
  status: string;
  blobs: WorkflowBlob[];
  errors: string[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function asUnknownArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isCivitaiHost(hostname: string): boolean {
  return hostname === "civitai.com" || hostname.endsWith(".civitai.com");
}

function parseJsonText(text: string, context: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${context} returned invalid JSON`);
  }
}

function unwrapTrpc(value: unknown, context: string): unknown {
  const root = asRecord(value);
  const result = asRecord(root?.result);
  const data = asRecord(result?.data);
  if (!data || !("json" in data) || data.json === null) {
    throw new Error(`${context} returned an unexpected tRPC envelope`);
  }
  return data.json;
}

function responseError(context: string, status: number, text: string): Error {
  const compact = text.trim().replace(/\s+/g, " ").slice(0, 800);
  return new Error(`${context} failed (${String(status)})${compact ? `: ${compact}` : ""}`);
}

async function civitaiRequest(
  url: string,
  init: RequestInit,
  token: string,
  context: string,
): Promise<unknown> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(url, {
    ...init,
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  if (!response.ok) throw responseError(context, response.status, text);
  return parseJsonText(text, context);
}

function numericVersionId(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  try {
    const url = new URL(trimmed);
    if (!isCivitaiHost(url.hostname)) return null;
    const match = url.pathname.match(/\/api\/download\/models\/(\d+)(?:\/|$)/);
    return match?.[1] ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

function numericControl(input: Readonly<Record<string, unknown>> | undefined, field: string): number | null {
  const value = input?.[field];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Pure graph builder used by both preview and the real provider send. */
export function civitaiKleinGraph(
  model: Pick<ImageModel, "slug">,
  request: Pick<RegistryModelRequest, "prompt" | "aspect" | "controlInput" | "versionId">,
): CivitaiGenerationGraph {
  if (model.slug !== CIVITAI_FLUX2_KLEIN4B_SLUG) {
    throw new Error(`Unsupported Civitai image model: ${model.slug}`);
  }
  if (request.versionId && request.versionId !== CIVITAI_KLEIN_4B_VERSION_ID) {
    throw new Error(
      `${model.slug} is pinned to Civitai version ${CIVITAI_KLEIN_4B_VERSION_ID}; requested ${request.versionId}`,
    );
  }

  const controls = request.controlInput;
  const loraVersion = numericVersionId(controls?.[CIVITAI_LORA_VERSION_FIELD]);
  const loraStrength = numericControl(controls, CIVITAI_LORA_STRENGTH_FIELD);
  const negativePrompt = asString(controls?.negative_prompt)?.trim() ?? "";
  const seed = numericControl(controls, "seed");

  if (controls?.[CIVITAI_LORA_VERSION_FIELD] !== undefined && loraVersion === null) {
    throw new Error("Civitai LoRA selection did not resolve to a model-version id");
  }
  if (loraVersion !== null && loraStrength === null) {
    throw new Error("Civitai LoRA selection is missing its strength");
  }

  return {
    workflow: "txt2img",
    ecosystem: CIVITAI_KLEIN_4B_ECOSYSTEM,
    prompt: request.prompt,
    ...(negativePrompt ? { negativePrompt } : {}),
    quantity: 1,
    aspectRatio: request.aspect ?? "1:1",
    model: { id: Number(CIVITAI_KLEIN_4B_VERSION_ID) },
    ...(loraVersion === null
      ? {}
      : { resources: [{ id: loraVersion, model: { type: "LORA" as const }, strength: loraStrength ?? 1 }] }),
    ...(seed === null ? {} : { seed: Math.trunc(seed) }),
  };
}

/** Preview contains only numeric Civitai resource ids — never a download token. */
export function previewCivitaiKleinRequest(
  model: Pick<ImageModel, "slug">,
  request: Pick<RegistryModelRequest, "prompt" | "aspect" | "controlInput" | "versionId">,
): Record<string, unknown> {
  return { ...civitaiKleinGraph(model, request) };
}

export function hasCivitai(): boolean {
  return civitaiApiToken() !== null;
}

function withoutPrompts(graph: CivitaiGenerationGraph): Record<string, unknown> {
  const { prompt: _prompt, negativePrompt: _negativePrompt, ...rest } = graph;
  return rest;
}

async function whatIf(graph: CivitaiGenerationGraph, token: string): Promise<WhatIfResult> {
  const input = JSON.stringify({ json: withoutPrompts(graph) });
  const url = `${CIVITAI_BASE_URL}${WHAT_IF_PATH}?${new URLSearchParams({ input }).toString()}`;
  const raw = await civitaiRequest(url, { method: "GET" }, token, "Civitai generation preflight");
  const payload = asRecord(unwrapTrpc(raw, "Civitai generation preflight"));
  if (!payload || typeof payload.ready !== "boolean") {
    throw new Error("Civitai generation preflight returned no readiness result");
  }
  const allowMatureContent = asBoolean(payload.allowMatureContent);
  return {
    ready: payload.ready,
    ...(allowMatureContent === null ? {} : { allowMatureContent }),
    modelSubstitutions: asUnknownArray(payload.modelSubstitutions),
  };
}

async function submit(graph: CivitaiGenerationGraph, token: string): Promise<SubmitResult> {
  const body = JSON.stringify({
    json: {
      input: graph,
      externalId: randomUUID(),
      tags: ["vesper", "image-generator"],
    },
  });
  const raw = await civitaiRequest(
    `${CIVITAI_BASE_URL}${GENERATE_PATH}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body },
    token,
    "Civitai generation submit",
  );
  const payload = asRecord(unwrapTrpc(raw, "Civitai generation submit"));
  const id = asString(payload?.id);
  const status = asString(payload?.status);
  if (!id || !status) throw new Error("Civitai generation submit returned no workflow id/status");
  return { id, status, modelSubstitutions: asUnknownArray(payload?.modelSubstitutions) };
}

function collectStrings(value: unknown, output: string[]): void {
  if (typeof value === "string") {
    const text = value.trim();
    if (text && text.length <= 500) output.push(text);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, output);
  }
}

function blobsFromOutput(output: Record<string, unknown> | null): unknown[] {
  if (!output) return [];
  if (Array.isArray(output.images)) return output.images;
  if (Array.isArray(output.blobs)) return output.blobs;
  return output.blob === undefined || output.blob === null ? [] : [output.blob];
}

/**
 * Civitai's RAW `getWorkflow` response stores the hidden flag in step metadata,
 * keyed by blob id. It is not a blob field. The legacy key was `images`; the
 * current key is `output`, with the current value winning when both exist.
 */
function hiddenForBlob(step: Record<string, unknown> | null, blobId: string): boolean {
  if (!step || !blobId) return false;
  const metadata = asRecord(step.metadata);
  const current = asRecord(metadata?.output);
  const legacy = asRecord(metadata?.images);
  const currentMeta = asRecord(current?.[blobId]);
  const legacyMeta = asRecord(legacy?.[blobId]);
  return asBoolean(currentMeta?.hidden) ?? asBoolean(legacyMeta?.hidden) ?? false;
}

function parseWorkflow(value: unknown, requestedId: string): WorkflowResult {
  const payload = asRecord(unwrapTrpc(value, "Civitai workflow status"));
  if (!payload) throw new Error("Civitai workflow status returned an invalid workflow");
  const status = asString(payload.status);
  if (!status) throw new Error("Civitai workflow status returned no status");

  const blobs: WorkflowBlob[] = [];
  const errors: string[] = [];
  for (const stepValue of asUnknownArray(payload.steps)) {
    const step = asRecord(stepValue);
    const output = asRecord(step?.output);
    for (const blobValue of blobsFromOutput(output)) {
      const blob = asRecord(blobValue);
      const url = asString(blob?.url);
      if (!url) continue;
      const blobId = asString(blob?.id) ?? "";
      blobs.push({
        url,
        available: asBoolean(blob?.available) ?? false,
        blockedReason: asString(blob?.blockedReason),
        hidden: hiddenForBlob(step, blobId),
      });
    }
    collectStrings(step?.errors, errors);
    collectStrings(step?.error, errors);
    collectStrings(output?.errors, errors);
    collectStrings(output?.error, errors);
  }

  return {
    id: asString(payload.id) ?? requestedId,
    status,
    blobs,
    errors: [...new Set(errors)].slice(0, 5),
  };
}

async function getWorkflow(id: string, token: string): Promise<WorkflowResult> {
  const input = JSON.stringify({ json: { workflowId: id } });
  const url = `${CIVITAI_BASE_URL}${GET_WORKFLOW_PATH}?${new URLSearchParams({ input }).toString()}`;
  const raw = await civitaiRequest(url, { method: "GET" }, token, "Civitai workflow status");
  return parseWorkflow(raw, id);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForWorkflow(id: string, token: string, timeoutMs: number): Promise<WorkflowResult> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const workflow = await getWorkflow(id, token);
    const status = workflow.status.toLowerCase();
    if (!["unassigned", "preparing", "scheduled", "processing"].includes(status)) return workflow;
    if (Date.now() >= deadline) throw new Error(`Civitai workflow ${id} timed out`);
    await sleep(Math.min(POLL_INTERVAL_MS, Math.max(50, deadline - Date.now())));
  }
}

function civitaiOutputUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Civitai returned an invalid output URL");
  }
  if (parsed.protocol !== "https:") throw new Error("Civitai output URL was not HTTPS");
  if (!isCivitaiHost(parsed.hostname)) {
    throw new Error(`Civitai returned output on an unexpected host: ${parsed.hostname}`);
  }
  return parsed;
}

async function downloadOutput(url: string): Promise<Buffer> {
  const response = await fetch(civitaiOutputUrl(url), { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`Civitai output download failed (${String(response.status)})`);
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_OUTPUT_BYTES) {
    throw new Error("Civitai image exceeded the 32 MiB download limit");
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0) throw new Error("Civitai returned an empty image");
  if (bytes.length > MAX_OUTPUT_BYTES) throw new Error("Civitai image exceeded the 32 MiB download limit");
  return bytes;
}

export async function runCivitaiKleinImageModel(
  model: ImageModel,
  request: RegistryModelRequest,
): Promise<ReplicateImageResult> {
  const token = civitaiApiToken();
  if (!token) return { ok: false, error: "Civitai API token is not configured" };
  if ((request.references?.length ?? 0) > 0 || (request.controlReferences?.length ?? 0) > 0) {
    return { ok: false, error: `${model.slug} is currently registered for text-to-image generation only` };
  }

  try {
    const graph = civitaiKleinGraph(model, request);
    const estimate = await whatIf(graph, token);
    if (!estimate.ready) {
      return { ok: false, error: "Civitai reports this checkpoint/LoRA combination is not currently generatable" };
    }
    if (estimate.modelSubstitutions.length > 0) {
      return { ok: false, error: "Civitai would substitute a different checkpoint; generation was refused before spend" };
    }
    if ((graph.resources?.length ?? 0) > 0 && estimate.allowMatureContent === false) {
      return { ok: false, error: "Civitai account does not currently permit mature-content generation" };
    }

    const submitted = await submit(graph, token);
    if (submitted.modelSubstitutions.length > 0) {
      return {
        ok: false,
        predictionId: submitted.id,
        error: "Civitai substituted a different checkpoint after submit; refusing the result",
      };
    }

    const workflow = await waitForWorkflow(
      submitted.id,
      token,
      Math.max(30_000, request.timeoutMs ?? DEFAULT_GENERATION_TIMEOUT_MS),
    );
    if (workflow.status.toLowerCase() !== "succeeded") {
      const detail = workflow.errors.length > 0 ? `: ${workflow.errors.join("; ")}` : "";
      return { ok: false, predictionId: workflow.id, error: `Civitai workflow ${workflow.status}${detail}` };
    }

    const deliverable = workflow.blobs.find(
      (blob) => blob.available && !blob.hidden && (blob.blockedReason === null || blob.blockedReason.trim() === ""),
    );
    if (!deliverable) {
      const blocked = workflow.blobs.find((blob) => blob.blockedReason && blob.blockedReason.trim() !== "");
      return {
        ok: false,
        predictionId: workflow.id,
        error: blocked?.blockedReason
          ? `Civitai blocked the generated output: ${blocked.blockedReason}`
          : "Civitai workflow succeeded without a deliverable image",
      };
    }

    return {
      ok: true,
      image: await downloadOutput(deliverable.url),
      predictionId: workflow.id,
      executedVersionId: CIVITAI_KLEIN_4B_VERSION_ID,
      sentReferenceCount: 0,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Civitai generation failed" };
  }
}
