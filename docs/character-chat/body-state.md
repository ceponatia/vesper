# Scene environment & body surface

The two authoritative owners that let the visual layer read *state* rather than parse
prose: the chat-wide `environment` (wind, precipitation, indoors) and the per-character
`body_surface` — wetness, contact marks, and the material a body is carrying. What is
projected *from* them lives on its own pages: the affordance read and its narrator cues in
[affordance-cues.md](affordance-cues.md), recognition and the narrator's cue record in
[visual-memory.md](visual-memory.md), and the constraint/premise fences in
[physical-guidance.md](physical-guidance.md). Everything else a conversation carries
between exchanges is [state.md](state.md).

The law both owners exist to serve is that **narrator prose is never parsed at read time** —
the continuity extraction leg proposes typed ops and the fold commits them through
`parseOr`, exactly as the garment lane does.

## The two owners

- **`character_chats.environment`** (`contracts/state/chat-environment.ts`
  `ChatEnvironment`): the scene's `wind` (`none`/`breeze`/`windy`/`gusting`),
  `precipitation` (`none`/`drizzle`/`rain`/`downpour`), `indoors`, and the story minute
  it last CHANGED. Chat-wide like `scene_memory` — one sky for the roster — so it rides
  `pre_exchange_scenario` and rolls back with everything else. **Indoors/still/dry is the
  degraded default**, and `indoors` is a hard zero on both `windForceOf` and
  `precipitationActive`: a downpour seen through a window wets nobody. Weather is
  deliberately NOT a scene-memory detail (that field records durable places).
- **`character_chat_state.body_surface`** (`contracts/state/body-surface.ts`
  `BodySurfaceState`): per-body-location wetness — a fixed-point level, the minute it
  last changed, and what wet it (`rain`/`immersion`/`splash`/`other`). Per character, so
  it rides `storedChatStateSchema` and the `pre_exchange_state` anchor. It **dries lazily
  on the story clock** at a flat rate (saturated → dry in ~3⅓ story hours), the
  garment-condition precedent: reading integrates forward and never mutates, writes touch
  only the locations a proposal named, and `updatedAtMinutes` therefore stays a truthful
  freshness stamp for the cause. Only the **primary character** carries a body surface,
  and `hair` is the one owned location.

## Three laws about not letting a gap become a physical claim

- **Absent, dry, and invalid are three answers, and the wrong one is a physical claim.**
  A stored entry whose `level`/`updatedAtMinutes` fails parsing is **quarantined** as
  `{ status: "invalid" }` — persisted verbatim, never pruned, healed only by the next
  authoritative write — and `bodySurfaceWetnessAt` returns an explicit `invalid` read the
  caller must handle. Repairing it to `0`, or dropping it so absence answers instead, would
  be worse than useless: losing wetness does not merely forget that hair was soaked, it
  asserts that hair is dry, and dry hair carries mobility that wet hair does not — a corrupt
  row would have bought a wind-motion cue. The adapter maps `invalid` onto the affordance
  result law's `invalid`, files `affordance.input.invalid`, and the hair domain (for which
  wetness is structural) falls silent.
- **Keys are validated per entry, and an unusable wetness key poisons absence.**
  `z.record` rejects the whole *record* when one key fails, which would empty a character's
  wetness and take every valid sibling with it, so wetness and the three identity-keyed
  modules below each check their keys entry by entry. A key that is empty, longer than its
  module's bound (64 characters for a body location), or that would need trimming is
  **refused, not normalised**: a stored `"  hair  "` is never turned into the real `hair`
  (that gives two events one slot) and never dropped either, since absence is a claim here.
  It quarantines under its own raw identity carrying a second marker,
  `{ status: "invalid", scope: "key" }`, because persisted authority is read under exactly
  the identity it was written under. **So an absent location is honestly dry only while
  every stored key is assignable** — where one is not, every absent location in that record
  reads `invalid`, since an unassignable key could have named any location. The asymmetry is
  the load-bearing part: a corrupt *value* has known scope and poisons nothing but its own
  location; only an unassignable *key* poisons absence. The two markers are a superset
  relationship — the predicate for "is this unreadable" answers true for both, so no caller
  can spend either as a level. Two consequences while debugging: `pruneDryBodySurface`
  prunes nothing at all in a record holding an unusable key, so pruning still cannot change
  what any read returns; and a write heals the location it NAMES — at capacity it makes
  room by spending an unassignable key rather than refusing, since a tombstone is not a
  material fact, so the poison can never wedge a full record shut. What a write does not
  do is heal the record: absence keeps reading `invalid` while any unassignable key
  stands, and only capacity pressure ever spends one.
