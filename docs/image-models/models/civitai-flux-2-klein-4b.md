# Civitai FLUX.2 Klein 4B

**Slug:** `civitai/flux-2-klein-4b`

Civitai's hosted distilled Klein 4B lane has a native public v2 workflow API.
The `4b` catalog variant generates from a prompt or edits reference images with
a curated LoRA. Mature-content permission and payment currency are explicit
request policy for that variant.

## Owns / does not own

- **Owns:** this endpoint's operation, variant identity, input limits, mature
  policy, credentials, and evidence boundary, and the Civitai transport rules
  every Civitai lane shares — the payment policy and the execution and
  diagnostics sections below. [Qwen Image 2.1](civitai-qwen-image-2-1.md) owns
  only its own lane.
- **Does not own:** the [curated LoRA library](../../images/providers/loras.md),
  [catalog lifecycle](../../images/providers/registry.md), or
  [render/reference planning](../../images/providers/render-intents.md).

## Provider identity

- The stored version marker controls dispatch. `2612557` uses the legacy
  website graph and its text-to-image-only catalog contract; `4b` uses the
  native v2 workflow described below. A captured run retains its version and
  does not substitute one path for the other.
- The legacy graph does not carry Vesper's explicit mature/yellow payment policy
  or references, so it is not evidence of the mandatory combined capability.
- The workflow contains one `imageGen` step with `engine: "flux2"`,
  `model: "klein"`, and `modelVersion: "4b"`.
- `4b` selects the distilled variant. It is not an immutable checkpoint revision;
  neither the catalog marker nor render provenance claims a numeric checkpoint
  pin that this API cannot express.
- Other variants, including `4b-base` and the 9B family, do not inherit this
  lane's reviewed contract.
- The catalog row is an admin Image Generator bench target. The transport's
  capabilities do not activate a production portrait, variant, or scene profile.

## Reference and LoRA contract

- Zero references select `operation: "createImage"`; one or two select
  `operation: "editImage"` with the `images` list.
- Prepared references retain their media type and are sent as data URLs. Image
  bytes and authenticated locators do not belong in request previews or errors.
- **References must be JPEG.** This endpoint accepts a webp data URI everywhere
  it could refuse one — the upload ingests to a blob, the what-if preflight
  passes and echoes the reference count, the workflow schedules — and then the
  render job ends `failed` with `errors: []`, no jobs, no blocked flag and a full
  refund, indistinguishable from any other silent terminal failure. Measured
  2026-09-16: two concurrent workflows differing only in the encoding of one
  identical reference settled `succeeded` (jpeg) and `failed` (webp) under the
  same prompt, sampling and LoRA. Vesper's stored assets are webp, so
  preparation converts for this provider and refuses to fall back to unconverted
  bytes ([../../images/providers/transport.md](../../images/providers/transport.md)).
- More than two references or dedicated structural-control inputs are refused
  before a paid workflow is submitted.
- A compatible curated LoRA reaches the provider's `loras` map as an AIR resource
  and its selected strength. The map and reference images coexist in one step.
- Before any preflight, the LoRA's `GET https://civitai.com/api/v1/model-versions/{id}`
  metadata must report `model.type` `LORA` and `baseModel` `Flux.2 Klein 4B`;
  any other resource or family is refused before spend, naming what the
  metadata reports.
- A Civitai LoRA AIR identifies both its model and immutable model-version id;
  a bare download URL is not the workflow's LoRA input.
- The prompt is limited to 1,000 characters. The adapter does not import
  Replicate-specific controls merely because the two endpoints share a family.

## Generation settings

- The curated output aspects are `1:1`, `2:3`, and `3:2`; the transport sends
  explicit width and height rather than relying on a provider aspect default.
- One image is requested per invocation, encoded as JPEG. Prompt expansion is
  disabled. `sampleMethod: "euler"` and `schedule: "simple"` remain fixed.
