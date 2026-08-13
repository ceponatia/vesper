import { defineConfig, globalIgnores } from "eslint/config";
import nextPlugin from "eslint-config-next";
import tseslint from "typescript-eslint";

// LLM provider construction (createOpenRouter) belongs only in the model gateway
// (src/server/ai). `streamText`/`generateImage` from the `ai` SDK are used at the
// call sites that need them (engine narration, image pipelines) by design, so the
// `ai` package itself is NOT restricted — only provider wiring is centralized.
const RESTRICT_PROVIDER = {
  group: ["@openrouter/ai-sdk-provider"],
  message: "Build LLM providers only in the model gateway (src/server/ai); consume them through its barrel.",
};

// A workspace package publishes ONE curated entry point, so `@vesper/x/anything`
// is a path into someone else's internals. `pnpm lint:package-boundaries` is the
// authoritative check (it also proves the target exists and is declared); this
// is the same rule at editor latency.
const RESTRICT_PACKAGE_SUBPATH = {
  group: ["@vesper/*/*", "@vesper/*/**"],
  message:
    "Import a workspace package by its exact name (@vesper/<name>). Code subpaths are not public API — add the symbol to the package's root barrel instead.",
};

// The Replicate transport is a SERVER package: it holds the provider credential
// and performs network IO. While it lived under `src/server/**` the path name
// was the protection; now that it is a package, the ban has to be stated. Server
// modules, route handlers and root scripts reach it through the configured
// application runtime (`src/server/ai/replicate-runtime.ts`).
// (monorepo-image-core.spec.replicate.md §"Server-only application boundary".)
const RESTRICT_TRANSPORT_PACKAGE = {
  group: ["@vesper/image-replicate"],
  message:
    "@vesper/image-replicate is server-only — it carries the provider credential. Client-importable layers must not import it; reach the provider through a route handler and @/server/ai.",
};

const NAMING_CONVENTION = [
  "error",
  { selector: "default", format: ["camelCase"], leadingUnderscore: "allowDouble", trailingUnderscore: "allow" },
  { selector: "variable", format: ["camelCase", "UPPER_CASE", "PascalCase"], leadingUnderscore: "allowDouble" },
  { selector: "function", format: ["camelCase", "PascalCase"] },
  { selector: "parameter", format: ["camelCase", "PascalCase"], leadingUnderscore: "allow" },
  { selector: "typeLike", format: ["PascalCase"] },
  { selector: "enumMember", format: ["PascalCase", "UPPER_CASE"] },
  { selector: "import", format: null },
  // Object/type keys frequently mirror external shapes (JSON APIs, DB columns).
  { selector: ["objectLiteralProperty", "typeProperty"], format: null },
];

