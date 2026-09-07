import { z } from "zod";

export interface ApiError {
  status: number;
  code: string;
  message: string;
  /**
   * The raw error body, for the rare caller whose FAILURE response carries data it
   * must act on — the identity-pack manual crop reads the fresh summary out of a
   * 409 so a stale editor reloads from the conflict itself rather than racing a
   * second GET. Untyped on purpose: parse it, never read fields off it.
   */
  body?: unknown;
}

export type ApiResult<T> =
  { ok: true; data: T } | { ok: false; error: ApiError };

const errorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string().catch("unknown"),
    message: z.string().catch(""),
  }),
});

/** Pure: shape an HTTP failure body (any JSON, or none) into an ApiError. */
export function toApiError(status: number, raw: unknown): ApiError {
  const parsed = errorEnvelopeSchema.safeParse(raw);
  if (parsed.success) {
    return {
      status,
      code: parsed.data.error.code,
      message: parsed.data.error.message || `Request failed (${status})`,
    };
  }
  return {
    status,
    code: `http_${status}`,
    message: `Request failed (${status})`,
  };
}

async function request<T>(
  schema: z.ZodType<T>,
  path: string,
  init?: RequestInit,
): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(path, {
      cache: "no-store",
      ...init,
      headers: {
        accept: "application/json",
        ...(init?.body !== undefined
          ? { "content-type": "application/json" }
          : {}),
        ...(init?.headers ?? {}),
      },
    });
  } catch (err) {
    return {
      ok: false,
      error: {
        status: 0,
        code: "network_error",
        message: err instanceof Error ? err.message : "Network error",
      },
    };
  }
  let raw: unknown = null;
  try {
    raw = await res.json();
  } catch {
    raw = null; // empty body (e.g. 204) is fine; schemas tolerate null
  }
  if (!res.ok)
    return { ok: false, error: { ...toApiError(res.status, raw), body: raw } };
  const parsed = schema.safeParse(raw);
  if (parsed.success) return { ok: true, data: parsed.data };
  return {
    ok: false,
    error: {
      status: res.status,
      code: "client.response_shape",
      message: "Unexpected response shape",
    },
  };
}

export function apiGet<T>(
  schema: z.ZodType<T>,
  path: string,
): Promise<ApiResult<T>> {
  return request(schema, path);
}

export function apiPost<T>(
  schema: z.ZodType<T>,
  path: string,
  body?: unknown,
): Promise<ApiResult<T>> {
  return request(schema, path, {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export function apiPatch<T>(
  schema: z.ZodType<T>,
  path: string,
  body: unknown,
): Promise<ApiResult<T>> {
  return request(schema, path, { method: "PATCH", body: JSON.stringify(body) });
}

export function apiPut<T>(
  schema: z.ZodType<T>,
  path: string,
  body: unknown,
): Promise<ApiResult<T>> {
  return request(schema, path, { method: "PUT", body: JSON.stringify(body) });
}

export function apiDelete(path: string): Promise<ApiResult<unknown>> {
  return request(z.unknown(), path, { method: "DELETE" });
}

/** Build `path?key=value` skipping undefined/empty params. */
export function withQuery(
  path: string,
  params: Record<string, string | number | boolean | undefined>,
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === "") continue;
    search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `${path}?${qs}` : path;
}

export function imageUrl(imageId: string): string {
  return `/api/images/${imageId}/file`;
}
