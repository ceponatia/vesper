# `@vesper/image-replicate` — the transport package — slice 4

Status: detail for [monorepo-image-core.plan.md](monorepo-image-core.plan.md) slice 4

Implementation state: not started — blocked on Slices 2 and 3.

Put Replicate's network transport and schema probing behind a server-only
workspace package while keeping secrets, deployment settings and Vesper state in
the application. Shared mechanics are in
[monorepo-image-core.spec.md](monorepo-image-core.spec.md); workspace import,
dependency ownership, package graph and package-local tooling rules are already
active from
[monorepo-image-core.spec.guardrails.md](monorepo-image-core.spec.guardrails.md).

## Runtime target

`@vesper/image-replicate` is deliberately a **Node/server transport package**.
Unlike `@vesper/image-core` and `@vesper/contracts`, it is not browser portable.
Network IO, timeouts, polling, Buffer/data conversion and other server transport
primitives are part of its job.

That does not permit application coupling: the package still owns no Vesper
state, no Next-specific framework dependency and no ambient environment reads.
Client-importable application layers are mechanically prohibited from importing
it.

## What moves

Two modules move after their environment reads are inverted:

| Module                             | Owns                             |
| ---------------------------------- | -------------------------------- |
| `src/server/ai/replicate.ts`       | Prediction/upload/poll/download  |
| `src/server/ai/replicate-probe.ts` | Model/version schema probing     |

By then `reservedImageInputFields` has already moved to `image-core` in Slice 2.
The transport package owns Replicate vocabulary and mechanics:

- prediction targets and version pins;
- request payload construction and provider-field overlay;
- file upload/delete lifecycle;
- data-URL conversion and byte budget;
- prediction creation, polling, cancellation and output download;
- provider output URL allow-listing;
- preprocessor execution;
- model/version OpenAPI probing and Replicate-specific capability derivation;
- Replicate response schemas and error normalization local to this transport;
- fixed request/output/probe timeout constants.

## What stays in the application

### Vesper image orchestration

`src/server/images/models.ts` stays. It still owns:

- registry DB reads;
- `sharp` crop normalization;
- Vesper's `RenderWithModelResult` application shape;
- the call that bridges a planned Vesper render into the configured Replicate
  transport.

All character/chat/identity/asset/job modules stay for the same reason.

### General AI-SDK error extraction

`src/server/ai/image-providers.ts` stays. It turns an AI-SDK error into a message
before calling provider-neutral failure classification from `image-core`. That
adapter knows the AI-SDK/OpenRouter-side error shape, not Replicate transport
mechanics.

### Environment resolution and configured runtime

A small application adapter stays in `src/server/ai`, for example
`replicate-runtime.ts`. It is the only code that reads Replicate environment
variables after this slice.

It owns:

- resolving the process environment into a validated `ReplicateConfig`;
- lazily memoizing one config/client pair for the lifetime of the running
  process;
- application convenience accessors such as `hasReplicate()` and the current
  `safetyCheckerDisabled` fact;
- handing the configured client to application/server and root-script callers.

Do not construct the snapshot eagerly at module import time. Next may load server
modules while building or analyzing routes, when runtime secrets are absent. The
first real runtime use resolves the environment and memoizes the result; later
calls in that process reuse it.

## Environment inversion

The first inventory counted four environment reads in `replicate.ts`. There is a
fifth relevant read in `replicate-probe.ts`: `probeReplicateModel` reads
`REPLICATE_API_TOKEN` independently. All five disappear from package source.

The application resolves:

- `REPLICATE_API_TOKEN`;
- `REPLICATE_SAFE_MODE`;
- `REPLICATE_PREDICTION_TIMEOUT_MS`.

The token read used by the probe is not a separate setting; probing uses the same
configured client as rendering.

### Config contract

`@vesper/image-replicate` owns the provider config type because it owns the code
that consumes it:

```ts
export interface ReplicateConfig {
  apiToken: string | null;
  safetyCheckerDisabled: boolean;
  predictionTimeoutMs: number;
}
```

Resolution rules stay behavior-compatible with today's transport:

- missing/blank token means the provider is unavailable;
- `REPLICATE_SAFE_MODE === "true"` means the safety checker remains enabled;
  every other value means `safetyCheckerDisabled: true`, preserving the current
  controlled-environment default;
- prediction timeout uses the configured number only when finite and at least
  30 seconds, clamps it at 30 minutes, and otherwise uses five minutes.

Per-request `timeoutMs` still overrides the config default and is clamped to the
same 30-second–30-minute range by the package.

### Configured client

Prefer one configured object rather than passing the token/config through every
private function:

```ts
export interface ReplicateClient {
  readonly configured: boolean;
  readonly safetyCheckerDisabled: boolean;

  runRegistryImageModel(
    model: ImageModel,
    request: RegistryModelRequest,
    sink?: DiagnosticSink,
  ): Promise<ReplicateImageResult>;

  runReplicatePreprocessor(
    request: ReplicatePreprocessorRequest,
  ): Promise<ReplicateImageResult>;

  probeReplicateModel(slug: string): Promise<ProbeResult>;
}

export function createReplicateClient(config: ReplicateConfig): ReplicateClient;
```

