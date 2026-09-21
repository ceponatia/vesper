/**
 * Direct Civitai Orchestration API client for the evaluation harness.
 *
 * Rules the client enforces on every call:
 * - the bearer token lives in a private field and is never interpolated
 *   anywhere but the Authorization header;
 * - POSTs (what-if and paid submit) are NEVER retried automatically;
 * - idempotent GETs retry a bounded number of times on 429/5xx/transport;
 * - output downloads follow redirects manually and only onto Civitai hosts.
 */

export const WORKFLOWS_URL = "https://orchestration.civitai.com/v2/consumer/workflows";
export const MODEL_VERSIONS_URL = "https://civitai.com/api/v1/model-versions";
export const MODELS_URL = "https://civitai.com/api/v1/models";

export const PENDING_STATUSES = new Set(["unassigned", "preparing", "scheduled", "processing"]);
export const TERMINAL_STATUSES = new Set(["succeeded", "failed", "expired", "canceled"]);

export function isCivitaiHost(host) {
  return host === "civitai.com" || host.endsWith(".civitai.com");
}

function describeError(error) {
  return {
    name: error?.name ?? "Error",
    message: String(error?.message ?? error).slice(0, 300),
    cause: error?.cause ? String(error.cause?.code ?? error.cause?.message ?? error.cause).slice(0, 200) : undefined,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(attempt) {
  const base = Math.min(30_000, 1000 * 3 ** attempt);
  return base + Math.floor(Math.random() * 500);
}

export class CivitaiClient {
  #token;

  constructor(token, { userAgent = "vesper-klein-4b-qualification/0.1", log = () => {} } = {}) {
    if (typeof token !== "string" || token === "") throw new Error("CivitaiClient needs a token");
    this.#token = token;
    this.userAgent = userAgent;
    this.log = log;
  }

  async #request(method, url, { body, timeoutMs = 60_000, retries = 0, stage = method } = {}) {
    for (let attempt = 0; ; attempt += 1) {
      const startedAt = Date.now();
      let response;
      let text;
      try {
        response = await fetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${this.#token}`,
            "Content-Type": "application/json",
            Accept: "application/json",
            "User-Agent": this.userAgent,
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          redirect: "error",
          signal: AbortSignal.timeout(timeoutMs),
        });
        text = await response.text();
      } catch (error) {
        const failure = { ok: false, status: 0, stage, transport: describeError(error), elapsedMs: Date.now() - startedAt, attempt };
        if (method === "GET" && attempt < retries) {
          this.log(`  ${stage}: transport failure (${failure.transport.name}); retrying`);
          await sleep(backoffMs(attempt));
          continue;
        }
        return failure;
      }
      let json = null;
      try {
        json = text === "" ? null : JSON.parse(text);
      } catch {
        json = { unparsedBody: text.slice(0, 4000) };
      }
      const result = {
        ok: response.ok,
        status: response.status,
        stage,
        body: json,
        elapsedMs: Date.now() - startedAt,
        attempt,
        contentType: response.headers.get("content-type"),
      };
      if (!response.ok && method === "GET" && (response.status === 429 || response.status >= 500) && attempt < retries) {
        this.log(`  ${stage}: http ${response.status}; retrying`);
        await sleep(backoffMs(attempt));
        continue;
      }
      return result;
    }
  }

  getModelVersion(versionId) {
    return this.#request("GET", `${MODEL_VERSIONS_URL}/${encodeURIComponent(String(versionId))}`, { retries: 2, stage: "lora_metadata" });
  }

  getModel(modelId) {
    return this.#request("GET", `${MODELS_URL}/${encodeURIComponent(String(modelId))}`, { retries: 2, stage: "model_metadata" });
  }

  /** Zero-cost validation + cost quote. Never retried. */
  whatif(workflow) {
    return this.#request("POST", `${WORKFLOWS_URL}?whatif=true&wait=0`, { body: workflow, timeoutMs: 180_000, stage: "whatif" });
  }

  /** PAID. Never retried; the caller reconciles any ambiguity by tag or id. */
  submit(workflow) {
    return this.#request("POST", `${WORKFLOWS_URL}?whatif=false&wait=0`, { body: workflow, timeoutMs: 180_000, stage: "submit" });
  }

  getWorkflow(workflowId) {
    return this.#request("GET", `${WORKFLOWS_URL}/${encodeURIComponent(workflowId)}`, { retries: 3, stage: "workflow_status" });
  }

  listWorkflows({ take = 10, tags = [], cursor } = {}) {
    const params = new URLSearchParams({ take: String(take) });
    for (const tag of tags) params.append("tags", tag);
    if (cursor) params.set("cursor", cursor);
    return this.#request("GET", `${WORKFLOWS_URL}?${params.toString()}`, { retries: 2, stage: "workflow_list" });
  }

  /**
   * Download a delivered output through the blob endpoint with the bearer
   * token. Measured 2026-09-17: the signed `url` on a workflow's output
   * redirects once and, for blobs rated `r` or above, the redirect target
   * answers 403 even with the token, while `GET /v2/consumer/blobs/{id}`
   * with the token serves the bytes. Blobs rated `pg` download either way.
   */
  async downloadBlob(blobId, { maxBytes = 32 * 1024 * 1024, maxRedirects = 3 } = {}) {
    let current = `https://orchestration.civitai.com/v2/consumer/blobs/${encodeURIComponent(blobId)}`;
    const hosts = [];
    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      const parsed = new URL(current);
      if (parsed.protocol !== "https:" || !isCivitaiHost(parsed.hostname)) throw new Error(`refusing blob download from ${parsed.hostname}`);
      hosts.push(parsed.hostname);
      const response = await fetch(parsed, { redirect: "manual", headers: { Authorization: `Bearer ${this.#token}`, "User-Agent": this.userAgent }, signal: AbortSignal.timeout(120_000) });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (!location) throw new Error("blob redirect without location");
        current = new URL(location, parsed).toString();
        continue;
      }
      if (!response.ok) throw new Error(`blob download http ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length === 0) throw new Error("blob download was empty");
      if (bytes.length > maxBytes) throw new Error("blob download exceeded the size cap");
      return { bytes, hosts, contentType: response.headers.get("content-type"), via: "blob-endpoint-with-bearer" };
    }
    throw new Error("blob download exceeded the redirect cap");
  }

  /**
   * Download a delivered output. HTTPS on Civitai hosts only, at every hop.
   * Returns the bytes plus the hostname chain, never the signed URL.
   */
  async downloadOutput(url, { maxBytes = 32 * 1024 * 1024, maxRedirects = 3 } = {}) {
    let current = url;
    const hosts = [];
    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      const parsed = new URL(current);
      if (parsed.protocol !== "https:" || parsed.username || parsed.password || !isCivitaiHost(parsed.hostname)) {
        throw new Error(`refusing output download from ${parsed.protocol}//${parsed.hostname}`);
      }
      hosts.push(parsed.hostname);
      const response = await fetch(parsed, { redirect: "manual", signal: AbortSignal.timeout(120_000) });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (!location) throw new Error("redirect without location");
        current = new URL(location, parsed).toString();
        continue;
      }
      if (!response.ok) throw new Error(`output download http ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length === 0) throw new Error("output download was empty");
      if (bytes.length > maxBytes) throw new Error("output download exceeded the size cap");
      return { bytes, hosts, contentType: response.headers.get("content-type") };
    }
    throw new Error("output download exceeded the redirect cap");
  }
}

/** Poll one workflow to a terminal state, recording every observation. */
export async function pollWorkflow(client, workflowId, { timeoutMs, intervalMs = 4000, log = () => {} }) {
  const deadline = Date.now() + timeoutMs;
  const timeline = [];
  let lastStatus = null;
  for (;;) {
    const result = await client.getWorkflow(workflowId);
    const body = result.ok ? result.body : null;
    const step = body?.steps?.[0] ?? null;
    const status = body?.status ?? null;
    timeline.push({
      at: new Date().toISOString(),
      http: result.status,
      status,
      stepStatus: step?.status ?? null,
      queuePosition: step?.queuePosition ?? null,
      progress: step?.estimatedProgressRate ?? null,
      transport: result.transport,
    });
    if (status !== lastStatus) {
      log(`  workflow ${workflowId}: ${status ?? `http ${result.status}`}`);
      lastStatus = status;
    }
    if (status && TERMINAL_STATUSES.has(status)) return { workflow: body, timeline, timedOut: false };
    if (Date.now() >= deadline) return { workflow: body, timeline, timedOut: true };
    await sleep(Math.min(intervalMs, Math.max(250, deadline - Date.now())));
  }
}
