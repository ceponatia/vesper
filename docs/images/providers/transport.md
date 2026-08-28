# Transport and send strictness

`@vesper/image-replicate` is the wire half: the model prediction endpoint
(`POST /models/{owner}/{name}/predictions`) with `Prefer: wait=60`, then poll — or
`POST /predictions` carrying a version id when the slug is pinned `owner/name:version`.

## Execution budgets

Production renders run under one budget. `REPLICATE_PREDICTION_TIMEOUT_MS` (clamped 30s–30m,
default 5m) drives both deadlines — Replicate's `Cancel-After` header and the client's own poll
cutoff — so raising it cannot leave the provider cancelling at a stale bound.

**`Cancel-After` starts when the prediction is created, so under a single budget provider queue
time consumes the same budget as execution time.** A five-minute budget can abort a prediction
that spent nearly all five minutes queued even when the model itself runs in seconds, so diagnose
queue time separately from model run time before treating such an abort as a model failure.

Bench lanes (Image Generator, Image Lab) instead pass a `ProviderExecutionPolicy` splitting that
budget into a startup phase (creation → first execution) and a render phase (execution start →
output). `Cancel-After` carries the sum, the phases are enforced client-side, and a prediction
that dies in the queue without ever executing — confirmed by re-reading its record after the
cancel — is recreated up to the policy's retry count, with every attempt reported to the caller. A
started prediction is never recreated, and an unconfirmable cancellation refuses the retry rather
than risk paying for two renders.

## Reference bytes

Reference and control bytes cross a **preparation pass** at the `renderWithModel` choke point
(`reference-preparation.ts`): EXIF orientation applied, metadata stripped, alpha flattened only
for non-alpha targets, encoded to a format the model accepts. An already-clean webp passes through
byte-identical after one metadata sniff, and a reference whose preparation fails degrades to its
original bytes with a diagnostic rather than failing the render. Prepared bytes carry their real
media type and extension to the wire.

Edit references are uploaded as **private Replicate files** — Vesper's images are not publicly
addressable and exceed the data-URL guidance — trimmed to the model's capacity by `fitReferences`
*before* the upload cost is paid, uploaded with **bounded concurrency of three**
(`transportReplicateReferences`: input-order URIs whatever the completion order, and on any single
failure every successful upload is deleted best-effort before the failure returns), and deleted
best-effort as soon as the prediction settles.

Outputs are downloaded only from `replicate.delivery` / `api.replicate.com` and land in the same
immutable pipeline as every other asset ([../asset-registry.md](../asset-registry.md)). Nothing
throws — a failure degrades to an error string the caller turns into a failed row.

## Send strictness is the caller's policy

`ImageRenderPolicy`. By default a render trims what will not fit, lets the provider judge the
values, and posts an empty prompt as an empty string — which is what every production lane and the
Image Lab's control probe want.

A caller may instead ask for:

- **`references: "require_all"`** — refuses **before a prediction is created** when capacity or the
  inline byte budget would leave a selected reference behind;
- **`providerInputs: "strict"`** — holds the finished payload against the version's probed
  descriptors (required presence unless the schema declares its own default, primitive type,
  integer-ness, enum membership, range) and fails closed on `uri`, `array` and `unknown` shapes no
  typed transport owns; and
- **`emptyPrompt: "omit"`** — drops the prompt key entirely for an empty prompt, so a version's own
  declared default applies.

Both refusals name what was wrong and create nothing, so the caller settles them as unspent rather
than as provider failures. The rules live in `packages/image-replicate/src/strict-request.ts`,
beside the payload builder they judge; the admin [Image
Generator](../../image-generator/README.md) is the only caller asking for them.

`disable_safety_checker` is only ever sent to models whose schema declares it — Replicate rejects
unknown inputs — and its value comes from `REPLICATE_SAFE_MODE`.

## The transport reads no environment

`apps/web/src/server/ai/replicate-runtime.ts` is the only code in Vesper that reads
`REPLICATE_API_TOKEN`, `REPLICATE_SAFE_MODE` and `REPLICATE_PREDICTION_TIMEOUT_MS`. It resolves
them on first use — lazily, because Next loads server modules while building routes, when secrets
are absent — and memoizes one configured client for the process. `hasReplicate()` and
`disableSafetyChecker()` are views onto that one snapshot, and rendering, preprocessing and probing
all run through it.

That is what keeps the safety posture single-source: the value a render's plan is fingerprinted
with is the same immutable value the payload builder writes, so a process cannot hash one posture
and send another.

## Failure classification is split across the boundary

The vocabulary and the rules — transient / content rejection / other, and what each says about
provider health — are provider-neutral and live in
`packages/image-core/src/provider-interface/failures.ts`, taking a plain message.
`apps/web/src/server/ai/image-providers.ts` is the four-line adapter that turns a *thrown* value
into that message, which is the one part that has to know the AI SDK: an upstream moderation
verdict arrives buried in `APICallError.responseBody`, not in `error.message`. A second image
transport reuses every rule by describing its own errors and calling the same functions.

**Billing failures are their own class.** `replicate 402: Insufficient credit` would otherwise
match the transient status-code pattern and earn a pointless retry, so classification checks
billing first and `isBillingFailure` names it.
