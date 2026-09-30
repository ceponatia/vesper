# Civitai Qwen Image 2.1

**Slug:** `civitai/qwen-image-2.1`

**Provenance:** probed 2026-09-30 against hosted checkpoint version `3352534` — the
row's identity; the workflow itself pins no checkpoint (§Provider identity).

Civitai hosts Qwen Image 2.1 — a 7B single-stream DiT with a Qwen3-VL text
encoder — on its Orchestration v2 comfy lane. One checkpoint generates from a
prompt or edits from one to ten references, and a curated Qwen 2.1 LoRA travels
in the same request as those references. Mature-content permission and payment
currency are explicit request policy.

## Owns / does not own

- **Owns:** this lane's identity, operations, controls and bands, sizing, LoRA
  family rule, pricing, and evidence boundary.
- **Does not own:** the Civitai transport every lane shares — payment policy,
  what-if preflight, polling, output download and diagnostic codes — which
  [civitai-flux-2-klein-4b.md](civitai-flux-2-klein-4b.md) owns; the
  [curated LoRA library](../../images/providers/loras.md);
  [catalog lifecycle](../../images/providers/registry.md); or
  [reference preparation](../../images/providers/transport.md).

## Provider identity

- The workflow's one `imageGen` step sends `engine: "comfy"`,
  `ecosystem: "qwen"`, and `model: "2.1"`. This is not the Qwen-Image 20B
  `sdcpp` lane (`model: "20b"` with a `version`) and not Klein's `flux2`
  engine: it has no `version`, `modelVersion`, `sampleMethod`, `schedule`,
  `enablePromptExpansion`, or control-net field.
- The hosted checkpoint is Civitai model 2954443, version 3352534
  (`urn:air:qwen21:diffusionmodel:civitai:2954443@3352534`). The workflow omits
  `diffusionModel`, as Civitai's own generator does for the hosted default. The
  row stores `3352534` as its `probed_version_id`, the identity that provenance
  and a LoRA row's `compatibleVersionIds` name.
- The preflight echo reports the lane, not a checkpoint, so a render records no
  executed version. A row whose stored version is not `3352534` has no transport
  lane and is refused before any provider call.
- Owner ruling 2026-09-30: the row is an admin Image Generator bench target
  only. It has no profile and no production surface flag.
- The weights are published under the Qwen Research License, which is
  non-commercial without a separate agreement.

## Reference and LoRA contract

- Zero references send `operation: "createImage"`; one to ten send
  `operation: "editImage"` with the `images` list. More than ten are refused
  before a preflight; the provider itself rejects an eleventh.
- References are JPEG data URLs: preparation converts every Civitai reference
  to JPEG
  ([../../images/providers/transport.md §Reference bytes](../../images/providers/transport.md)).
- Owner ruling 2026-09-30: a LoRA comes only from a curated library row that
  lists this slug. There is no raw AIR entry.
- Before any preflight, the transport reads
  `GET https://civitai.com/api/v1/model-versions/{id}` for the selected LoRA
  and requires `model.type` `LORA` and `baseModel` `Qwen 2.1`. It then sends
  `urn:air:qwen21:lora:civitai:<modelId>@<versionId>` with the selected strength
  in the workflow's `loras` map.
- A LoRA of any other family is refused before spend, and the refusal names the
  family the metadata reports. The Qwen-Image 20B family reports `baseModel`
  `Qwen` and uses `urn:air:qwen:lora:…` identifiers.
- **The provider does not enforce the family.** The orchestrator accepted and
  priced a 20B LoRA on this lane, so the metadata gate is the only check that
  keeps a mis-curated row from rendering foreign weights.
- One LoRA per render, strength 0–4, inside the library row's curated band.

## Generation settings

The Generator labels each control with the provider field it writes (owner
ruling 2026-09-30). A blank control sends the official Qwen Image 2.1 recipe
(owner ruling 2026-09-30): the diffusers `QwenImage21Pipeline` samples 40 steps
at a true CFG of 1 with flow-matching Euler, which is Comfy's `euler` on the
`simple` scheduler. The provider's own step default is 25, so Vesper resolves a
blank control itself rather than deferring to it.

| Control              | Provider field                   | Blank sends | Band                 |
| -------------------- | -------------------------------- | ----------- | -------------------- |
| `guidance`           | `cfgScale`                       | 1           | 0–30                 |
| `steps`              | `steps`                          | 40          | 1–60                 |
| Advanced `sampler`   | `sampler`                        | `euler`     | Comfy's 31 samplers  |
| Advanced `scheduler` | `scheduler`                      | `simple`    | Comfy's 7 schedulers |
| `resolution` tier    | `width`/`height` or `resolution` | `1K`        | `1K`, `2K`           |
| `negativePrompt`     | `negativePrompt`                 | unset       | ≤ 2,000 characters   |
| `seed`               | `seed`                           | unset       | safe integer         |

- A value outside its band, a sampler or scheduler outside Comfy's enums, and
  any other control key are refused, never clamped or dropped.
- `steps` stops at 60 although the provider accepts 150: cost is linear in
  steps, and 60 leaves headroom above the official 40.
- **A negative prompt is refused at `cfgScale` 1 or below.** Qwen Image 2.1
  applies it only under true CFG — the official pipeline ignores
  `negative_prompt` unless the scale exceeds 1 — so the pair would bill for a
  setting that does nothing. The refusal names the fix.
