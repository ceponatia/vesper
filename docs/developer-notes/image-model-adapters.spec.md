# Image model adapters — spec

Status: companion to `image-model-adapters.plan.md`

Technical decisions for the adapter/composer build. Each section names its
owning layer; implementation status lives beside each area.

## Contracts (`@vesper/image-core`)

Status: complete — merged 2026-08-24.

Rulings the build settled:

- Mechanical checks run entirely before task policy, so a row failing both
  reports the mechanical reason (previously the task check came before the
  scale/binding checks). Both remain `incompatible`; only which message wins
  changed.
- The evaluator resolves the artifact locator itself: `binding.locator` is the
  resolved provider address (`resolveImageLoraArtifactLocator`), verbatim for
  the two legacy types, so a Civitai row can never reach a payload as a bare
  id — and the resolved URL is on `civitai.com`, so the app's existing
  credential host-match completes the token with no app change.
- The wire invariant treats a present-but-nullish provider field as missing;
  `missingField` names the provider field when the version declares a binding
  and the binding name when it declares none. A profile override that
  *replaces* `lora_weights` with a different value does not breach the
  invariant — overrides win is the documented escape hatch.
- The kernel's prompt preparer rides `ImageRenderRuntimeFacts.preparePrompt`;
  the default is identity — no dialect without an injected preparer.

### Execution context

```ts
type ImageExecutionContext =
  | { kind: "production"; task: ImageProfileTask }
  | { kind: "generator_bench" }
  | { kind: "image_lab"; task: ImageProfileTask };
```

- Lives beside the LoRA contracts in `src/loras/`; exported from the barrel.
- `evaluateImageLoraForRender` takes `context` instead of bare `task`. The
  decision body is restructured into two named internal checks:
  **mechanical compatibility** (enabled, model slug, version, scale vs curated
  band, scale vs binding range, weights+scale bindings present, locator valid)
  and **production task policy** (`allowedTasks`). Mechanical runs in every
  context; task policy runs for `production` and `image_lab` and is skipped for
  `generator_bench`.
- The stored row is untouched: `allowed_tasks` remains the flat jsonb column and
  the parsed `ImageLora` stays flat. The compatibility/policy concept split is
  expressed in the evaluator and its doc comments, not in a reshaped type
  (plan §22).
- Refusal codes are unchanged: mechanical → existing `incompatible`/
  `unreachable` split as today; a task-policy refusal stays `incompatible` with
  the existing message shape.

### LoRA artifact sources

- `imageLoraLocatorTypes` gains `"civitai_model_version"`; its locator is the
  numeric model-version id (digits only, validated by
  `isValidImageLoraLocator`). Query-string tails are refused — variants ride
  the id, not a pasted URL.
- A pure resolver (`loras/`) maps a row to its provider-consumable locator:
  `https_url` → verbatim; `huggingface_repo` → verbatim slug;
  `civitai_model_version` → `https://civitai.com/api/download/models/<id>`.
  Credential completion stays in the app (below).
- `"managed_asset"` is documented headroom in the union's comment, not a member.
- No DB migration: the column enum is TypeScript-level (no CHECK), and existing
  rows keep their types.

### Provider execution policy

```ts
type ProviderExecutionPolicy = {
  startupBudgetMs: number;   // creation → first execution
  renderBudgetMs: number;    // execution start → output
  maxStartupRetries: number; // retries after an unstarted abort
};
```

- Lives in `src/provider-interface/`; provider-neutral on purpose so an intent
  can carry it without importing a transport.
- `ImageRenderIntent` gains optional `executionPolicy`; absent means the
  transport's legacy single-budget behavior, byte-for-byte.

### Compile-step wire invariant

In `compile-profile-plan.ts`, and the invariant is IDENTITY, not presence
(owner ruling 2026-08-24): a plan that records `appliedControls.lora` must
carry both bound provider fields in `controlInput` with values EQUAL to the
resolved binding's own locator and scale, or the compile refuses pre-spend; a
plan whose `controlInput` lacks the binding must not record the LoRA as
applied. A resolved LoRA additionally OWNS its bound fields: they join the
override validator's reserved set, so a profile/raw override colliding with
them is dropped with the ordinary recorded reason — which closes the one
public route to a mismatch and makes the equality gate a pure backstop.
Without a resolved LoRA the fields stay ordinary advanced inputs. Owned and
unit-tested at this one layer.

