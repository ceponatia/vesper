# Admission and ownership examples

Read this reference when it is unclear whether a test earns its maintenance cost or which layer owns it.

## Other gates already own these claims

| Gate                            | Do not add a test merely to prove                                    |
| ------------------------------- | -------------------------------------------------------------------- |
| TypeScript                      | Types, arity, nullability, exhaustive switches                       |
| Type-aware ESLint               | Lint-shaped mistakes and unsafe flows                                |
| Zod                             | That Zod rejects a wrong shape; test Vesper's fallback instead       |
| `lint:cycles`                   | Circular imports                                                     |
| Auth and package guardrails     | Presence of owner predicates, dependency direction, declared exports |
| Workspace registration tripwire | Dockerfile manifest copies and `transpilePackages` registration      |
| Existing registry invariants    | A new row has a unique ID, validates, and resolves references        |
| `branchFootprint`               | A new simulation table participates in branch teardown               |
| jscpd                           | Copy-pasted scaffolding                                              |

## Primary owner map

| Claim                                                    | Primary owner                                                    |
| -------------------------------------------------------- | ---------------------------------------------------------------- |
| Pure simulation transition, deterministic replay         | `packages/simulation-core/src/lib/*.test.ts`                     |
| Registry shape, vocabulary, precedence, alias resolution | `apps/web/src/contracts/**/*.test.ts`                            |
| Parse tolerance and degraded fallback                    | The parser's module, using `@/test/diagnostics`                  |
| Prompt structure and required content                    | `apps/web/src/server/engine/prompts/*.test.ts`                   |
| Persistence, atomicity, idempotency, concurrency, replay | `apps/web/src/server/engine/simulation/*.int.test.ts`            |
| Cross-owner route authorization semantics                | `apps/web/src/server/api/authz-matrix.int.test.ts`               |
| HTTP envelopes, CSRF, quotas, backpressure               | `apps/web/src/server/api/*.test.ts` or focused integration owner |
| Repository structure no compiler can discover            | `scripts/*.test.ts` tripwire                                     |

One invariant may have several seam checks without duplicating its matrix. A pure kernel suite can own every transition; a store integration suite proves one representative transition persists atomically; a route suite proves an authorized request reaches the store and a denied request does not. Each layer states a different claim.

## Strong candidates

Tests usually earn their place for an observed regression, authorization or authority boundary, transaction rollback, concurrency, idempotency, persisted-format compatibility, deterministic identity, failure that must close safely, promised degradation, path containment, external wire format, or a user-visible behavior no other gate observes.

Tests usually do not earn their place for trivial accessors, object construction, private helper call order, framework behavior, every enum spelling, incidental formatting, snapshots of large generated text, or a refactor that preserves behavior.

For an integration test, name the real-infrastructure fact the test requires. If removing Postgres and replacing the store with an object would preserve the claim, the claim belongs in a pure suite.