The exact method declarations may reuse existing exported request/result types;
the ownership rule is the important part. Every network helper closes over the
same immutable config.

Pure helpers that are useful without credentials — for example
`replicatePredictionTarget`, response-shape helpers worth testing directly, or
payload construction — may remain ordinary package exports if they are genuine
external entry points. Curate them explicitly at the package root; do not make
every private helper public or expose code subpaths.

## One safety value from plan to send

Slice 2 makes the render kernel accept `safetyCheckerDisabled` as an explicit
runtime fact. Slice 4 is where that fact becomes single-source.

For an ordinary render:

1. the application obtains its memoized Replicate runtime;
2. `renderImageIntent` passes `runtime.client.safetyCheckerDisabled` into
   `planImageRender`;
3. the plan/fingerprint resolves the effective model with that value;
4. `renderWithModel` invokes the **same configured client**;
5. payload construction uses the client's closed-over config when replacing a
   declared `disable_safety_checker` value.

No second environment read is allowed between steps 2 and 5. A process cannot
fingerprint one safety posture and send another because there is only one
resolved runtime snapshot.

Controlled trial/lab paths that compile and send separately must likewise carry
or obtain the same application runtime for the operation. Do not re-resolve env
inside the package to make a call site easier.

## The provider seam

Do not introduce a general plugin framework in this slice.

`image-core` already owns the provider-neutral decisions that should remain
provider-neutral: model/profile contracts, reference planning, control mapping,
prompt compilation, attempt/failure vocabulary and the final planned render
shape.

The application is the bridge:

```text
Vesper state
   -> resolved image intent/profile
   -> @vesper/image-core planning
   -> application render wrapper / crop + persistence context
   -> configured @vesper/image-replicate client
   -> Replicate
```

The dependency direction is:

```text
@vesper/image-replicate -> @vesper/image-core -> @vesper/contracts
@vesper/image-replicate ----------------------> @vesper/contracts (diagnostics)
application ------------> all three
```

The Slice 1 package graph checker treats that direction as policy, not merely a
diagram. `image-core -> image-replicate` fails even if it would not create a
cycle.

`image-core` does not need to declare an invocation interface solely for this
refactor; the plan/result types are the provider-neutral data seam. If a second
provider later needs a shared invocation interface, design it from both real
implementations.

## Server-only application boundary

Moving Replicate out of `src/server/**` removes the protection that path name
currently provides. The Slice 4 PR therefore updates application import
boundaries at the same time.

Add `@vesper/image-replicate` to prohibited imports for:

- `src/components/**/*.{ts,tsx}`;
- non-route `src/app/**/*.{ts,tsx}`;
- `src/contracts/**/*.{ts,tsx}`;
- `src/lib/**/*.{ts,tsx}`.

Server routes/modules and root operational scripts may use the configured
application adapter. Prefer that adapter over constructing a second config.

The workspace checker independently prevents client or server code from reaching
`packages/image-replicate/src/...` by filesystem path or a code subpath. Do not
add `server-only` or another Next-specific dependency inside the provider package;
repository boundaries should make the package reusable without Next.

## Consumer inventory

Do not inventory by the two source module names alone. `src/server/ai/index.ts`
currently re-exports their symbols, so many consumers import through `../ai` and
never spell `replicate.ts`.

Before the move, enumerate **every exported symbol** from `replicate.ts` and
`replicate-probe.ts`, then search each symbol. Classify each consumer as one of:

- package direct import of a genuine public type/helper;
- application use of the configured Replicate runtime/client;
- application convenience check such as `hasReplicate()`;
- stale/dead export to delete.

Known consumers that must be included in that inventory include:

- `src/server/images/models.ts` — registry model execution and control-reference
  types;
- `src/server/images/identity-pack-trial.ts` — request/output timeout constants;
- `src/server/images/image-lab.ts` — direct controlled render path/default model
  constants where still live;
- `src/server/images/image-lab-controls.ts` — preprocessors;
- `src/server/images/chat-look.ts` — provider-availability check;
- `src/server/images/character-scene.ts` — provider-availability check;
- `src/server/images/identity-trial-model-versions.ts` — probing/version work;
- admin image-model routes — model probing;
- `scripts/eval/scene-images/model.ts` — direct eval rendering;
- Replicate unit tests and probe tests.

Search again after deleting the old `src/server/ai` exports. The old barrel must
not continue re-exporting transport implementations under their former home.
It may export the tiny application runtime adapter because that adapter remains
application-owned.

## Package layout

A straightforward target:

