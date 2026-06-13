import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // sharp and pg stay external to the server bundle
  serverExternalPackages: ["sharp", "pg"],
};

export default nextConfig;