- The 2,000-character negative-prompt ceiling is Vesper's shared control
  contract; the provider accepts 10,000. The prompt is limited to 10,000
  characters.
- Each request asks for one image (`quantity: 1`) encoded as JPEG
  (`outputFormat: "jpeg"`). Neither is a control.

### Sizing

A create sends explicit `width` and `height` for the aspect and tier, each a
multiple of 32 and at most 2048:

| Aspect | 1K        | 2K        |
| ------ | --------- | --------- |
| `1:1`  | 1024×1024 | 2048×2048 |
| `4:3`  | 1024×768  | 2048×1536 |
| `3:4`  | 768×1024  | 1536×2048 |
| `3:2`  | 1216×832  | 2048×1344 |
| `2:3`  | 832×1216  | 1344×2048 |
| `16:9` | 1024×576  | 2048×1152 |
| `9:16` | 576×1024  | 1152×2048 |

- An edit sends the tier as `resolution` — an output pixel budget of 1024 (1K)
  or 2048 (2K) — and no size: the provider derives an edit's `width` and
  `height` from the reference and ignores an explicit pair, so the output keeps
  the reference's aspect.
- An edit with a chosen output shape is refused before any preflight. The shape
  could be neither sent nor applied, so running it would record a shape the
  output does not have; clear the shape or remove the references.
- The checkpoint's native non-square 2K sizes exceed Civitai's 2048 cap; the 2K
  column is the largest 32-aligned fit of each ratio.
- The 2048 cap bounds create inputs, not edit outputs: an edit at the 2K tier
  from an 832×1216 reference was echoed at 1696×2464 at the provenance probe,
  priced at the same four-megapixel factor as a 2048×2048 create.

## Cost

Yellow Buzz = base × pixels × (steps ÷ 25) × cfg × images × quantity, where the
base is 8 to create and 10 to edit, pixels is the output area ÷ 1024², the cfg
factor is 2 whenever `cfgScale` exceeds 1, and the images factor is 1, 1.68 and
5.32 for one, three and ten references. The provenance probe priced:

- create at 1024×1024: 8 at 25 steps, 13 at 40, and 26 at 40 steps with
  `cfgScale` 2.5; 52 at 2048×2048 and 40 steps;
- edit with one reference at 40 steps: 4 at `resolution` 512, 16 at 1024, and
  77 at 2048; three references at 1024 cost 27.

## Mature-content and payment policy

The what-if preflight and the paid submit both carry the fixed Civitai workflow
policy — `allowMatureContent: true`, `currencies: ["yellow"]`,
`upgradeMode: "manual"` — owned by
[civitai-flux-2-klein-4b.md §Mature-content and payment policy](civitai-flux-2-klein-4b.md).
Every preflight at the provenance probe settled `accountType: "yellow"` with
`insufficientBuzz: false`.

## Execution and diagnostics

- The shared transport rules — zero-Buzz preflight before every paid submit,
  distinct external ids, polling, blob download, redaction, and retry
  dispositions — are in
  [civitai-flux-2-klein-4b.md §Execution and diagnostics](civitai-flux-2-klein-4b.md).
  The Image Generator plans every Civitai lane at the 900-second queue-time
  ceiling that page explains.
- The preflight echo must return, field by field, `engine`, `ecosystem`,
  `model`, `operation`, `quantity`, `cfgScale`, `steps`, `sampler`, `scheduler`,
  and `outputFormat`, plus `width` and `height` on a create or `resolution` on an
  edit. It must also return the seed when one was set, the negative prompt by
  presence and value, the same number of `images`, and the `loras` map key for
  key with each strength. Any difference refuses before the paid submit, which
  is how one request is shown to carry both the LoRA and the references.
- A model version Civitai has not enabled for generation — `canGenerate: false`
  on `GET https://civitai.com/api/v1/model-versions/mini/{id}` — fails the
  preflight with HTTP 400. Vesper reports `civitai_http_400` with
  `reason=resource_not_enabled`, retains none of the provider's sentence, and
  submits nothing. One free what-if or the `canGenerate` flag rechecks it.
- **Coverage at the provenance probe:** Civitai had enabled generation for none
  of 80 sampled Qwen 2.1 LoRAs (newest, highest-rated and most-downloaded,
  mature included) and for no community 2.1 checkpoint pin; each was refused as
  not enabled for generation. The hosted default passes the preflight because
  the workflow pins no checkpoint.

## Evidence boundary

The [provider OpenAPI](https://orchestration.civitai.com/openapi/v2-consumers.json)
(`ComfyQwen21ImageGenInput` and its create and edit variants, `ComfySampler`,
`ComfyScheduler`), the
[workflow payment rules](https://github.com/civitai/civitai-developer-docs/blob/main/orchestration/guide/submitting-work.md),
the [model card](https://huggingface.co/Qwen/Qwen-Image-2.1), and zero-Buzz
what-if preflights establish the fields above, their echo, pricing, and yellow
settlement. A what-if renders nothing. Account entitlement for a paid mature
render, output quality, identity preservation, and the combined curated-LoRA and
reference result each require an authorized paid run on this lane and
inspection of its output; the combined result also needs a generation-enabled
Qwen 2.1 LoRA.
