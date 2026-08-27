# @vesper/image-replicate

The Replicate transport. Everything here is about talking to
`api.replicate.com`; nothing here knows that Vesper has characters, chats, a
database, or a Next.js application.

How the application drives it: [docs/images/providers.md](../../docs/images/providers.md).

## Server-only, and configured from outside

This package is deliberately **not** browser portable — unlike `@vesper/contracts`
and `@vesper/image-core`, network IO, byte handling and timeouts are its job. It
is ranked `server` in the workspace layer policy, and ESLint additionally bars
`apps/web/src/components`, non-route `apps/web/src/app`, `apps/web/src/contracts` and
`apps/web/src/lib` from
importing it: it carries the provider credential.

Server-only is not permission to be ambient. The package **reads no
environment**. The application resolves the deployment's settings once
(`apps/web/src/server/ai/replicate-runtime.ts` — the only code in Vesper that reads
`REPLICATE_*`), builds one client, and hands that client to every render,
preprocessor run and schema probe in the process:

```ts
const client = createReplicateClient({
  apiToken,
  safetyCheckerDisabled,
  predictionTimeoutMs,
});
```

That single snapshot is what keeps the safety posture single-source. A render's
plan is fingerprinted with `client.safetyCheckerDisabled` and the payload builder
writes the same value, so a process cannot hash one posture and send another.
Probing shares the client too — it used to read the token independently.

## Prediction budgets: one, or two phases

By default a prediction gets one budget (`predictionTimeoutMs`) covering both
the time it waits in Replicate's queue and the time the model spends rendering.
That is what every production lane uses, and it is unchanged.

A caller may instead pass a `ProviderExecutionPolicy` (from
`@vesper/image-core`) on the render request, which splits the budget in two:

- the provider is sent one `Cancel-After` covering `startupBudgetMs +
  renderBudgetMs`, because Replicate has no notion of the split;
- locally, a prediction that has not begun executing is held to the startup
  budget, and one that has begun gets the render budget from the moment
  execution was first observed;
- a prediction that dies before it ever executes — this client's startup cutoff,
  or the provider abandoning a queued prediction — is recreated up to
  `maxStartupRetries` times. A prediction that ran and failed is never retried;
- the result then carries `attempts`, one record per created prediction
  (`predictionId`, outcome, queue and render durations). `predictionId` and
  `executedVersionId` keep describing the final attempt.

"Never started" is judged from the prediction record, not from wall-clock
guesses, and **not** from `started_at`: Replicate stamps that field even on a
prediction it abandons. Evidence of execution means `metrics.predict_time`, log
output, or a status that means "executing right now".

## Layout

Read in this order — the flow runs top to bottom.

| Module            | Owns                                                        |
| ----------------- | ------------------------------------------------------------ |
| `config.ts`       | `ReplicateConfig`, fixed budgets, per-request timeout clamp |
| `http.ts`         | The credentialed fetch surface; error text                  |
| `payload.ts`      | The render request, provider input, control overlay         |
| `files.ts`        | Reference upload/delete, data URLs, the inline byte budget  |
| `prediction.ts`   | Prediction targets, create, poll, cancel, budgets, attempts |
| `outputs.ts`      | Which member is the image; the output-host allow-list       |
| `render.ts`       | `runRegistryImageModel` — the registry render entry point   |
| `preprocessor.ts` | One image-in, image-out lab tool run                        |
| `probe.ts`        | Reading a model/version's published input schema            |
| `client.ts`       | `createReplicateClient` — binds the config to all of it     |

The package has one public code import path, `@vesper/image-replicate`, and the
root `src/index.ts` lists every public name explicitly. Private polling and
parsing helpers stay private; `export *` in a root barrel is rejected by
`pnpm lint:package-boundaries`.

## What stays in the application

- resolving `REPLICATE_API_TOKEN`, `REPLICATE_SAFE_MODE` and
  `REPLICATE_PREDICTION_TIMEOUT_MS`, and memoizing one configured client;
- translating Vesper state into a render request, and `sharp` crop
  normalization (`apps/web/src/server/images/models.ts`);
- registry database reads, asset persistence, jobs, authorization, cost;
- AI-SDK/OpenRouter error extraction (`apps/web/src/server/ai/image-providers.ts`), which
  knows a different provider's error shape, not Replicate transport mechanics.

## Working in here

- No build artifact: the package exports TypeScript source and is consumed as a
  workspace dependency; Next transpiles it for the server bundle.
- Tests run through this package's own `vitest.config.ts`, with no application
  setup and no `@/` alias; root `pnpm test` reaches them by recursing over the
  workspace. They install their own `fetch` stub and construct a
  `ReplicateConfig` per case — there is no environment to manipulate.
- Dependencies this package imports belong in **its** `package.json`, including
  test-only ones.
- Node's built-in `fetch`, `FormData`, `Blob`, `URL`, `AbortSignal` and `Buffer`
  are the transport primitives. The Replicate npm SDK is deliberately not a
  dependency.
- Validation follows the repository milestone-gate policy: code work is proven by
  a ready-state CI `verify`. A green build is not sufficient for provider
  wiring — a config mistake typechecks perfectly while every real call is
  unauthenticated, so this package's changes also get a real render and a real
  probe against the deploy.
