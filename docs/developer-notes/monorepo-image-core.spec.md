# Monorepo migration — spec index and shared mechanics

Status: companion to [monorepo-image-core.plan.md](monorepo-image-core.plan.md)

This is the technical hub for the monorepo topic. It indexes the slice specs and
owns only the cross-slice facts that do not have a narrower owner. Mechanical
workspace boundaries, dependency ownership, package runtime targets, public
exports, package-local typechecking and test isolation are owned by the Slice 1
guardrails spec rather than duplicated here.

## Spec index

| Spec                                                                 | Slice | Canonical owner of                           |
| -------------------------------------------------------------------- | ----- | -------------------------------------------- |
| [spec.guardrails.md](monorepo-image-core.spec.guardrails.md)         | 1     | Workspace/package mechanical guardrails     |
| [spec.render-kernel.md](monorepo-image-core.spec.render-kernel.md)   | 2     | Render planning/compile extraction           |
| [spec.foundation.md](monorepo-image-core.spec.foundation.md)         | 3     | `@vesper/contracts`                          |
| [spec.replicate.md](monorepo-image-core.spec.replicate.md)           | 4     | `@vesper/image-replicate`                    |
| [spec.apps-web.md](monorepo-image-core.spec.apps-web.md)             | 6     | The application move to `apps/web`           |

Slice 5 (vision) has no detail spec because the architecture review concluded
that no package-worthy pure surface exists today. The inventory below is the
canonical technical record of that completed no-extraction decision.

## Implementation status

| Slice | State                              | Notes                                     |
| ----- | ---------------------------------- | ----------------------------------------- |
| 1     | complete — 2026-08-12              | —                                         |
| 2     | complete — 2026-08-12              | —                                         |
| 3     | complete — 2026-08-12              | —                                         |
| 4     | complete — 2026-08-13              | —                                         |
| 5     | complete — no extraction warranted | revisit only when a shared seam earns it  |
| 6     | built 2026-08-12                   | awaiting the deployed verification        |

## Cross-slice ownership map

Use the narrower spec rather than restating its rules in implementation work:

- **Workspace imports, deep-import bans, nearest-manifest dependency ownership,
  package graph direction/cycles, explicit package root exports, package-local
  TypeScript, package-scoped tests, real-workspace resolution smoke checks, and
  runtime targets** —
  [guardrails spec](monorepo-image-core.spec.guardrails.md).
- **What moves into the core render kernel, including browser-safe fingerprint
  construction versus application-owned SHA-256 execution** —
  [render-kernel spec](monorepo-image-core.spec.render-kernel.md).
- **The one shared diagnostics/parsing implementation and application re-export
  policy** — [foundation spec](monorepo-image-core.spec.foundation.md).
- **Replicate transport, configured runtime, environment inversion, server-only
  boundary and live provider smoke checks** —
  [Replicate spec](monorepo-image-core.spec.replicate.md).
- **Workspace/app manifests, root/app tooling split, path/CWD audit, CI
  classifier, Docker/Fly/storage preservation and Next-root configuration** —
  [apps/web spec](monorepo-image-core.spec.apps-web.md).

When two specs appear to define the same contract, this map decides the owner;
the other document should summarize and link rather than grow a second version.

## The vision path: extraction decision

The target architecture has previously named a possible `@vesper/image-vision`.
The architecture review found that creating it now would move names without
moving ownership, so Slice 5 completes with no package extraction.

The live path runs on **OpenRouter, not Replicate**. Its entry point is
`generateChecked` with an `images` option, and `visionModelId()`
(`src/server/ai/provider.ts`, `MODEL_DEFAULTS.vision`) supplies the code-default
model. Two consumers exist:

| Consumer                                      | What it does                        |
| --------------------------------------------- | ----------------------------------- |
| `src/server/authoring/portrait-attributes.ts` | Portrait → closed-vocabulary traits |
| `src/server/engine/chat-vision.ts`            | Describes a message's attachments   |

Neither exposes a provider-neutral image core worth a package:

- `portrait-attributes.ts` builds its schema from the Vesper attribute registry
  and merges readings against a character draft.
- `chat-vision.ts` is a small game-facing prompt and one general model call with
  a fallback.
- What they genuinely share — `generateChecked`, `withGenerateTimeout`, and demo
  handling — is the general model-call layer the narrator also uses. A future
  extraction there would be an `@vesper/ai` concern, not an image package.

**Reopen this decision only when at least two vision consumers demonstrably
share a meaningful provider-neutral visual-understanding contract or
implementation** — for example a common reading vocabulary, grounding or
provenance step, uncertainty/occlusion handling, multi-image ordering, model
capability negotiation, or degradation policy. A third consumer is neither
required nor sufficient by itself. Until such a seam exists, creating an
`@vesper/image-vision` package would make the diagram prettier without making
the code easier to own.

Reference doc for the live path: [docs/images/vision.md](../images/vision.md).

## Conventions every implementation slice follows

- **One slice, one PR, ready-state `verify` green for code/config work.** Open the
  PR as a draft while iterating; mark it ready only for the milestone CI run, per
  root `CLAUDE.md`.
- **Local validation follows the repository gate policy.** `pnpm gates:local` is
  allowed only as a deliberate batch checkpoint when the owner asks or the
  repository rules call for one. Raw lint/type/test/verify commands remain
  banned locally; tests/build/evals run in CI.
- **Documentation-only changes follow the repository docs path.** Review rendered
  Markdown, links and topic consistency; they do not need a full CI dispatch.
- **Tests move with the code they cover.** A database-dependent test stays in the
  application; a supposedly moved pure test that still needs DB/app setup is a
  boundary smell to fix before moving it.
- **Behavior is unchanged at every extraction slice.** A bug uncovered by the
  move is filed or fixed separately unless correcting it is required to preserve
  the stated boundary itself.
- **Prefer deletion to compatibility implementation wrappers.** An existing
  application barrel may re-export a package when that barrel remains a genuine
  application-facing API, but it must not hide copied/dead implementation code.
- **Inventory by exported symbol, not only module path.** Wide barrels can hide
  consumers that never spell the original source filename. Search the exported
  names before deleting/moving an implementation.
- **Exercise packages as packages.** The Slice 1 real-workspace smoke check stays
  in verification for later packages so source aliases cannot become the only
  proof that manifests/exports resolve.