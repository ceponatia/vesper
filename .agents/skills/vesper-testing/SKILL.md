---
name: vesper-testing
description: Decide whether a Vesper change needs a test, choose the one owning layer, and report what CI actually verified. Use before creating, expanding, or substantially rewriting tests, and when reviewing whether coverage is sufficient. No new test is a valid outcome.
---

# Make a Vesper testing decision

## Local execution boundary

Do not run application gates on this machine. This includes every form of Vitest (`pnpm test*`, direct `vitest`, package-filtered Vitest, and watch mode), application lint, typecheck, build, and integration setup. Use CI through the task's authorized delivery workflow.

The ban is on the check, not on how it is spelled or where it runs: invoking the compiler, linter or bundler directly (`tsc`, `npx tsc`, `pnpm exec tsc`, `./node_modules/.bin/tsc`, `eslint`, `next build`), pointing it at a hand-written or throwaway config, or running it from a temp directory or a copy of the sources is the same application gate, because each one resolves this repository's code or dependency types. Do not look for a spelling that gets through; `.codex/hooks/preflight.py` refuses these, and routing around it is itself a violation. Satisfy a compiler constraint by construction instead: under `noUncheckedIndexedAccess` an indexed read is `T | undefined`, so guard it with an explicit `=== undefined` or length check rather than a non-null assertion, which `no-non-null-assertion` forbids anyway.

Two narrow local checks remain allowed:

- `pnpm lint:docs` for documentation-only changes.
- Dependency-free offline fixtures for skill-owned shell or Python helpers when they do not start Vesper, a database, or an external service. "Dependency-free" is literal: a fixture that resolves application sources or their dependency types is an application gate, not a fixture.

## Decide before writing

Answer these internally before writing:

1. The invariant, regression, contract, or failure mode the test would protect.
2. A realistic bad implementation that the test would catch.

Then search for existing coverage, static gates, and shared helpers. If another gate already catches the defect, or no plausible defect is identifiable, add no test. Read [admission and ownership examples](references/admission-and-ownership.md) when the decision is ambiguous.

Choose the lowest layer that owns the claim. Test the full behavior matrix once at that layer; higher layers prove only their connection to it. An integration test must depend on real persistence, transactions, concurrency, constraints, authorization across stored rows, or route/database wiring. Pure deterministic logic stays in a pure suite.

Prefer strengthening a nearby test over adding a parallel suite. Prefer table-, schema-, registry-, or property-derived assertions over copied case lists. Before adding fixtures or builders, read [existing helper lookup](references/existing-helpers.md).

## Rules that change the decision

- A bug fix needs the smallest regression test that fails for the observed bug, unless existing coverage already fails on the bad implementation.
- Degradation coverage asserts both the fallback and its diagnostic code.
- Registry coverage derives expectations from the registry; do not hand-copy its members into the test.
- Prompt tests assert structure and required content rather than full-text snapshots or incidental ordinals.
- Application tests use the configured fake AI provider; do not mock LLM calls at the fetch layer or restore provider credentials removed by test setup.
- Preserve literal pins only when the literal is the contract, such as a wire format, persisted hash, security allowlist, or migration compatibility value.
- A behavior-preserving refactor does not create a testing obligation. Fix tests that break only because private arrangement changed.

When unrelated test debt is discovered, add it to the relevant existing GitHub issue only if issue updates are within the current authorized scope. Otherwise report it in the handoff for the owner to route. Never create a repository working document for test debt.

## After a coding task

The `vesper-test-keeper` role (`.codex/agents/vesper-test-keeper.toml`,
`.claude/agents/vesper-test-keeper.md`) applies these rules to one finished
change: it brings every test that owns the changed or new code in line with the
diff, edits tests only, and reports the CI evidence. Its procedure is
[references/test-keeper.md](references/test-keeper.md); run it before an
implementation is reported complete.

## Finish with exact evidence

Name the test file changed, the claim it protects, and the CI job or script that actually selects it. A green aggregate `verify` result means all applicable jobs succeeded; it does not mean every repository suite ran.

Read [CI evidence](references/ci-evidence.md) before claiming integration coverage. Every ready code change runs the complete `app-int` inventory in its strict and legacy modes, and `verify` reconciles the evidence; cite that run's evidence summary at the tested head, not the file's presence in the repository. Do not substitute a prohibited local run.

If no test was added, say why: existing coverage owns the invariant, another gate catches the defect, or the change introduces no meaningful runtime behavior.