The compile also emits `typedControlFields` — the `controlInput` fields the
normalized mapper wrote that the raw override bag did not replace. The strict
provider-input validator (`typedOwnerFields`) extends its URI/array trust to
exactly that set, threaded plan → `renderWithModel` → the transport request
and the Generator's pre-spend gate: a curated LoRA's probed weights field may
carry its URI, a raw advanced value never may (owner ruling 2026-08-24,
closing the latent strict-arm gap in this PR).

### Prompt-preparation hook

- The kernel's dialect call site in `compile-profile-plan.ts` takes an
  injected preparer whose default is identity; `preparePromptForImageModel`,
  the Qwen branch, and both `QWEN_*_IDENTITY_LOCK` constants are deleted from
  `quality-presets.ts` and live only in the Qwen adapter.
- `withReviewedImageQuality` and the reviewed-controls table stay in
  `image-core` untouched.

## Transport (`@vesper/image-replicate`)

Status: complete — merged 2026-08-24.

Rulings the build settled:

- Result contract for consumers: `attempts?: ReplicatePredictionAttempt[]`
  (oldest first, emitted ONLY under a policy so stored production results gain
  no new keys); outcome vocabulary `succeeded | failed | canceled |
  aborted_before_start | startup_timeout | render_timeout`;
  `predictionId`/`executedVersionId` keep describing the final attempt.
- Execution evidence is `processing`/`succeeded` status, a numeric
  `metrics.predict_time`, or non-empty logs — `started_at` is explicitly not
  proof (the observed abort stamps it at abort time).
