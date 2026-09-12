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
edit endpoints declare: wide enough on purpose to reach the strengths the provider documents as the
strong ones, so a scale sweep can find the too-strong edge and not only the too-weak one. Seeded
rows are ordinary rows — an admin may retune any band, and the retuned value is the one every
later render is judged against.

## What reaches the payload

The resolved locator and scale land on the version's two declared fields. Prompt additions and
any trigger word not already present are woven into the compiled prompt, so the recorded final
prompt is the sent prompt. The record keeps `{ id, scale }` while the locator goes to the
provider payload and nowhere else, with URL query strings redacted from diagnostics.

**One LoRA per render** — that is what the tested binding supports. For Qwen's current edit
endpoints, prefer a Hugging Face repo slug (or a documented direct `.safetensors` URL) over
credential-bearing or expiring download URLs.

### Scalar and array bindings

A version's two LoRA fields declare one of two shapes, both scoped to that one LoRA — never
several stacked at once:

- **scalar** — a `lora_weights` string field paired with a `lora_scale` number field. Every
  Qwen edit endpoint declares this shape, and it is the shape every row saved before the array
  shape existed still reads as: absent arity means scalar.
- **array** — a `lora_weights` field paired with a plural `lora_scales` field, both declared as
  lists. A FLUX.2 klein `-base-lora` endpoint declares this shape; the resolved locator and
  scale still describe exactly one LoRA, sent as the single element of a one-item list on each
  field (`lora_weights: [locator]`, `lora_scales: [scale]`) — never a second entry, and never an
  empty list.

Which shape a version uses is read from its schema by the probe
([registry.md](registry.md) §Probe-owned columns), never chosen by an adapter or a stored row.
A version whose two fields disagree on shape — an array `lora_weights` beside a scalar
`lora_scale`, say — is treated the same as a version missing one of the two fields: no LoRA can
be sent, and resolution refuses with `image_lora.unreachable_configuration` before any provider
work.

## RefControl depth row (klein 4B, pilot)

Migration `0137` seeds one curated `image_loras` row (`imglorklein4brefdepthaaa`) for
[`black-forest-labs/flux-2-klein-4b-base-lora`](../../image-models/models/flux-2-klein-4b-base-lora.md)'s
RefControl depth recipe, with these exact values: `label` "FLUX.2 klein 4B RefControl depth
(pilot)", `locatorType` `https_url`, `compatibleModelSlugs` naming that one endpoint slug,
`compatibleVersionIds` naming the fixture version its capability record was probed against,
`triggerWords: ["refcontrol"]` with no prompt prefix or suffix, and
`allowedTasks: []` — Generator-only, so the row runs mechanically in the bench while granting
itself no production or Image Lab eligibility until an operator curates a task for it. Its scale
band, 0.8–1.0 around a default of 0.9, is a pilot choice informed by the model card's recommended
weight range, not a provider-declared limit or a measured optimum.

`compatibleVersionIds` is non-empty here, unlike the intimate-scene row: everything known about
this recipe was read from that one fixture version's published schema, so a version move is a
re-curation an operator makes deliberately rather than something the seed pre-authorizes. The row
is an ordinary row like any other seeded one — an admin may retune its band, switch it off, or
delete it, and a deletion stays deleted, because the migrator applies each migration once per
database rather than re-asserting seeded values on every deploy.

**Provenance:** read from the Hugging Face API on 2026-09-12, repository
`thedeoxen/refcontrol-FLUX.2-klein-4B-reference-depth-lora`, revision
`0ae1ef7f9acc4e55ec2237360943c3c3032d3583`, base model `black-forest-labs/FLUX.2-klein-base-4B`,
licence `apache-2.0`. The published weights file is `flux2_klein_4b_refcontrol_depth.safetensors`,
92426784 bytes, sha256 `65ec4c71fa7538b2201481928609a5836773f0dc06a4041b2d28abd05826c401`. The model
card documents depth map first and identity reference second, the `refcontrol` trigger word, and a
recommended weight of 0.8–1.0; its "~50 steps, guidance ~4.0" describes the publisher's own
pipeline rather than this Replicate endpoint, which declares neither field, so neither is sent or
inferred. The card's sample pairs (`images/1d.png`…`5d.png` for depth, `images/1ref.png`…`5ref.png`
for reference) are Apache-2.0 fixtures an operator may use for a first run. The repository publishes
no `LICENSE` file: the Apache-2.0 grant is declared in the model card's front matter, so that
declaration — recorded here and beside the re-hosted artifact — is the notice that travels with the
copy, and there is no separate notice file to carry.

**The locator is a re-hosted copy, not the publisher's URL.** The endpoint's `lora_weights` field
takes a list of URLs, so the Hugging Face repository is a source reference rather than something to
send: Vesper's `huggingface_repo` resolver passes a slug through unchanged, and a slug is not an
address this provider can fetch. Following the re-hosting pattern the Sabrina LoRA established, the
row's `locator` is
`https://snarebox-pub.s3.us-east-2.amazonaws.com/lora/flux2_klein_4b_refcontrol_depth-65ec4c71.safetensors`
— the published filename plus the checksum's first eight hex characters, in `s3://snarebox-pub/lora/`
in `us-east-2`. It carries no credential, no query string and no expiry: nothing is appended to it at
send time, which is what keeps this table free of the token the Civitai row needs.

**Verified 2026-09-12**, before the URL was written anywhere: the artifact was downloaded at the
pinned revision above, and its byte size and `sha256sum` both matched the published values before
upload. The object then served over HTTPS answers 200 at that size, and an unauthenticated fetch of
it hashes to the same checksum — so the bytes a provider retrieves are the bytes that were checked.
No placeholder or guessed URL is ever written to that field.

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