- The exposed controls are seed, the curated LoRA/strength pair, and the three
  sampling controls below. Other raw controls are refused rather than silently
  accepted or discarded.

### Sampling controls

Klein 4B is a DISTILLED checkpoint: Black Forest Labs' reference usage for
`Flux2KleinPipeline` is `guidance_scale=1.0, num_inference_steps=4`. Those are
the defaults, and an operator overrides them per render.

| Control          | Provider field   | Default | Band               |
| ---------------- | ---------------- | ------- | ------------------ |
| `guidance`       | `cfgScale`       | 1       | 1–8                |
| `steps`          | `steps`          | 4       | 1–40               |
| `negativePrompt` | `negativePrompt` | unset   | ≤ 2,000 characters |

A value outside a band is refused rather than clamped. The bands are cost rails
as well: the provider prices off both knobs, and guidance above 1 runs a second
unconditional pass that doubles the bill. Measured at 832x1248 — 4 steps at
guidance 1 cost 2 Buzz, 8 steps 3, 20 steps 6, and 20 steps at guidance 5 cost 12.

Two rules that are not obvious from the wire format:

- **`negativePrompt` is the camelCase spelling.** The endpoint discards
  `negative_prompt` as silently as it discards an invented field name, so a
  snake_case binding renders without the operator's negative prompt while
  reporting success.
- **A negative prompt is refused at `cfgScale` 1.** With no unconditional branch
  there is nothing to steer away from: the same seed with and without one
  produced pixel-identical output while the provider echoed the field back both
  times. The adapter refuses the pair and names the fix rather than billing for
  a setting that does nothing.

The 2,000-character negative-prompt ceiling is Vesper's shared control contract
(`imageRenderControlsSchema`), not a provider bound — the endpoint accepted 4,000
characters unchanged.

## Mature-content and payment policy

- Both the free what-if request and the paid workflow explicitly send
  `allowMatureContent: true`, `currencies: ["yellow"]`, and
  `upgradeMode: "manual"`.
- Blue and green Buzz are SFW currencies. Yellow Buzz permits mature workflows,
  subject to the account, token, resource, and provider's content restrictions.
- An unspecified permission is not evidence of NSFW access. Vesper does not
  silently fall back to SFW settlement or rely on a post-generation payment
  upgrade to deliver this lane's result.
- The mature-content setting is fixed transport policy, not a generic
  `disable_safety_checker` control. It does not remove provider restrictions.
- The account needs sufficient yellow Buzz and a token authorized for the recipe,
  resources, and mature-content setting. Buying credits and changing account
  permissions are operator actions outside a model invocation.

## Execution and diagnostics

- `CIVITAI_API_TOKEN` authenticates requests to
  `https://orchestration.civitai.com/v2/consumer/workflows`.
- The preflight uses `whatif=true`; only a successful, validated preflight permits
  an actual submission. Both calls carry the same model, LoRA, references, and
  mature-content/payment policy. The preflight's echo is compared field by field —
  the prompt verbatim, references by count — and a difference in any compared
  field refuses the paid submit.
- A what-if response can be `unassigned`: no rendering has occurred. Its policy,
  model identity, payment evidence, and errors determine whether it admits a paid
  request; it need not claim a completed generation.
- Preflight and paid submission have distinct top-level `externalId` keys. A
  what-if does not persist and does not claim its key: two what-if requests
  sent under one fresh key returned two different workflow ids, and `GET
  /workflows/{id}` on either answered 404 (measured 2026-10-01). Reusing the
  preflight's key for the paid submission would therefore not retrieve an
  unexecuted estimate either way; whether reusing an EXISTING PAID workflow's
  key deduplicates a submission is unmeasured. The paid submission always
  mints its own fresh key regardless, so the distinction stays theoretical.
- Permission, payment, malformed-response, unavailable-resource, and blocked-output
  failures remain distinguishable. A generic readiness failure does not prove
  that a checkpoint and LoRA are incompatible.
