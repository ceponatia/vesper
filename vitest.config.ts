import path from "node:path";
import { configDefaults, defineConfig } from "vitest/config";

/**
 * Test projects, one per workspace that owns tests.
 *
 * The split exists so a package's behavior is never established by another
 * workspace's test environment: `src/test/setup.ts` forces the application into
 * demo mode (fake AI, no provider keys), and a package test that quietly
 * depended on it would be proving something about Vesper's configuration rather
 * than about the package. Every package project therefore runs with no setup
 * file and no `@/` alias, and resolves package names through the installed
 * workspace rather than through an alias pointing at source
 * (monorepo-image-core.spec.guardrails.md).
 *
 * `app` and `app-int` are the same application suite split by cost: integration
 * tests need Postgres, unit tests do not. The split is expressed HERE rather
 * than as a CLI `--exclude` because Vitest passes only a fixed set of CLI
 * options down to projects — `include`/`exclude` are not among them, so a
 * command-line filter would silently stop applying.
 */

const applicationAliases = { "@": path.resolve(__dirname, "./src") };
const applicationSetup = ["./src/test/setup.ts"];

export default defineConfig({
  test: {
    // Cap worker fan-out: the default forks pool otherwise spawns ~1 process
    // per core (20 here), each holding the full module graph — a big RAM spike
    // that can tip the box into OOM when a game / dev server is also running.
    // 3 keeps tests reasonably parallel without the spike. See memory notes.
    maxWorkers: 3,
    projects: [
      {
        resolve: { alias: applicationAliases },
        test: {
          name: "app",
          environment: "node",
          include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
          exclude: [...configDefaults.exclude, "**/*.int.test.ts"],
          setupFiles: applicationSetup,
        },
      },
      {
        resolve: { alias: applicationAliases },
        test: {
          name: "app-int",
          environment: "node",
          include: ["src/**/*.int.test.ts", "scripts/**/*.int.test.ts"],
          setupFiles: applicationSetup,
        },
      },
      {
        test: {
          name: "contracts",
          root: path.resolve(__dirname, "./packages/contracts"),
          environment: "node",
          include: ["src/**/*.test.ts"],
        },
      },
      {
        test: {
          name: "image-core",
          root: path.resolve(__dirname, "./packages/image-core"),
          environment: "node",
          include: ["src/**/*.test.ts"],
        },
      },
    ],
  },
});
