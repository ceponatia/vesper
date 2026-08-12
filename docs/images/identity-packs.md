# Identity packs (derived face crops)
A character's **identity pack** records which bytes its face reference came from, how it was cropped, and what was
measured about it ([developer-notes/image-identity-packs.plan.md](../developer-notes/image-identity-packs.plan.md) ·
[spec](../developer-notes/image-identity-packs.spec.md)). One **current** pack per character, derived from that
character's **current canonical portrait** — never a gallery image, never an old avatar — keyed by a **SHA-256 over
the stored normalized WebP bytes**, so bytes that merely *look* the same are a different source. Revisions are **rows**
in `image_identity_packs` (migration 0101, `images/identity-packs.ts`): a partial unique index enforces one `current`
row per character, and each revision carries its status (`pending`/`ready`/`unusable`/`failed`/`stale`/`superseded`),
crop method (`detector`/`heuristic`/`manual`), geometry, measurements, warning codes and review actor. The **pack row,
not the crop's `images.meta`, is the authority** for which crop is current.

**The crop is a hidden asset.** `kind: "identity_face_crop"` is written through the normal row-before-file WebP path ([asset-registry.md](asset-registry.md)),
then subtracted from every user surface by `HIDDEN_IMAGE_KINDS` (`images/assets.ts`): the character detail response's
portrait strip, `cloneEntityImages`, and the public-widening branch of `GET /api/images/:id/file` (a hidden row stays
owner-only whatever entity it names). The portrait studio's routes use a positive allow-list instead
(`PORTRAIT_STUDIO_KINDS` = avatar + variant), so list/read/delete/promote cannot address one; the Gallery's
`GALLERY_IMAGE_KINDS` never included it; and `promoteVariant` refuses a hidden kind outright
(`images.promote.hidden_kind`) — a render *input* is never a portrait.

**Derivation v1 is heuristic-only, deliberately.** `IdentityFaceDetector` (`images/identity-pack-detector.ts`) is a
real seam, but the shipped adapter is `nullIdentityFaceDetector` (`"null_v1"`) and reports nothing: picking a library
is a trial-slice decision, and any candidate must run locally (the portrait never goes to a third-party face service).
Automatic derivation is therefore the deterministic `heuristic_v1` crop for portrait-shaped sources (height/width
1.2–2.2, squared, top offset 0.08 of source height), carrying the `heuristic_crop` warning and never promoted to
`detector` by inference — and it **fails closed with `no_usable_face`** on any other shape rather than guessing a
rectangle out of a group shot. Face-box expansion, lost-padding refusal and the multi-face `ambiguous_faces` refusal
(never the biggest or most central face) are implemented and proven against injected test detectors. Every tunable
number lives in `packages/image-core/src/identity/identity-pack-policy.ts` behind `derive_v1` (bump when crop **bytes** would change) and
`policy_v1` (bump when a **threshold** re-judges stored measurements), with golden fixtures pinning the geometry so "the
crop moved" is always deliberate. The v1 values are conservative placeholders; blur and occlusion
thresholds are `null` — defined, not armed.

**A stored verdict is not eternal truth.** Rows persist *measurements*, never `quality.accepted`, so a revision stamped
with an older `policyVersion` is **re-judged on read** by `projectIdentityPackPolicy` (`images/identity-packs.ts`) —
one helper shared by all three read seams (`ensureIdentityPack`'s reuse path, `getIdentityPackForOwner`,
`evaluateIdentityPackForProfile`), so a policy bump can never leave one of them quoting a verdict the others dropped.
It is a **projection, not a repair**: the row keeps the status and warnings it was finalized with (a revision is a
historical claim, and admin history shows it), while readers get today's answer — blockers make the pack `unusable`
with a non-retryable code, warnings are recomputed from the stored numbers, and the two *provenance* warnings
(`heuristic_crop`, `manual_admin_override` — how the crop was authored, not what a threshold measured) survive
unchanged. Only `ready` revisions are projected: a loosened policy cannot promote a refused revision, which has no crop
bytes to hand anybody, so that direction is a re-derivation.

