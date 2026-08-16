# Image lane consolidation — reference ownership and retirement

Status: companion to [image-lane-consolidation.plan.md](image-lane-consolidation.plan.md)

This spec owns final reference numbering, cast-integrity ownership, the verified
legacy-deletion procedure, and post-migration architectural tripwires.

## Implementation status

- Immediate dead-symbol verification/deletion: remaining.
- Final reference ownership: remaining.
- Superseded helper retirement: remaining.
- Architecture enforcement: remaining.

## Final reference ownership

The app declares references by semantic role and subject, for example identity,
place, style, pose, or object. It does not assign provider-visible image
numbers.

`@vesper/image-core` owns:

1. reference validation and fitting;
2. final send order;
3. provider slot/input mapping;
4. model-dialect reference labels;
5. cast-integrity instructions derived from distinct identity subjects that
   survive planning;
6. provenance for sent and dropped references.

A compiled prompt must never name a reference slot before the planner has fixed
the final send order.

The app-side `describeMultiReferences` behavior and duplicate “render each
person exactly once” clause are removed after parity. Cast integrity is emitted
once.

## Immediate deletion candidates

The audit identified these zero-consumer symbols:

- `intimateSceneAppearance`, superseded by `sceneRevealAppearance`;
- `speciesAppearancePhrase`, while live species label/morphology machinery
  remains.

Before deletion, repeat a full-tree search including packages, scripts, tests,
barrels, dynamic registries, and documentation. Delete:

- implementations;
- exports/barrel entries;
- tests that exist only to preserve the dead API;
- comments/docs that falsely describe the API as shared or live.

Do not delete `renderChatAffordanceCues` under this plan while preview,
evaluation, or pipeline callers remain. “Parked” is not “dead.”

## Post-cutover candidates

After all production consumers use the digest/segments, evaluate and delete
zero-consumer portions of:

- `prompts-appearance.ts`: character/identity/age/viewer/reveal prose helpers;
- `prompts-avatar.ts`: direct grouping and visible-outfit derivation;
- `prompts-scene-render.ts`: `assembleMulti` and duplicated appearance
  assembly;
- `prompts-format.ts`: image-specific attribute formatting and guard helpers;
- local exposure and wardrobe prose renderers;
- scene-local string budget helpers after profile budget acceptance;
- portrait identity-lock constants and exact-string rewrite;
- app-side reference numbering and cast-integrity text.

File deletion is determined after the import graph is clean. Do not delete a
whole module merely because its best-known exports migrated; retain legitimate
non-image or shared adapters in their canonical home.

## Deletion gate

A symbol or module may be deleted only when all are true:

1. no production import/caller;
2. no admin/dev/preview surface;
3. no retained evaluation/trial harness;
4. no dynamic registry or string lookup;
5. no barrel or package API consumer;
6. no persisted schema, replay format, or provenance parser;
7. replacement path has focused coverage;
8. characterization and relevant pinned trials pass;
9. typecheck and relevant unit/integration suites pass;
10. live documentation is updated in the same change.

Search results alone are insufficient when a dynamic or persisted dependency is
plausible. Conversely, once all gates hold, delete rather than deprecate.

## Compatibility fences

The consolidation must not change:

- `ProjectedFeatureTruth` names/shapes;
- appearance feature keys;
- canonical truth fingerprints;
- visual-memory row keys or notice/mention behavior;
- scene-state persistence or committed staging;
- identity-pack versions/source hashes;
- provider prediction/version provenance.

Golden tests pin the first five where the migration passes nearby.

## Architecture tripwires

After cutover, fail CI when:

- a production image prompt module directly imports attribute registry,
  realization, garment state, anatomy state, or raw profile attributes outside
  the one adapter allowlist;
- production code manually numbers reference images;
- duplicate cast-integrity literals appear outside the package compiler;
- the removed legacy symbol names are re-exported;
- a character-bearing production intent uses only an opaque prompt;
- app code imports package internals instead of declared
  `@vesper/image-core` subpath exports.

Tripwires should report the owning plan/spec and the approved extension point.

## Validation matrix

Static validation:

- full-tree symbol/import search;
- package export tests;
- dependency-boundary lint;
- workspace typecheck;
- image-core and web unit tests;
- relevant integration tests;
- documentation link/residue checks.

Behavior validation:

- one-reference identity edit;
- multi-person scene with reordered/dropped optional references;
- role mixture: identity + place + pose/style;
- a reference fitting refusal rather than stranger substitution;
- human/non-human/altered anatomy;
- wardrobe/exposure and embodied viewer;
- retake/branch restore;
- Qwen and one non-Qwen dialect.

Assert final prompt labels against final sent reference order, not the initial
request order.

## Rollback

Migration commits may retain the old code only while a lane is still actively
dual-read for comparison. No runtime feature flag may preserve the retired
appearance path after acceptance.

Rollback before acceptance reverts the lane to its previous builder. Rollback
after deletion uses version control; it must not be implemented as a permanent
second production path.
