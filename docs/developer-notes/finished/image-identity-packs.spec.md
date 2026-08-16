# Image identity packs — technical spec

Status: companion to [image-identity-packs.plan.md](image-identity-packs.plan.md)

This hub indexes the technical contract for durable identity references. The
system compiles a character's current canonical portrait into a versioned,
authorized pack containing the source portrait, a hidden face-detail crop,
derivation provenance, quality measurements, and profile-aware eligibility.

## Reading order

1. [Data and persistence](image-identity-packs.spec.data.md) — pure contracts,
   status vocabulary, pack revisions, database ownership, hidden image assets,
   source hashing, and state transitions.
2. [Derivation and quality](image-identity-packs.spec.derivation.md) —
   `ensureIdentityPack`, concurrency, detector interpretation, deterministic crop
   geometry, quality measurements, versioned policy, manual correction, and
   retry behavior.
3. [Lifecycle and authorization](image-identity-packs.spec.lifecycle.md) — creation
   triggers, lazy backfill, staleness, copy/publish isolation, deletion, cleanup,
   privacy, routes, and admin operations.
4. [Render integration](image-identity-packs.spec.integration.md) — reference
   roles, profile capacity, shared render intent, provenance, rollout, and
   consumer tests.
5. [Trial and promotion](image-identity-packs.spec.trial.md) — fixed comparison
   cells, corpus, blinded review, threshold calibration, and profile/version
   verdicts.

## Sibling ownership

- [image-model-capabilities.spec.md](image-model-capabilities.spec.md) owns
  provider-neutral render intent, profile eligibility, role-aware reference
  selection, capacity, and transport.
- [image-render-quality.spec.md](../image-render-quality.spec.md) owns prompt dialects,
  profile quality settings, identity fidelity verdicts, repair, and output QA.
- [docs/images/asset-registry.md](../../images/asset-registry.md) owns the existing
  row-before-file image pipeline, normalized WebP storage, and resilient reads;
  Gallery behavior is [docs/images/pipelines.md](../../images/pipelines.md).
- [data-lifecycle.plan.md](../data-lifecycle.plan.md) owns broad image retention. The
  identity-pack lifecycle spec adds the narrower rule that hidden derived crops
  are operational character data rather than permanent Gallery artifacts.

## Contract summary

V1 has one current identity-pack revision per character and one current canonical
source portrait. The pack exposes two semantic reference roles:

```text
canonical_identity
face_detail
```

The current source portrait remains the identity authority. The face crop is a
persistent hidden derivative, not an independent identity and not a replacement
for the authored character appearance.

Automatic derivation may use a reviewed local detector or a labelled conservative
heuristic. It never chooses between several plausible people. A user or admin may
save a manual crop as a new revision; historical revisions are not overwritten.

The pack stores source hash, crop geometry, method/version/confidence, intrinsic
quality measurements, warning/failure codes, and review provenance. V1 does not
persist face-recognition embeddings or guessed demographic/identity labels.

A profile-aware evaluation occurs before provider spend. The same pack may be
eligible for one model profile and too small or otherwise unsuitable for another.
The capabilities layer chooses whether a profile sends the canonical source, face
detail, or both, and proves that all required character identities fit its
reference cap.

Copied or published characters derive destination-owned packs and crops. Hidden
pack assets never cross an owner boundary. Character deletion removes pack records
and hidden crops while the canonical source continues to follow the broader
Gallery-retention policy.

## Implementation sequence

The matching plan delivers the system in seven slices:

1. contracts, persistence, and hidden asset kind;
2. deterministic derivation and local detector adapter;
3. lifecycle, concurrency, and lazy backfill;
4. user/admin manual review and correction;
5. shared render-intent reference integration;
6. fixed identity-reference trials;
7. production gates, provenance, telemetry, and fallback removal.

[The plan](image-identity-packs.plan.md) owns which of those have shipped. Two
facts frame everything below: migrations 0101 (packs) and 0102–0103 (trial) are
applied, and **every identity-critical render lane consumes the pack
unconditionally** — the `IMAGE_IDENTITY_PACK_REFERENCES` rollout flag and the
legacy direct-avatar reads were removed in the slice-7 close-out (2026-08-13),
so the integration spec describes the contract production runs on.

## Completion boundary

The identity-pack system is complete when every identity-critical image consumer
obtains traceable, current, authorized references through this contract and no
lane performs its own persistent face recropping.

Structured visual state, generated-output similarity QA, regional face repair,
multi-angle identity sets, LoRAs/embeddings, and pose/depth/mask controls remain
separate systems even when they consume identity packs.
