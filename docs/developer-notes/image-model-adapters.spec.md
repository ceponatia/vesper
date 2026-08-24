# Image model adapters — spec

Status: companion to `image-model-adapters.plan.md`

Technical decisions for the adapter/composer build. Each section names its
owning layer; implementation status lives beside each area.

## Contracts (`@vesper/image-core`)

Status: built 2026-08-24 — awaiting CI.

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
- The kernel's prompt preparer rides `ImageRenderRuntimeFacts.preparePrompt`,
  defaulting to the legacy `preparePromptForImageModel` until Stage 4 rewires
  callers.

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

In `compile-profile-plan.ts`: a plan that records `appliedControls.lora` MUST
carry both bound provider fields in `controlInput`, or the compile refuses
pre-spend (kernel refusal vocabulary, message naming the missing field); a plan
whose `controlInput` lacks the binding MUST NOT record the LoRA as applied.
Owned and unit-tested at this one layer.

### Prompt-preparation hook

- The kernel's dialect call site (`compile-profile-plan.ts` →
  `preparePromptForImageModel`) accepts an injected preparer; the default
  remains the legacy function until Stage 4 rewires callers, after which the
  Qwen branch and both `QWEN_*_IDENTITY_LOCK` constants are deleted from
  `quality-presets.ts` and live only in the Qwen adapter.
- `withReviewedImageQuality` and the reviewed-controls table stay in
  `image-core` untouched.

## Transport (`@vesper/image-replicate`)

Status: built 2026-08-24 — awaiting CI.

Rulings the build settled:

- Result contract for consumers: `attempts?: ReplicatePredictionAttempt[]`
  (oldest first, emitted ONLY under a policy so stored production results gain
  no new keys); outcome vocabulary `succeeded | failed | canceled |
  aborted_before_start | startup_timeout | render_timeout`;
  `predictionId`/`executedVersionId` keep describing the final attempt.
- Execution evidence is `processing`/`succeeded` status, a numeric
  `metrics.predict_time`, or non-empty logs — `started_at` is explicitly not
  proof (the observed abort stamps it at abort time).
- The retryable class is a terminal `aborted`, or a terminal `failed` with no
  execution evidence AND no error text, plus the client's own startup cutoff;
  `canceled` never retries (a cancel is somebody's decision) and a failure
  carrying error text never retries (an input error would be re-billed).
- Recreations have no backoff — acceptable at one retry; a ruling is needed
  before retries ever exceed one or reach production.
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

Status: built 2026-08-24 — awaiting CI.

Rulings the build settled:

- **Owner ruling (2026-08-24): the numbered-reference dialect is a Qwen
  Edit-family behavior**, composed by both `image-edit-2511` and
  `image-edit-plus-lora` — never a 2511-specific conditional. The legacy
  slug-check restriction was an artifact, not a decision; once Stage 4 wires
  adapters, wrapper renders (intimate scene, portrait-studio NSFW test) get
  the numbered-reference identity locks instead of the legacy lock passing
  through unswapped. Endpoint differences — LoRA support, cold-start hints,
  `go_fast` — stay endpoint-level.
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
  `image-edit-2511.ts` (edit, no loadable LoRA), `image-edit-plus-lora.ts`
  (2509-generation wrapper, LoRA feature, 3-reference cap, `go_fast` note),
  `image-2512.ts` (generator arm, ignores negative field — see
  `model-aware-image-prompts` docs). The dialect quirk carries the two
  identity-lock constants moved from `quality-presets.ts`.
- Registry: `adapterForImageModel(baseSlug)` → adapter or null; null is the
  ordinary no-special-behavior answer.
- The probed registry stays authoritative for wire fields; adapters never
  restate a field the probe owns.

## Application wiring (Stage 4)

Status: queued.

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

Status: queued.

- Generator form: LoRA picker filtered by mechanical compatibility (slug match
  is already there; drop nothing merely for task policy), so no offered pick
  can refuse.
- Generator run detail: render the attempts record (queued duration, retries,
  outcome per attempt).
- LoRA library form: `civitai_model_version` as a locator-type option with the
  id field validated as digits.

## Invariant coverage (Stage 6)

Status: queued.

- Cross-stack, no-network: seeded library row → `generator_bench` resolution →
  intent → `planImageRender` → `previewRegistryModelInput`, asserting
  `lora_weights`/`lora_scale` verbatim (token-free — credential completion is
  covered separately by `lora-credentials.test.ts`).
- Compile invariant unit tests live with the kernel; transport retry behavior
  with the transport's tests. One owning layer each; no duplicate coverage.

## Deferred follow-ups

- Other model families (Flux, Wan, SDXL, Seedream) migrate into adapters when
  their behavior is next touched.
- Managed LoRA storage / weight caching / sha256 provenance columns.
- Production adoption of `ProviderExecutionPolicy` and startup retries.
- Nested `ImageLora` contract shape (compatibility/productionPolicy as nested
  objects) if the flat shape starts to mislead.
