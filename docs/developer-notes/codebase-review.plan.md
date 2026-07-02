# Codebase review — batch 1: correctness & security fixes

Status: **shipped — 2026-07-02**

**Completion note.** All 17 items landed in one pass; `pnpm verify` (1648 pure
tests) + the full int suite (172) green; no migration needed. Implementation
notes beyond the rulings: A2 took the "prefer" shape — `saveChatState` /
`persistChatState` collapsed into one `upsertChatState` so the column list
exists once; A6 + A8 ride a new shared `engine/keyed-lock.ts` (`tryKeyedLock` →
409 `chat_busy` on the chat POST, `withKeyedLock` serializing summary folds —
A8's "claim-time recheck" became lock-serialization: the second fold's own
recompute no-ops under the lock, no partial index); the chat lock releases via
a new guaranteed `onSettled` hook on `streamReply` (the persist callback alone
is skipped on empty replies); the transactional Clear threads a new `DbWriter`
executor type through `deleteChatState`/`deleteChatMemory`/
`delete{Facts,Episodes}ForScope`; item 14 added `pipLabel` to the meters
registry thresholds + shared `MOOD_BRIGHT_MIN`/`MOOD_LOW_MAX` (chip bounds now
strict-compare, aligning the strip exactly with narration cues); item 3 carries
the taste-raise semantics in the axis doc line + prior-brief render (`taste`
added to all example exposures as the field's shape). Punted to batch 3 (as
planned): relocating the chat lock into a `submitChatMessage` extraction.
Docs touched: auth.md (secret boot-check + seed guard), contracts/conditions.md
(label is the match key), contracts/meters-actions.md (`pipLabel`).

Source: [codebase-review.md](codebase-review.md) §A–B (the 2026-07-02
five-agent review of the Opus-era diff). This plan is batch 1 of four; batches
2–4 (§C prompt intelligence, §D chat-lane consolidation, §E dedup sweep) get
their own topic plans when picked up.

## Why this batch first

Three findings silently flatten gameplay systems that were designed, built,
and tested (A1 condition→mood, A2 chat social cards, A3 taste exposure); the
rest are small data-loss/race edges and the security trio worth closing before
more public exposure on Fly. Everything here is independent of the later
refactor batches — fixes are made in place, minimal shape.

## Work items

Effort tags S/M; finding ids reference [codebase-review.md](codebase-review.md).

### Silent gameplay bugs

1. **Condition→mood keying (A1, S).** Key `CONDITION_MOOD_BASELINE_SHIFTS`
   (`contracts/mood/events.ts`) and the tipsy/flustered tint sets
   (`contracts/mood/projection.ts`) by **normalized label** via one shared
   condition-key helper in the conditions contract (matching
   `conditions/catalog.ts` / `perception/darkness.ts` behavior). Update
   `events.test.ts` / `projection.test.ts` to use realistic random ids (they
   currently set `id === label`, masking the bug) + a regression test
   asserting a `newId()`-style condition still shifts/tints. *Don't
   gold-plate:* folding the four condition tables into `CONDITION_CATALOG` is
   batch 4 (E-K1); here only fix the keying.
2. **Chat first exchange drops seeded cards + outfit (A2, S).** Add `outfit`,
   `outfit_exposed`, `active_social_cards` to `saveChatState`'s guarded insert
   **and** its on-conflict update (`server/engine/chat-state.ts` ~:600).
   Prefer collapsing `saveChatState`/`persistChatState` into one code path
   with an optional `guardMessageId` if it stays readable. Int test: fresh
   chat with a carded character → first exchange → `loadChatState` returns the
   seeded cards and outfit fields.
3. **Director prompt: surface the `taste` axis (A3, S).** Extend the exposure
   doc line in `prompts/agents.ts` (taste `none|close|intimate` — earned only
   at oral contact, kept raised while such intimacy continues), render taste
   in the prior-brief exposure line, raise it in one worked example. Schema
   already carries it. Prompt-builder test asserts both renders.

### Data-loss / race / degradation edges

4. **Batch image routes: 400 on malformed body (A4, S).**
   `items/images/route.ts` + `locations/images/route.ts`: `if (!body.ok)
   return body.response;`, drop the schema-level `.catch({})`. Test: invalid
   JSON → 400, zero jobs enqueued. (Route-factory dedup of the twins is E-S3.)