- **Standing outdoor precipitation HOLDS wetness** (`surfaceDryingSuspended` —
  `precipitationActive`, i.e. raining *and* not indoors). Without it a soaked character
  standing in a continuing downpour would read bone dry after a few story hours, because
  "unchanged weather" proposes no ops. Holding never *raises* the level; raising still
  requires a committed proposal. The finalize fold applies the environment patch first
  and integrates against the result, so an exchange is attributed to the sky it ends
  under (a documented one-window approximation).

## What rides beside wetness

- **Temporary contact marks** live beside wetness in the same `BodySurfaceState`
  (`marks`, keyed by idempotency identity, `bodySurfaceMarkKinds = ["pressure"]` —
  closed; a stored unknown kind quarantines exactly like corrupt wetness). A mark is
  committed only by the body-surface transaction (`applyBodyMarkProposals` in
  `contracts/turns/chat-contact-effects.ts`) from a `BodyMarkProposal` that contact
  derives from an acknowledged committed touch — firm/moderate pressure with direct
  skin contact, primary character's body only. Marks **fade lazily on the story
  clock** (flat rate; the strongest band is gone in ~30 story minutes), reading never
  mutates, retrying the same causal event cannot double-commit, and the `marks` key is
  absent until the first commit and dropped when the last mark prunes. The commit leg
  is gated by `CHAT_CONTACT_EFFECTS` (default off, and inert without
  `CHAT_CONTACT_ACTIONS`); the read side projects committed marks into visual state as
  `body_surface.contact_mark` current-state features.
- **Deposits** are the owner's third module (`deposits`, keyed by a deterministic
  `dep:<kind>:<location>:<minute>` identity): material standing on skin or hair — mud,
  blood, dust, food, paint, cosmetic, or `unknown` when the fiction did not name it. The
  substance kinds, amount bands, freshness bands and 45-minute freshness half-life live
  in `contracts/materials/surface-deposits.ts` and are **shared outright with the garment
  store**, so mud on a sleeve and mud on the forearm beneath it are one vocabulary. Each
  entry carries a location, a fixed-point amount, the minute it landed, and a free-text
  cause; per-entry quarantine, the 12-entry bound and the absent-until-first-commit key
  rule all match `marks`. **At that bound a new identity is refused, never evicted** — one
  material-capacity law across both surface owners, so the garment store's ordinary deposit
  path drops with `garment_op.deposit_capacity` rather than destroying a material fact to
  make room. Deepening an identity that already stands still works at capacity: the check
  guards growth, not update, and explicit cleaning is what frees capacity. The parse-time
  bound on a stored deposit array is a different thing — it trims a corrupt or oversized
  blob, and never makes room for a write. Deposits are ungated, unlike marks — material on
  skin is ordinary body state, not a contact effect. The read projects as
  `body_surface.deposit` current-state features (heaviest deposit per location, banded).
  - **Material never leaves on its own.** Wetness dries and marks fade because a surface
    is returning to its resting state; a deposit is a substance, and a surface that
    quietly cleaned itself would delete material nobody removed. Only a *write* shrinks a
    deposit — an explicit removal or a conserved take (below), never the clock. In a
    removal (`reduceBodySurfaceDeposits`) everything at or under the removal floor drops,
    and a removal that names a substance leaves the others where they are. What *does* move
    with the clock is `freshness`, which drives phrasing (wet blood, drying blood, set
    blood) and nothing else — which is also why a projected deposit is the one feature
    family carrying no expiry window.
