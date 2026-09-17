# Civitai FLUX.2 Klein 4B

**Slug:** `civitai/flux-2-klein-4b`

Civitai's hosted distilled Klein 4B lane has a native public v2 workflow API.
The `4b` catalog variant generates from a prompt or edits reference images with
a curated LoRA. Mature-content permission and payment currency are explicit
request policy for that variant.

## Owns / does not own

- **Owns:** this endpoint's operation, variant identity, input limits, mature
  policy, credentials, and evidence boundary.
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

| Control | Provider field | Default | Band |
| --- | --- | --- | --- |
| `guidance` | `cfgScale` | 1 | 1–8 |
| `steps` | `steps` | 4 | 1–40 |
| `negativePrompt` | `negativePrompt` | unset | ≤ 2,000 characters |

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
  mature-content/payment policy.
- A what-if response can be `unassigned`: no rendering has occurred. Its policy,
  model identity, payment evidence, and errors determine whether it admits a paid
  request; it need not claim a completed generation.
- Preflight and paid submission have distinct top-level `externalId` keys.
  Reusing one key can return the preflight workflow instead of executing a render.
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
- Diagnostics expose only stable `civitai_http_*`, `civitai_async_*`, `civitai_transport_failure`, `civitai_malformed_response`, and `civitai_output_*` codes,
  plus a retry disposition. HTTP 429/5xx retries are bounded, exponentially
  backed off with jitter, and apply only to idempotent metadata or workflow-status reads; a paid submission and what-if
  POST are never repeated automatically.
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

## Evidence boundary

The [provider OpenAPI](https://orchestration.civitai.com/openapi/v2-consumers.json),
[FLUX.2 recipe](https://github.com/civitai/civitai-developer-docs/blob/main/orchestration/recipes/flux2.md),
and [workflow payment rules](https://github.com/civitai/civitai-developer-docs/blob/main/orchestration/guide/submitting-work.md)
document these capabilities. Schema support and request serialization do not
establish account entitlement, resource availability, identity preservation, or
image quality. Those claims require an authorized live run against the selected
variant, LoRA, and references and inspection of its delivered output.
