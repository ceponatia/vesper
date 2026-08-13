# @vesper/contracts

The shared foundation — the bottom of the workspace package graph. Two primitive
groups live here and nothing else:

| Module           | Owns                                                             |
| ---------------- | ---------------------------------------------------------------- |
| `diagnostics.ts` | The diagnostic contract: severity, shape, schema, collector, tee |
| `parse.ts`       | `parseOr` / `parseOrNull`, the defensive boundary parser         |

Plan and rationale: [monorepo-image-core.plan.md](../../docs/developer-notes/monorepo-image-core.plan.md).
What belongs here: [spec.foundation.md](../../docs/developer-notes/monorepo-image-core.spec.foundation.md).
How the application uses both: [docs/resilience.md](../../docs/resilience.md).

## Why it exists

`Diagnostic` is not a game concept and not an image concept. Every layer that
degrades instead of failing reports through it, so a second declaration of it is
a boundary the type system can only check by accident — which is exactly what the
first image-core extraction had to do temporarily. One definition removes the
question.

`diag` is the other half of that: a transport or planner that builds a
diagnostic needs the function, not only the shape.

## What this is NOT

**Not the new home for `src/contracts/`.** The application's contracts folder is
Vesper's game vocabulary — attributes, meters, body locations, item visibility,
species, facts — and it stays in the application. The rule of thumb:

- if a primitive can describe a chat, a character or the simulation, it belongs
  to the app;
- if it is generic infrastructure for the boundary between workspaces, it may
  belong here;
- convenience alone is never a reason to move something in.

**Not a mandate to parse more.** `parseOr` is pre-positioned here so a package
that owns an untrusted edge has one to reach for. The application keeps parsing
the database/request/LLM boundaries it already parses, and a package adopts it
only when the package itself owns the trust boundary.

## Boundary

The rules are the workspace's, not this package's — see
[the guardrails spec](../../docs/developer-notes/monorepo-image-core.spec.guardrails.md)
and `packages/image-core/README.md` §Boundary for the full statement. In short:

- one public code import path, `@vesper/contracts`, whose root barrel lists every
  public name explicitly (`export *` is rejected there);
- no `@/` imports and no relative path climbing out of this package; consumers
  likewise may not reach in by filesystem path or code subpath;
- **browser/server portable.** `zod` is the only runtime dependency. No Next, no
  Node-only built-ins, no persistence, no `process.env`, no clock or randomness;
- **no Vesper domain vocabulary**, ever;
- dependencies are declared in this package's own manifest, including test-only
  ones;
- its TypeScript project is its own — no `@/*` alias, no Next plugin, and
  `"types": []`, so no ambient `@types/*` from the root install can establish it.

`pnpm lint:package-boundaries` and `pnpm lint:package-resolution` enforce all of
that in CI's static gate.

## The application still imports its own paths

`src/contracts/diagnostics.ts` and `src/lib/parse.ts` remain the application's
entry points; they are now **re-export barrels with no implementation**. That is
deliberate: rewriting several hundred application imports to advertise a package
move buys nothing, and those barrels are still genuine application-facing APIs.

Package code imports `@vesper/contracts` directly — never an application barrel.