5. **Provenance `.catch` on trait + attribute values (A5, S).**
   `traits/value.ts` and `attributes/value.ts`: leaf-`.catch` the `source`
   enum so one bad entry can't reject a whole profile at the JSONB boundary
   (resilience §3). Degradation test: malformed `source` on one entry →
   parses with default, siblings intact, no profile-level fallback.
6. **Chat exchange concurrency guard (A6, M).** In-process per-
   `(ownerId, characterId)` mutex on the chat POST; second concurrent exchange
   gets 409 `chat_busy` (mirrors the session lane's `narrating` CAS). Unit
   test the mutex; route test the 409. Relocates into `submitChatMessage`
   when batch 3 extracts it (leave a pointer comment).
7. **Finalizer: memory-write failure must not discard state (A7, S).** Wrap
   `writeChatMemory` in its own try/diagnostic (`chat.memory.write_failed`)
   inside `finalizeChatState` so `saveChatState` always runs. Degradation
   test asserts state persisted + the diagnostic code.
8. **Chat summary fold enqueue race (A8, S).** Prefer a claim-time watermark
   recheck (no migration) over a partial unique index; decide at
   implementation whichever is smaller. Test: double enqueue → one fold.
9. **Chat Clear in one transaction (A9, S).** Wrap the five deletes in the
   chat DELETE route in `db().transaction`.

### Security

10. **Seed credential production guard (B1, S).** `ensureDevCredential`
    refuses (skip + loud warning) when `NODE_ENV === "production"` and
    `DEV_PASSWORD` is unset; dev keeps the zero-config default (CLAUDE.md dev
    flow unchanged).
11. **`BETTER_AUTH_SECRET` hard-fail (B2, S).** Throw at auth init when
    production && missing. Confirm `docs/auth.md` / `docs/deployment.md` state
    the requirement.
12. **Strict model-id resolvers (B3, S).** `narrativeModelId` /
    `agentModelId` (`server/ai/provider.ts`) and the chat-model resolution
    validate against the curated lists; unknown slug ⇒ curated default + a
    `warn` diagnostic. Covers world PATCH, `characters.chatModel`, and the
    chat POST `model` param at one seam. Unit tests: curated passes, junk →
    default + diagnostic.
13. **`dev/me` gate order (B4, S).** Production 404 before `withUser`,
    matching the other dev routes.

### Client-side small fixes (A10, each S)

14. `character-chat.tsx` `meterPips` — derive pip bands from
    `contracts/meters/registry.ts` thresholds instead of hardcoded numbers.
15. `entity-library.tsx` search debounce — timer in a `useRef`, cleared on
    unmount.
16. `image-lightbox.tsx` — use the shared `useFocusTrap`.
17. `character-edit-page.tsx` `saveChatModel` — generation-ref guard so rapid
    picks can't persist out of order.

## Rulings (recorded at planning, 2026-07-02)

1. **saveChatState on-conflict updates the outfit trio too** — they ride the
   loaded state exactly like `premise`; the current divergence reads as
   omission, not design.
2. **Model-id validation coerces to the curated default (+ diagnostic), not
   400** — matches the client `resolveChatModelId` and the degrade-don't-fail
   convention; the UI only offers curated ids, so anything else is
   out-of-contract.
3. **Fix the Fable-era `attributeValueSchema` gap alongside the trait one** —
   same boundary, two lines.
4. **Seed guard is production-scoped** — dev ergonomics (zero-config default
   password) unchanged.
5. **The chat mutex is in-process** — correct on the single-machine Fly
   deploy; revisit if machines scale past one (note in a code comment).

## Open questions

None — the rulings above cover the judgment calls.

## Out of scope (later batches)

Condition-catalog consolidation (E-K1), chat route→engine extraction and the
shared §6/timeout/SSE machinery (§D), the prompt-intelligence pass (§C), the
route-factory and UI-hook dedup (§E). See the batch map in
[codebase-review.md](codebase-review.md).

## Acceptance

- `pnpm verify` green; every item lands with its test (degradation tests
  assert diagnostic codes per docs/testing.md).
- Doc updates ride the same change where behavior shifts (auth/deployment for
  B1–B2; the mood contracts doc if it documents id keying).
- On completion: roadmap entry → **Shipped**, this plan → `shipped — <date>`
  with a completion note naming anything punted and where it went.
