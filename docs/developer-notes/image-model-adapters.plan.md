# Image model adapters and the feature composer

Status: awaiting acceptance — CI on the draft PR, then the owner's Stage 7 bench validation

Outcome: The owner can run any registered image model — LoRA weights included —
from the Image Generator and trust that what the record claims was sent is what
the provider received, so that a model's real capabilities are proven on the
bench before any production lane depends on them.

**Proposed package/component:** `@vesper/image-models` (new), plus seams in `@vesper/image-core` and `@vesper/image-replicate`  
**Primary owner:** `@vesper/image-models` for model-family behavior; `@vesper/image-core` for contracts and policy  
**Primary integration:** the normalized render-intent path (`planImageRender` → `renderWithModel`) and the Image Generator/Lab benches  
**Provider/dependency:** Replicate (existing transport); Civitai and Hugging Face as LoRA weight sources

## 1. Goal

Make the reusable unit of the image stack a **semantic capability** (prompt,
references, LoRA, aspect, seed, …) and give each model family one home for its
weirdness, instead of slug-checks scattered through shared code. Three defects
drive the work, all found on one bench run:

- No LoRA can run in the Image Generator at all, because the bench borrows a
  fake production task (`item`) and the LoRA library's task curation refuses it.
- A render that queues longer than its whole budget is aborted by the provider
  before it starts, and Vesper reports that as a render failure.
- Across the entire retained provider history, no prediction has ever carried
  `lora_weights` — every unit test passed while the system never sent the thing.

Quality bar: existing production lanes behave byte-for-byte as before; the
change enters through the existing render intent and profile resolution, not
through feature-specific branches in callers.

## 2. Core architectural rule

`@vesper/image-models` **composes** capabilities that `@vesper/image-core`
defines; it never replaces the probed capability registry, which remains the
authority on provider wire fields. Model-family adapters own behavior (prompt
dialect, validation, execution hints); the probe owns field truth.

```text
@vesper/contracts            (10)
        ▲
@vesper/image-core           (20)  contracts, policies, render kernel, feature vocabulary
        ▲
@vesper/image-models (30) ─ peers ─ @vesper/image-replicate (30), @vesper/image-sd (30)
        ▲
apps/web                     (100) joins adapters to transport; owns DB, UI, jobs
```

- `image-models` may depend on `image-core` (and `contracts`); it must not
  import `image-replicate`, `image-sd`, or the app.
- `image-core` must not import `image-models` — model-specific prompt behavior
  reaches the render kernel through an injected hook, never an upward import.
- `scripts/check-workspace-imports.ts` gains the package at rank 30, runtime
  `universal`; `transpilePackages` and the Dockerfile manifest COPY gain it too.

## 3. What the new component owns

- **The composer**: `defineImageModel({ family, features, quirks })` producing an
  `ImageModelAdapter` — this is where "what Vesper wants to express" is joined
  to "how this family expresses it".
- **Feature modules** (`features/`): reusable semantic capabilities a model
  composes rather than reimplements. Built as needed, not exhaustively.
- **Model-family adapters** (`families/qwen/…` first): shared family behavior,
  per-endpoint differences (the LoRA wrapper is the older 2509-generation edit
  endpoint, not Edit 2511), prompt dialects, execution hints (startup/render
  budgets, startup-retry counts).
- **The adapter registry**: resolve an adapter from a registered model's base
  slug; absence of an adapter is a legal state meaning "no special behavior".

If this package disappeared, Vesper would forget how specific model families
differ — and that knowledge would leak back into shared code as slug checks.

## 4. What remains outside the component

**`@vesper/image-core` continues to own:** normalized contracts and controls,
the render kernel and pure planner, the LoRA library contract and the
compatibility/policy evaluator, execution-context and execution-policy types,
the reviewed-quality seam.

**`@vesper/image-replicate` continues to own:** payload building, schema
probing, uploads, the prediction lifecycle — now including two-phase
startup/render budget enforcement and startup-abort retry.

**The application continues to own:** the model registry and probe records, the
LoRA library rows, credentials (the Civitai token never enters a package), all
routes/jobs/UI, and the join between adapters and transport.

## 5. Existing system integration

```text
Generator / Lab / production lane
   │
   ▼
resolve profile + model (app)          ← adapter registry consulted here
   │
   ▼
resolve LoRA (execution context)       ← context replaces the fake task
   │
   ▼
planImageRender (image-core kernel)    ← adapter prompt hook injected
   │
   ▼
renderWithModel → @vesper/image-replicate   ← execution policy (bench lanes)
   │
   ▼
prediction, attempts recorded on the run row
```

