import path from "node:path";
import { configDefaults, defineConfig } from "vitest/config";

/**
 * The APPLICATION test projects — and only those.
 *
 * Every workspace package owns its own `vitest.config.ts` and its own `test`
 * script, so `pnpm test` at the root runs this config's `app` project and then
 * `pnpm -r run test`, which discovers the packages by walking the workspace.
 * Adding a package therefore adds no project here and no name to any root
 * script; forgetting to register one is no longer a way to lose a suite.
 *
 * `app` and `app-int` stay ROOT-OWNED on purpose — the documented exception.
 * Two properties force it, and both are properties of the repository rather
 * than of `apps/web`:
 *
 *   - the run root must be the REPOSITORY root. Several application and script
 *     tests locate source through `process.cwd()` plus a repo-relative path
 *     (`apps/web/src/app/api`, the Dockerfile, `eslint.config.mjs`), so a
 *     config rooted at `apps/web` would resolve them one directory too deep.
 *   - the suite spans TWO workspaces. `scripts/**` tests are the repository's
 *     tripwire tests — they scan application source and import
 *     `@/server/test-support` — so they need the application alias and the same
 *     demo-mode setup (`apps/web/src/test/setup.ts`, which forces fake AI and
 *     strips provider keys) as the code they inspect. A config inside
 *     `apps/web` could not claim them.
 *
 * `apps/web` consequently defines NO `test` script: its suite is already this
 * config's `app`/`app-int` projects, and a delegating script would either run
 * the same tests twice or hand them a working directory that breaks them.
 * `pnpm -r run test` simply skips a workspace without the script, so the
 * absence is the whole mechanism. (`typecheck` has no such constraint, so
 * `apps/web` owns that one like every package.)
 *
 * Package projects are gone from here, and the properties they were given
 * survive in each package's own config: no setup file and no `@/` alias, so a
 * package test proves something about the package rather than about Vesper's
 * configuration, and workspace dependencies resolve through the installed
 * workspace link rather than an alias pointing at source
 * (monorepo-image-core.spec.guardrails.md).
 *
 * `app` and `app-int` are the same application suite split by cost: integration
 * tests need Postgres, unit tests do not. The split is expressed HERE rather
 * than as a CLI `--exclude` because Vitest passes only a fixed set of CLI
 * options down to projects — `include`/`exclude` are not among them, so a
 * command-line filter would silently stop applying.
 */

const applicationAliases = { "@": path.resolve(__dirname, "./apps/web/src") };
const applicationSetup = ["./apps/web/src/test/setup.ts"];

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
          include: ["apps/web/src/**/*.test.ts", "scripts/**/*.test.ts"],
          exclude: [...configDefaults.exclude, "**/*.int.test.ts"],
          setupFiles: applicationSetup,
        },
      },
      {
        resolve: { alias: applicationAliases },
        test: {
          name: "app-int",
          environment: "node",
          include: ["apps/web/src/**/*.int.test.ts", "scripts/**/*.int.test.ts"],
          setupFiles: applicationSetup,
        },
      },
    ],
  },
});
