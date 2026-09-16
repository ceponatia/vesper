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
- More than two references or dedicated structural-control inputs are refused
  before a paid workflow is submitted.
- A compatible curated LoRA reaches the provider's `loras` map as an AIR resource
  and its selected strength. The map and reference images coexist in one step.
- A Civitai LoRA AIR identifies both its model and immutable model-version id;
  a bare download URL is not the workflow's LoRA input.
- The prompt is limited to 1,000 characters. The adapter does not import
  Replicate-specific controls merely because the two endpoints share a family.

## Fixed generation settings

- The curated output aspects are `1:1`, `2:3`, and `3:2`; the transport sends
  explicit width and height rather than relying on a provider aspect default.
- One image is requested per invocation, encoded as JPEG. Prompt expansion is
  disabled. Sampling uses `cfgScale: 5`, `steps: 20`, `sampleMethod: "euler"`,
  and `schedule: "simple"`.
- The exposed controls are seed and the curated LoRA/strength pair. Other raw
  controls are refused rather than silently accepted or discarded. The fixed
  sampling values state the selected wire contract, not a measured quality claim.

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
  prove usable output: an image must be available and unblocked before download.
- Diagnostics retain actionable provider facts without credentials, signed URLs,
  prompts, or reference bytes.
- Download policy requires credential-free HTTPS on Civitai hosts and refuses
  redirects. A different provider storage host requires explicit review; the
  OpenAPI's generic URI field is not an unrestricted network-download permission.

## Evidence boundary

The [provider OpenAPI](https://orchestration.civitai.com/openapi/v2-consumers.json),
[FLUX.2 recipe](https://github.com/civitai/civitai-developer-docs/blob/main/orchestration/recipes/flux2.md),
and [workflow payment rules](https://github.com/civitai/civitai-developer-docs/blob/main/orchestration/guide/submitting-work.md)
document these capabilities. Schema support and request serialization do not
establish account entitlement, resource availability, identity preservation, or
image quality. Those claims require an authorized live run against the selected
variant, LoRA, and references and inspection of its delivered output.