```text
packages/image-replicate/
  package.json
  tsconfig.json
  src/
    index.ts
    client.ts
    config.ts               # types only; no process.env reads
    prediction.ts           # targets, polling, cancellation
    files.ts                # upload/delete/data URL
    outputs.ts              # output URL selection/download allow-list
    payload.ts              # provider payload + overlays
    preprocessor.ts
    probe.ts
```

Do not split mechanically to hit a line count. The layout is a suggested domain
separation; keep helpers together where the transport flow is easier to read.

The root export is explicit and curated per the hub spec. Private
polling/parsing helpers stay private. Root `export *` and public code subpaths are
not used.

## Dependencies and registration

Use the hub/guardrails registration checklist rather than a fixed count of config
files.

`packages/image-replicate/package.json` declares:

- `@vesper/image-core: workspace:*`;
- `@vesper/contracts: workspace:*` where diagnostics are imported directly;
- `zod` if package source actually imports it;
- every other third-party runtime dependency the transport imports;
- no Next, Drizzle, Sharp, Better Auth or Vesper application dependency.

The nearest-manifest dependency checker must reject an undeclared dependency even
if the root/web workspace also installs it.

Registration also requires:

- `packages/image-replicate/tsconfig.json` with a Node/server runtime target and
  no Next/app alias;
- root `pnpm typecheck` includes the package project;
- root Vitest discovers package tests without application-global setup;
- `next.config.ts` includes the package in `transpilePackages` where the server
  app consumes its TypeScript source;
- Dockerfile copies its manifest before workspace install;
- the real-workspace CI smoke check resolves `@vesper/image-replicate` through
  its manifest/exports;
- `lint:package-boundaries` accepts only the declared/allowed package graph edges.

Node's built-in `fetch`, `FormData`, `Blob`, `URL`, `AbortSignal` and `Buffer`
remain the transport primitives; do not add the Replicate npm SDK as part of this
refactor unless a separate decision replaces the existing HTTP transport.

Update package inventory/reference documentation in the Slice 4 implementation
PR.

## Tests

Move `replicate.test.ts` and `replicate-probe.test.ts` with their subjects, then
rewrite environment cases as config/client cases.

Required coverage includes:

- missing token -> configured client reports unavailable and calls fail before
  network work;
- safety true/false changes only models that declare the provider field;
- config prediction timeout fallback/clamping matches current behavior;
- per-request timeout overrides config without mutating it;
- official versus version-pinned prediction target behavior is unchanged;
- file and data-URL reference transport behavior is unchanged;
- upload cleanup still runs on success and failure;
- output host allow-list remains enforced;
- probe uses the configured token/client and never reads environment;
- model/version probe parsing and capability derivation stay unchanged;
- package source contains no `process.env`.

The package tests install/mock `fetch` at their own boundary in the package-scoped
Vitest project. They must not rely on `src/test/setup.ts` deleting the application
token. The package-local TypeScript project covers every transport source/test
file independently of Next.

## Verification

### Repository gates

- CI `verify` green for the Slice 4 PR.
- package-local typecheck and package-scoped tests are green;
- the real-workspace smoke check imports `@vesper/image-replicate` through its
  public package root;
- `lint:package-boundaries` accepts only declared, correctly directed package
  dependencies and rejects filesystem/deep-import alternatives;
- nearest-manifest checks prove every transport dependency belongs to the
  transport package;
- no source under `packages/image-replicate` imports `@/` or resolves into
  application/other-workspace implementation by relative path;
- `grep`/AST search finds no `process.env` in `packages/image-replicate`;
- client-importable app layers cannot import `@vesper/image-replicate`;
- package root exports are explicit rather than wildcard/deep subpaths.

### Consumer completeness

- exported-symbol inventory finds no live consumer of deleted
  `src/server/ai/replicate*` implementation exports;
- `scripts/eval/scene-images/model.ts` still runs through the configured runtime
  rather than constructing its own environment interpretation;
- `hasReplicate()` callers still behave the same through the application adapter.

### Live verification

This slice requires two deployed smoke checks because rendering and probing used
separate credential reads before the extraction:

1. **Real render:** generate an image on the Fly dev deploy and confirm the image
   saves normally with provider provenance.
2. **Real probe:** probe/save a known Replicate model from the admin model surface
   and confirm schema/version data returns normally.

A green unit/build suite is not enough for this slice. A config-wiring mistake can
typecheck while every real provider call is unauthenticated.

## Invariants

1. The package owns Replicate mechanics, not Vesper state.
2. The package performs network IO but owns no ambient environment reads.
3. The package remains Node/server-only without becoming Next-specific.
4. One immutable runtime config snapshot feeds compile and send for a process.
5. Probe and render share the same configured token/client.
6. Existing timeout, version pin, upload cleanup and output-host security behavior
   stays unchanged.
7. The application still owns cropping, persistence, jobs, authorization and
   registry database reads.
8. The provider package remains inaccessible to client-importable code and by
   filesystem/deep package imports.
9. All runtime dependencies are declared in the transport package's manifest.
10. No general provider-plugin framework is introduced in this extraction.
