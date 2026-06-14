# GPT review: Pre-narrator intent & guardrail agents

Source: [../pre-narrator-agents-spec.phase5.md](../pre-narrator-agents-spec.phase5.md)

## Overall opinion

The approved Stack A is the right move: one latency-hidden intake classifier, fallback to the old regex path, persisted on the turn, and consumed by existing prompt builders. The current code already implements much of that shape: `src/server/engine/intake.ts:26` (`runIntake`), concurrent fan-out in `src/server/engine/pipeline.ts:492`, persistence in `src/server/engine/pipeline.ts:341`, and post-turn continuity reuse in `src/server/engine/agents.ts:149`.

The spec should be tightened around what Stack A actually shipped. The top update says movement, appointment, and check are persisted seams only; later sections still read as if movement authority, appointment creation, and digest integration are Stack A behavior. That ambiguity matters because the code still commits movement from the simulant path.

## Gaps and mismatches

- The `IntentBrief` sketch is stale. The source spec sketches ID-resolved `targets`, `allowed`, `memoryQueries`, and parsed appointment minutes. The current contract stores display-name mirror fields plus `movement`, `appointment`, and `check` seams, with no aggregate `targets`, no `allowed`, and no `memoryQueries`; see `src/contracts/turns/intent-brief.ts:20` and `docs/contracts.md:323`.

- Intake does not feed `buildTurnDigest` today. The pipeline calls `buildTurnDigest` at `src/server/engine/pipeline.ts:655` with the bundle, prompt location, and blocked move only. The builder itself promises every line is a deterministic restatement of state at `src/server/engine/scene.ts:596`. Intake currently feeds exposure, glance, and awareness at `src/server/engine/pipeline.ts:681`, not the digest.

- Entity validation is weaker than the spec claims. The spec says names resolve inside the agent boundary, but the schema accepts raw strings, and `src/server/engine/intake.ts:83` (`sceneIntentFromBrief`) projects those directly into the old `SceneIntent` shape. Invalid target strings can reach prompt builders before any deterministic normalizer drops them.

- Degradation diagnostics are incomplete relative to the docs. Timeout records `agent.intake.timeout` at `src/server/engine/intake.ts:60`, but demo/disabled intake silently returns the regex fallback at `src/server/engine/intake.ts:30`. That conflicts with the resilience doc's broader "fallback records a diagnostic" wording.

- Stack A's enforcement language needs separation from the approved scope. The source says the merge should prefer intake-derived player movement, but `src/server/engine/merge.ts:113` (`MergeTurn`) has no `intentBrief`, and the movement loop still starts from `simulant.movements` at `src/server/engine/merge.ts:1366`.

- The turn inspector does not expose the persisted brief. `src/app/api/sessions/[id]/turns/[turnId]/inspect/route.ts:53` returns turn metadata, agent results, diagnostics, and retrieval events, but not `intentBrief`, which makes the new classifier hard to debug in the tool meant for turn diagnostics.

## Improvements I would make

- Add a deterministic intake normalization step immediately after LLM output. It should resolve allowed display names against present NPCs, off-screen NPCs, in-scope items, and locations; drop invalid fields; and emit `agent.intake.unresolved_*` diagnostics. This preserves the "LLM classifies, engine adjudicates" principle.

- Update the spec's `IntentBrief` section to match the current contract, then add a separate "future normalized brief" if ID-resolved targets are still desired later.

- Keep digest integration as a future deterministic resolver, not a raw `allowed` field from the LLM. If intake affects the digest, deterministic code should derive digest lines from canonical roster, movement state, and normalized intent.

- Add `intentBrief` to the Turn Inspector payload and UI. The `notes` field exists for debugging; right now it is stored but not easily visible.

- Add diagnostic tests for timeout, disabled/demo fallback if diagnostics are desired there, malformed LLM output, and invalid entity names. Existing tests cover fallback shape, but the resilience rule says degradation tests should assert both behavior and diagnostic code.

- Decide whether disabled/demo fallback should be silent by design. If yes, fix the docs. If no, add diagnostics. Silent demo mode is defensible; undocumented silence is not.

## Things I do not think are a good idea

- Do not add an LLM-authored `allowed` field directly to `buildTurnDigest`. That would violate the digest invariant: every line must restate authoritative state from below it.

- Do not broaden skip heuristics yet. OOC and non-player turns are clear skips in `src/server/engine/pipeline.ts:477`. Skipping "simple" conversation or bare waits should wait for measured latency and missed-classification data.

- Do not ship Stack B without evidence. Serializing retrieval behind intake is a real first-token cost, and the current concurrent fan-out is the right default.

- Do not let the intake agent become a planner. The prompt at `src/server/engine/prompts/intake.ts:11` is correctly framed as classify/resolve only; keep it that way.

## Test additions I would expect

- Invalid intake entity names are normalized away with diagnostics before prompt builders consume them.
- The inspector API returns the persisted `intentBrief`.
- Timeout/failure/disabled/demo behavior matches the docs exactly, including diagnostics if promised.
- Movement/appointment/check fields remain persisted seams until their downstream resolvers are implemented.
- `buildTurnDigest` remains deterministic and does not accept raw LLM permission text.