Requires: **a new package** (`@vesper/image-models`). Does **not** require a
new route, database table, UI surface, provider, or job type. One new
normalized concept (execution context) and one new provider-neutral type
(execution policy) enter `image-core`.

## 6. Data and contract changes

- **`ImageExecutionContext`** — runtime-only, provider-neutral:
  `production(task)` | `generator_bench` | `image_lab(task)`. Owned by
  `image-core`; replaces the bare task at every LoRA-resolution call site.
- **LoRA compatibility vs production policy** — the `image_loras` row is
  unchanged on disk; the evaluator is restructured so mechanical compatibility
  (model, version, scale, bindings, locator) and production task policy
  (`allowedTasks`) are separate named checks, applied by context.
- **LoRA artifact sources** — `locator_type` gains `civitai_model_version`
  (the numeric model-version id; the resolver builds the download URL). The
  existing `https_url` and `huggingface_repo` rows are untouched; a `managed`
  source is documented headroom, not built. No migration: the column's enum is
  TypeScript-level.
- **`ProviderExecutionPolicy`** — runtime-only: startup budget, render budget,
  startup-retry count. Owned by `image-core`; enforced by `image-replicate`.
- **Provider attempts** — the run row's `meta` (jsonb) records each provider
  attempt (prediction id, outcome, queue/render timing); the `prediction_id`
  column keeps the final attempt. No migration.

## 7. Model / provider / implementation strategy

The Qwen image family is the reference implementation: shared family behavior,
`qwen-image-edit-2511`, `qwen-image-edit-plus-lora` (the LoRA-capable
2509-generation wrapper), and `qwen-image-2512` as the family's generator arm.
Other families (Flux, Wan, SDXL) stay on the legacy path and migrate when next
touched — the adapter registry treats "no adapter" as ordinary. Replicate stays
the only transport.

## 8. Starting configuration

Bench-lane execution policy (Generator and Image Lab), starting points:

| Setting               | Initial target |
| --------------------- | -------------- |
| Startup budget        | 8 minutes      |
| Render budget         | 3 minutes      |
| Startup-abort retries | 1              |

Production lanes deliberately receive no policy in this work (owner ruling
2026-08-24) and keep today's single five-minute budget. Tune the bench values
from observed queue behavior before considering production adoption.

## 9. State / identity / source-of-truth strategy

The probed capability record (registry row) remains the source of truth for
provider wire fields; adapters consume the resolved `ImageModel` and never
re-derive bindings. The LoRA library row remains the source of truth for
weights compatibility and curation. Prompts keep flowing from the existing
prompt pipeline; adapters only apply dialect at the model boundary.

## 10. Storage and association

N/A — no new persisted resources; provider attempts ride the existing run row's
`meta`, keyed by prediction id, and LoRA rows keep their existing identity.

## 11. Current limitations that must remain limitations

- One LoRA per render; one provider (Replicate); single-output renders.
- The Generator still refuses rather than trims (all-or-nothing references).
- The reviewed-quality seam keeps its current four-slug shape; adapters do not
  absorb it in this work.
- Managed (Vesper-hosted) LoRA weights remain unbuilt; the source union merely
  leaves room.

## 12. Specialized behavior

### Execution contexts

The LoRA evaluator takes a context, not a task. Mechanical checks run in every
context; `allowedTasks` applies in `production` and `image_lab` (the Lab
reproduces production), and is skipped in `generator_bench`. The Generator form
filters its LoRA picker by mechanical compatibility only, so it never offers a
pick that will refuse.

### The composer and feature modules

`defineImageModel` composes feature modules into an adapter; features carry the
semantic concept, adapters bind family behavior to it. The render path asks the
registry for an adapter and uses its prompt hook, validation, and execution
hints; everything else flows exactly as today.

### The final-wire LoRA invariant

In the compile step: if the plan records a LoRA as applied, the compiled
provider input must carry both bound fields, or the compile refuses pre-spend;
conversely a plan whose payload lacks the binding may not record the LoRA as
applied. A cross-stack test drives a library row through resolution, intent,
plan, and the provider payload builder and asserts `lora_weights`/`lora_scale`
land verbatim — no network.

### Two-phase prediction budgets

