import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // sharp and pg stay external to the server bundle
  serverExternalPackages: ["sharp", "pg"],
  // Dev-only: let LAN devices (a phone on the same WiFi) use the dev server.
  // Next 16 measures "cross-origin" dev requests (HMR, RSC, /_next/* client
  // runtime) against localhost, not the current host — so a page opened at the
  // LAN IP renders its SSR shell but its client-side fetches/hydration are
  // refused, leaving lists empty. Listing the LAN IP here unblocks them.
  allowedDevOrigins: ["192.168.1.64", "192.168.1.*", "192.168.0.*"],
};

export default nextConfig;