**`ensureIdentityPack` is the one entry point**, and idempotent: authorize → hash the source → reuse a matching
ready/unusable revision → coalesce behind a **keyed single flight** (`identity_pack:<characterId>`, also the advisory
lock inside both transactions) → else reserve a `pending` revision, derive **outside** the transaction, and finalize by
**compare-and-set** on the same source pointer and hash; a derivation that loses that race goes stale and its crop is
deleted at once. The keyed lock only covers one process, so **another machine's live reservation is joined, not
raced**: the reserve transaction — the one current-row read taken under the advisory lock — leaves a `pending` row
standing when it matches this source and is younger than the 15-minute staleness bound, and the caller polls the row
(no database transaction held — the in-process character key is, which is why the join gets its own 5s budget — 250ms
granularity) until it settles, then answers through the same projection any other reader uses. Waiting purposes
(`identity_render`, `admin_trial`) join; `background` declines promptly with `pending_conflict` rather than starting
duplicate work; a manual crop save gets the editor's `busy` conflict. One re-entry at most — a second consecutive
in-flight degrades to a retryable `derivation_failed` — with one exception: a FORCED re-derivation (reset-to-automatic,
admin regenerate) whose join timed out re-enters with leave to reclaim the wedged reservation, the operator's escape
hatch the staleness bound is otherwise 15 minutes away from providing — leave bound to the joined row **by id**, so a
replacement reservation standing in its place is joined or refused, never clobbered. Retiring a live
reservation instead is a legal write the one-current index cannot catch, and costs two detector runs, two crops, and a
deleted crop for the loser. Retry backoff is **derived from the revision rows** (their count is the attempt number, the newest
row's timestamp the clock — 60s doubling to an hour, five attempts per set of source bytes), so no second scheduler
exists, and expected failure is a value — `blocked` with an actionable code — not an exception. Preparation is queued
fire-and-forget after avatar generation, variant promotion and library clone as an `identity_pack` job (local lane, one
live per character); a pack failure never fails the portrait. **That live job converges, which is what makes the dedupe
safe**: once its `ensure` settles it re-reads the character's canonical pointer and derives again when the current
revision doesn't cover it — otherwise promoting portrait B mid-derivation left B prepared by nobody (B's trigger
correctly invalidated A's pack and was correctly suppressed by A's job; A's derivation then correctly lost its finalize).
A pass is only repeated because the pointer MOVED (a recheck naming the source that pass just targeted means the same
call with the same arguments, so it stops and leaves the retry to the backoff clock); bounded at 3 passes, each
re-reading the LATEST pointer so a burst of portrait changes collapses onto the final one; another process's live
reservation for that pointer stops the loop rather than being polled from a job slot; a throw doesn't recheck (it means
the database is failing, and every recheck read is another one of those). Past the bound it stops with `source_changed`
and leaves the character to the next trigger or a lazy ensure. The job payload records the source each pass targeted,
the last outcome, and why it stopped — a detached job has no diagnostic sink, so the row is it.

**Lifecycle.** A changed source makes the pack stale (read-time hash verification is the backstop), and a deleted one
invalidates the pack through a **maintenance registration hook** (`registerIdentityPackMaintenance` — a registry rather
than an import, because `assets.ts` importing the pack service would close a cycle). **Ordering is load-bearing:
`purgeImagesWhere` fires that hook BEFORE the rows go**, because `source_image_id` is a `set null` FK and a pack is
findable by source id only while that id exists — invalidate afterwards and the character keeps a `current`, `ready`
revision over bytes that are gone. Every purge-based delete inherits it; the portrait studio's own `DELETE` repeats it
around its hand-written delete, and `clearEntityImagePointers` still runs the hook for ids whose row survived a kind
guard. Three defences, not one: that ordering, the FK, and `projectIdentityPackPolicy` refusing any `ready`/`pending`
revision whose source id is null (`source_missing`, and the owner summary calls it stale) so no reader can surface one
however it arose. The same hook gives the 6-hourly `image_sweep` ([asset-registry.md](asset-registry.md)) its identity pass: bounded idempotent cleanup of
retired revisions' crops after a **7-day diagnostic window** (pack metadata survives as the audit trail, the current
revision is never touched, `pending` rows abandoned by a dead process are retired at the 15-minute job-staleness bound,
a `current` row that lost its source is retired so its crop can age out at all, and orphan crops go too), plus
consistency **findings** counted into the sweep job's payload rather than silently repaired. Hidden crops are
hard-deleted with the character (`deleteCharacterIdentityAssets`, guarded by kind *and*
entity, which keeps them dying with it once data-lifecycle retires `deleteEntityImages`). Copy and publish stay
isolated: a clone carries no crop, and the destination derives its own pack from its own copied portrait.