- **Conserved transfer** adds a second pair of deposit writers and a fourth key, and the
  pairs are deliberately unmistakable because picking the wrong one breaks conservation
  silently. `commitBodySurfaceDeposit` **raises to the max** — the fiction saying there is
  mud on her hands establishes *at least* that much — and `reduceBodySurfaceDeposits` is
  an explicit sink that sweeps the removal floor off every substance at a location;
  neither conserves. `takeBodySurfaceDeposit` reports **exactly what left** and does
  **not** inherit the removal floor: taking 1,000 off a 1,400 deposit leaves 400 standing,
  because the floor is washing's cleanup policy and a transfer that swept it would destroy
  the difference between what left and what arrived. `acceptBodySurfaceDeposit` **adds**,
  and refuses (`invalid_amount`/`saturated`/`quarantined`/`capacity`) rather than clamping,
  evicting, or writing over a quarantined slot — a destination that absorbs less than the
  source lost is the unowned sink the deposit law exists to prevent. Both are keyed by the
  exact deposit identity, never by location, since the removal path takes from every
  substance standing at a place and would destroy the blood while moving the mud.
- **`transfers` is a receipt record, not body state**, and it rides this owner
  deliberately: a receipt has to roll back with the DEBIT, or a half-applied transfer
  leaves a receipt claiming it happened. It is written in the same value, restored from
  the same `pre_exchange_state` anchor, and dropped by the same retake, so a key here
  inherits that boundary where a table of its own would have to be taught it. An *adding*
  credit cannot tell a retry from a second helping by looking at its own amount, so the
  transaction asks `bodySurfaceTransferCommitted` on the source surface and short-circuits
  **before any debit** (a quarantined receipt answers "committed" — skipping a beat that
  may already have happened beats debiting it twice). Receipts prune on the write path
  only, past `BODY_SURFACE_TRANSFER_RECEIPT_HORIZON_MINUTES`, and capacity
  (`BODY_SURFACE_MAX_TRANSFER_RECEIPTS`) refuses rather than evicting, because evicting a
  receipt makes the transfer it recorded runnable again. Absent until the first transfer
  commits, on the `marks`/`deposits` key rule; no migration.
- **The transfer transaction is fixture-only** (`contracts/turns/chat-contact-transfer.ts`,
  over proposals from `contracts/affordances/contact/transfer.ts`): no chat-lane producer
  resolves a source material read or an owner-addressable layer path, so nothing in
  production reaches it. It is all-or-nothing by construction — every owner is folded on a
  local copy and a refusal simply never returns them — and it verifies each credit by
  reading the owner back, so a garment or surface that clamps, evicts, or max-merges a
  conserved credit fails the settlement with a `surface_transfer.*` code instead of
  silently breaking conservation.

## The extraction

`chatArchivistSchema.environment` / `.surfaceWetness` / `.surfaceDeposits`, all on the
shared continuity leg: a partial weather patch (absent key = unchanged) and a list of
`{ location, direction, degree 1-3, cause? }`. Semantic, never numeric — the reducer
owns the delta table and clamps regardless; an unowned location drops with
`chat_surface.location_unknown`. `surfaceWetness` is carried **raw** on the aggregate
and parsed per item by `parseSurfaceWetnessProposals`, which drops malformed items and
reports the count as `chat_surface.proposal_invalid`. A record already holding
its 32 locations refuses the write with `chat_surface.wetness_capacity` rather than
passing for a quiet exchange, the deposit lane's rule exactly.

`direction` and `degree` are strict — the standing law is that **`.catch` is for
narration-affecting leaves, never for state-mutating magnitudes**, so a hallucinated
`degree: 999` fails its item instead of being repaired into a real 50% wetness change.
`cause` stays lenient (provenance only).

`surfaceDeposits` follows the same shape — `{ location, substance, direction
add/remove, degree 1-3, cause? }`, parsed per item by `parseSurfaceDepositProposals` —
with two deliberate differences. An unrecognised **substance** degrades to `unknown`
rather than failing its item, because `unknown` is a real member of the vocabulary and
something is genuinely on her hands either way. And `substance` is **optional**, where
an absent one is not the same answer as `unknown`: absent is the wildcard that removes
whatever is on the location (a general wash), while `unknown` is the substance an
unrecognised name became — so wiping the glitter off muddy hands leaves the mud. Its
locations are the everyday body
surfaces; the intimate sub-tree is excluded by construction, since it is gated per
character and would need that gate honoured on every read first. A full record refuses
with `chat_surface.deposit_capacity` rather than reporting a silent no-op.