- A submitted workflow is polled by its id. A successful status alone does not
  prove usable output: an image must be available, unblocked, and carry a blob
  id before download.
- **The prediction budget is spent mostly on QUEUE time, and abandoning the poll
  neither cancels nor refunds the workflow.** Buzz is debited at submit, and
  Vesper does not pay to leave the shared `low` priority pool, so a budget
  shorter than the queue discards an image the account was already charged for.
  Measured 2026-09-16: waits of 3-348 s for identical requests against renders of
  36-43 s, with one workflow succeeding at 390 s. The Image Generator therefore
  plans this lane at the profile ceiling (`MAX_TRIAL_PREDICTION_MS`, 900 s)
  rather than the five-minute default that suits compute-billed providers.
- A failed workflow is auto-refunded by the provider (a debit followed by a
  matching credit, `cost.total: 0`) and carries no diagnostic detail —
  `errors: []`, no jobs, no reason — so `civitai_async_unknown_terminal` is often
  as specific as the provider permits.
- Diagnostics expose only stable `civitai_http_*`, `civitai_async_*`, `civitai_transport_failure`, `civitai_malformed_response`, `civitai_submit_unconfirmed`, and `civitai_output_*` codes,
  plus a retry disposition. HTTP 429/5xx retries are bounded, exponentially
  backed off with jitter, and apply to idempotent metadata or workflow-status
  reads and, up to one retry, the what-if preflight; a paid submission is
  never repeated automatically — not by this transport, and not by the scene
  chain's own retry. Every failure that can surface once a workflow id
  exists declares a non-automatic disposition (`deliberate`, `never`, or
  `reconcile`, never `automatic`). The ones Civitai's own error vocabulary
  describes carry one on their own; a small set of plain identity/shape
  failures carry none natively — a workflow answering with a different id
  while polling, a shape a submitted or adopted record fails to parse, the
  mature/yellow retention check — so the transport appends one fixed
  sentence naming the workflow id and declaring `retry=reconcile` whenever a
  workflow id already exists and the failure does not already declare a
  disposition of its own; a failure that already declares one is left
  exactly as it is.
- The what-if preflight and the paid submission share a per-attempt timeout
  that SCALES with how many reference images are in the body being sent: 120 s
  base, plus 40 s per reference, capped at 480 s (`civitaiWorkflowPostTimeoutMs`
  in `civitai-runtime.ts`). Every other stage keeps a 30 s budget. The
  submission carries the same references the preflight already validated, in
  the same body shape, so whatever makes a preflight run long can equally make
  the submission run long.

  The automatic retry described next belongs to the PREFLIGHT alone; the
  submission still gets none, on this timeout or any other failure — an
  unreadable submission answer is handled by the read-only lookup described
  below instead, never by reposting. A transport failure (abort or timeout,
  network error, an unreadable response body) or an HTTP 429/5xx on the
  preflight is POSTed again automatically exactly once, with the identical
  preflight body and its `externalId`, after the same jittered backoff as a
  read retry, and under the SAME scaled budget as the attempt it repeats. Any
  other 4xx — including the 400 `resource_not_enabled` — a 200 OK whose body
  is not JSON, and a failure surfaced only after a 200 OK (insufficient Buzz,
  a failed or blocked workflow status, an echo refusal) are never retried; a
  non-2xx with an unparseable body (an HTML gateway page from a 502/503, say)
  is judged by status like any other response and is retried if that status
  is 429/5xx too. When the repeat fails the same transient way — another
  transport failure, or another 429/5xx — the render fails with its stable
  code, `retry=deliberate`, and a message saying the automatic retry already
  ran; a repeat that fails a different way (a plain 4xx, or a 409) reports
  that failure's own disposition instead.

  Measured 2026-10-01 against the hosted Qwen Image 2.1 lane (checkpoint
  version `3352534`, `model: "2.1"`, `editImage`, one synthetic 768x1024 jpeg
  reference), zero-Buzz what-ifs:

  | Probe                                                        | Latency     |
  | ------------------------------------------------------------ | ----------- |
  | short prompt, single                                         | 3.1 s       |
  | short prompt, 8 concurrent identical                         | 2.1 s each  |
  | real front-clothed view prompt (1,741 chars), first sighting | 13.0 s      |
  | same prompt again, 8 concurrent                              | 2.4 s each  |
  | all 8 real view prompts + a fresh nonce, concurrent          | 12.4 s each |
  | real front-bare prompt (2,567 chars), first sighting         | 2.9 s       |

  On Fly v284 (`a544edbe`) the same day, all 8 preflights of one
  reference-view batch failed at 30.4-30.9 s under a uniform 30 s budget,
  before any paid submit. The probes above do not reproduce the production
  latency, so the 120 s BASE is headroom over the measured range, not a
  tuned minimum.

  A separate 2026-10-01 probe measured latency against REFERENCE COUNT
  instead of prompt length or concurrency: zero-Buzz what-ifs sent the Qwen
  Image 2.1 lane's exact `editImage` body with 1 reference answered in
  18.8 s, and three references answered in 62.0 s, 67.0 s and 62.4 s — about
  20 s per reference, independent of bytes (a 275 KB body with downscaled
  320x427 references measured the same as a 929 KB one at the same reference
  count). Production has measured slower than local probes (the Fly v284
  failure above), so the per-reference allowance is twice that measured
  cost. The 480 s ceiling binds only at 10 references — Qwen 2.1's own
  maximum; Klein's own 2-reference cap never reaches it. See
  eval-images/civitai-qwen-2-1/whatif-669-reference-count-2026-10-01.txt.
