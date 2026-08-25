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
- Avatar migration: **built 2026-08-21.** `generateAvatar` renders from the
  standalone visual digest through `buildAvatarSegments`
  (`server/images/avatar-segments.ts`): one camera-bound selection, segments on
  `intent.promptSegments` (the compiled join doubles as the stored `prompt`),
  refusal before provider spend (`images.avatar.visual_digest_ineligible`) when
  a required fact resolves no clause, `meta.visualState` at reserve time.
  Identity attributes (hair/eyes/skin, gender, heritage) remain a route-owned
  residual segment built from the sheet, because visual state projects only
  species feature groups, anatomy departures, current-state owners, and the
  cataloged recognition marks today; each residue entry is deleted — not
  rewritten — as the projection grows an owner for it. `buildAvatarPrompt`
  stays in the tree, uncalled by production, with its freeze pins, until the
  Stage 6 gates pass.
- Single-character scene migration: **built 2026-08-21, fact source only.**
  For an effective cast of one (selfies included), `applySceneSubjectVisual`
  (`server/images/scene-subject-visual.ts`) replaces the focal spec's
  preformatted appearance/identity/reveal fields with digest-sourced clauses
  after the plan resolves, binding `plan.camera` into the one selection pass.
  The lane's TRANSPORT stays an opaque prompt on purpose:
  `buildSceneRenderPrompt`, the 1,500-character budgeter, and the
  identity-lock adaptation operate on the compiled string, and
  `promptSegments` would override the adapted string in the kernel — segment
  transport for scenes lands with Stage 5's unified assembly. Deliberate fact
  changes: the text-to-image row no longer states covered intimate skin, and
  every scene row gains the digest's mandatory morphology anchors. Stage 4
  extended the same field production to every present member.
- Render-intent capture and comparison: **built 2026-08-21.**
  `captureRenderIntent` (`server/images/render-intent-capture.ts`) records the
  transport half plan-first with no provider IO;
  `lane-cutover-comparison.test.ts` builds both paths of each cut-over lane
  from one fixture and fails on any lost, duplicated, newly exposed, or
  unexplained fact delta (the intentional deltas are named, self-verifying
  allowlists). Pinned image trials over live providers remain owner-run work
  before Stage 6 deletes fallback assembly.
- Multi-character scene migration: **built 2026-08-25.** `applySceneCastVisual`
  (`server/images/scene-subject-visual.ts`) runs one shadow assembly, one
  camera-bound selection and one digest realization PER SUBJECT — each person's
  own committed cut — and patches `plan.focal` plus the matching `plan.others`
  entries through ONE shared per-subject field producer. There is no second
  appearance algorithm for bystanders: `applySceneSubjectVisual` is now the
  one-subject spelling of the same call. `character-scene.ts` takes a
  `subjectVisuals` map keyed by character id instead of a single cut, and the
  scene queue (`app/api/chats/[chatId]/scene/queue.ts`) builds a cut per present
  member, resolving every member's `memoryGroupId` in ONE batched query; a
  member with no participant row warns and keeps the legacy `presentCharacter`
  fields for that member alone. Transport still sends an opaque compiled prompt
  for the same reason the cast-of-one lane does (Stage 5). The per-subject
  digest records merge into ONE `meta.visualState` record: `subjects` and
  `suppressions` concatenated in cast order, snapshot and selection fingerprints
  combined into a cast-wide composite, `cutId`/`atMinutes` from the shared cut,
  `cameraFingerprint` from the focal.
