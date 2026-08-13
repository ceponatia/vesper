import { OUTPUT_TIMEOUT_MS } from "./config";
import { type ReplicateHttp, responseError } from "./http";

/**
 * Reading the image back out of a settled prediction: which member of the
 * output is the picture, and whether the host it points at may be fetched.
 */

/**
 * The image URL in a prediction's output.
 *
 * `field` names a member of an OBJECT output, which is how the multi-map
 * preprocessors answer (`{ grey_depth, color_depth }`). It is applied ONLY to
 * an object: a caller that named a field and got a bare string or an array
 * still gets that image rather than null, because "the model answered in the
 * ordinary shape" is a better outcome than refusing an image that is plainly
 * there. A field naming a member that does not exist reads as no output, which
 * is the honest answer — the caller asked for a map this version does not
 * produce.
 */
export function outputUrl(output: unknown, field?: string): string | null {
  if (field !== undefined && typeof output === "object" && output !== null && !Array.isArray(output)) {
    return outputUrl((output as Record<string, unknown>)[field]);
  }
  if (typeof output === "string" && output.trim()) return output;
  if (Array.isArray(output)) {
    const first = output.find((value): value is string => typeof value === "string" && value.trim().length > 0);
    return first ?? null;
  }
  return null;
}

/**
 * The only hosts a prediction may send us to fetch bytes from. A provider that
 * echoed an attacker-supplied URL would otherwise have this process fetch it.
 */
export function allowedOutputHost(hostname: string): boolean {
  return hostname === "replicate.delivery" || hostname.endsWith(".replicate.delivery") || hostname === "api.replicate.com";
}

export async function downloadReplicateOutput(http: ReplicateHttp, value: string): Promise<Buffer> {
  if (value.startsWith("data:image/")) {
    const comma = value.indexOf(",");
    if (comma === -1) throw new Error("replicate returned an invalid image data URL");
    return Buffer.from(value.slice(comma + 1), "base64");
  }

  const url = new URL(value);
  if (url.protocol !== "https:" || !allowedOutputHost(url.hostname)) {
    throw new Error(`replicate returned an untrusted output URL: ${url.hostname}`);
  }
  const headers = url.hostname === "api.replicate.com" ? http.authHeaders() : undefined;
  const response = await fetch(url, {
    headers,
    cache: "no-store",
    signal: AbortSignal.timeout(OUTPUT_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(await responseError(response));
  return Buffer.from(await response.arrayBuffer());
}
