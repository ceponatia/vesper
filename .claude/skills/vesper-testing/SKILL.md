---
name: vesper-testing
description: Decide whether a Vesper change actually needs a new test, and design the smallest test that earns its keep. Use this whenever you are about to write, expand, or review a test anywhere in this repo — when a plan says "add tests", right after fixing a bug, when you changed production code and are wondering what to cover, when you added a registry entry or a helper, or when you catch yourself writing a second test for something another layer already proves. Vesper already runs ~6,000 pure test cases across 487 files; test count is not a quality metric here, and "no new test" is a valid and common outcome.
---

# Testing decisions in Vesper

`docs/testing.md` is the authoritative reference for **how** Vesper's suites are
wired — projects, layers, shared utilities, gates, strict integration mode. Read
it for mechanics. This skill covers what that doc deliberately leaves out:
**whether a test should exist at all, and who owns it.**

## The rule

> **Test distinct, important behavior and failure modes. Do not test code
> merely because code exists.**

Vesper has 487 test files and ~145k lines of test code — roughly 6,000 pure
cases plus ~1,000 integration cases. Every one of them is permanent: it runs on
every push, gets read during every nearby refactor, and has to be updated when
the code it touches moves. A 2026-07-28 audit found ~6k removable lines of
scaffolding and hand-enumerated assertions, and the consolidation deleted ~5.9k
net test lines (`docs/developer-notes/finished/test-consolidation.plan.md`).
That debt was not written by careless people; it accumulated one reasonable-
looking test at a time.

**Test count is not a quality metric.** A change with zero new tests may be
completely correct — because existing tests already protect the behavior, or
because the change has no runtime invariant worth protecting. One well-designed
test routinely beats twenty narrow ones. Optimize for **defect-detection value
per line of permanent test code**, not for the appearance of thoroughness.

## Admission checklist

Answer these to yourself before writing any new permanent test. **If you cannot
answer 1 and 2 concretely and specifically, do not write the test.**

1. **What invariant, contract, regression, or failure mode does this protect?**
   Name it in one sentence. "It covers `resolveFoo`" is not an answer; "an
   unanchored player principal cannot mutate another owner's branch" is.
2. **What realistic defect would make this test fail?** Describe the bad
   implementation it kills. If the only implementation that fails it is one
   nobody would write, the test is ceremony.
3. **Would another gate already catch that defect?** See below — Vesper has a
   lot of them.
4. **Is this behavior already tested at another layer?** Search first.
5. **What is the lowest layer that owns this invariant?** Test it there.
6. **Can an existing test or suite be extended instead?** Usually yes.
7. **Can several cases collapse into one table-driven, property, registry-derived
   or schema-derived test?**
8. **Is the assertion about externally meaningful behavior, or about how the code
   currently happens to be arranged?**

### What Vesper's other gates already catch

Question 3 is answerable, not rhetorical. Do not spend a permanent test on
anything in this column:

| Already gated by                                        | So don't test                                                     |
| ------------------------------------------------------- | ----------------------------------------------------------------- |
| `tsc` (root + every workspace)                           | types, arity, nullability, exhaustive switches, "returns an object" |
| type-aware ESLint at `--max-warnings 0`                  | lint-shaped mistakes, unsafe `any` flows                            |
| Zod schemas at trust boundaries (`parseOr`)              | that Zod rejects the wrong shape — test *your* fallback instead     |
| `lint:cycles`                                            | circular imports                                                    |
| `lint:authz` + `scripts/ownership-guardrail.test.ts`     | that a route mutation carries *some* owner predicate                |
| `lint:package-boundaries` / `lint:package-resolution`    | import direction, declared exports, runtime targets                 |
| `scripts/workspace-registration.test.ts`                 | Dockerfile COPY and `transpilePackages` registration                |
| existing registry invariants (`@/test/registry-invariants`) | that a **new registry row** has a unique id, validates, resolves refs |
| `branchFootprint` (`@/server/test-support`)              | that a new `sim_*` table is covered by branch teardown/footprint     |
| `scripts/fixtures/harbor-house.test.ts`                  | that the seed fixture still matches the contracts registries        |
| jscpd (threshold 3, **covers test files**)               | nothing — but it will fail you for copy-pasted test scaffolding      |

