import type { NextConfig } from "next";

const isProduction = process.env.NODE_ENV === "production";

// Security headers applied to all routes (source: "/(.*)")
//
// CSP philosophy:
//   'unsafe-inline' and 'unsafe-eval' in script-src are a deliberate
//   concession so Next.js's inline runtime bootstrap and HMR scripts
//   aren't broken. The high-value mitigations that protect against the
//   most impactful attack classes still hold:
//     - object-src 'none'     → no Flash/plugin code execution
//     - base-uri 'self'       → no base-tag hijacking of relative URLs
//     - frame-ancestors 'none'→ clickjacking blocked (replaces X-Frame-Options)
//     - form-action 'self'    → form submissions can't be exfiltrated off-origin
//
// HSTS is only emitted in production (NODE_ENV==="production") so the header
// is never sent over a plaintext LAN dev server, where it would poison the
// browser's HSTS cache for the LAN IP.
//
// connect-src adds ws:/wss: in development only, so Next's HMR/Fast-Refresh
// WebSocket is guaranteed to connect regardless of browser 'self'-vs-WebSocket
// quirks. Production stays strict ('self' only) — the app makes no client-side
// off-origin requests (no Sentry/analytics/CDN; next/font self-hosts).

const securityHeaders: Array<{ key: string; value: string }> = [
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      isProduction ? "connect-src 'self'" : "connect-src 'self' ws: wss:",
      "object-src 'none'",
      "base-uri 'self'",
      "frame-ancestors 'none'",
      "form-action 'self'",
    ].join("; "),
  },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=()",
  },
  ...(isProduction
    ? [
        {
          key: "Strict-Transport-Security",
          value: "max-age=63072000; includeSubDomains; preload",
        },
      ]
    : []),
];

const nextConfig: NextConfig = {
  // sharp and pg stay external to the server bundle
  serverExternalPackages: ["sharp", "pg"],
  // Workspace packages ship TypeScript source (no build step), so Next has to
  // compile them the same way it compiles src/.
  transpilePackages: ["@vesper/image-core"],
  // Dev-only: let LAN devices (a phone on the same WiFi) use the dev server.
  // Next 16 measures "cross-origin" dev requests (HMR, RSC, /_next/* client
  // runtime) against localhost, not the current host — so a page opened at the
  // LAN IP renders its SSR shell but its client-side fetches/hydration are
  // refused, leaving lists empty. Listing the LAN IP here unblocks them.
  // Wildcards dropped — only the specific dev machine IP is allowed.
  allowedDevOrigins: ["192.168.1.64"],

  // Disable Turbopack's persistent dev filesystem cache. It's on by default
  // (writes .next/dev/cache/turbopack/*.sst) but isn't garbage-collected — it
  // grew to 34 GB over days and inflated the dev server to ~4 GB RAM (the cache
  // is memory-mapped and indexed), which on this 16 GB box helped trip the OOM
  // killer. Off = bounded memory and no disk churn; the only cost is a cold
  // compile of each route on first visit per session (Turbopack compiles
  // lazily, so the server is still "Ready" in ~1-2s). In-session caching is
  // unaffected — revisiting a page you've already opened stays instant.
  experimental: {
    turbopackFileSystemCacheForDev: false,
  },

  async headers(): Promise<
    Array<{ source: string; headers: Array<{ key: string; value: string }> }>
  > {
    return [
      {
        source: "/(.*)",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
