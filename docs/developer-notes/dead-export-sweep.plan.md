# Dead-export sweep — delete the leavings, shrink the search space

Status: draft (unsafe temporary/stale files may go early; broad de-export work
stays after consolidation. Re-verified 2026-08-07: every named target is still
present — the stale site description, all three scripts, `chatGarmentStoreOf`,
`CHAT_PULSE_EVERY_N`, `submitDurableApplyBodyModifier`,
`openCoPresentEngagementsForActor`. Only C19's documentation half is done)

Outcome: A developer can ask "who calls this?" about any exported name and get a
truthful answer, so that genuinely dead code — an entire command handler with no
callers and no test — stops hiding among the 190 exports nobody uses.

## Why

One thing here is visible to players: the site description that ships in the
`<head>` of **every page** still sells the retired world model — "play
turn-based sessions with a living world model" (D9, `app/layout.tsx:14`). That
is the text a link preview or a search result shows, and it describes a system
we deleted in R6. It should have gone with the lane.

Everything else is invisible to players and valuable to everyone who reads the
code, agents included. The repo has accumulated a thick layer of
exported-but-unused surface: the simulation barrel publishes 204 names of which
**136 have no consumer outside the simulation folder** (A19), the chat-engine
barrel leaks 33 exports used only inside their own file (B16), and ~22 more
server internals are exported wider than they are used (C21). The cost is not
bytes — it is that "who calls this?" stops being a reliable question, so real
dead code hides in the noise: the audit found an entire durable command handler
with zero callers **and no test** (A17) among the built-but-unwired successor
API it resembles. Stale one-off scripts want deleting too, one for reasons
beyond tidiness — `scripts/tmp-scene-diag.ts` opens a raw Postgres connection
with TLS certificate verification turned off (C22).

**Four guardrails govern this batch** (detail under Risks & coordination): 1. the
parked branch/fork/replay primitives are **intentionally** callerless and must
survive; 2. `CHAT_AFFORDANCE_CUES` is parked by owner ruling, not dead; 3.
test-support helpers are sometimes built a slice ahead of their suite, so check
the git log first; 4. this sweep runs **after** the other consolidation batches
where possible, so it collects their leavings instead of churning twice.

## Scope

The audit's per-finding entries are the work list — this plan sequences them and
sets the rules.

- **Chat engine (B16)** — the two truly zero-ref exports (`chatGarmentStoreOf`,
  and `CHAT_PULSE_EVERY_N`, a knob nothing reads because the pulse runs
  unconditionally) plus the 33 file-local exports, several carrying stale
  "exported for tests" comments that are no longer true.
- **Server (C20, C21)** — dead exports (`composeItemDefinition`,
  `findCharactersByName`, the `LORE_*` constants for a lore channel that was
  never built, `daylightBand` and its constant, four test-support helpers) and
  ~22 over-exported internals narrowed to module scope.
- **Scripts (C22)** — delete `tmp-scene-diag.ts`,
  `backfill-image-references.ts` **and** its `db:backfill-image-refs` package
  script, and `delete-avatar-expression-frames.ts`.
- **Simulation lane (A17, A18, A19)** — rule on the callerless command handler;
  delete `openCoPresentEngagementsForActor`, superseded by a SQL predicate;
  split the simulation barrel to the ~68 externally-used names, with integration
  tests importing store modules directly (most already do).
- **Contracts remainder (E5)** — whatever dead exports
  [contracts-hygiene.plan.md](contracts-hygiene.plan.md) leaves behind.
- **Deleted-lane UI (D9)** — the meta description above, a dead `/sessions/`
  branch in the app shell, stale `"session"`/`"world"` envelope probes in the
  client API helper, a stale comment.
- **Database relic (C19)** — `location_links.travel_minutes`, written only by
  its own default and read nowhere. The retain ruling below settles disposal;
  what remains is annotating the column itself in `src/server/db/schema.ts`, since
  `docs/database.md` already records the reservation.
- **Docs**, corrected in the same change: the doc comments the audit flagged as
  untrue.

## Non-goals

- **No behavior change.** Aside from the site description, nothing a player or
  an API caller can observe should differ: no route changes, no renames of live
  modules, no signature changes — only visibility and deletion.
- **No consolidation or refactoring** (the audit's other batches) and **not the
  tooling batch** (F1, F2, F4) — only the doc fixes attached to the findings
  above ride along here.
- **The parked successor primitives and `CHAT_AFFORDANCE_CUES` stay**
  (guardrails 1 and 2).

## Review rulings and scope adjustments — 2026-07-30

- Remove the unsafe temporary database script and clearly stale site copy early;
  they reduce risk without destabilizing imports. Keep the broad barrel/de-export
  census after the consolidation plans settle.
- **Retain `location_links.travel_minutes`.** It is reserved for the planned
  authored travel-duration system; annotate that status in schema/reference docs
  instead of paying for a drop-and-recreate migration.
- The durable body-modifier command survives only if it receives a real caller and
  integration test in near-term scheduled work. Otherwise delete the callerless
  durable handler while retaining the pure resolver.
- Keep the test-support git-history guard and the parked fork/branch primitives.
  Zero current production callers is not enough evidence to delete intentionally
  staged engine capability.

## Delivery slices

Each lands on its own pull request, reaches a green `pnpm verify` run, and
reviews on its own.

- **Slice 0 — the retain list.** Before deleting anything, write down what is
  deliberately callerless and comment each such export with the plan that keeps
  it. This is what stops a future sweep re-litigating the same names.
- **Slice 1 — visible and unsafe first.** The D9 leftovers (site description
  leads) and the C22 deletions: smallest diff, highest confidence.
- **Slice 2 — chat-engine de-export (B16).** One mechanical barrel pass.
- **Slice 3 — server exports (C20, C21).** Git-log check on each test-support
  helper; check sibling tests before narrowing each internal, since a test
  import is a legitimate reason for a wider-than-production export.
- **Slice 4 — contracts remainder (E5),** after the contracts hygiene sweep.
- **Slice 5 — simulation lane (A17, A18, A19).** Largest and last: the A17
  ruling, the A18 deletion, then the barrel split, with the gate corpus
  integration suites green before **and** after.
- **Slice 6 — the C19 annotation and the untrue doc comments.**

## Success criteria

- Every export the audit named is gone, narrowed to its module, or still
  exported **with a comment naming why** — no silent survivors.
- The simulation barrel exports only names with consumers outside the simulation
  folder, and the engine barrel no longer re-exports simulation internals.
- The retain-list items (guardrails 1 and 2) survive, now annotated, so the next
  reader need not re-derive their status.
- **A green `pnpm verify` run at each slice boundary**, plus the gate corpus
  integration suites on the simulation slice. Validation is the local gate (root
  `CLAUDE.md`) — `.husky/pre-push` runs it before the branch reaches GitHub.
- No user-visible change other than the corrected site description.

## Risks & coordination

- **Guardrail 1 — never delete the parked branch/fork/replay primitives.**
  [deferred/sim-branch-ux.plan.md](deferred/sim-branch-ux.plan.md) (stub D19)
  intentionally retains fork, ancestry, replay-assembly, narrative-cut and
  placement-explain primitives with **zero production callers by design**,
  awaiting the UI that will use them. A17 is the exception the audit singled out
  precisely because it is *not* on that list: no callers **and** no test.
- **Guardrail 2 — `CHAT_AFFORDANCE_CUES` is not dead (B17).** It gates ~480 lines
  parked OFF permanently by owner trial ruling, kept as the validated-wording
  reference and a live arm of the evaluation harness. Leave it, flag included.
- **Guardrail 3 — test-support helpers can precede their suite.** Check
  `git log` first; a helper added a slice early looks identical to rot.
- **Guardrail 4 — sequence this batch late.** The other batches will orphan code
  of their own, so going afterwards means one pass over the same files instead
  of two. Slice 1 is the exception and can land any time.
- **Active-work coordination.** Both
  [narrator-physical-guidance.plan.md](narrator-physical-guidance.plan.md) and
  [romantic-contact-affordances.plan.md](romantic-contact-affordances.plan.md)
  are live over the affordance contracts and the chat affordance /
  physical-guidance engine modules; `[WIP]`-tagged audit items sit in that churn,
  so coordinate first and expect their line references to have moved. The audit's
  line numbers repo-wide should be treated as stale and re-grepped by finding id.
- **Reversibility.** Everything here is a `git revert` away — the retain ruling
  on `travel_minutes` means no column drop, so no migration and no deploy.

## Open questions

- After the simulation barrel is narrowed, should its surviving public surface
  remain re-exported through the outer engine barrel?
- What standing rule should govern harmless unreferenced `z.infer` aliases:
  remove every non-public alias, or retain schema-adjacent aliases by default?
