import { NextResponse, type NextRequest } from "next/server";
import { jsonError, type ApiError } from "./respond";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export type RouteCsrfOptions =
  | { csrf?: "enforce" }
  | { csrf: "exempt"; csrfExemptionReason: string };

function normalizeOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/**
 * The same origin policy Better Auth uses: the canonical deployment URL plus
 * explicitly trusted alternate origins (LAN development, preview hosts, etc.).
 * In non-production environments only, the request URL itself is also accepted
 * so zero-config local development and isolated route tests remain usable.
 */
export function configuredApplicationOrigins(req: NextRequest): ReadonlySet<string> {
  const origins = new Set<string>();
  const candidates = [
    process.env.BETTER_AUTH_URL ?? "",
    ...(process.env.BETTER_AUTH_TRUSTED_ORIGINS ?? "").split(","),
  ];
  for (const candidate of candidates) {
    const normalized = normalizeOrigin(candidate.trim());
    if (normalized) origins.add(normalized);
  }
  if (process.env.NODE_ENV !== "production") origins.add(req.nextUrl.origin);
  return origins;
}

/**
 * Reject cookie-authenticated cross-site mutations before authentication or
 * handler code runs. Requests without cookies are not CSRF-capable; browser
 * mutations carrying a session cookie must provide an allowed Origin.
 */
export function csrfRejection(
  req: NextRequest,
  options: RouteCsrfOptions = {},
): NextResponse<ApiError> | null {
  if (!MUTATING_METHODS.has(req.method.toUpperCase())) return null;
  if (options.csrf === "exempt") {
    if (!options.csrfExemptionReason.trim()) {
      throw new Error("CSRF exemptions require a documented reason");
    }
    return null;
  }

  if (!req.headers.has("cookie")) return null;

  const origin = req.headers.get("origin");
  const normalizedOrigin = origin ? normalizeOrigin(origin) : null;
  if (!normalizedOrigin || !configuredApplicationOrigins(req).has(normalizedOrigin)) {
    return jsonError("csrf_origin", "request origin is not allowed", 403);
  }
  return null;
}