## Ownership: one invariant, one owner

This is the single biggest source of avoidable test bloat. **Every invariant has
exactly one primary owner. That layer tests it thoroughly. Every other layer
tests only that its seam connects correctly — never the owner's full matrix.**

Worked example — a pure state transition with 30 meaningful input combinations:

- **`packages/simulation-core/src/lib/*.test.ts` (owner)** — exhaustively
  exercises all 30. Pure, fast, no DB, no alias, no demo-mode setup.
- **`server/engine/simulation/*-store.int.test.ts`** — proves *persistence*:
  durability, transaction atomicity, idempotency key behavior, typed holdings,
  crash rollback. Plus maybe **one or two** representative transitions to prove
  the store hands the kernel the right input. Not 30.
- **`app/api/**/*.int.test.ts`** — proves *wiring*: auth, request validation,
  response envelope, one accepted and one rejected command. Not 30.
- **Components** — nothing. The matrix does not belong in the UI.

If you find yourself re-proving the same rule at contracts *and* adapter *and*
engine *and* store *and* route, four of those five are waste.

### Owner map

| Invariant kind                                          | Primary owner                                                       |
| ------------------------------------------------------- | -------------------------------------------------------------------- |
| pure simulation rules, kernels, deterministic replay     | `packages/simulation-core/src/lib/*.test.ts`                          |
| registry shape, vocabulary, precedence, alias resolution | `apps/web/src/contracts/**` (derived invariants)                      |
| parse tolerance + degradation fallback                   | the module owning the parse, asserted via `@/test/diagnostics`        |
| durability, atomicity, idempotency, concurrency, replay  | `server/engine/simulation/*.int.test.ts`                              |
| authorization *semantics* per route                      | `server/api/authz-matrix.int.test.ts`                                 |
| prompt structure and content                             | `server/engine/prompts/*.test.ts` (structural, not snapshots)         |
| HTTP envelope, SSE framing, error→status mapping         | `server/api/*.test.ts` (`respond`, `stream`, `schemas`)               |
| rate limiting, quota, CSRF, backpressure                 | `server/api/*.test.ts`                                                |
| repo-structural facts nothing else can discover          | `scripts/*.test.ts` tripwires                                         |

### Legitimate multi-layer coverage

Multi-layer is not automatically duplication — it is duplication when the layers
prove the *same claim*. Vesper's authorization coverage is the model case, and
each layer proves something the others cannot:

- `server/api/authz.test.ts` — the **wrappers** behave correctly in isolation
  (unit, mocked auth).
- `server/api/authz-matrix.int.test.ts` — **real routes** deny real cross-owner
  requests against a real database.
- `scripts/ownership-guardrail.test.ts` — a **static tripwire**: no route
  mutation ships without an owner predicate *in the right position*. It cannot
  prove the predicate is correct, which is exactly why the other two exist.

Three layers, three distinct claims. Contrast that with re-asserting the same
enum mapping in five files.

### Integration tests must justify their boundary

An `.int.test.ts` needs Postgres, runs with file parallelism off, and is slower
and more fragile than anything pure. Add one only when the behavior **cannot be
proven without real infrastructure**: Postgres semantics, transactions,
concurrency and locking, persistence and replay, foreign keys and CHECK
constraints, ownership spanning stored records, route/auth wiring, or several
real components interacting.

Never reach for an integration test to re-verify pure deterministic logic that
`simulation-core` or `contracts` already owns.

One practical Vesper caveat: the `engine` gate runs `test:engine`'s curated
glob, so route-level int suites (`gallery`, `chat`, `library-routes`,
`authz-matrix`, `public-dto`, `variants`) are covered by **no** automatic gate.
An int test you add there only runs when someone runs `pnpm test:int` by hand —
weigh that against putting the invariant somewhere that always runs.