- Portrait variants and edits: **built 2026-08-25.** `buildVariantSegments`
  (`server/images/variant-segments.ts`) assembles the lane from the standalone
  digest; `variants.ts` sets BOTH `prompt` and `intent.promptSegments`, which is
  safe here and only here because this lane's `instruction_edit` strategy passes
  the base prompt through unchanged. Policy: state age, full-figure frame, never
  intimate, omit exposure. The lane now loads the default wardrobe for coverage
  and camera perception and mints a `standaloneCharacterReadToken`; a digest it
  cannot build refuses through `failedPrecondition` before provider spend.
  Measured fact-set delta against the legacy builder: gains horns, wings and
  tail; loses nothing. See [What the variant prompt gains](#what-the-variant-prompt-gains).
- Chat-look mint: **built 2026-08-25.** `buildChatLookSegments`
  (`server/images/chat-look-segments.ts`); the mint sets both `prompt` and
  `promptSegments`. Policy: omit age, waist-up frame, never intimate, omit
  exposure. Route-owned segments are the outfit-change/undress/keep-casual line
  (`operation`), the identity lock (`identity`), and the framing sentence
  (`framing`). Current-state facts — active conditions, body-surface wetness —
  are suppressed as lane policy, because `chatLookKey` caches and reproduces the
  anchor and cannot see transient body state; `chatLookKey` itself is unchanged.
  `chat-reference-images.ts` resolves the `memoryGroupId` and hands the render
  the committed cut; a missing participant row warns and the mint still happens
  without a digest. The refusal stays pre-reserve, so an ineligible chat leaves
  no failed row. Measured delta: gains horns, wings and tail; loses nothing.
- Staged character renders: **built 2026-08-25.** The chat lane's staged renders
  needed no work — every scene staging is solo-cast, so a staging can only
  survive on a cast of one, which rode the digest from Stage 3. The Advanced
  Image Lab's `staged_scene` bench kind was the only unmigrated staged path, and
  it now carries a `subjectFacts` mode
  ([The staged bench's two arms](#the-staged-benchs-two-arms));
  the implementation is `server/images/image-lab-staged-visual.ts`.
- Shared standalone assembly: **built 2026-08-25.**
  `buildStandaloneSubjectVisual` (`server/images/standalone-subject-visual.ts`)
  is the no-chat digest assembly extracted from the avatar lane and now shared by
  the avatar, variant and staged-bench lanes. The avatar lane's output is
  byte-identical across the extraction.
- Scene transport budget: **fixed 2026-08-25.** In `prompts-scene-render.ts` the
  single-reference assembler left a textual subject's `appearance` unbudgeted
  while the multi-reference assembler capped it. That was harmless while a cast
  of two or more carried the legacy 200-character summary; digest-sourced
  appearance is longer, and an uncapped field could push the prompt past the
  1,500-character limit so `clampToLimit` cut the tail — taking the
  clothing-authority clause the builder is documented never to drop. Both
  assemblers now budget it identically.
- Unified scene segment builder: remaining (Stage 5).
- Local string-budget retirement: remaining (Stage 6).

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

### Task policy hooks

`VisualSegmentTaskPolicy` (`contracts/images/visual-segments.ts`) carries the
per-lane hooks the shared subject builder reads. `exposure` joined the existing
`age`, `frame` and `intimate` hooks for Stage 4's edit lanes: where coverage
belongs to the reference image, or where the requested change IS the coverage,
an authoritative coverage readout beside the instruction either restates it or
contradicts it. Omitting it is recorded as a policy suppression, never as a
missing mandatory fact or a fitting decision.

The migrated lanes' values:

- **Avatar** — age `state`, frame `waist_up`, intimate `never`, exposure `state`.
- **Chat scene** — age `omit`, frame `full_figure`, intimate `when_bare`,
  exposure `state`.
- **Portrait variant** — age `state`, frame `full_figure`, intimate `never`,
  exposure `omit`.
- **Chat look** — age `omit`, frame `waist_up`, intimate `never`, exposure
  `omit`.
- **Staged bench (parity arm)** — the chat scene's policy, imported rather than
  restated.

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

#### What the variant prompt gains

**Owner ruling (2026-08-25):** the variant prompt gains only the digest's
body-shape anchors — species feature groups and anatomy departures — and
nothing else. Hair, eye and skin color keep coming from the identity reference
photograph and stay unstated, because the picture is a better source than any
sentence and a text anchor beside it only competes with it. This lane therefore
ships **no route-owned identity residual sheet**, unlike the avatar lane; the
digest's cataloged-mark clause is the only statement of a mark, so the clause
resolver runs with an empty omit set here.

The route-owned segments are:

- the identity lock, byte-identical to `PORTRAIT_IDENTITY_LOCK` (the Qwen
  dialect matches the literal string; see
  [Identity-lock migration](#identity-lock-migration));
- the apparent-age anchor, emitted only when non-empty — a missing anchor is
  never a missing required fact;
- the requested change, as the `operation` segment;
- the outfit-keep line as a `wardrobe` segment, omitted for the `outfit` and
  `nsfw_test` kinds, where the wardrobe IS the operation's target and an
  authoritative wardrobe line would contradict the instruction;
- the `nsfw_test` anatomy line, route-owned on purpose: that bench kind states
  the sheet's intimate anatomy with no exposure state at all, and routing it
  through the digest's coverage gate would delete it the moment the character
  owns a wardrobe;
- the quality tail.

### Chat look/selfie and staged character renders

Consume the same digest. Preserve each lane's actual camera, setting, social
format, and staging responsibilities.

#### The staged bench's two arms

The chat lane's staged renders never needed migrating: every scene staging is
solo-cast, so a staging survives only on a cast of one, which moved to the
digest in Stage 3. The Advanced Image Lab's `staged_scene` bench kind was the
only unmigrated staged path. It was built name-only, and
`intimate-scene-lora.spec.md` §"What the bench does NOT reproduce" recorded that
gap as deliberate on 2026-08-16.

**Owner ruling (2026-08-25):** that ruling is reversed for the default mode
only. `staged_scene` carries a `subjectFacts` mode
(`imageLabSubjectFactsModes`, `packages/image-core/src/lab/image-lab.ts`), an
extensible union rather than a boolean:

- `production_parity` — the new default. The bench reads the character sheet,
  builds the standalone digest, and describes the subject the way the production
  chat lane now does. It imports `SCENE_SEGMENT_POLICY` and the scene lane's
  `RECOGNITION_RESIDUE_ATTRIBUTE_IDS` omit set rather than restating either, so
  a policy change on the chat lane cannot silently leave the bench behind.
- `reference_only` — the pre-ruling behavior, preserved as an explicit,
  operator-selectable ablation. It is the only way to ask whether the written
  anchors help or fight the identity reference, and a mode that always sends
  them cannot answer that.

The mode is resolved at create time and recorded on the row, because it is a
fact about the run rather than a preference. A row that records none predates
the vocabulary and reads back as `reference_only`, which is what it actually
sent.

The staging's invented exposure premise (`entry.requiresBare`) and the
hard-coded viewer exposure stay. They are statements about the ACT, not about
the character's closet: a real coverage read would switch several stagings off,
and the bench would quietly pay for an ordinary portrait. The premise is handed
to the standalone assembly as worn coverage, so the digest's exposure readout
and the camera's per-location perception answer the same premise and cannot
disagree.

A digest the parity arm cannot build settles the row with the lab failure code
`visual_digest_unavailable` before any provider spend. It never falls back to
the ablation: an arm the operator did not choose would answer a different
question than the row asks, which is the one failure a comparison bench cannot
survive.

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
- the chat-look and portrait-variant lanes state the requested change and
  almost no other character fact, leaning entirely on the reference image. The
  variant lane also states apparent age, from a caller-supplied string. The
  chat-look mint no longer does: the narrative/visual age split took age out of
  that lane after the freeze was written, leaving the garment as its only fact
  until the Stage 4 cutover.

A third disagreement surfaced after the freeze and is closed in code rather
than waiting on Stage 2: the chat scene lane resolved condition overlays but
not the chat's persisted narrative `attributeOverlays`, so a recorded haircut
or dye reached the narrator prompt and the visual-state projection while the
scene prompt's identity anchor still asserted the authored hair. Closed
2026-08-21 by giving `character-scene.ts` the same base → persisted → condition
resolve `resolveShadowAttributes` takes; the digest cutover must preserve that
layering. Stage 4 closed the rest of that finding
(`visual-state.audit.md` finding 6): the chat-look mint now takes its cut from
the same shared chat factory and reads the same base → persisted → condition
resolve, so a recorded haircut or dye reaches the look anchor. The variant lane
has no chat and therefore no persisted narrative overlays to resolve at all: the
character sheet plus its default wardrobe ARE that lane's committed cut.

One invariant is asserted across every lane rather than frozen per lane, because
it holds today and must survive every stage: covered intimate **skin** is never
described, including on the uncensored routes, where the gate is coverage and
not the route. Intimate **shape** is excluded from that assertion on purpose —
silhouette reads through clothing by design.

The transport half of the capture is built (2026-08-21): `captureRenderIntent`
records task, profile, prompt strategy, model slug/version, prompt and negative
hashes, reference roles in send order, target aspect, subject ids, required
fact keys from the digest provenance, camera fingerprint, and applied/dropped
controls — plan-first, with no provider call. The comparison suite asserts
transport equality between the legacy and digest builds of each cut-over lane
everywhere transport was not supposed to move.

Image trials cover representative avatar, scene, edit, chat-image, realistic,
stylized, human, non-human, altered anatomy, wardrobe, exposure, and embodied
viewer cases.

### The two roads a recognition mark travels

A cataloged recognition mark reaches a lane by one of two roads, and Stage 4
measured that they do not agree. The STANDALONE snapshot road (avatar, variant)
projects a cataloged distinctive value into the digest as a mark. The chat
SHADOW road (scene, chat-look) projects none at all — verified by suppression
record: the avatar build records `nose/shape` as a `lane_curated` suppression,
and both chat builds record no such fact.

The scene lane never noticed, because its route-owned residual attribute sheet
states the mark regardless. The chat-look mint has no residual sheet, so there
the mark is simply unstated.

Left silent deliberately for now: that lane edits FROM an identity reference,
and identity detail the reference already carries is exactly what the owner
ruled stays unstated on the sibling edit lane
([What the variant prompt gains](#what-the-variant-prompt-gains)). Closing the
asymmetry belongs to the plan that owns the projection —
`visual-state.plan.md` — not to this one; when it lands, the chat lanes gain the
mark with no change here. The claim is pinned by
`lane-characterization.test.ts`'s distinctive-mark test.

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
