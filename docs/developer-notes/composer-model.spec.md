# Scene composer model — technical companion

Status: companion to [composer-model.plan.md](composer-model.plan.md)

The curated model list, the composer seam and its fallback rung, the per-chat
persistence and admin surface, and the A/B harness — its arms, answer keys,
grading rules and honesty checks.

## The curated list

`apps/web/src/lib/composer-models.ts` owns `SCENE_COMPOSER_MODELS`,
`DEFAULT_SCENE_COMPOSER_MODEL_ID` and `resolveSceneComposerModelId`. Same shape
as `agent-models.ts` and `narrative-models.ts`, with one addition: every entry
carries a `description`, because it is rendered under the admin dropdown and an
entry without one is an unexplained choice.

**An id earns its place by being run through the A/B**, with the verdict recorded
in [Results](#results). The list is not a menu of everything OpenRouter sells.

| Id                                   | In / out $ per M | Why it is a candidate                   |
| ------------------------------------ | ---------------- | --------------------------------------- |
| `aion-labs/aion-3.0`                 | 3.000 / 6.000    | The shipped default; the control        |
| `aion-labs/aion-3.0-mini`            | 0.700 / 1.400    | Same lab, ~4× cheaper                   |
| `aion-labs/aion-2.0`                 | 0.800 / 1.600    | The session narrator; proven permissive |
| `~deepseek/deepseek-v4-flash-latest` | 0.068 / 0.135    | The in-session agent default            |
| `qwen/qwen3.7-flash`                 | 0.030 / 0.130    | Cheapest capable                        |
| `z-ai/glm-4.7-flash`                 | 0.060 / 0.400    | Flash sibling of the curated narrator   |
| `inclusionai/ling-3.0-flash`         | 0.021 / 0.063    | The price floor                         |

**No entry needs tool calling or `response_format`.** `generateChecked` sends the
JSON Schema as prompt text and parses the reply locally — provider-side
constrained decoding was rejected because it degenerated on some models
(followups.phase2.md #20). That is what makes Aion 2.0, which advertises no
structured-output support, a legitimate candidate.

## The seam and its fallback rung

`sceneComposerModelId(chatComposerModel?)` (`server/ai/provider.ts`) resolves the
per-chat override through `resolveCurated`, the same strict resolver the narrator
and agent seams use. Strictness is a billing control, not a tidiness rule: the id
reaches `openrouter().chat()` on the deployment's key, so an uncurated value must
not survive the trip from a chat row to a generation.

`composerFallbackModelId(primary)` owns the ladder's second rung. It is
`narrativeModelId()` — a model already trusted with this repo's most explicit
text — **except when that is the primary**, which the per-chat override made
reachable now that Aion 2.0 is a curated composer option. Asking the same model
twice is not a fallback, it is a retry of a refusal, so it falls to the curated
composer default instead. The invariant every caller depends on: **the two rungs
are never the same id**, asserted over the whole curated list in
`scene-composer-model.test.ts`.

`composeSceneSpec` resolves the primary **once** and reads it four times (the
call, the diagnostic message, the diagnostic context, the fallback's collision
check). Re-resolving would let a mid-composition default change split the ladder
across two models nobody chose.

## Persistence and the admin surface

`character_chats.scene_composer_model`, text, default `""` (migration
`0109_scene-composer-model.sql`). `""` means no override, which is every chat
that has never been switched.

**It is deliberately not on the scenario.** `ChatScenario` is the "another take"
rollback snapshot (`pre_exchange_scenario`), and this is operational
configuration for comparing models — folding it in would make a retake silently
revert an admin's pick, which is the one thing an A/B must never do. It is read
by `loadChatComposerModel(chatId)` (`server/engine/chat-state.ts`), a read of its
own, exactly as `agentReasoningProfile` is.

The value threads `queueChatScene` → `renderCharacterSceneImage({composerModel})`
→ `composeSceneSpec({composerModel})`, and rides the `chat_scene_image` job
payload **only when set** — so a job row reads as "whatever the app default was"
rather than pinning a value nobody chose.

`GET`/`PATCH /api/admin/self/scene-composer/[chatId]` is the surface, wrapped in
`withOwnerAdminOwnedChat`. It is implemented **directly beneath `/api/admin/self`**
rather than as a re-export of an `/api/admin/**` twin: `withOwnerAdmin` fails
closed with a hidden 404 outside that prefix, so the twin would be a phantom path
that can never serve (codebase-modularity.audit.md §"admin/self shim inversion").

Both verbs return `stored` **and** `model`, which are not the same thing:
`stored` is the override as saved and is what the dropdown shows selected, while
`model` is what will actually run. Collapsing them would make "pinned to Aion
3.0" and "following the default, which is Aion 3.0" indistinguishable — and those
diverge the moment the default moves, which is the point of the probe.

`SceneComposerSelect` (`components/chat/scene-composer-select.tsx`) renders in
the conversation menu beside `AgentReasoningSelect`, admin-only. Its first option
is "Default (follows the app)" bound to `""`; the description line always
describes the **effective** model, since on "Default" the operator's open
question is which model that currently is.

## The A/B harness

Two files, split so the part that produces a number is covered by `pnpm test`:

- `scripts/eval/scene-images/composer-model-score.ts` — the grader. Pure.
- `scripts/eval/scene-images/composer-model-ab.ts` — the runner. IO and reporting.

### What is asked

Every arm gets the **real** question: `sceneComposerSystem(embodied)`, the real
`buildSceneComposerPrompt` output, the real `sceneSpecSchema`, through the real
`generateChecked`. A difference measured here is a difference production would
see. `usageAccounting: true` is set so cost comes back **measured** rather than
estimated from a price table.

### Beats

Imported from `orientation-ab.ts`, never restated — two probes disagreeing about
what "doggy" is would make their gradings incomparable, the same rule
`intimate-model-ab.ts` follows. Seven: `behind`, `glance`, `kneel`, plus the four
intimate acceptance scenes `doggy`, `oral`, `oral_guided`, `missionary`.

The beat's own `spec` is **not** the answer key. For the intimate beats it is
deliberately written in the cautious register the composer really produces,
because there it plays the `old` arm of an image A/B. The answer key is the
beat's `camera` and `staging` — the shot the story establishes — plus a small
`EXPECTED_VIEWER_BODY` table for the one thing `Beat` cannot supply.

### Arms

Eight: the control, the two other Aion models, DeepSeek 4 Flash **twice**
(reasoning off and reasoning low — genuinely different products for a short
structured extraction, and the only way to know is to pay for both), and the three
remaining flash-tier candidates. `AB_ARMS`, `AB_BEAT`, `AB_RUNS` and `EVAL_OUT`
scope a run. Full matrix: 8 × 7 × 2 = 112 calls, well under $2, dominated almost
entirely by the control.

### Grading

The load-bearing decision: **scoring runs the spec through `resolveScenePlan`**,
the function production calls, rather than re-implementing its rules. A model
cannot pass by satisfying a paraphrase of the pipeline. Nine checks, each `true`,
`false`, or `null` when the beat does not grade that axis; the score is passed
over applicable.

| Check            | Passes when                                             |
| ---------------- | ------------------------------------------------------- |
| `answered`       | Not a refusal, transport failure, or all-defaulted spec |
| `focal`          | The right roster member, with no focal clamp            |
| `camera`         | The resolved camera is the ids the story establishes    |
| `staging`        | The right staging id survived every gate                |
| `viewerBody`     | Every expected viewer part was proposed                 |
| `groundedParts`  | No ungrounded, off-vocabulary or unrequested part       |
| `noInventedCast` | Nobody was invented into the frame                      |
| `noBannedWords`  | `scrubBlush` leaves every authored field unchanged      |
| `concrete`       | The pose and activity are not the documented hedge      |

Three of these need their reasoning stated:

- **`camera` is graded only on unstaged beats.** A surviving staging's camera
  replaces the composer's in `resolveScenePlan`, so grading it on a staged beat
  would grade the registry.
- **`viewerBody` is scored against the raw proposal, not the resolved plan.** A
  surviving staging unions its own registry parts into the plan, which would make
  this pass for a model that proposed nothing at all.
- **`concrete` is a short list of the documented failure signature**
  (`VAGUE_SIGNATURES`), not a prose-quality heuristic. A fuzzy readability score
  would quietly become the thing the arms are ranked on, and it would be a measure
  nobody agreed to. `EXPECTED_VIEWER_BODY` is empty for the oral beats for the
  same discipline: the registry supplies that hand and the reference fixture
  proposes no part, so requiring one would grade the arms against an expectation
  the reference answer itself does not meet.

### Honesty checks

The run refuses to spend anything when it would prove nothing:

- **The answer key must be satisfiable.** Before the first call, an _ideal_ spec
  is built for each beat from its own evidence quotes and graded. If it does not
  score 1.0, the answer key and the pipeline have drifted and every arm would be
  marked down for the harness's mistake — a broken instrument, not a model
  finding.
- **The control must be present.** Every number here is a comparison against the
  shipped default; without it the table ranks arms against nothing.
- **At least two arms.** An A/B with one arm is not one.
- A beat with no `EXPECTED_VIEWER_BODY` entry throws, so a beat added to
  `orientation-ab.ts` cannot be silently graded against a missing key.

With no provider key the runner prints every system prompt and user prompt and
makes no calls — the wording is free to review, exactly as the image A/Bs do it.

### Output

A per-beat detail block (which axis each arm lost, its prose, its proposed camera
and staging with the evidence it quoted, and the diagnostics that fired), then a
summary table with mean score, refusals, repair round-trips, p50/p95 latency,
dollars per thousand compositions, and each arm's speed and cost as a multiple of
the control's. `results.csv` and `results.json` land under `EVAL_OUT` (default
`data/eval/composer-model-ab`, gitignored).

## Results

Not yet run. Slice 3 of the plan fills this section: the summary table, then one
short verdict per arm naming which beats it held and which it lost, in the shape
[finished/scene-composition.spec.md](finished/scene-composition.spec.md)
§"Probe results" uses.

## Open questions

- **Does the fallback rung need to change if the default moves?** Today a degraded
  composition retries on `narrativeModelId()` — Aion 2.0, permissive and mid-priced
  — and it fires rarely enough that its cost is noise. With a cheap primary, that
  retry becomes the thing that rescues a refused intimate scene, and both its rate
  and its cost stop being negligible. The A/B's `answered` column is the number
  that decides this: an arm that refuses one beat in ten makes the fallback a
  tenth of all compositions, not a rounding error.
  - If the fallback is triggered often (10% or higher) we should look at a new fallback as Aion-2.0 is dated.
    However, I do not foresee Deepseek refusing often.
- **Should a winning model be pinned or floating?** `~deepseek/…-latest` is
  OpenRouter's floating alias and always redirects to the newest release, so a new
  snapshot needs no code change — and the exact weights can shift under us. The
  dated `deepseek/deepseek-v4-flash-<mmdd>` slugs are the pin-it escape hatch. The
  agent lane already accepted the floating trade (owner ask 2026-08-04); whether
  the composer should is a separate call, because a regression here shows up as a
  wrong picture rather than a dropped background field.
  - Pin v4 Flash if it wins, etc.
