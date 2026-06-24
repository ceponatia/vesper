import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
    setupFiles: ["./src/test/setup.ts"],
    // Cap worker fan-out: the default forks pool otherwise spawns ~1 process
    // per core (20 here), each holding the full module graph — a big RAM spike
    // that can tip the box into OOM when a game / dev server is also running.
    // 3 keeps tests reasonably parallel without the spike. See memory notes.
    maxWorkers: 3,
  },
});
