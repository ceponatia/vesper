import { createHash } from "node:crypto";

const REDACTED = "[REDACTED]";
const SECRET_KEYS = /^(authorization|token|apikey|api_key|api-key|x-api-key|bearer)$/i;

export function sha256Hex(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

/** Strip signed query material and embedded credentials from a URL. */
export function redactUrl(value) {
  try {
    const url = new URL(value);
    const hadQuery = url.search !== "";
    const hadCredentials = url.username !== "" || url.password !== "";
    if (!hadQuery && !hadCredentials) return value;
    url.username = "";
    url.password = "";
    url.search = "";
    return `${url.toString()}${hadQuery ? "?[query-redacted]" : ""}`;
  } catch {
    return value;
  }
}

/**
 * Describe a data URL by media type, byte length and content hash instead of
 * retaining megabytes of base64 in every saved request.
 */
export function describeDataUrl(value, labels) {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(value);
  if (!match) return "[data-url unparsed]";
  const bytes = Buffer.from(match[2], "base64");
  const label = labels?.get(value);
  return `[data-url ${match[1]} ${bytes.length}B sha256:${sha256Hex(bytes)}${label ? ` ref:${label}` : ""}]`;
}

/**
 * Deep-redact a JSON value for retention on disk: secrets by key name,
 * signed URLs by query removal, data URLs by hash description, and any
 * other opaque blob by length. Safe to call on requests and responses alike.
 */
export function redact(value, labels) {
  if (typeof value === "string") {
    if (value.startsWith("data:")) return describeDataUrl(value, labels);
    if (/^https?:\/\//i.test(value)) return redactUrl(value);
    if (value.length > 4096 && !/\s/.test(value)) return `[opaque ${value.length} chars]`;
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, labels));
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = SECRET_KEYS.test(key) ? REDACTED : redact(item, labels);
    }
    return out;
  }
  return value;
}

/** Hostname only, for retained output provenance. */
export function urlHost(value) {
  try {
    return new URL(value).hostname;
  } catch {
    return null;
  }
}
