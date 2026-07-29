# Test consolidation — shared fixtures, gate integrity, de-brittling

Status: shipped — 2026-07-28

Completion note: all six slices landed in one push (foundations →
simulation-lane adoption → API/contracts → chat-lane/lib →
memory/images/guardrail → docs + jscpd gate). ~5.9k net test lines removed;
strict mode now gates every integration suite; jscpd covers tests at
threshold 3. Bugs found and fixed en route: `route-safe.int.test.ts`'s four
cross-owner denial tests had never run (collection-time `runIf` on a flag set
in `beforeAll`); three admin suites leaked swapped roles on assertion failure;
17 auth mocks stubbed dead exports and omitted `Unauthenticated`;
`canonicalImageRow` silently discarded caller paths (now throws);
`household-store`'s test re-implemented production row mappers. Leftovers:
none — helper-gap wishlist items surfaced during adoption (fork-result
pass-through, `expectRejected` narrowing, `seedSimpleBranch` worldSeed) were
folded in; the remaining nice-to-haves (e.g. `bindSimMaterialFixtures`,
`expectDiagnostic` path/severity options, `testPrincipalAs`) are small enough
to add when a consumer appears.

## Why

A 2026-07-28 audit of the full test suite (264 files, ~74k lines) found ~6k
removable lines of copy-pasted scaffolding, several correctness gaps in what the
tests actually enforce, and a family of hand-enumerated assertions that force
multi-file edits whenever a registry entry / command kind / event type is added.
Root cause for the accumulation: `.jscpd.json` ignores `**/*.test.ts`, so the
copy-paste gate never sees test code (a scan at the standard 70-token threshold
found 214 exact clones / 3,242 duplicated lines).

## Slices

1. **Gate integrity + drift fixes (behavioral).**
   - Convert every `.int.test.ts` suite still carrying an inline DB probe
     (51 files) to `probeIntegrationDb` (`@/server/test-support`) so
     `pnpm test:int:strict` actually gates them (docs/testing.md §strict already
     names this debt).
   - Replace the 17 copies of the `vi.mock("@/server/auth")` factory that stub
     dead exports (`USER_COOKIE`, `ensureDefaultUser`, `listUsers`) and omit
     `Unauthenticated` (latent `instanceof` TypeError in `respond.ts`) with a
     shared `routeAuthModule` helper.
   - Make `canonicalImageRow` reject caller-supplied `path` (today silently
     discarded; gallery passes one at 5 sites).
   - Normalize pool teardown (`endTestPool`: `end()` + clear
     `globalThis.__vesperPool`) and wrap role-swap tests in restore-safe helpers.
   - Drop `household-store.int.test.ts`'s private copies of production row
     mappers (`rowToEvent` ≡ `branchEventFromRow`).
2. **Shared server-side test utilities** (`src/server/test-support/`, via the
   barrel): auth mock, `apiRequest`/`routeCtx`, `expectJson`/`expectApiError`/
   `drainStream`, `seedTestUser`/`purgeOwnerRows`/`endTestPool`, sim harness
   (`simulationSuiteHarness`, `simCommand` + principals, `seedSimBranch`,
   `readBranchEvents`, `forkAtHead`, `expectAccepted`/`expectRejected`,
   schema-reflected `branchFootprint`, `seedReferenceRhythms`), chat fixtures
   (`seedChatFixture`/`newChat`/`settleChatExchange`, shared archivist mock),
   profile/prompt fixtures + prompt assertions (`expectNumberedRule`,
   `expectOrder`, `expectFenced`, `section`), image/tmp-dir/memory fixtures,
   `source-scan` (the 375-line scanner extracted from
   `ownership-guardrail.test.ts`, shared with `scripts/image-internal-callers`).
3. **Shared pure test utilities** (`src/test/` — outside the contracts/lib
   purity fence, which blocks `@/server/**` imports): registry invariants
   (`expectUniqueIds` et al.), sim command/event envelope builders +
   `testPrincipal`, space/material/meter fixtures, diagnostics assertions
   (`codes`/`expectDiagnostics`); garment fixtures colocated under
   `src/contracts/items/`.
4. **Adoption** across the five test families (simulation stores, app/api +
   server/api routes, chat lane + prompts, contracts/lib, memory/images/
   guardrail).
5. **De-brittle enumerations**: derive from registries/schema instead of
   hand-listing (`items/coverage.test.ts`, bands/stages/life-stage lists,
   `["cleanliness","wear"]` ×3, `worldFootprint` hand-listed tables ×3,
   numbered-prompt-rule and fence-nonce literals, full expected-event-train
   `toEqual`s); export `PUBLIC_KEYS` from production for the two security
   suites; cross-check the `OWNER_ASSERTING_HELPERS` ↔ `check-route-authz`
   allowlists.
6. **Regrowth gate**: include test files in jscpd (threshold tuned to the
   post-consolidation level) and record the conventions in docs/testing.md.

## Rules for the work

- Shared helpers for contracts/lib tests live in `src/test/` (importing only
  contracts/lib/vitest); server-side helpers live in `src/server/test-support/`
  and are imported through the barrel (lint-enforced).
- No behavioral loosening: every degradation test keeps asserting fallback +
  diagnostic code; deliberate exceptions (e.g. `path-containment` hand-building
  rows to test the CHECK constraint) stay exceptions.
- Verification on this RAM-constrained machine: gates run strictly one at a
  time (never `pnpm verify`); subagents use targeted single-worker vitest only.

## Open questions

_(none — audit rulings recorded above; deferred ideas, if any emerge, go to
deferred.plan.md)_
