# Image lane consolidation — prompt and lane migration

Status: companion to [image-lane-consolidation.plan.md](image-lane-consolidation.plan.md)

This spec owns the migration of character-bearing image routes from
independently formatted appearance strings to `ImagePromptSegment[]`. The
image-render-quality plan remains canonical for segment fitting, prompt
dialects, negatives, and measured model budgets.

## Implementation status

- Stage 1 characterization: remaining.
- Avatar and single-character migration: remaining.
- Remaining character-bearing lanes: remaining.
- Unified scene segment builder: remaining.
- Local string-budget retirement: remaining.

## Production API rule

A character-bearing production request supplies semantic prompt segments and
role-aware references. It must not maintain a separately editable opaque prompt
that describes the same facts.

Raw prompt text remains allowed only for explicit non-character item/location
lanes and admin/lab/trial callers. The call site must opt into the escape hatch
rather than receiving it as a default.

## Segment mapping

Use the existing segment vocabulary. At minimum:

| Digest fact                 | Segment kind       | Priority  |
| --------------------------- | ------------------ | --------- |
| Requested operation/change  | `operation`        | mandatory |
| Subject identity            | `identity`         | mandatory |
| Intended morphology         | `morphology`       | mandatory |
| Apparent age                | `age`              | mandatory |
| Authoritative wardrobe      | `wardrobe`         | mandatory |
| Exposure/coverage           | `exposure`         | mandatory |
| Proved pose/body language   | `pose`             | optional  |
| Current visible state       | `current_state`    | optional  |
| Setting/location            | `setting`          | task-owned |
| Camera/framing              | existing task kind | task-owned |
| Style/quality               | existing task kind | profile-owned |

Do not add a generic `appearance` segment containing a preformatted paragraph
when a narrower semantic kind exists.

## Lane migration order

### Avatar

Replace direct attribute-registry traversal, local appearance grouping,
independent age wording, outfit filtering, and exposure recomputation. Preserve
avatar-specific subject line, framing, background, and style behavior.

### Single-character scene

Replace preformatted `appearance`, `identityAnchors`, `ageAnchor`,
`lowerBody`, `exposure`, `intimateAppearance`, and `outfitSummary` fields
with the digest and segments. Preserve scene composition and committed staging.

### Multi-character scene

Repeat the same subject segment producer for each subject. Do not use a second
appearance algorithm for referenced versus textual subjects. Subject/reference
association is declarative and reference numbering happens downstream.

### Variants and edits

Express the requested delta as an operation/change contract. Identity,
morphology, age, and unchanged wardrobe/scene facts remain separate mandatory
segments. The compiler, not the app, writes model-specific preserve wording.

### Chat look/selfie and staged character renders

Consume the same digest. Preserve each lane's actual camera, setting, social
format, and staging responsibilities.

### Exempt lanes

Item-only, location-only, and operator-authored lab/trial prompts stay outside
the visual digest unless they also render a character from committed state.

## Unified scene assembly

Replace `buildSceneRenderPrompt` and `assembleMulti` content assembly with one
function that produces scene prompt segments from:

- scene plan and committed camera/staging facts;
- one image visual digest;
- task-specific action, setting, and style facts;
- declarative role-aware references.

Reference count/profile strategy may alter provider compilation but cannot
change which character facts are selected or their semantic ordering.

## Fitting and budgets

Mandatory segments are indivisible. Optional segments are dropped from lowest
priority upward according to the existing fitter. A diagnostic `source` field
must never reach provider text.

The scene-local 1,500-character budgeter remains during migration. Remove it
only after:

1. every affected profile has a measured/conservative segment budget;
2. final compiled prompts respect provider constraints;
3. characterization tests show no mandatory loss;
4. pinned trials show no material quality regression.

Do not maintain both budgeters indefinitely after those gates pass.

## Identity-lock migration

Replace app/package exact-string coupling with an identity semantic. The
image-render-quality dialect compiler owns Qwen numbered/delta-first wording and
other model forms.

Parity tests must cover:

- one identity reference;
- several role-aware references;
- an edit with one requested change;
- an already-compiled prompt (idempotence);
- a non-Qwen profile unchanged except for intended segment compilation.

Only then remove both literal identity-lock constants and exact
`replaceAll` logic.

## Characterization and comparison

Before each lane cutover, capture structured pre-migration render intent:

- task/profile/model strategy;
- prompt and negative hashes;
- subject list;
- reference roles and order;
- requested operation;
- required character facts;
- camera/framing/style inputs.

Comparison should normalize intentional wording changes but fail on lost,
duplicated, newly exposed, or route-specific character facts.

Image trials cover representative avatar, scene, edit, chat-image, realistic,
stylized, human, non-human, altered anatomy, wardrobe, exposure, and embodied
viewer cases.

## Failure behavior

If a required digest cannot be built, refuse before provider spend with a
specific diagnostic. Do not fall back to a stale prose summary or silently omit
identity/morphology.

If only optional current state is unavailable, continue with required facts and
record the degradation.

## Tests and enforcement

Add tests that fail when production character-bearing prompt modules:

- import the attribute registry or raw garment/anatomy state outside the adapter;
- manually format apparent age, exposure, or wardrobe;
- manually emit `Image N` reference labels;
- submit both opaque prompt and segments for the same production request;
- make required segments optional;
- allow a segment diagnostic source into provider text.

Use dependency/lint tripwires where stable; use focused architecture tests where
AST/lint enforcement would be brittle.
