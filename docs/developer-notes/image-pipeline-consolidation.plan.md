# Image pipeline consolidation — one path from prompt to saved asset

Status: draft (sequenced after fork-registry; golden determinism baselines precede consolidation)

## Why

Vesper has six image lanes — character avatars, item/location art, portrait variants, a
chat's cached "current look" anchor, its cached "current place" anchor, and chat scene
renders. Each one does the same five things in the same order: reserve a database row before
anything is generated, ask a provider for pixels, save the bytes or mark the row failed, and
log what happened. That sequence is **written out six separate times**
(audit **C1** — `avatar.ts`, `entity.ts`, `variants.ts`, `chat-look.ts` twice, `scene.ts`),
and it is the highest-value consolidation in that area of the codebase.

The cost is not the line count. It is that the six copies have already drifted in ways nobody
decided: a failed entity render pushes a warning diagnostic, a failed avatar render does not;
one lane returns the new asset id on failure, another returns nothing. When a rule about
images changes — and [../images.md](../images.md) is full of hard-won rules like "row before
file" — it has to be re-applied in six places, and any place that gets missed fails silently.

Underneath the six copies sit four smaller repeats with the same shape: unwrapping a Venice
result (**C2**, five times in the app plus eight more in the eval scripts), the parallel batch
loop behind the library's "Generate images" button (**C3**, written twice, byte-for-byte),
"load an image row then read its bytes" (**C4**, four times), and select-delete-unlink
(**C5**, three times outside the asset module).

**One item is riskier than its size suggests.** A small string hash is hand-rolled five times
in two different constant spellings (**C10**), and two of those copies are *determinism seams*:
the character forge relies on its hash to reproduce the same result from the same input, and
the chat-look anchor uses its hash as a cache key deciding whether a look is stale. If those
two ever disagree nothing throws — the forge just stops being reproducible, or every chat
silently re-renders its look anchor. Divergence here is invisible by construction, which is
why one shared implementation is worth more than the ~40 lines it saves.

None of this was caught by the duplication gate, which measures duplication as a share of the
whole repository — these hot spots pass under the global budget (**F1**).

## Scope

Consolidation only, in `src/server/images` and `src/server/ai`:

- **C1** — one shared pipeline shell in `images/assets.ts` that owns the reserve → generate →
  save-or-fail → log sequence, with all six lanes calling it.
- **C2** — one Venice result unwrap in `server/ai/venice.ts`.
- **C3** — one batch-runner behind both the avatar and entity batch buttons.
- **C4** — one "row plus bytes" loader and one reader for the stored image metadata.
- **C5** — one purge helper for the select-delete-unlink paths.
- **C10** — one string hash in `src/lib`, with the two determinism seams pinned by tests.

Also in scope: updating [../images.md](../images.md) §Adding a pipeline so the next image kind
is written against the shared shell instead of copied from a neighbour.

## Non-goals

- **No behaviour change to any image output.** Same prompts, same models, same rows, same
  files, same failure text. The prompt builders (`images/prompts.ts`) are not touched, and
  neither is the scene provider chain, the router's fallback order, or any model default.
- **No new features.** [spatial-scene-images.plan.md](spatial-scene-images.plan.md) (draft)
  owns future pipeline capability — pose and depth control — and the body-affordance
  scene-image consumer stays parked in [deferred.plan.md](deferred.plan.md). Neither is
  touched here; this plan only makes the ground they land on smaller.
- **No schema work.** No new columns, no migration, no deploy sequencing.
- **Not the resilience closures** (**C12**, time-boxing the image-side model calls) and **not
  the eval-harness rewrite** (**C11**). The shared shell is the obvious future home for the
  first, and the scripts may adopt the shared Venice unwrap, but both stay out of this plan.

## Review rulings and scope adjustments — 2026-07-30

- Preserve each lane's return type and caller contract. The shared pipeline owns
  common execution, not a lowest-common-denominator response.
- Normalize missing failure diagnostics to the entity lane's observable behavior.
  That is a deliberate resilience improvement, not behavior-neutral cleanup, and
  needs explicit tests and release notes in the shipped slice.
- Pin golden prompt/reference hashes before touching ordering, unwrapping, or
  reference preparation. Determinism is an input contract, not a snapshot to
  update after the refactor.
- Share only the actual skeleton. Lane-specific event/placeholder behavior remains
  separate until its user-visible consequences have a ruling.

## Delivery slices

Invisible-risk item first, the broad one last. Each slice is independently shippable.

1. **The shared hash (C10).** Before changing any caller, pin the current output of the two
   determinism seams with golden-value tests — the forge seed and the chat-look cache key must
   provably not move. Then move one implementation into `src/lib`, in both the numeric and hex
   forms the callers need, and delete the five copies.
2. **Leaf helpers (C2, C3).** The Venice unwrap and the batch runner. Nothing about call order
   or concurrency changes; the batch size stays five per lane as documented.
3. **Readers and purge (C4, C5).** One row-and-bytes loader, one metadata reader, one purge
   helper — the last preserving every existing guard exactly, including the gallery's
   allowed-kinds restriction and the "null out any pointer at the deleted id" step.
4. **The pipeline shell (C1).** Build the shell, then migrate the six call sites **one at a
   time**, avatars first (best-covered, simplest) and chat scenes last (most branching).
   Where two lanes disagree today, the difference is either preserved deliberately or fixed
   deliberately with a note saying which — no difference gets normalized by accident.
5. **Close-out.** Update [../images.md](../images.md) §Adding a pipeline to name the shared
   shell as the way to add an image kind, so the seventh lane is written once rather than
   copied a seventh time.

## Success criteria

- Every image lane produces the same rows, files, metadata and failure text it does today, for
  the same input. All six call sites are already test-covered; that coverage passes unchanged.
- The reserve → generate → save-or-fail → log sequence exists in exactly one place.
- The forge's reproducibility seam and the chat-look cache key are covered by golden-value
  tests that fail loudly if the hash ever changes — the failure mode that is invisible today.
- Adding a new image kind is a prompt builder plus one call to the shared shell, and
  `docs/images.md` says so.
- Full gate green (lint → lint:cycles → typecheck → test → jscpd), run one at a time.

## Risks & coordination

- **Slice 4 is the only broad one.** It touches every lane, and the invariant it must not bend
  is the row-before-file lifecycle in [../images.md](../images.md): the row is inserted
  *before* the file exists, so every file on disk is always explained by a row. Any change to
  when the row is written relative to when bytes land is out of bounds for this plan.
- **Slice 3 touches deletion.** The purge helper operates on user data; a predicate
  accidentally wider than the copy it replaced deletes the wrong assets. Highest-consequence
  item among the small ones, and it wants the most careful review.
- **Recent churn in the scene and chat-anchor lanes** (both edited in late July). If either is
  under active edit when this is picked up, take slice 4 after that work settles — and the same
  applies if [spatial-scene-images.plan.md](spatial-scene-images.plan.md) activates first:
  landing the shell first makes that plan cheaper, but refactoring a file a feature is being
  built in does not.
- **Keeping the copies from returning** is a tooling change (**F1** — the duplication gate's
  global threshold and its `scripts/` blind spot), owned by the audit's tooling batch.

## Open questions

- Should eval scripts that already import Venice adopt the shared unwrap in this
  plan, or migrate only when the eval-harness work lands?
- Does the event log stay per-lane, or become one shared event with explicit lane
  metadata? Decide from the inspector and failed-placeholder behavior, not from
  whichever lane migrates first.