export default defineConfig([
  globalIgnores([".next/**", "**/node_modules/**", "drizzle/**", "coverage/**", "eslint.config.mjs", ".claude/**"]),
  ...nextPlugin,

  // ---------------------------------------------------------------------------
  // Type-aware guardrails (whole repo). These encode the failure modes agents
  // hit in a large codebase: `any` escape hatches, dropped awaits, suppressed
  // errors, unhandled union variants. See
  // docs/developer-notes/monorepo-evaluation.md (lint hardening).
  // (Circular-dependency detection lives in `pnpm lint:cycles` / madge, not
  // here: `import/no-cycle` was ~90% of lint wall-time and ~0.3 GB of its RAM
  // because it re-resolves the whole module graph per file.)
  // ---------------------------------------------------------------------------
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules: {
      // Type-safety escape hatches.
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-return": "error",
      "@typescript-eslint/no-unsafe-argument": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/ban-ts-comment": [
        "error",
        { "ts-expect-error": "allow-with-description", "ts-ignore": true, "ts-nocheck": true },
      ],
      // Async correctness — the classic agent bug in an async-heavy RAG/LLM pipeline.
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": ["error", { checksVoidReturn: { attributes: false } }],
      // Exhaustiveness over discriminated unions (turn pipeline / state variants).
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      // Consistency / drift.
      // Allow inline `import()` type annotations (idiomatic in vi.mock factories);
      // still require `import type` for ordinary imports.
      "@typescript-eslint/consistent-type-imports": ["error", { disallowTypeAnnotations: false }],
      "@typescript-eslint/no-import-type-side-effects": "error",
      "@typescript-eslint/naming-convention": NAMING_CONVENTION,
      // Cycle detection moved to `pnpm lint:cycles` (madge) — see comment above.
      "import/no-duplicates": "error",
    },
  },

  // ---------------------------------------------------------------------------
  // Module-boundary enforcement (docs/architecture.md "Module dependency rules").
  // Disjoint file globs → each file resolves to exactly one no-restricted-imports
  // config (flat config is last-match-wins, so overlapping blocks would clobber).
  // Each zone carries the provider-gateway ban except src/server/ai itself.
  // ---------------------------------------------------------------------------

  // 0. Workspace packages: the one-way boundary. `@vesper/image-core` is the
  //    provider-neutral image engine — it may not reach back into the
  //    application for ANYTHING, which is the rule that makes it a package
  //    rather than a folder with a different name. It keeps the package
  //    extractable to its own repository later without untangling imports first.
  //    (monorepo-image-core.plan.md §"The rule".)
  //
  //    TWO patterns, because there are two ways to name the app. `@/*` is its
  //    alias, and banning the alias bans the database, routes, characters, chats
  //    and the simulation engine in one line. But an alias ban alone is not a
  //    boundary: `../../../src/server/db` reaches exactly the same module and
  //    matches no `@/` glob, so the escape is spelled as a path instead. The
  //    second pattern closes it by rejecting any relative climb that lands in a
  //    top-level app directory — a package file never needs one, since
  //    everything it may import is either beneath it or a package specifier.
  {
    files: ["packages/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [
        {
          group: ["@/*", "@/**"],
          message:
            "Workspace packages are standalone: no @/ imports. If a package needs something from the app, invert it — take the value as an argument, or leave the code in the app (monorepo-image-core.plan.md).",
        },
        {
          // `../src/…`, `../../src/…`, `../../../scripts/…`, `../../packages/…` —
          // any number of climbs landing on a top-level directory of the repo.
          regex: "^\\.\\.(/\\.\\.)*/(src|scripts|drizzle|packages)(/|$)",
          message:
            "Workspace packages are standalone: a relative path that climbs out of the package is the same boundary violation as an @/ import. Import another package by its name (@vesper/…), never by path.",
        },
        RESTRICT_PROVIDER,
        RESTRICT_PACKAGE_SUBPATH,
      ] }],
    },
  },
  // 1. Purity: contracts + lib stay client-importable — no server/app/components.
  {
    files: ["src/contracts/**/*.{ts,tsx}", "src/lib/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [
        {
          group: ["@/server", "@/server/**", "@/app", "@/app/**", "@/components", "@/components/**"],
          message: "src/contracts and src/lib are pure and client-importable: no @/server, @/app, or @/components imports.",
        },
        RESTRICT_PROVIDER,
        RESTRICT_PACKAGE_SUBPATH,
        RESTRICT_TRANSPORT_PACKAGE,
      ] }],
    },
  },
  // 2. Client→server: UI reaches the server only via route handlers (src/app/api).
  {
    files: ["src/components/**/*.{ts,tsx}", "src/app/**/*.{ts,tsx}"],
    ignores: ["src/app/api/**"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [
        {
          group: ["@/server", "@/server/**"],
          message: "Client code must not import @/server; reach the server through a route handler in src/app/api.",
        },
        RESTRICT_PROVIDER,
        RESTRICT_PACKAGE_SUBPATH,
        RESTRICT_TRANSPORT_PACKAGE,
      ] }],
    },
  },
  // 3. Route handlers: barrel discipline + provider gateway + owner-safe image mutations.
  {
    files: ["src/app/api/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": ["error", {
        paths: [
          {
            name: "@/server/images",
            importNames: [
              "saveImageBuffer",
              "deleteChatUploads",
              "deleteChatAssets",
              "purgeImagesWhere",
              "internalSaveImageBuffer",
              "internalDeleteChatUploads",
              "internalDeleteChatAssets",
            ],
            message:
              "Route handlers must use saveOwnedImageBuffer/deleteOwnedChatUploads/deleteOwnedChatAssets/deleteOwnedImage(s) and pass the authenticated owner id — never a hand-built delete predicate.",
          },
        ],
        patterns: [
          { group: ["@/server/*/*"], message: "Import a server module through its barrel (@/server/<module>), not a deep path." },
          {
            group: ["@/server/images/internal", "@/server/images/internal/**"],
            message: "Internal image mutations are reserved for trusted workers and verified cascade paths, never route modules.",
          },
          RESTRICT_PROVIDER,
          RESTRICT_PACKAGE_SUBPATH,
        ],
      }],
    },
  },
  // 4. Server (except the AI gateway) + scripts: barrel discipline + provider gateway.
  {
    files: ["src/server/**/*.{ts,tsx}", "scripts/**/*.{ts,tsx}"],
    ignores: ["src/server/ai/**"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [
        { group: ["@/server/*/*"], message: "Import a server module through its barrel (@/server/<module>), not a deep path." },
        RESTRICT_PROVIDER,
        RESTRICT_PACKAGE_SUBPATH,
      ] }],
    },
  },
  // 5. The AI gateway: barrel discipline only (it owns provider construction).
  {
    files: ["src/server/ai/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [
        { group: ["@/server/*/*"], message: "Import a server module through its barrel (@/server/<module>), not a deep path." },
        RESTRICT_PACKAGE_SUBPATH,
      ] }],
    },
  },

  // A package root barrel IS the package's public API, so it lists what it
  // publishes. With `export *` a helper added to an internal domain barrel
  // becomes public through a chain of wildcards, in a diff that shows only the
  // helper. Internal folder barrels keep their wildcards — they are reading
  // aids, not publication. (monorepo-image-core.spec.guardrails.md.)
  {
    files: ["packages/*/src/index.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "ExportAllDeclaration",
          message:
            "A package root barrel may not use `export *` — list the public API explicitly, so adding an internal helper cannot publish it accidentally.",
        },
      ],
    },
  },

  // Raw fetch is forbidden in pure/UI layers — data goes through src/lib/client
  // (browser) or src/server/ai (external APIs), the only sanctioned fetch sites.
  {
    files: ["src/components/**/*.{ts,tsx}", "src/app/**/*.{ts,tsx}", "src/contracts/**/*.{ts,tsx}", "src/lib/**/*.{ts,tsx}"],
    ignores: ["src/lib/client/**", "src/app/api/**"],
    rules: {
      "no-restricted-syntax": ["error", {
        selector: "CallExpression[callee.name='fetch']",
        message: "Don't call fetch directly here; use the client data layer (src/lib/client).",
      }],
    },
  },

  // Encapsulation gate for the merge reducer (merge-decomposition.spec.md §5.5).
  // The per-turn working state (participants/items) is mutated ONLY through
  // WorkingState methods, which own the dirty-tracking. A direct field assignment
  // anywhere else in merge/ would silently bypass a dirty-mark and drop a DB
  // write, so it's a lint error. working-state.ts is the one place the mutators
  // live, so it's exempt. Two selectors: writes THROUGH `.state` (e.g.
  // `p.state.meters =`) and writes to the placement scalars on a working row.
  {
    files: ["src/server/engine/merge/**/*.{ts,tsx}"],
    ignores: ["src/server/engine/merge/working-state.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "AssignmentExpression[left.object.property.name='state']",
          message:
            "Mutate participant/item state only through a WorkingState method (it owns the dirty-mark) — see merge-decomposition.spec.md §5.5.",
        },
        {
          selector:
            "AssignmentExpression[left.property.name=/^(locationId|worn|holderParticipantId|containerInstanceId|positionNote)$/]",
          message:
            "Mutate participant/item placement only through a WorkingState method (it owns the dirty-mark) — see merge-decomposition.spec.md §5.5.",
        },
      ],
    },
  },

  // Tests & fixtures: relax the rules that legitimately fire on test scaffolding
  // (non-null on known-present fixtures; loose typing of parsed HTTP responses).
  {
    files: ["**/*.test.{ts,tsx}", "**/*.int.test.{ts,tsx}", "scripts/fixtures/**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
    },
  },
]);