The transport sends the provider one deadline (startup + render) and enforces
the phases locally: a prediction still unstarted past the startup budget is
cancelled and — on bench lanes — retried once; a started prediction gets the
render budget from the moment it starts. Every attempt is recorded.

### LoRA artifact resolution

A stored source (Civitai model-version id, Hugging Face repo, direct URL)
resolves to the provider-consumable locator in one pure step; the app-side
credential seam completes Civitai downloads with the deployment token exactly
as today.

## 13. Failure and degradation behavior

- LoRA refusals keep their codes: mechanical failures refuse pre-spend as
  `image_lora.incompatible`/`unreachable_configuration`; a production-policy
  refusal keeps `image_lora.incompatible` with a message naming the task rule.
- A startup-aborted prediction that exhausted retries settles as a render
  failure whose message names the queue timeout — distinct from a model error —
  and the health classifier keeps reading it as transient.
- The wire invariant refuses at compile time (pre-spend), with a diagnostic
  naming the missing binding.
- A model with no adapter renders exactly as before — the registry returning
  nothing is the ordinary case, never an error.

## 14. Web UI integration

| Web feature          | Existing mechanism            | New behavior                                  |
| -------------------- | ----------------------------- | --------------------------------------------- |
| Generator LoRA pick  | form's LoRA select            | mechanical-compatibility filter, no dead picks |
| Generator run detail | run detail panel              | provider attempts (queue/render, retries)      |
| LoRA library form    | locator type + locator fields | Civitai model-version source option            |

No new UI surface; the Generator and the LoRA library remain the only screens
touched.

## 15. Normal production path

```text
owner opens /settings/image-generator
   │
   ▼
existing generator form (LoRA picker now honest)
   │
   ▼
existing run route + generator_image job
   │
   ▼
runner resolves model + adapter + LoRA (bench context)
   │
   ▼
planImageRender with adapter prompt hook — wire invariant enforced
   │
   ▼
renderWithModel + bench execution policy → Replicate (attempts recorded)
   │
   ▼
existing run row, result image, run detail
```

Production chat/scene lanes traverse the same seams with a `production`
context, no execution policy, and unchanged behavior.

## 16. Shared abstractions versus implementation-specific controls

Promoted into shared contracts: execution context, execution policy, the
feature vocabulary, the artifact-source union. Left model-specific: prompt
dialects, `go_fast`-style quirks, per-endpoint reference conventions, execution
hints. A probed provider field with no normalized meaning stays reachable
through the Generator's advanced inputs — it is not promoted until several
models share the concept.

## 17. Multi-entity / complex-case behavior

N/A — this work changes which requests are *expressible and honest*, not scene
composition; multi-character behavior is owned by the existing scene/lane plans.

## 18. Prompting / policy / rule interaction

The prompt pipeline (positive/negative authorship, fitting, budget) is
untouched. Adapters own only the model-boundary dialect step — the Qwen
numbered-reference identity locks move from `image-core`'s quality presets into
the Qwen family adapter, and the kernel/transport apply whatever hook the app
injects. Safety-checker policy and reviewed-quality pins stay where they are.

## 19. Development stages

### Stage 0 — Baseline

Status: complete — 2026-08-24.

The failing bench runs are the baseline: run 1 refused
(`image_lora.incompatible`, task gate), run 2 aborted unstarted after a
five-minute queue; provider history shows zero `lora_weights` ever sent.

### Stage 1 — Contracts and boundaries (image-core)

Status: built 2026-08-24 — awaiting CI.

Execution contexts, the compatibility/policy split in the evaluator, the
artifact-source union and pure resolver, the execution-policy type, the compile
wire invariant, and the kernel prompt hook (defaulting to legacy behavior).
**Production behavior changes:** none.

### Stage 2 — Transport lifecycle (image-replicate)

Status: built 2026-08-24 — awaiting CI.

Two-phase budgets, startup-abort retry, attempt records. Without a policy the
transport behaves exactly as today. **Production behavior changes:** none.

### Stage 3 — The composer and the Qwen family (image-models)

Status: built 2026-08-24 — awaiting CI.

Package scaffolding and registration, feature modules, `defineImageModel`, the
Qwen family adapters and dialect quirk, the adapter registry.
**Production behavior changes:** none (nothing consumes the package yet).

### Stage 4 — Application wiring

Status: built 2026-08-24 — awaiting CI.

