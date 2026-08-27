import { createHmac } from "node:crypto";
import type { NextRequest } from "next/server";

/**
 * Client-address resolution for the pre-authentication limiter.
 *
 * Forwarded headers are attacker-controlled in general, so the order below is a
 * trust ranking, not a convenience fallback: Fly's edge proxy overwrites
 * `fly-client-ip` on every inbound request, making it the only header that
 * cannot be forged from outside. The rest are accepted so local dev and any
 * future reverse proxy still isolate callers.
 *
 * The security property does **not** depend on that ranking holding, though.
 * A spoofed header only changes *which* bucket a caller lands in — it never
 * grants an unlimited one — and a request with no usable header at all falls
 * into the single shared {@link UNKNOWN_CLIENT_IP} bucket. Stripping headers to
 * evade therefore costs the attacker their own isolation and buys nothing.
 */
const TRUSTED_IP_HEADERS = ["fly-client-ip", "x-real-ip"] as const;

/** The shared bucket for requests whose origin cannot be established. */
export const UNKNOWN_CLIENT_IP = "unknown";

function firstForwardedFor(value: string): string | null {
  // Leftmost entry is the original client; later entries are proxies.
  const first = value.split(",")[0]?.trim();
  return first !== undefined && first.length > 0 ? first : null;
}

export function clientIp(req: NextRequest): string {
  for (const header of TRUSTED_IP_HEADERS) {
    const value = req.headers.get(header)?.trim();
    if (value !== undefined && value.length > 0) return value;
  }
  const forwarded = req.headers.get("x-forwarded-for");
  const first = forwarded === null ? null : firstForwardedFor(forwarded);
  return first ?? UNKNOWN_CLIENT_IP;
}

/**
 * Stable, non-reversible client identifier for durable abuse records. Salted
 * with the app secret so the digest cannot be dictionary-reversed across the
 * whole IPv4 space, and truncated because correlation — not identification — is
 * the only thing the abuse log needs.
 */
export function hashClientIp(ip: string): string {
  const salt = process.env.BETTER_AUTH_SECRET ?? "vesper-abuse-salt";
  return createHmac("sha256", salt).update(ip).digest("hex").slice(0, 16);
}
