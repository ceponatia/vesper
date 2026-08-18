# Existing test helpers — check here before writing scaffolding

Vesper's shared test utilities, indexed by **what you are trying to do**. jscpd
covers test files at threshold 3, so copy-pasted setup fails the gate; almost
every scaffolding need below already has an answer.

`docs/testing.md` §"Shared test utilities" owns the authoritative description of
the three homes and why the split exists. This file is the lookup table. Names
drift — confirm before importing:

```bash
sed -n '1,40p' apps/web/src/server/test-support/index.ts
```

## Which home

| Home                                        | Import as                                | For                                          |
| -------------------------------------------- | ------------------------------------------ | ---------------------------------------------- |
| `apps/web/src/test/`                         | `@/test/...`                               | contracts/lib tests — imports no `@/server/**` |
| `apps/web/src/server/test-support/`          | `@/server/test-support` (barrel only)      | every server-side suite                        |
| `packages/simulation-core/src/test-support/` | relative in-package; 2 published subpaths  | simulation fixtures                            |

The purity fence is lint-enforced: contracts/lib tests may not reach into
`@/server/**`, and **no production code may import the server barrel** (several
of its modules import vitest).

Published package subpaths, for app-side suites that need simulation fixtures:

- `@vesper/simulation-core/testing/sim-envelopes`
- `@vesper/simulation-core/testing/sim-space-fixtures`

## Registry / schema invariants — `@/test/registry-invariants`

Use these instead of hand-enumerating registry contents.

`expectUniqueIds`, `expectUniqueBy`, `expectAllValidate`, `expectRefsResolve`,
`expectCaseInsensitiveLookup`, `expectContiguousBands`

Model suite: `apps/web/src/contracts/attributes/registry.test.ts`.

## Degradation + diagnostics — `@/test/diagnostics`

Degradation tests must assert the fallback **and** the diagnostic code
(`docs/resilience.md` §8).

`codes`, `expectDiagnostics` (exact ordered set), `expectDiagnostic` (one code,
optional `times`), `expectCleanSink` (happy path recorded nothing)

## Route / API suites — `@/server/test-support`

| Need                        | Helper                                                             |
| ---------------------------- | -------------------------------------------------------------------- |
| mock `@/server/auth`         | `routeAuthModule`, `bindAuthUser`, `withAuthUser` (restore-safe roles) |
| build a request / ctx        | `apiRequest`, `routeCtx`, `apiError`                                  |
| assert a response            | `expectJson`, `expectApiError`, `drainStream`, `collectStream`        |

Do not hand-write the `vi.mock("@/server/auth")` factory — 17 hand-copied copies
stubbed dead exports and omitted `Unauthenticated`, which is a latent
`instanceof` TypeError.

## Database / integration suites — `@/server/test-support`

| Need                          | Helper                                                        |
| ------------------------------ | --------------------------------------------------------------- |
| DB probe (required, not inline) | `probeIntegrationDb(suite, table)`, `requireIntegrationDb`     |
| users and cleanup              | `seedTestUser`, `seedTestUsers`, `purgeOwnerRows`, `endTestPool` |
| an `images` row                | `canonicalImageRow` (the `images_path_canonical` CHECK)          |
| temp `DATA_ROOT`               | `withTempDataRoot`                                               |
| symlink cases on Windows       | `canCreateSymlinks`                                              |

An inline DB probe silently opts the suite out of strict mode and therefore out
of the release gate. Always use the helper (or the harness below).

## Simulation suites

| Need                            | Helper                                                                    |
| -------------------------------- | --------------------------------------------------------------------------- |
| whole-suite scaffold             | `simulationSuiteHarness` (top-level + awaited; registers teardown)          |
| seed a branch                    | `seedSimBranch`, `seedSimpleBranch`, `forkAtHead`                           |
| build a command                  | `simCommand`; principals: `playerPrincipal`, `npcPrincipal`, `gmPrincipal`, `systemPrincipal` |
| assert the outcome               | `expectAccepted`, `expectRejected`                                          |
| read the event log               | `readBranchEvents`, `readBranchEventTypes`, `latestEventPayload`            |
| prove new tables are covered     | `branchFootprint`, `footprintDelta`                                         |
| legacy player opt-in guard       | `requireLegacyUnanchoredEngineTestMode`                                     |
| envelopes/spaces (in package)    | `commandEnvelope`, `eventEnvelope`, `bindSimEnvelopes`, `testPrincipal`, `walkTopology`, `atZone`, `heldBy` |

`branchFootprint` is schema-derived, so a new `sim_*` table is covered
automatically — do not add a hand-listed table assertion.

`command-authz.int.test.ts` deliberately passes `legacyPlayerMode: false`; its
denial coverage must not depend on the opt-in flag.

## Chat lane

`seedChatFixture`, `newChat`, `settleChatExchange`, `dropChatFixture`,
`emptyChatFixture`, `chatMemoryMockModule`, `chatArchivist`

Routed sim chat: `seedRoutedSimChat`, `routeSimChat`, `newSimChat`,
`dropRoutedSimChat`, `resetRolloutWorld` — these share one fixed rollout world,
so those suites **must not run file-parallel**.

## Prompts

`expectOrder`, `expectNumberedRule`, `expectFenced`, `expectSections`,
`promptSection`, `matchDelimiter`

Assert **content and relative order**, never ordinals or nonce literals. This is
why Vesper has essentially no prompt snapshots.

## AI and embeddings

Never mock at the fetch layer. `apps/web/src/test/setup.ts` forces `AI_FAKE=1`
globally and strips provider keys for both application projects — do not re-set
it per file. `server/ai` exposes a fake provider returning canned typed results,
so tests exercise the real parsing and degradation paths.

Embedding-dependent logic uses `pseudoEmbed` (`@/server/ai/embeddings`) —
deterministic, so similarity thresholds are exact.

## Profiles, images, source scanning

Profiles/characters: `makeProfile`, `maraProfile`, `withOutfit`,
`withPlayerOutfit`, `withOps`, `attr`, `manualAttr`, `drive`, `draftWith`

Images: `testPngBuffer`, `testPngDataUrl`, `identityCandidateFixture`,
`identityProvenanceFixture`, lane-probe fixtures

Repo tripwires (static source scanning): `sourceFilesUnder`, `repoRelative`,
`stripComments`, `functionBody`, `callArguments`, `methodCallArguments` — shared
by `scripts/ownership-guardrail.test.ts` and `scripts/image-internal-callers.test.ts`.