**Surfaces.** Owner lane `/api/characters/:id/identity-pack` — `GET` (summary; a pure read that never derives, so
`none` and `pending` are answers rather than spinners), `POST ensure`, `POST manual-crop` (409 with a fresh summary on
a stale editor save, 422 on a measured rejection), `POST reset-automatic` (a new automatic revision, not an undo) — all
authorized from the **character in the URL**, with a body `packId`/`revision`/`sourceContentHash` only as a concurrency
guard. Every route answers `{ summary }`; the two write routes add an optional `blocked: { code, retryable }` when the
refusal happened **before** a revision existed (no portrait, source still generating, unreadable bytes, single-flight
timeout) — that outcome is invisible in the re-read summary, so without it a Prepare click answers with silence. The
portrait studio shows a quiet `IdentityReferencePanel` (keyed on the character **and** its canonical portrait, so a new
portrait re-reads instead of showing the previous pack's state; renders nothing if the read fails) opening
`identity-crop-dialog.tsx`: a drag/resize square over the canonical source, live preview, plain-language warnings, and
the `blocked` code in the owner's words when a prepare or reset refuses. The
**self-scoped** admin lane `/api/admin/self/identity-packs` adds a bounded preparation `batch` (dry run, hard caps,
named trial-corpus registry, empty), per-pack `history`, and a recorded `override` waiving a *reviewed
threshold* only (ownership, bounds and stale-hash refusals stand whoever asks; the revision records actor, reason and
the `manual_admin_override` warning). No route returns image bytes or URLs, admin included.

**Evaluation exists; no render lane consumes it.** `images/identity-pack-references.ts`
(`evaluateIdentityPackForProfile`) maps the current pack plus a profile's declared strategy (`canonical_only` ·
`face_detail_only` · `canonical_then_face_detail` · `face_detail_then_canonical`) to ordered role candidates
(`canonical_identity`, `face_detail`) carrying ids, measurements and provenance — never bytes, never a model choice —
and refuses **before** provider reservation. Consumers gate on `IMAGE_IDENTITY_PACK_REFERENCES`
(`imageIdentityPackReferencesEnabled()`, default off, checked by the caller so admin and trial surfaces can still
measure), and **nothing calls it in production**: every lane
anchors on the library avatar exactly as described in [pipelines.md](pipelines.md)
([image-model-capabilities.plan.md](../developer-notes/image-model-capabilities.plan.md) owns the consumer).

**The fixed-trial harness.** Admin-only infrastructure for the reference trial of
[the trial spec](../developer-notes/image-identity-packs.spec.trial.md): four tables (migrations
0102/0103 — `image_identity_pack_trial_runs`/`_cells`/`_grades`/`_verdicts`; one verdict row per
profile/strategy slot, upserted so a concurrent ruling can never clobber another), a service
(`images/identity-pack-trial.ts`), owner-admin routes under `/api/admin/self/identity-packs/trial`, and a Settings →
Identity trials page. A run expands characters × profiles × strategies × six checked-in prompt fixtures (two per
identity-critical task) into at most 96 cells, resolves each through `ensureIdentityPack` (purpose `admin_trial`) +
`evaluateIdentityPackForProfile`, and **refuses — never trims** — blocked packs, over-capacity reference sets, and
detector-method cells (no detector exists in v1). Execution is bounded (1–20 renders per click, single-flight per run;
the daily budget + storage backpressure are charged inside the run lock for exactly the cells the pass picked, through
a route-supplied guard, so a refused or empty pass is never billed); each cell re-verifies its pinned fixture, model
version, pack revision and controls hash before rendering, refusing on drift; outputs land as the hidden kind
`identity_trial_output` — in `HIDDEN_IMAGE_KINDS` beside the face crop, owner-viewable for review, deleted with the run
and swept with the character. Review is blinded pairwise (left/right from sha256 parity of run + pair id, persisted on
the grade row; grades stored unblinded), aggregated per profile/strategy pair, and closed by a recorded verdict with
actor, reason and policy version. All of it runs with `IMAGE_IDENTITY_PACK_REFERENCES` still off — the flag gates
render-lane consumption, not the trial. Detail lives in the spec's Implementation section, not here.

**A new warning or failure code requires copy.** The server reasons about stable codes only;
`components/characters/identity-pack-copy.ts` is the single exhaustive code → English map, so adding a code without
copy is a **compile error**, not a raw identifier on someone's screen.