- **A submission whose own answer is unreadable is looked up, never
  reposted.** Civitai may still have accepted and billed the workflow even
  though this process could not read the submission's own answer — a
  transport failure, any HTTP 5xx, or a 2xx body that is not JSON or does
  not parse into a usable workflow identity and status. The paid POST is
  never sent again to find out. Instead the workflow list is searched,
  read-only, for an item whose `externalId` ends with the submission's own
  key: `GET /v2/consumer/workflows?tags=vesper&fromDate=<the submission's
  own start time, minus a clock-skew margin of a few minutes>&take=100&hideMatureContent=false`
  (explicit, since the endpoint defaults it to `true`), following `next` as
  `cursor` up to a small page cap. Two rounds run — the first after a short
  settle delay, the second after a longer wait — because
  the provider may still be registering the workflow at the moment of the
  first read. A match is parsed and adopted as the submitted workflow, and
  the ordinary poll, terminal-status, and download path resumes on it
  unchanged. An HTTP 429 or any other 4xx on the submission already proves
  Civitai rejected it, so these fail exactly as before, with no lookup.
  Finding no match after every round, or being unable to read the list at
  all, both end the render in a stable `civitai_submit_unconfirmed` failure
  naming the original failure's code and the submission's own externalId —
  distinguishing "no workflow under this key was found" from "the lookup
  itself could not be read."
- **A list response this process cannot interpret counts as unreadable,
  never as a clean page with no match.** A body that is not an object, or
  whose `items` is not an array, makes the round that read it unreadable
  rather than an empty search. `next` absent, `null`, or `""` means the
  natural end of the list; a non-empty string means another page follows;
  any other type is unreadable too. Measured 2026-10-01, zero Buzz: the
  provider's own OpenAPI marks `next` required, but the LAST page omits the
  key entirely — an absent `next` is the ordinary, expected end of the
  list, never a malformed response.
- **No lookup can fence off a workflow that lands later.** A workflow absent
  from every lookup round can still be created under the same key
  afterward, so the unconfirmed failure always names the externalId: an
  operator checks the workflow list for that key before starting one
  deliberate replacement.
