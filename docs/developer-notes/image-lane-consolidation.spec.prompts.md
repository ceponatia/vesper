# Image lane consolidation — prompt and lane migration

Status: companion to [image-lane-consolidation.plan.md](image-lane-consolidation.plan.md)

This spec owns the migration of character-bearing image routes from
independently formatted appearance strings to `ImagePromptSegment[]`. The
image-render-quality plan remains canonical for segment fitting, prompt
dialects, negatives, and measured model budgets.

## Implementation status

- Stage 1 characterization: **built 2026-08-16** — the harness is
  `apps/web/src/server/test-support/image-lane-probe.ts` and the frozen matrices
  are `apps/web/src/server/images/lane-characterization.test.ts`. See
  [Characterization and comparison](#characterization-and-comparison).
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

### The Stage 1 harness

The character-fact half of that comparison is built. One fixture character — a
succubus, so species morphology is live rather than a human's empty set, with
intimate regions present so exposure gating has something to gate — carries
deliberately distinctive attribute values, and a probe asks only whether each
value's word reached the compiled prompt and how many times. Matching is
whitespace- and case-normalized. `voice.timbre` is the negative control: a
`kind: "sensory"` attribute that must never appear.

This is deliberately not a prompt-string snapshot. The migration's whole purpose
is to change the wording, so a string snapshot would fail on every rewrite and
the only available response would be to re-bless it. A fact probe survives any
reasonable rewording and fails on a changed fact set, which is the property the
comparison rule above asks for.

`presentVisualFacts` yields the readable per-lane list the matrices freeze;
`duplicatedVisualFacts` covers the duplication failure mode separately.

Two disagreements the freeze put on the record, both of which Stage 2 resolves
by giving every lane one coverage-aware selection:

- the text-to-image scene lane routes appearance through
  `characterAppearanceSummary`, which applies no coverage gate, so it describes
  skin a garment is covering — while the reference lanes, routing the same fact
  through the exposure-gated reveal line, stay silent;
- the chat-look and portrait-variant lanes state apparent age and the requested
  change and no other character fact at all, leaning entirely on the reference
  image, and take their age anchor as a caller-supplied string.

One invariant is asserted across every lane rather than frozen per lane, because
it holds today and must survive every stage: covered intimate **skin** is never
described, including on the uncensored routes, where the gate is coverage and
not the route. Intimate **shape** is excluded from that assertion on purpose —
silhouette reads through clothing by design.

The transport half of the capture (profile/model strategy, prompt and negative
hashes, reference roles and order) is not built; it belongs with the render
intent Stage 3 starts comparing.

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