## What usually deserves a test

This list says what **qualifies** when your change actually introduces it — it is
not a checklist to satisfy. A change that touches no authorization boundary does
not need an authorization test because "authorization" appears below.

Strong candidates, because a defect here is silent, expensive, or unrecoverable:

- a **previously observed bug** — the smallest test that would have caught it
- authorization, owner isolation, cross-account boundaries
- permission / agency / authority gates
- transaction atomicity and crash rollback
- concurrency, locking, and lock-timeout behavior
- idempotency (same command applied twice)
- persistence and replay correctness
- migrations and persisted-format compatibility
- deterministic simulation invariants and hash stability
- fail-closed behavior (the refusal path, not just the happy path)
- degradation Vesper intentionally promises — **fallback *and* diagnostic code**
- security boundaries (path containment, symlink escape, public DTO field sets)
- externally consumed contracts and wire formats
- parsing where malformed or adversarial input has real consequences
- state-machine transitions where a wrong transition corrupts world state
- behavior that spans a genuine architectural seam
- user-visible behavior that could regress with no other gate noticing

## What usually does not

Do not spend permanent tests on:

- proving TypeScript's type behavior, or that Zod works as documented
- trivial getters/setters, constant existence, plain object construction
- pass-through wrappers and private helper call sequences
- asserting *which internal helper called which* — that is a refactor tripwire
- intermediate objects when only the final contract matters
- mirroring the production implementation inside the test
- chasing line or branch coverage
- one test per enum value when a registry-derived invariant covers the set
- every wording variant when a representative corpus already protects the behavior
- large text snapshots where structural assertions state the actual requirement
  (Vesper has essentially one snapshot file on purpose — prompt suites use
  `expectOrder` / `expectNumberedRule` / `expectFenced` instead)
- incidental formatting, ordering, nonce values, ids, timestamps
- framework behavior
- generated or declarative data entry-by-entry, unless an entry carries distinct policy
- behavior that is intentionally obsolete, or transitional compatibility that has
  already been retired

**"This function is new" is not a reason for a test to exist.**

## Bug fixes

CLAUDE.md and `docs/testing.md` both require it: *every bug fix lands with the
regression test that would have caught it.* Apply that intelligently.

- **Reproduce the actual failure mode**, not a paraphrase of it. If the bug was a
  correlated subquery silently matching nothing, the test must fail against the
  old query.
- **Lowest layer capable of proving it.** A bug that manifests in a route but
  originates in a kernel belongs to the kernel's suite.
- **One test, one layer.** Do not add the same regression at contracts, engine
  and API.
- **Prefer strengthening an existing test** if one covers nearby ground and would
  have caught the bug with a better assertion. That is a net-zero-line fix.
- **Do not add unrelated coverage** while fixing the bug. Fix the bug; note other
  gaps elsewhere.

## Assertions that mean something

Every test should make obvious what production defect it prevents. Compare:

| Weak                                            | Strong                                                                       |
| ------------------------------------------------ | ----------------------------------------------------------------------------- |
| the function returned an object                  | an unauthorized actor cannot observe another owner's resource                  |
| the reducer called helper X                      | replaying the same accepted command produces the same authoritative state      |
| every field matches this giant snapshot          | the public representation excludes private fields and keeps the required ones  |
| 30 tests exercise 30 enum strings                | every registered member satisfies the invariant, derived from the registry     |
| parse returned a default                         | a malformed row degrades to the default **and** emits `chat_state.parse_failed` |

Vesper's best suites state this in a header comment: cite the owning doc, name
the invariant, and say what bad implementation the test kills — the way
`app/api/chats/[chatId]/sim-routing.test.ts` records "Falsified against the old
fork, where only a plain send reached the successor engine." Write that sentence
before the test. If you cannot, reconsider the test.

## Refactors and extractions add no tests

**A change that preserves behavior earns zero new tests.** Extracting a helper,
moving a function into `lib/`, splitting a file, renaming, inlining, converting a
loop to a map — none of these create a new invariant, so none of them create a
defect for a test to catch. The existing suite is already the proof: if the
behavior is unchanged and the tests still pass, that *is* the verification.

