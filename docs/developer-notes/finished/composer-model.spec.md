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
| `deepseek/deepseek-v4-flash-0731`    | 0.070 / 0.140    | **The shipped default**; the A/B winner |
| `aion-labs/aion-3.0`                 | 3.000 / 6.000    | The A/B control; the former default     |
| `aion-labs/aion-3.0-mini`            | 0.700 / 1.400    | Same lab, ~4× cheaper                   |
| `aion-labs/aion-2.0`                 | 0.800 / 1.600    | The session narrator; proven permissive |
| `~deepseek/deepseek-v4-flash-latest` | 0.068 / 0.135    | Same weights, floating; tries a newer snapshot |
| `qwen/qwen3.7-flash`                 | 0.030 / 0.130    | Cheapest capable                        |
| `z-ai/glm-4.7-flash`                 | 0.060 / 0.400    | Flash sibling of the curated narrator   |
| `inclusionai/ling-3.0-flash`         | 0.021 / 0.063    | The price floor                         |

The default and the alias are the **same weights** — the alias resolved to
`deepseek-v4-flash-0731` when the default was promoted — and both are listed on
purpose: the pin is what production is measured on, the alias is how a newer
snapshot gets tried on one conversation before it is promoted. The default's
price is the routed one (see [Provider routing](#provider-routing-for-the-pinned-default));
OpenRouter lists the dated slug at 0.140/0.280, which is its *unrouted* price.

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

### The reasoning policy is per rung

`composerDisablesReasoning(modelId)` (`server/ai/provider.ts`) owns the winning
arm's second half: a `COMPOSER_REASONING_OFF` set of model ids asked with
`generateChecked`'s existing `disableReasoning` knob, which sends OpenRouter
`reasoning:{enabled:false}`.

**It is an opt-in set rather than a flag on the composer call**, and that is
load-bearing rather than fastidious: the AionLabs endpoints *reject* the option
("Reasoning is mandatory for this endpoint" — it killed all 12 `off` cells of the
narrator eval), and an Aion model is both a curated composer option and the
ladder's refusal rung. So each rung resolves its own policy from its own id.
A DeepSeek primary runs reasoning-off while its Aion 2.0 fallback is asked
without the option; a chat switched onto Aion 3.0 sends it on neither call.
A model absent from the set sends no reasoning option at all, which is exactly
how every arm was measured.

**Parity check (2026-08-15).** Direct probes against the pinned snapshot
confirmed the endpoint accepts `reasoning:{enabled:false}` and returns
`reasoning_tokens: 0` under it — the failure this guards against is an endpoint
that rejects the option outright, as the AionLabs ones do. What that does **not**
cover is a full composition through `composeSceneSpec` on the deployed build;
that is the first scene render after deploy, and it is named on the plan's Status
line as one of the two things acceptance waits on.

### Provider routing for the pinned default

`PROVIDER_ORDER` (`server/ai/provider.ts`) routes the pinned snapshot to
`gmicloud/fp8` then `deepinfra/fp8`, with `allow_fallbacks` on.

This exists because pinning has a price consequence that pinning alone does not
solve. OpenRouter prices a slug by its cheapest endpoint but routes an
unconstrained call by its own price/latency/uptime blend: an unrouted probe of
the dated slug landed on CoreWeave at $0.13/$0.28 per M while endpoints at
$0.07/$0.14 were up. The composer runs on every scene image, so that factor of
two is most of the cost case for the move.

The list is **fp8-or-better and US-hosted on purpose.** Two endpoints undercut
these by ~2% (Decart, OpenInference) and both serve fp4; the composer's whole
output is a structured object that has to parse, and this repo already refused
provider-side constrained decoding because models degenerate under it
(followups.phase2.md #20). Two more (StreamLake, Baidu) are ~2% cheaper and
CN-hosted, and the composer is handed the most explicit stretch of a
conversation. Neither exclusion is a capability judgement, and 2% is not enough
to spend on either question. `allow_fallbacks` stays on because the alternative
to a pricier DeepSeek endpoint is not a cheaper one — it is the ladder degrading
to its Aion 2.0 rung at ~20× the token price.

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

The persisted/admin value is **model id only** — the reasoning policy is not per
chat and never was. It is keyed by model id in code
([The reasoning policy is per rung](#the-reasoning-policy-is-per-rung)), so
switching a conversation onto either DeepSeek row selects the reasoning-off
configuration the A/B measured, and switching it onto any Aion row selects none.
An admin picks a model; what that model's call looks like is a code decision
backed by the probe, not a second dropdown.

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

**DeepSeek's two rows were not directly promotable as-is, and the winner was
promoted with its call configuration.** The reasoning-off arm won, so Slice 4
encoded that exact setting as a composer-specific model policy
([The reasoning policy is per rung](#the-reasoning-policy-is-per-rung)) rather
than changing `DEFAULT_SCENE_COMPOSER_MODEL_ID` alone, which would have tested
one product and shipped another. The same rule applies to any future A/B arm
that adds a call option the production seam does not already carry.

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

Two paid runs happened on 2026-08-15. **Both were measured on the pre-fix
instrument**, and the second is the one the promotion rests on.

### What was measured, and on which instrument

- **Run 1** — eight arms, seven beats, `data/eval/composer-model-ab/`.
- **Run 2** — four arms (control, DeepSeek off, DeepSeek low, Qwen3.7 Flash),
  seven beats, two runs each, `data/eval/composer-model-ab-r2/`.

Neither run carries the fixes recorded in
[What the composer is told](#what-the-composer-is-told-changed-2026-08-15). Both
`results.csv` files carry a single `camera` column where the current grader
emits three, and `oral_guided` staging is 0 across every arm in both — the exact
fixture fault the same commit repaired. So Run 2 re-ran the superseded
instrument with a narrower arm set rather than re-running on the current prompt.

**What that does and does not license.** It does not license a per-axis reading:
staging and camera answers move when the vocabularies are described, so no arm's
`staging` or `camera` number here is evidence about that arm. It does license the
promotion, on two grounds the prompt cannot reach:

- **The ranking is stable across two independent runs.** DeepSeek reasoning-off
  scored 0.939 against the control's 0.928 in Run 1 and tied it at 0.939 in Run 2.
  An arm that matches or beats the control on both runs of a handicap every arm
  carried equally is not a prompt artifact.
- **The latency and cost gaps are structural, not graded.** Aion 3.0's endpoint
  mandates reasoning; that is where its 45-second mean comes from, and no prompt
  wording closes a 12× latency gap or an 88× cost gap.

**Owner ruling (2026-08-15): this is the accepted verdict; the confirming re-run
is waived.** A re-run on the current prompt would have cost roughly $0.19 at Run
2's arm set and would have made the evidence tidier, but it could not plausibly
reverse a decision resting on a ranking that held across two runs and on gaps
that come from the control's endpoint rather than its answers.

That ruling accepts the decision, not the data: every per-axis number below stays
instrument-bound, because that is a property of how it was measured. Anyone
reopening this — to move the default again, or to read an arm's staging or camera
behaviour — starts from a fresh run rather than from these cells.

### Run 2 summary — 14 calls per arm

| Arm                   | Score | Latency mean / median | $ per 1k |
| --------------------- | ----- | --------------------- | -------- |
| Aion 3.0 (control)    | 0.939 | 45.4s / 44.4s         | $12.46   |
| DeepSeek 4 Flash, off | 0.939 | 3.6s / 2.3s           | $0.14    |
| DeepSeek 4 Flash, low | 0.949 | 13.0s / 9.5s          | $0.33    |
| Qwen3.7 Flash         | 0.949 | 28.4s / 28.2s         | $0.49    |

DeepSeek's $ per 1k is quoted at the **routed** price the app now pays
(`PROVIDER_ORDER`, $0.07/$0.14 per M), not at the alias price the probe was
billed; the control's is its measured spend.

### The reasoning question, settled

**The +1% for reasoning-low is one check, in one run, on one beat.** Summed over
14 runs the two DeepSeek arms differ by 0.143, and one check on a seven-check
beat is worth exactly 0.143 — the entire margin is `behind`, run 1, where
reasoning-low got the viewer's body right and reasoning-off did not. Every other
beat scored identically on both arms. Qwen3.7 Flash's matching 0.949 comes the
same way, and it pays 8× the latency for it.

That margin bought a 3.6× mean and 4.1× median latency increase. Owner ruling
(2026-08-15): **reasoning off.** The composer runs before the player sees
anything, so seconds there are seconds of nothing happening on screen, and a
one-run difference is not a quality signal to buy them with.

### Per-arm verdicts

- **DeepSeek 4 Flash, reasoning off — promoted.** Held all four intimate beats
  (`doggy`, `oral`, `missionary` at 1.000; `oral_guided` at the 0.857 every arm
  scored, including the control). Never degraded, so the refusal rung stayed
  unexercised. Its prose is the tersest on the board — one run answered `oral`
  with "kneeling, looking up; performing oral sex", which passes every mechanical
  check and is thinner than the control's equivalent. Nothing in the score
  captures that, and it is the one thing to watch on the deployed build.
- **DeepSeek 4 Flash, reasoning low — not promoted.** See above: the margin is a
  single check, the cost is 3.6× the latency.
- **Qwen3.7 Flash — not promoted.** Ties reasoning-low on score at 8× DeepSeek's
  latency and 3.5× its cost. It also emitted the run's only
  `viewer_body_unrequested` diagnostic and its only sub-0.857 run (`kneel`, 0.714).
- **Aion 3.0 — demoted to a curated option.** Never refused and never degraded;
  it simply has no measured quality advantage to justify 45 seconds and 88× the
  cost. It stays selectable per chat.

### Fallback rung — no change

The owner's 10% review threshold is not approached: `images.scene_composer.degraded`
fired **0 times in 56 calls**, on every arm. Aion 2.0 stays the second rung, and
the promotion does not create a collision — the two rungs remain distinct ids.

## Owner decisions — 2026-08-15

- **Fallback rung:** keep the session-default Aion 2.0 fallback unless the winning
  cheap primary invokes it often enough to matter. The owner-set review threshold
  is **10%**: at or above a 10% measured production fallback rate, test/select a
  newer second rung before promoting that primary; below 10%, keep Aion 2.0 rather
  than optimizing a rare path pre-emptively. DeepSeek is expected to refuse rarely,
  but the measured `degraded` rate decides this, not the expectation.
- **Reasoning off for the composer (resolved 2026-08-15):** the reasoning-low arm
  scored 1% higher, and that margin is one check in one run of fourteen. The
  composer runs before the player sees anything, so the 3.6× latency it costs is
  not worth a difference that small. Reasoning is off for the DeepSeek rows and
  unset everywhere else.
- **Cheap-provider routing (resolved 2026-08-15):** pin the snapshot *and* route
  it, preferring the cheapest endpoints that are fp8-or-better; a list is fine
  where one provider would be fragile. ZDR is preferred but not required, which
  is why the ~2% cheaper CN-hosted endpoints are skipped rather than the routing
  being made conditional on a policy field OpenRouter does not expose per
  endpoint.
- **Pinning and call parity:** if the winner is reached through a floating alias,
  pin the exact snapshot that was tested before assigning it to
  `DEFAULT_SCENE_COMPOSER_MODEL_ID`. Floating aliases remain valid admin/eval
  candidates. If the winning arm also changed reasoning or another provider
  option, encode that exact call behavior before promotion and parity-probe it
  through production. The production-default test makes the model-snapshot rule
  executable; the Slice 4 parity check covers call options that a slug cannot.
