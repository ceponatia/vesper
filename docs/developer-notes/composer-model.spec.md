# Scene composer model — technical companion

Status: companion to [composer-model.plan.md](composer-model.plan.md)

The curated candidate list, the composer seam and its fallback rung, the per-chat
persistence and admin surface, and the A/B harness — its arms, answer keys,
grading rules, honesty checks, and production-ladder economics.

## The curated candidate list

`apps/web/src/lib/composer-models.ts` owns `SCENE_COMPOSER_MODELS`,
`DEFAULT_SCENE_COMPOSER_MODEL_ID` and `resolveSceneComposerModelId`. Same shape
as `agent-models.ts` and `narrative-models.ts`, with one addition: every entry
carries a `description`, because it is rendered under the admin dropdown and an
entry without one is an unexplained choice.

**The list is an owner-approved shortlist, not a validation ledger.** Candidates
must be present here to be selectable in the live admin surface, so they may be
listed before the paid A/B is run. Promotion to
`DEFAULT_SCENE_COMPOSER_MODEL_ID` is the stronger contract: it requires a
recorded A/B verdict in [Results](#results). The list is still not a menu of
everything OpenRouter sells.

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

Floating aliases are valid **candidate** ids because the point of the probe and
per-chat switch is to evaluate what is available now. The **production default
is different**: it must be pinned to the exact tested snapshot before promotion.
`composer-models.test.ts` rejects a default beginning with `~` or ending in
`-latest`, so a future edit cannot silently turn the production composer into a
moving target.

## The seam and its fallback rung

`sceneComposerModelId(chatComposerModel?)` (`server/ai/provider.ts`) resolves the
per-chat override through `resolveCurated`, the same strict resolver the narrator
and agent seams use. Strictness is a billing control, not a tidiness rule: the id
reaches `openrouter().chat()` on the deployment's key, so an uncurated value must
not survive the trip from a chat row to a generation.

`composerFallbackModelId(primary)` owns the ladder's second rung. It is
`narrativeModelId()` — the **session narrative default, currently Aion 2.0** —
except when that is the primary, which the per-chat composer override made
reachable now that Aion 2.0 is a candidate. This is deliberately **not** the
character chat's selected narrator model: changing a chat from one narrator to
another must not silently change image-composer reliability or economics. Asking
the same model twice is not a fallback, it is a retry of a refusal, so when Aion
2.0 itself is primary the rung falls to the curated composer default instead.
The invariant every caller depends on: **the two rungs are never the same id**,
asserted over the whole candidate list in `scene-composer-model.test.ts`.

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

The persisted/admin value is **model id only**. It does not carry a composer
reasoning profile. That matters for the DeepSeek A/B arms below: selecting
DeepSeek in a live chat exercises the model's normal production call, not the
probe's explicit `reasoning: off` or `reasoning: low` variants. Those variants
are diagnostic until Slice 4 deliberately encodes the winning reasoning policy.

## The A/B harness

The grading path and the owner-facing economics are deliberately separated so
reporting changes cannot accidentally change the instrument:

- `scripts/eval/scene-images/composer-model-score.ts` — the grader. Pure and
  covered by `pnpm test`.
- `scripts/eval/scene-images/composer-model-ab.ts` — the existing runner. IO,
  model calls, raw results and the quality table. Left unchanged by the
  ladder-economics follow-up.
- `scripts/eval/scene-images/composer-model-economics.ts` — pure fallback-rate
  and effective-cost arithmetic, covered by `pnpm test`.
- `scripts/eval/scene-images/composer-model-eval.ts` — the **one-command owner
  entrypoint**. It runs `composer-model-ab.ts` unchanged, reads its `results.json`,
  derives the exact production fallback trigger from the runner's diagnostics,
  prints the ladder-economics table, and writes `ladder-summary.json`.

Run the full comparison with:

```sh
pnpm tsx scripts/eval/scene-images/composer-model-eval.ts
```

The existing `AB_ARMS`, `AB_BEAT`, `AB_RUNS` and `EVAL_OUT` environment filters
flow through to the underlying runner unchanged.

### What is asked

Every arm gets the **real** question: `sceneComposerSystem(embodied)`, the real
`buildSceneComposerPrompt` output, the real `sceneSpecSchema`, through the real
`generateChecked`. A difference measured here is a difference production would
see. `usageAccounting: true` is set so cost comes back **measured** rather than
estimated from a price table.

### Beats

Imported from `orientation-ab.ts`, never restated — two probes disagreeing about
what a fixture means would make their gradings incomparable, the same rule
`intimate-model-ab.ts` follows. Seven: `behind`, `glance`, `kneel`, plus the four
intimate acceptance scenes `doggy`, `oral`, `oral_guided`, `missionary`.

The beat's own `spec` is **not** the answer key. For the intimate beats it is
deliberately written in the cautious register the composer really produces,
because there it plays the `old` arm of an image A/B. The answer key is the
beat's `camera` and `staging` — the shot the story establishes — plus a small
`EXPECTED_VIEWER_BODY` table for the one thing `Beat` cannot supply.

**`oral` and `oral_guided` must tell two different stories** (fixed 2026-08-15).
They shared one narration verbatim — hand on her head included — and expected
two different answers from it. That is unanswerable: the two registry entries
describe the same act and differ only by the viewer's hand resting on her head,
so a story stating the hand supports the guided entry and contradicts the plain
one. The A/B scored the consequence rather than the model: `oral_guided` 0/16
across eight arms, every one of them answering the plain sibling. The guided beat
now states the hand and the plain beat does not, and each carries the quote that
establishes its own entry rather than the act they share. A fixture pair that
differs only in its answer key is a broken instrument.

### Arms

Eight: the control, the two other Aion models, DeepSeek 4 Flash **twice**
(reasoning off and reasoning low — genuinely different call configurations for
a short structured extraction, and the only way to know is to pay for both), and
the three remaining flash-tier candidates. `AB_ARMS`, `AB_BEAT`, `AB_RUNS` and
`EVAL_OUT` scope a run. Full matrix: 8 × 7 × 2 = 112 calls, well under $2,
dominated almost entirely by the control.

**DeepSeek's two rows are not directly promotable as-is.** Production currently
persists only the model id and `composeSceneSpec` supplies neither the A/B's
`disableReasoning` option nor its `reasoning.effort="low"` option. If either
DeepSeek reasoning arm wins, Slice 4 must first encode that exact setting as a
composer-specific model policy, then rerun a targeted parity check through the
production call. Merely changing `DEFAULT_SCENE_COMPOSER_MODEL_ID` would test one
product and ship another. The same rule applies to any future A/B arm that adds a
call option the production seam does not already carry.

### Grading

The load-bearing decision: **scoring runs the spec through `resolveScenePlan`**,
the function production calls, rather than re-implementing its rules. A model
cannot pass by satisfying a paraphrase of the pipeline. Eleven checks, each
`true`, `false`, or `null` when the beat does not grade that axis; the score is
passed over applicable, **excluding the framing axis below**.

| Check               | Passes when                                              |
| ------------------- | -------------------------------------------------------- |
| `answered`          | Not a refusal, transport failure, or all-defaulted spec  |
| `focal`             | The right roster member, with no focal clamp             |
| `cameraOrientation` | Which way she is turned is the id the story establishes  |
| `cameraHeight`      | Where the camera sits is the id the story establishes    |
| `cameraDistance`    | The frame holds what the beat wants — reported, unscored |
| `staging`           | The right staging id survived every gate                 |
| `viewerBody`        | Every expected viewer part was proposed                  |
| `groundedParts`     | No ungrounded, off-vocabulary or unrequested part        |
| `noInventedCast`    | Nobody was invented into the frame                       |
| `noBannedWords`     | `scrubBlush` leaves every authored field unchanged       |
| `concrete`          | The pose and activity are not the documented hedge       |

Four of these need their reasoning stated:

- **The camera is three checks, not one, and only two of them score.**
  Orientation and height are **spatial correctness**: a front-facing shot of a
  character with her back to the room contradicts the text. Distance is
  **framing quality**, and the registry says so in the vocabulary itself — shot
  distance carries no `evidenceRequired` field, "because a wrong distance is a
  taste miss and a wrong orientation is a contradiction", and nothing in
  production degrades one. So `cameraDistance` is recorded per run and printed as
  `(framing: …)` rather than a failure, and `UNSCORED_CHECKS` keeps it out of the
  score. The 2026-08-15 run is why: a single combined check put every arm at
  2/14 and read as "no model can work the camera", when orientation and height
  were largely right and distance was disagreeing almost everywhere.
- **The camera is graded only on unstaged beats.** A surviving staging's camera
  replaces the composer's in `resolveScenePlan`, so grading it on a staged beat
  would grade the registry. Unchanged by the split — all three axes are `null`
  on a staged beat.
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

**`answered` is not the fallback-rate metric.** It is intentionally broader than
production's retry trigger because a syntactically valid, all-defaulted spec is
still a useless composition and should score as unanswered. Production retries
only when `generateChecked` returns `degraded: true`. The runner already records
that event as `images.scene_composer.degraded` in its diagnostics, and
`composer-model-eval.ts` uses that exact signal for fallback-rate and cost math.
This keeps quality and economics honest instead of pretending they are the same
question.

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
The wrapper detects that no `results.json` was written and skips economics rather
than inventing zero-cost measurements or reading a stale paid result.

### Output

The unchanged runner prints a per-beat detail block (which axis each arm lost,
its prose, its proposed camera and staging with the evidence it quoted, and the
diagnostics that fired), then its existing quality/latency/cost summary.
`results.csv` and `results.json` land under `EVAL_OUT` (default
`data/eval/composer-model-ab`, gitignored).

The owner entrypoint then adds a second table with:

- `answered` rate — quality;
- **fallback rate** — rows carrying `images.scene_composer.degraded`, the exact
  condition that makes production ask rung 2;
- measured primary dollars per thousand compositions;
- the actual fallback model selected by `composerFallbackModelId(primary)`; and
- **effective dollars per thousand** = primary $/1k + fallback rate × measured
  fallback-model $/1k.

It writes the same per-arm economics to `ladder-summary.json`. If a filtered run
omits the fallback arm and the fallback actually fires, effective cost remains
unknown rather than substituting a price-table estimate.

## What the composer is told (changed 2026-08-15)

The first paid run measured the prompt as much as the models, and two of its
findings were the prompt's fault rather than any arm's. Both fixes are
**registry-owned**, so the vocabulary the composer reads and the vocabulary the
backend resolves cannot drift: a new id is a type error until it carries its
description.

- **Stagings are listed with a selection hint, not as bare ids.**
  `SceneStaging.hint` is one clause naming the geometry that makes an entry the
  right answer and its siblings wrong, rendered as `id — hint`. An id is a
  label, not a definition, and `kneeling_before_viewer_guided` differs from its
  sibling by one adjective whose meaning lived only in the render template. The
  hint is **not** the template and never reaches an image prompt: templates are
  explicit because a render needs explicit words, hints are recognition cues for
  a planner, and keeping them apart lets templates be tuned for render quality
  without silently retraining selection. A test pins that no template appears in
  the composer's system prompt.
- **The camera vocabulary is defined, not merely named.** Distance and height
  ids render as `"id" (what it means)` from `SceneShotDistance.hint` /
  `SceneCameraHeight.hint`. Distance is stated as *how much of the body the
  frame holds*, never as how near the viewer stands — the confusion the bare
  list invited, since "he stops right behind her" reads as `close` while the
  beat wants a medium two-body frame.
- **Sibling variants must be quoted apart.** The staging rule now says that when
  entries differ by one detail — whose hands are where, whether she is bare,
  which way she faces — the evidence quote must establish *that detail*, not the
  act they share, and that an unstated detail means picking the plainer entry.

### Deferred: variant refinement from committed facts

Rejected 2026-08-15: resolving `kneeling_before_viewer` → `..._guided` in code
whenever the surviving `viewerBody` contains `hands`. A visible hand does not
prove hand-on-head geometry — the plain entry already puts the viewer's body in
frame — so the rule would silently promote correct plain answers into a
different act.

What could work later is narrower: the chat's **committed scene facts**
(`contracts/images/scene-committed.ts`) already carry authoritative pair
contacts, and a contact naming the viewer's hand on the subject's *head* would
be evidence for exactly this variant and no other. That is a per-variant
mapping over committed contacts, not a generic limb heuristic, and it needs the
contact vocabulary to distinguish the body location before it can be written.
Not scoped here.

## Results

No usable run yet. One paid run happened on 2026-08-15, across eight arms and
seven beats, and it is **superseded in full** — it exposed the two grader faults
and the prompt fault recorded above, and the fixes for all three change what the
arms are shown and how they are marked. Its numbers are evidence about the old
prompt, not about the candidates, so none of them belong in this section.

Slice 3 fills it from a re-run on the current prompt: the quality summary, the
ladder-economics summary, then one short verdict per arm naming which beats it
held and which it lost, in the shape
[finished/scene-composition.spec.md](finished/scene-composition.spec.md)
§"Probe results" uses. Every arm in that table must come from the same run —
a filtered run is fine, but arms measured on different prompts are not a
comparison.

## Owner decisions — 2026-08-15

- **Fallback rung:** keep the session-default Aion 2.0 fallback unless the winning
  cheap primary invokes it often enough to matter. The owner-set review threshold
  is **10%**: at or above a 10% measured production fallback rate, test/select a
  newer second rung before promoting that primary; below 10%, keep Aion 2.0 rather
  than optimizing a rare path pre-emptively. DeepSeek is expected to refuse rarely,
  but the measured `degraded` rate decides this, not the expectation.
- **Pinning and call parity:** if the winner is reached through a floating alias,
  pin the exact snapshot that was tested before assigning it to
  `DEFAULT_SCENE_COMPOSER_MODEL_ID`. Floating aliases remain valid admin/eval
  candidates. If the winning arm also changed reasoning or another provider
  option, encode that exact call behavior before promotion and parity-probe it
  through production. The production-default test makes the model-snapshot rule
  executable; the Slice 4 parity check covers call options that a slug cannot.