- **Every failure that can surface once a workflow id exists — from the
  submission's own answer, or from the lookup's adoption — declares a
  non-automatic disposition, so it is never retried automatically by this
  transport or by the scene chain's own same-rung retry.** A scene-chain
  rerun of that rung would be a second paid submission while the first,
  already billed, may still finish untracked. The ones Civitai's own error
  vocabulary describes carry one on their own (`deliberate`, `never`, or
  `reconcile`, never `automatic`); a handful of plain identity/shape
  failures — a workflow answering with a different id while polling, a
  shape a submitted or adopted record fails to parse, the mature/yellow
  retention check — carry none natively, so the transport appends one
  fixed sentence naming the workflow id and declaring `retry=reconcile`
  whenever a workflow id already exists and the failure does not already
  declare its own disposition; a failure that already declares one is left
  unchanged, never double-suffixed. This is why an exhausted
  workflow-status read reports `reconcile` rather than `automatic`, and why
  `civitai_submit_unconfirmed` is always `deliberate`.
  The character-chat selfie lane's own retry — which runs outside the scene
  chain's same-rung guard — honors this same rule and skips its retry on a
  non-automatic disposition, a content rejection excepted, since that is
  classified first. A scene chain FALLBACK to its next rung — a different,
  reduced-reference request to a different model — is unaffected and still
  runs; only a rerun of the SAME rung is ruled out.

  Measured 2026-10-01 against the live workflow list: a `GET` carrying
  `tags` and `fromDate` answered in 0.3-0.4 s and returned every persisted
  workflow under that tag since the given time, each with its full state
  (id, status, steps, transactions, `allowMatureContent`, `currencies`,
  `upgradeMode`) and an `externalId` stored as
  `"<civitaiUserId>-<the client value Vesper sent>"`. A what-if estimate
  never appeared in this list.
- A `civitai_http_400` whose RFC7807 `errors.messages[]` says a selected
  resource "is not enabled for generation" also carries
  `reason=resource_not_enabled`: the request was well formed, and Civitai will
  not run that LoRA or checkpoint version (its `canGenerate` flag is false). The
  provider's sentence, which names the resource, is not retained.
- A documented `steps[].jobs[].reason` or `blockedReason` determines the async
  classification when present. A terminal workflow with no documented reason
  reports `civitai_async_unknown_terminal` and requires one deliberate
  replacement decision.
- Diagnostics retain actionable provider facts without credentials, signed URLs,
  prompts, reference bytes, arbitrary provider prose, or RFC7807 values.
  RFC7807 diagnostics retain only sanitized validation field paths.
- The download requests the authenticated blob endpoint,
  `GET https://orchestration.civitai.com/v2/consumer/blobs/{id}`, with the
  bearer token — never the workflow's own signed `url`. That signed `url`
  redirects some mature outputs to a `blocked` path that answers `403` with or
  without the token, even though the blob itself is `available: true` with no
  `blockedReason` and the workflow carried explicit mature permission and
  yellow-only payment, and it stops answering within the hour; which blobs it
  blocks does not follow the reported `nsfwLevel`, so neither is a content
  signal, while the blob id stays valid. The blob endpoint answers `301` to a
  signed content path on the same host, fetched with no credentials — the
  bearer travels on the first request only, never on a hop the provider named.
  Each hop is revalidated under that same policy — credential-free HTTPS on a
  Civitai host — and a hop off the Civitai hosts, a credentialed one, or a
  chain longer than three redirects is refused as `civitai_output_invalid` and
  never requested. A different provider storage host requires explicit review;
  the OpenAPI's generic URI field is not an unrestricted network-download
  permission.