The instinct to test a freshly extracted function is the single most common
source of low-value tests in this repo. Resist it. If the extracted helper
genuinely holds an untested invariant, that invariant was untested *before* the
extraction too — decide about it on its own merits, not because the code moved.

If a behavior-preserving refactor breaks a test, that is information: the test
was probably asserting implementation. Fix the test to assert the contract
rather than mechanically updating it to match the new internals.

## Behavior over implementation

Refactoring production code without changing behavior should not require
widespread test rewrites. **If harmless refactoring routinely breaks a test,
that test is asserting implementation, not contract.** Treat it as a defect in
the test.

Pin implementation detail only where the detail *is* the invariant: persisted
hashes (the `node:crypto` equivalence pins in `simulation-core`), security
allowlists, wire formats, public APIs, deterministic serialization, migration
compatibility. Those pins stay literal and stay commented, so a reader knows the
literal is deliberate.

## Keep the line count down

jscpd covers test files at threshold 3 precisely because it did not before, and
~3.2k duplicated test lines accumulated. Before writing scaffolding, check
`references/existing-helpers.md` — Vesper already has three homes of shared
utilities, split by the purity fence:

- `@/test/*` — pure helpers, importable from contracts/lib tests
- `@/server/test-support` (barrel; lint-enforced) — everything server-side
- `packages/simulation-core/src/test-support/` — package fixtures, two published
  as exact subpaths for app-side consumers

Then prefer, in roughly this order:

1. extend a relevant existing suite instead of creating a file
2. `it.each` / table-driven cases when the cases share one invariant
3. schema-derived and registry-derived expectations — a vocabulary addition must
   never force unrelated test edits (`contracts/attributes/registry.test.ts` is
   the model)
4. property/invariant tests over enumerated examples
5. compact builders over repeated fixture literals

**Never hand-enumerate a production registry to assert the registry contains that
hand-enumerated list.** That test only proves you typed the list twice.

## Consolidating without scope creep

While working in an area you will notice weak or redundant tests. Do not turn
the task into a test-cleanup project.

- If your new test would duplicate an existing one, **strengthen the existing one
  instead** of adding yours.
- If a small local consolidation is what avoids adding duplicate coverage, do it.
- Otherwise, record the debt (a note in the relevant working doc, or
  `deferred.plan.md`) and move on. Unrelated test rewrites do not belong in a
  feature or bugfix change.

## Working process

When you change Vesper code:

- **A.** Understand the behavioral change — what can now be true that wasn't?
- **B.** Search existing tests for that invariant or failure mode before writing
  anything (`git grep` the concept, not the function name).
- **C.** Identify the owning layer.
- **D.** Decide whether a new test adds protection no existing gate provides.
- **E.** **If not, add no test.** Say so plainly in your summary — this is a
  correct outcome, not a gap.
- **F.** If yes, design the smallest high-value test at the owning layer.
- **G.** Reuse existing fixtures and helpers.
- **H.** Do not mirror the coverage at a higher or lower layer.
- **I.** Run the narrow suite while developing — name the project, so you are not
  also collecting the half that needs Postgres:
  - pure app test — `pnpm vitest run --project=app <path>`
  - integration test — `pnpm vitest run --project=app-int --no-file-parallelism <path>`
  - package test — `pnpm --filter @vesper/simulation-core exec vitest run <path>`
- **J.** Let CI on the PR handle broad validation. Do not run the full gate set
  locally.

## A note for autonomous agents

You will feel pressure to produce tests as evidence that work happened. Resist
it.

Tests are executable specifications and regression alarms — not receipts for
code generation. Do not add low-information assertions so a change can report
"tests added". Do not add a test per new file, per new branch, or per new
helper. Do not optimize for the appearance of thoroughness; the owner reads the
diff, and twenty shallow tests read worse than one sharp one.

When you add no tests, say what already protects the behavior. When you do add
one, say in a sentence which defect it kills.
