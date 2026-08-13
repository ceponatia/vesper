import { REPLICATE_BASE, type ReplicateConfig } from "./config";

/**
 * The credentialed edge of the transport. Every call to `api.replicate.com`
 * goes through one of these, and the token it carries comes from the config the
 * client was built with — there is no other way to reach the provider from this
 * package, which is what makes "no ambient environment reads" checkable rather
 * than aspirational.
 */
export interface ReplicateHttp {
  /** False when no token was configured: callers fail before doing network work. */
  readonly configured: boolean;
  apiFetch(path: string, init?: RequestInit): Promise<Response>;
  authHeaders(): Record<string, string>;
}

export function createReplicateHttp(config: ReplicateConfig): ReplicateHttp {
  const authHeaders = (): Record<string, string> => ({ Authorization: `Bearer ${config.apiToken ?? ""}` });
  return {
    configured: Boolean(config.apiToken),
    authHeaders,
    async apiFetch(path, init = {}) {
      return fetch(`${REPLICATE_BASE}${path}`, {
        ...init,
        cache: "no-store",
        headers: {
          ...authHeaders(),
          ...(init.headers ?? {}),
        },
      });
    },
  };
}

/** The message a caller gets when the provider was never configured. */
export const NOT_CONFIGURED_ERROR = "REPLICATE_API_TOKEN not configured";

export async function responseError(response: Response): Promise<string> {
  const body = await response.text().catch(() => "");
  return `replicate ${response.status}: ${body.slice(0, 500) || response.statusText}`;
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