- **Each output-download ATTEMPT gets its own 120 s budget**, separate from
  the scaled preflight/submit budget above and from the 30 s every other GET
  uses, covering every redirect hop and the whole body stream. A transport
  failure or a retryable HTTP status (429/5xx) retries up to 4 attempts in
  total, with a short fixed backoff (2 s, 4 s, 8 s) between them; every
  retried attempt restarts at the authenticated blob endpoint from hop 0 —
  never from a prior attempt's redirect target, because the signed content
  path a redirect names expires (see above) and a stale one would just fail
  again. Every other output failure — an off-host or credentialed redirect, a
  chain past the bound, an oversized or empty body, or a non-retryable HTTP
  status (401/403/404/410 included) — keeps throwing on its first occurrence,
  unchanged. Measured 2026-10-01 at 22:48:59Z: a production `side_right/clothed`
  download failed `civitai_output_transport_failure` under the previous 30 s
  shared budget while Civitai showed the workflow had succeeded with its
  output available; three read-only downloads of other outputs right after
  took 1.9 s, 6.8 s and 11.2 s, almost all of it body streaming (164 KB in
  about 9 s) — well inside the new 120 s attempt budget.
- **Exhausting every download attempt reports the output as RECOVERABLE
  (`civitai_output_undelivered`) rather than losing it.** The workflow
  already succeeded and was already paid for, so the render fails with a
  message naming the attempt count, stating that the output can be
  recovered without rendering again. The blob id itself travels only as
  structured provenance on the lane result, never embedded in that message:
  it is provider-supplied and therefore untrusted, and an id that happened
  to spell a billing or moderation word would otherwise make the shared
  keyword classifier misread an ordinary download failure as one of those
  (review P3-5). The failure is always `retry=reconcile` and classifies as
  `other`, never `transient` and never a billing or content-rejection
  reading, so the SAME rung is never rerun and the character-chat selfie
  retry's own guard skips it entirely. A scene chain FALLBACK to its next
  rung — a different, reduced-reference request to a different model — is
  unaffected and still runs, exactly as for any other non-transient failure,
  and that fallback DOES render again; only a rerun of the identical rung is
  ruled out.
- **`recoverCivitaiOutput` recovers that output without rendering again.**
  Read-only end to end: one GET to re-read the workflow, then the same
  retried download above. It never POSTs, never creates a workflow, and
  never charges. It reports `permanent: true` ONLY on positive evidence the
  output can never be fetched this way — the workflow read answers 404; the
  workflow's status is not `succeeded`, or its id differs from the one
  asked for; the workflow does not list the blob, or lists it as
  unavailable, hidden, or blocked; or the download's own final failure is
  `civitai_output_invalid`, oversized, a 404, or a 410. Everything else —
  a transport failure, 429/5xx, 401/403, another `civitai_output_undelivered`,
  an empty body, or a workflow read that parsed as JSON but not into a usable
  workflow shape — is `permanent: false`, since a wrong "permanent" withdraws
  the one free recovery for good while a wrong "transient" only costs
  trying again later.
- **An output blob outlives Vesper's own 24 h failed-row retention, with no
  observed expiry.** A 2026-10-02 read-only probe (zero Buzz) found every
  output blob the account still lists serving through the blob endpoint,
  including the oldest, from 2026-09-16 (15.7 days old) — no workflow in the
  sample carried an expiry field. The 24 h failed-row retention
  (`FAILED_ROW_RETENTION_MS`, `apps/web/src/server/images/asset-maintenance.ts`)
  is therefore the binding recovery window, not the blob's own lifetime. A
  blob the provider has stopped serving is reported `available: false` by
  the workflow read itself, before any download is attempted. See
  eval-images/civitai-qwen-2-1/blob-lifetime-682-2026-10-02.txt.

## Evidence boundary

The [provider OpenAPI](https://orchestration.civitai.com/openapi/v2-consumers.json),
[FLUX.2 recipe](https://github.com/civitai/civitai-developer-docs/blob/main/orchestration/recipes/flux2.md),
and [workflow payment rules](https://github.com/civitai/civitai-developer-docs/blob/main/orchestration/guide/submitting-work.md)
document these capabilities. Schema support and request serialization do not
establish account entitlement, resource availability, identity preservation, or
image quality. Those claims require an authorized live run against the selected
variant, LoRA, and references and inspection of its delivered output.
