# The LoRA library

**A LoRA is a curated library row, never a raw locator on a request.**

`image_loras` (contract `packages/image-core/src/loras/image-loras.ts`, admin CRUD under
`/api/admin/self/image-loras`, managed from a section of `/settings/image-models`) carries a
label, a locator — a Hugging Face `owner/repo` slug or a direct HTTPS weights URL, never a
credential — compatible model slugs and optional exact version ids, a curated scale range
(`minimumScale ≤ defaultScale ≤ maximumScale`), allowed tasks, optional trigger words and prompt
prefix/suffix, and an enabled flag.

## Resolution refuses, never clamps

A render names a LoRA only as `controls.lora = { id, scale? }`. Resolution loads the row and
refuses before any provider work when:

- the LoRA's own curation says no — `image_lora.incompatible`: wrong model, wrong version, wrong
  task, or a scale outside the curated range; or
- the configuration cannot reach the provider — `image_lora.unreachable_configuration`: row
  missing or disabled, the active version declaring no LoRA bindings, or a scale outside the
  provider's declared range.

A scale is refused, never clamped, which makes a band a **curation claim** rather than a slider's
convenience range. The two gates are independent, so widening a row's band never widens what
reaches the provider.

The built-in intimate-scene row ships at **0–2 around a default of 1**, inside the 0–4 both Qwen
wrappers declare: wide enough on purpose to reach the strengths the provider documents as the
strong ones, so a scale sweep can find the too-strong edge and not only the too-weak one. Seeded
rows are ordinary rows — an admin may retune any band, and the retuned value is the one every
later render is judged against.

## What reaches the payload

The resolved locator and scale land on the version's two declared fields. Prompt additions and
any trigger word not already present are woven into the compiled prompt, so the recorded final
prompt is the sent prompt. The record keeps `{ id, scale }` while the locator goes to the
provider payload and nowhere else, with URL query strings redacted from diagnostics.

**One LoRA per render** — that is what the tested binding supports. For Qwen's current wrappers,
prefer a Hugging Face repo slug (or a documented direct `.safetensors` URL) over
credential-bearing or expiring download URLs.

## Identity-LoRA bindings

A character LoRA additionally records which identity pack it was trained from.
`image_identity_lora_bindings` (contract
`packages/image-core/src/loras/identity-lora-bindings.ts`) points at an `image_identity_packs`
**revision** plus the `image_loras` row, and carries the training provenance: base checkpoint,
dataset fingerprint and image count, training recipe id and revision, LoRA rank, and trigger
token.

Supersession is what it exists to detect — weights trained from revision 3 keep rendering after
revision 4 becomes current, they just stop being a likeness — so `evaluateIdentityLoraBinding`
answers usable / `identity_pack_superseded` / `retired` against the character's current pack.

A pack may carry several bindings at once, because comparing two training configurations needs
that, and at most one may be `active`. Bindings are written by operator tooling, not by a route,
and no production render lane reads one.