Contexts at every LoRA call site; adapter hooks into kernel and
`renderWithModel`; Qwen dialect deleted from quality presets; bench execution
policy on Generator and Lab; attempts into run meta; Civitai source through the
credential seam. **Production behavior changes:** none intended — the
`production` context reproduces today's decisions.

### Stage 5 — UI

Status: built 2026-08-24 — awaiting CI.

Generator form filter, run-detail attempts, LoRA library Civitai source option.

### Stage 6 — Invariant coverage

Status: built 2026-08-24 — awaiting CI.

The cross-stack final-wire test plus the compile-invariant unit tests, per the
testing skill's one-owning-layer rule.

### Stage 7 — First production integration

Status: next — owner-triggered bench validation on the deployed app.

The owner's bench validation: the NSFW LoRA on the Qwen wrapper from the
Generator, rendered end to end on the deployed app — the run this plan exists
to make possible. Owner-triggered spend.

### Stage 8 — Complex cases

Status: N/A — multi-entity rendering is out of scope (§17); other model
families migrate under their own touches (§22).

### Stage 9 — Promotion decision

Status: queued.

Owner reviews the bench evidence and rules on production adoption of the
execution policy and on widening adapter coverage.

## 20. Evaluation criteria

| Dimension       | What is being evaluated                                          |
| --------------- | ---------------------------------------------------------------- |
| Correctness     | A recorded LoRA is provably in the sent payload                  |
| Reliability     | A queued cold start no longer consumes the whole budget          |
| Honesty         | Run records distinguish never-started from failed renders        |
| Maintainability | Qwen behavior lives in one adapter, not in slug checks           |
| Compatibility   | Production lanes byte-identical without a context/policy change  |

## 21. First proof before substantial implementation

The cross-stack invariant test is the cheapest disproof: if a resolved library
row cannot be driven to a payload carrying `lora_weights` without the network,
the abstraction is wrong before any UI or transport work lands on top of it.

## 22. Explicit non-goals

- Migrating Flux/Wan/SDXL/Seedream behavior into adapters now.
- Absorbing the reviewed-quality seam or the probe into adapters.
- Managed LoRA storage, weight caching, or sha256 verification columns.
- Restructuring the stored `image_loras` row or its admin CRUD shape.
- Production adoption of the execution policy or retries.
- A second provider, multi-LoRA, or any new route/table/UI surface.
- Nested restructuring of the parsed `ImageLora` contract type — the concept
  split lives in the evaluator; reshaping the type is cosmetic churn today.

## 23. Risks and open questions

| Question                                                        | Why it matters                            | Resolution                          |
| --------------------------------------------------------------- | ----------------------------------------- | ----------------------------------- |
| Why has production never sent `lora_weights` (dormant vs bug)?  | A defect would hide behind the bench fix  | Wire invariant test + Stage 7 run   |
| Do the stored extensionless locator URLs satisfy the wrapper?   | First real LoRA send could still fail     | Stage 7 bench run answers it live   |
| Are 8 min startup / 3 min render the right bench budgets?       | Too tight re-creates the abort; too loose wastes bench time | Tune from Stage 7 observations |

## 24. Definition of done

1. `@vesper/image-models` passes every workspace boundary gate at rank 30.
2. Every LoRA-resolution call site passes an execution context; no caller
   invents a task it does not have.
3. The Generator can run a mechanically compatible LoRA end to end, and its
   picker offers nothing that would refuse.
4. A compiled plan cannot claim a LoRA it did not place in the payload, and the
   cross-stack test proves the full path without network.
5. Bench predictions survive a cold-start queue up to the startup budget and
   retry once on a startup abort, with every attempt on the run record.
6. Qwen dialect behavior lives only in the Qwen adapter; the kernel and
   transport carry no model slug checks for it.
7. Production lanes pass a `production` context and no execution policy, and
   their behavior is unchanged.
8. A Civitai LoRA can be stored by model-version id and resolves to a working
   authenticated download.

## 25. Documentation requirements

- `@vesper/image-models` package README (composer, features, adapter registry).
- Reference-tier updates: `docs/` image system docs gain the execution-context
  and adapter facts once shipped; `docs/image-models/qwen-image-edit-plus-lora.md`
  stays the endpoint reference.
- The spec (`image-model-adapters.spec.md`) records every ruling this build
  settles; deferred follow-ups (family migration, managed weights, production
  policy adoption) recorded there, not silently dropped.
