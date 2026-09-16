import { createHmac } from "node:crypto";
import { isIP } from "node:net";
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
 *
 * Better Auth's own limiter reads the same edge header — `advanced.ipAddress`
 * in `server/auth/auth.ts` names it explicitly, because its default is
 * `x-forwarded-for` and a limiter keyed on a forgeable header is not a limiter.
 */
const TRUSTED_IP_HEADERS = ["fly-client-ip", "x-real-ip"] as const;

/** The shared bucket for requests whose origin cannot be established. */
export const UNKNOWN_CLIENT_IP = "unknown";

/**
 * IPv6 bucket width. A single subscriber is routinely handed a whole /64 and
 * rotates freely inside it — SLAAC privacy extensions change the low 64 bits on
 * a timer — so keying on the full address would hand any IPv6 client an
 * unlimited supply of fresh buckets, which is the same bypass this module
 * exists to prevent. /64 is the smallest block assigned as a unit, so
 * collapsing to it isolates networks without splitting one client across many
 * windows. (Better Auth's limiter defaults to the same width.)
 */
const IPV6_BUCKET_PREFIX_GROUPS = 4;

function firstForwardedFor(value: string): string | null {
  // Leftmost entry is the original client; later entries are proxies.
  const first = value.split(",")[0]?.trim();
  return first !== undefined && first.length > 0 ? first : null;
}

/**
 * Expand a syntactically valid IPv6 address to its eight 4-digit groups,
 * folding an embedded IPv4 tail (`::ffff:192.0.2.1`) into the two hex groups it
 * denotes. Callers pre-validate with {@link isIP}, so the only shapes reaching
 * here are well-formed.
 */
function ipv6Groups(value: string): string[] {
  let text = value;

  if (text.includes(".")) {
    // Rewrite the dotted tail as the two hex groups it denotes, in place, so
    // the rest of this function sees one uniform shape. Splicing rather than
    // trimming keeps a preceding `::` intact (`64:ff9b::192.0.2.1`).
    const cut = text.lastIndexOf(":");
    const octets = text
      .slice(cut + 1)
      .split(".")
      .map((part) => Number(part));
    const high = (((octets[0] ?? 0) << 8) | (octets[1] ?? 0)).toString(16);
    const low = (((octets[2] ?? 0) << 8) | (octets[3] ?? 0)).toString(16);
    text = `${text.slice(0, cut + 1)}${high}:${low}`;
  }

  const [head = "", tail = ""] = text.split("::");
  const compressed = text.includes("::");
  const left = head.length > 0 ? head.split(":") : [];
  const right = compressed && tail.length > 0 ? tail.split(":") : [];
  const zeros = Array<string>(Math.max(0, 8 - left.length - right.length)).fill("0");

  return [...left, ...zeros, ...right].map((group) => group.padStart(4, "0"));
}

/** True for `::ffff:a.b.c.d`, the IPv6 spelling of an IPv4 address. */
function mappedIpv4(groups: string[]): string | null {
  const isMapped = groups.slice(0, 5).every((group) => group === "0000") && groups[5] === "ffff";
  if (!isMapped) return null;
  const high = Number.parseInt(groups[6] ?? "0", 16);
  const low = Number.parseInt(groups[7] ?? "0", 16);
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

/**
 * Collapse an address to its bucket key: IPv4 verbatim, IPv6 to its /64, and
 * anything that is not an address at all to itself. The last case is why a
 * garbage header cannot mint buckets any faster than a real one would — it
 * still produces one key per distinct value, and the limiter's LRU ceiling
 * (`rate-limit.ts`) bounds how many of those survive.
 *
 * Passing junk through verbatim does mean a caller who spells a value as the
 * literal `2001:0db8:0000:0000::/64` lands in that network's bucket. That is
 * only reachable where no trusted header is set at all — off Fly — and there
 * every bucket is already the caller's to choose, so the collision costs nothing
 * that was not already given away.
 */
export function normalizeClientIp(value: string): string {
  const trimmed = value.trim();
  const family = isIP(trimmed);
  if (family === 4) return trimmed;
  if (family !== 6) return trimmed.toLowerCase();

  // `isIP` admits a zone index (`fe80::1%eth0`). It names a local interface
  // rather than a different caller, and left attached it would ride into the
  // dotted tail of a mapped address and corrupt the octet fold. Dropped here so
  // everything below parses a canonical literal.
  const [address = ""] = trimmed.toLowerCase().split("%");
  const groups = ipv6Groups(address);
  const ipv4 = mappedIpv4(groups);
  if (ipv4 !== null) return ipv4;
  return `${groups.slice(0, IPV6_BUCKET_PREFIX_GROUPS).join(":")}::/64`;
}

export function clientIp(req: NextRequest): string {
  for (const header of TRUSTED_IP_HEADERS) {
    const value = req.headers.get(header)?.trim();
    if (value !== undefined && value.length > 0) return normalizeClientIp(value);
  }
  const forwarded = req.headers.get("x-forwarded-for");
  const first = forwarded === null ? null : firstForwardedFor(forwarded);
  return first === null ? UNKNOWN_CLIENT_IP : normalizeClientIp(first);
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