- The retryable class is a terminal `aborted` with no execution evidence and
  no error text — the observed incident shape and nothing wider (owner ruling
  2026-08-24: a silent `failed` is NOT assumed unstarted; recreating an
  ambiguous failure risks rebilling a render that ran) — plus the client's own
  startup cutoff once its cancellation is confirmed. `canceled` never retries
  (a cancel is somebody's decision) and a failure carrying error text never
  retries (an input error would be re-billed).
- Recreations have no backoff — acceptable at one retry; a ruling is needed
  before retries ever exceed one or reach production.
- The startup cutoff CONFIRMS the cancellation before its caller may retry:
  cancel, then re-read the record (up to three polls). Execution evidence
  flips the attempt into the render phase and it is watched to its end; a
  terminal record with no execution evidence is the one retryable answer; an
  unconfirmable record refuses the retry outright — a second prediction beside
  an unconfirmed first could pay for two renders. Render-timeout and
  single-budget cutoffs never retry, so best-effort cancellation remains
  sufficient there.
- A policy with unusable numbers degrades to the legacy single budget rather
  than failing the render; the summed budget is not clamped here — the app
  owns the ceiling.
- Startup-timeout failure wording contains "timed out" so the app's failure
  classifier keeps reading it as transient (asserted by a package test).

- `runPrediction` accepts an optional `ProviderExecutionPolicy`. With one:
  `Cancel-After = startupBudgetMs + renderBudgetMs`; locally, an unstarted
  prediction past the startup budget is cancelled and retried up to
  `maxStartupRetries` times; a started prediction gets `renderBudgetMs` from
  observed execution start. Without one: today's single `timeoutMs` semantics,
  unchanged.
- "Never started" is judged from the prediction record (no execution start
  echo / no metrics), not from wall-clock guesses; the observed abort shape —
  `status: "aborted"`, empty logs, null metrics, `started_at ≈ completed_at` —
  is the fixture.
- The result reports `attempts`: prediction id, terminal outcome, queued and
  render durations where knowable. The final attempt keeps populating the
  existing provenance fields so current consumers read unchanged.

## Composer and Qwen family (`@vesper/image-models`)

Status: complete — merged 2026-08-24.

Rulings the build settled:

- **Owner ruling (2026-08-24): the numbered-reference dialect is a Qwen
  Edit-family behavior**, composed by both `image-edit-2511` and
  `image-edit-plus-lora` — never a 2511-specific conditional. The legacy
  slug-check restriction was an artifact, not a decision; once Stage 4 wires
  adapters, wrapper renders (intimate scene, portrait-studio NSFW test) get
  the numbered-reference identity locks instead of the legacy lock passing
  through unswapped. Endpoint differences — LoRA support, cold-start hints,
  `go_fast` — stay endpoint-level.
- **Provider recheck 2026-08-24:** Qwen Image Edit 2511 itself now exposes one
  runtime custom LoRA through `lora_weights`/`lora_scale`. Its adapter composes
  `loraFeature`, and migration 0118 backfills the verified bindings on the
  long-lived pinned registry row without changing its version. The older 2509
  plus-LoRA wrapper remains supported; it is no longer the only Qwen edit
  endpoint with runtime LoRA.
- Feature factories carry a `Feature` suffix (`promptFeature`, `loraFeature`);
  feature ids use the spec's camelCase names.
- Execution hints arrive via a quirk (the wrapper's cold-start quirk sets
  `startupBudgetMs: 8 min`, `maxStartupRetries: 1`, no render budget — the
  lane's default governs).
- Quirk merge: declaration order, each optional hook claimable exactly once —
  a second claim throws at definition time, as does a duplicate feature id.
- `image-2512` composes no negative-prompt feature — the endpoint ignores its
  negative field.
- The adapter's `preparePrompt` takes the full `ImageModel`; Stage 4 injection
  sites must hold the whole record.

- New workspace package: rank 30 peer of `image-replicate`/`image-sd`, runtime
  `universal`, depends on `@vesper/image-core` (and `@vesper/contracts` if
  needed). Registered in `check-workspace-imports.ts`, `transpilePackages`, and
  the Dockerfile manifest COPY; exact `exports`, no wildcards; own
  `typecheck`/`test` scripts, tsconfig, vitest config.
- `ImageFeature`: id plus optional hooks (payload contribution/validation
  against probed bindings). Feature modules built as needed: prompt,
  multi-reference, aspect-ratio, seed, LoRA, output-format, output-quality,
  safety-toggle, negative-prompt, guidance.
- `defineImageModel({ family, features, quirks })` → `ImageModelAdapter`
  `{ family, capabilities, preparePrompt?, validateRequest?, executionHints? }`.
- Qwen family: `families/qwen/shared.ts` (dialect + conventions),
  `image-edit-2511.ts` (current edit endpoint, runtime LoRA feature),
  `image-edit-plus-lora.ts` (2509-generation wrapper, LoRA feature,
  3-reference cap, `go_fast` note), `image-2512.ts` (generator arm, ignores
  negative field — see `model-aware-image-prompts` docs). The dialect quirk
  carries the two identity-lock constants moved from `quality-presets.ts`.
- Registry: `adapterForImageModel(baseSlug)` → adapter or null; null is the
  ordinary no-special-behavior answer.
- The probed registry stays authoritative for wire fields; adapters never
  restate a field the probe owns.

## Application wiring (Stage 4)

Status: complete — merged 2026-08-24.

Rulings the build settled:

- The adapter→render join is written once, in
  `apps/web/src/server/images/model-adapters.ts` (prompt dialect, runtime
  facts, bench budget resolver, adapter request validation).
- Adapter `validateRequest` is WIRED, not descriptive (owner ruling
  2026-08-24): the Generator runner asks the family adapter's composed
  validators pre-spend, where `require_all` makes the judged facts final, and
  settles a refusal under `operation_unsupported`. Production lanes are not
  wired yet — their `allow_trim` policy means the pre-plan reference count is
  not the sent count, and a validator judging the un-trimmed number would
  refuse renders the planner would legally trim (deferred follow-up).
- Attempts are stored as `meta.providerAttempts` (oldest first), a sibling of
  the existing `attempt`/`result` records, written only when the transport
  reports attempts; the `prediction_id`/`executed_version_id` columns keep the
  final attempt. The run contract carries `providerAttempts` as a deliberately
  loose array field so newer deploys' records reach the inspector.
- The bench-policy ceiling is owned app-side: startup+render is capped at
  `MAX_TRIAL_PREDICTION_MS`, taken off the startup phase.
- Lab baselines DO carry the bench policy — a baseline reproduces a production
  lane's configuration, not its impatience; a cold-start abort would cost a
  comparison its control arm for a reason unrelated to what is being tested.
- The identity-pack trial keeps its own pinned budget and no policy; its
  stale-claim window is sized against that budget.
- `JOB_STALE_MS` (15 min) is deliberately unchanged: the atomic run claim
  makes double-spend impossible, the job's own settle overwrites the sweep's
  orphan marking, and raising it would cost every player five extra minutes of
  a wedged chat when a real job dies. The real effect on a >15-minute bench
  run (owner assessment 2026-08-24): the job drops out of the per-user
  concurrency count while still running, so additional work can be admitted
  beside it — an accepted edge at one retry, not merely cosmetic; revisit
  before retries or budgets grow.
- Lab runs record attempts the same way: `meta.providerAttempts`, written on
  success and failure by `storeLabRender`, surfaced through the experiment wire
  record's own loose `providerAttempts` field.

- Context at every `resolveImageLoraForRender` call site:
  `render-intent.ts` and `nsfw-lora.ts` → `production(task)`;
  `image-lab-render.ts` → `image_lab(task)`;
  `image-generator-run.ts` → `generator_bench`.
- Adapter hooks: the app resolves the adapter once per render and injects its
  preparer into `planImageRender` and `renderWithModel`; Qwen behavior then has
  exactly one owner.
- Bench execution policy: Generator and Lab pass startup 8 min / render 3 min /
  1 startup retry (adapter `executionHints` may narrow, never widen past
  `MAX_TRIAL_PREDICTION_MS`). Production lanes pass nothing (owner ruling
  2026-08-24).
- Attempts land in the run row's `meta` beside the existing `attempt` record;
  the `prediction_id` column keeps the final attempt.
- `lora-credentials.ts` completes the resolved artifact locator: the Civitai
  token applies to `civitai_model_version` resolutions and to legacy
  civitai-host `https_url` rows exactly as today.

## UI (Stage 5)

Status: complete — merged 2026-08-24.

Rulings the build settled:

- The LoRA library form validates locators client-side with
  `isValidImageLoraLocator` itself (re-exported through the client API seam),
  per-type hints included — the UI never spells a second, looser rule.
- The Generator form warns (never blocks) on a version-list mismatch beside
  the existing slug mismatch, replay-aware via the effective version id.
- Generator copy for `image_lora.incompatible` no longer names the task as a
  cause — task curation cannot refuse a bench render.
- Run detail renders provider attempts inside the recorded-request section,
  parsed leniently; a run without attempts renders byte-identically.

- Generator form: LoRA picker filtered by mechanical compatibility (slug match
  is already there; drop nothing merely for task policy), so no offered pick
  can refuse.
- Generator run detail: render the attempts record (queued duration, retries,
  outcome per attempt).
- LoRA library form: `civitai_model_version` as a locator-type option with the
  id field validated as digits.

## Invariant coverage (Stage 6)

Status: complete — merged 2026-08-24.

The final-wire test lives at
`packages/image-replicate/src/lora-final-wire.test.ts`, beside the payload
builder: three cases assert against `buildPayload` with
`previewRegistryModelInput` agreement checked alongside, and one case runs the
real `runRegistryImageModel` against a stubbed `fetch` and asserts the exact
locator and scale in the JSON body of the prediction-create request — the
literal POST, not one seam short of it. The bench case pins the fixture's task
mismatch so the case cannot go vacuous if `allowedTasks` is ever widened.

- Cross-stack, no-network: seeded library row → `generator_bench` resolution →
  intent → `planImageRender` → `previewRegistryModelInput`, asserting
  `lora_weights`/`lora_scale` verbatim (token-free — credential completion is
  covered separately by `lora-credentials.test.ts`).
- Compile invariant unit tests live with the kernel; transport retry behavior
  with the transport's tests. One owning layer each; no duplicate coverage.

## Deferred follow-ups

- Adapter `validateRequest` on production lanes: needs trim-aware facts (the
  post-plan sent count), or validators restricted to trim-independent claims.
- Other model families (Flux, Wan, SDXL, Seedream) migrate into adapters when
  their behavior is next touched.
- Managed LoRA storage / weight caching / sha256 provenance columns.
- Production adoption of `ProviderExecutionPolicy` and startup retries.
- Nested `ImageLora` contract shape (compatibility/productionPolicy as nested
  objects) if the flat shape starts to mislead.
