import { defineConfig, globalIgnores } from "eslint/config";
import nextPlugin from "eslint-config-next";

export default defineConfig([
  globalIgnores([".next/**", "node_modules/**", "drizzle/**"]),
  ...nextPlugin,

  // Module-boundary enforcement (docs/architecture.md "Module dependency rules").
  // The three file globs are disjoint, so each file resolves to exactly one
  // `no-restricted-imports` config. See docs/developer-notes/monorepo-evaluation.md.

  // 1. Purity: contracts + lib stay client-importable — no server/app/components.
  {
    files: ["src/contracts/**/*.{ts,tsx}", "src/lib/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [{
        group: ["@/server", "@/server/**", "@/app", "@/app/**", "@/components", "@/components/**"],
        message: "src/contracts and src/lib are pure and client-importable: no @/server, @/app, or @/components imports.",
      }] }],
    },
  },
  // 2. Client→server: UI reaches the server only via route handlers (src/app/api).
  {
    files: ["src/components/**/*.{ts,tsx}", "src/app/**/*.{ts,tsx}"],
    ignores: ["src/app/api/**"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [{
        group: ["@/server", "@/server/**"],
        message: "Client code must not import @/server; reach the server through a route handler in src/app/api.",
      }] }],
    },
  },
  // 3. Barrel discipline: import a server module via its index.ts barrel, not deep.
  {
    files: ["src/server/**/*.{ts,tsx}", "src/app/api/**/*.{ts,tsx}", "scripts/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [{
        group: ["@/server/*/*"],
        message: "Import a server module through its barrel (@/server/<module>), not a deep path.",
      }] }],
    },
  },
]);
