# Resilience closures — time-box every model call, one contract per boundary

Status: next (queued after the active narrator-physical-guidance files are quiet; review rulings recorded 2026-07-30)

## Why

[docs/resilience.md](../resilience.md) opens with a prime directive: an error may
degrade a turn, it must never disrupt the game. The chat reply path honours that
completely — every model call there is time-boxed, every failure recorded, and the
Agent health panel shows the owner which legs are dying and how slow the living
ones are.

**Nothing outside that path is covered.** C12 found seven model calls in the rest
of the app — character forge, the portrait attribute read, item classification, and
the scene composer — with **no time limit and no telemetry at all**. Each already
has a sensible degraded fallback sitting right there; they simply never get to use
it, because nothing ever gives up waiting. So a slow or wedged provider turns
"forge this character" or "render this scene" into a spinner that runs until the
socket dies, the user gets no explanation, and afterwards there is no record that
anything went wrong. The scene composer runs on **every** scene render, so this is
not a rare path.

Coverage stopped at the chat lane because "call a cheap model safely" is
hand-assembled at each site rather than being a thing you call. B4 counts five
copies inside the chat engine alone, four of which quietly dropped the telemetry
half — including chat summary, which has **no timeout whatsoever and silently bills
the expensive narrator model** for a background job. So the fix and the cleanup are
one piece of work: build the harness once, and everything that should have been
wrapped can be wrapped in a line.

Three smaller closures ride along, all violations of rules the codebase already
states. Two places read a message's stored metadata with a raw type cast instead of
parsing it (B2) — the one thing resilience.md §1 says never to do — while a schema
for that exact field sits a module away. Degraded fallbacks are hand-typed at four
call sites (B5) rather than coming from a constructor beside the schema, which is
how the correct version one function over already works. And a 303-line
garment-blueprint validator is never called in production (E3), so its structural
rules are unenforced anywhere a real row enters the system.

**What the owner gets:** long-running authoring and image features that fail
politely instead of hanging, one place that records every model call's health across
the whole app rather than just chat, and three "we already have a rule for this"
gaps closed. Batch 1 of ~11 derived from the audit, and the only one carrying
correctness weight; the audit's §Proposed batches has the full map.

## Scope

Finding ids below; [the audit](codebase-efficiency.audit.md) carries the
file-and-line detail.

- **C12** — Seven model calls outside the chat engine (character forge ×3,
  portrait attributes, item classify ×2, scene composer) have no timeout and are
  never recorded when they fail.
- **B4** — The "call a cheap model with a fallback" recipe is copy-pasted at five
  chat-engine sites, four of which lost the failure telemetry and one of which has
  no timeout and uses the wrong (expensive) model; the fix is one shared harness
  so telemetry comes free, and C12's wrapping rides the same harness.
- **B2** — A chat message's stored metadata has four partial schemas, two raw
  casts, and no single contract; one schema plus an empty constructor replaces all
  of them.
- **B5** — Degraded fallbacks are hand-listed at four call sites instead of coming
  from constructors that live next to the schema.
- **E3** — The garment-blueprint validator never runs on the path where blueprint
  data actually enters the database, so its structural rules are unenforced —
  wire it or delete it (owner ruling needed, OQ1).

## Non-goals

- **Not** reworking the validate → repair → degrade ladder itself
  ([resilience.md](../resilience.md) §3). It is correct; this plan only ensures
  every caller is bounded and observed.
- **Not** adding, removing, or retuning any agent leg. No prompt, schema, or output
  changes, and nothing new is asked of any model. Chat summary gets a timeout and an
  explicit cheap model; whether its output is any *good* is a separate question.
- **Not** new UI. The Agent health panel already renders whatever gets recorded.
- **Not** the ChatState single-source rework (B1) — it pairs naturally with B2 and
  gets cheaper if B2 lands first, but it is its own plan.
- **Not** the other audit batches. Later batches assume this harness exists; none of
  their dedup work is in scope here.

## Review rulings and scope adjustments — 2026-07-30

- **Wire the garment-blueprint validator; do not delete it.** First census existing
  stored blueprints. Invalid historical data must degrade with diagnostics rather
  than crash a read, while new writes must not admit cyclic, orphaned, or otherwise
  graph-invalid garments. This is foundational correctness for the clothing-state
  and affordance work, not optional cleanup.
- **Keep the shared model-leg harness narrow.** It owns the targeted non-streaming,
  structured or background LLM legs. Streaming narration and image-provider calls
  keep their own lifecycle and are not forced through an extractor-shaped wrapper.
- **Give non-chat telemetry a run identity.** Forge, classification, and other
  background work report against an app-wide run context with optional chat linkage;
  they are not invented as conversation events merely to fit the current inspector.
- The meta contract covers both legacy-chat metadata and the successor lane's
  `simTurn` key. The existing `runExtractorLeg` is promoted rather than replaced.

## Delivery slices

Ordered; each lands on its own.

1. **The shared harness.** Promote the chat engine's local leg-runner into a
   proper `runAgentLeg` in the AI layer: one call takes the prompt, the schema,
   the fallback, a time budget, and a diagnostic code, and gets timeout handling
   plus failure/latency recording **by construction**. Migrate the five existing
   chat sites onto it. Behaviour is unchanged except that the four
   telemetry-losing sites start reporting, and chat summary gains a time budget
   and an explicitly named cheap model. (B4)
2. **Time-box the rest of the app.** Put the four outside-the-engine features on
   the harness with per-feature budgets — generous on authoring paths where a long
   wait is legitimate, tight on the scene-render path that a player is watching.
   Each site already has its degraded default, so this only bounds the wait and
   records the miss. (C12)
3. **One message-metadata contract.** A single schema plus an empty constructor in
   the turns contracts, consumed by every reader and writer — the two raw casts,
   the pipeline's partial parsers, and the client. Must cover the successor lane's
   own metadata key as well as the chat lane's, so both lanes stop describing the
   same column differently. (B2)
4. **Fallbacks move next to their schema.** Export the three missing degraded
   constructors and delete the hand-listed copies at the call sites. (B5)
5. **Garment blueprint invariants — wire or delete.** Gated on OQ1. If wired,
   preceded by a read-only census of live rows so we know what would newly
   degrade; if deleted, the module and its test go together. (E3)

Slice 1 unblocks slice 2. Slices 3 and 4 are independent of both and of each
other. Slice 5 is independent and blocked only on the ruling.

## Success criteria

- The full gate passes, run as **separate sequential commands** (never
  `pnpm verify`): `pnpm lint` → `pnpm lint:cycles` → `pnpm typecheck` →
  `pnpm test` → `pnpm jscpd`.
- **Every model call reachable from a request goes through the harness.** Verified
  by a census check, not by eyeball — the audit found this class of gap by
  grepping, and the same grep should come back empty afterwards.
- **A hung provider produces a bounded response.** With generation stubbed to
  never resolve, forge, item classify, and scene render each return their degraded
  result within their stated budget, and each leaves a recorded failure. Per
  [resilience.md](../resilience.md) §8 these tests assert the fallback **and** the
  diagnostic code.
- **No raw casts left on message metadata** — every read of that column parses
  through the new schema.
- **On Fly** (the UI-testing surface): forge a character and render a scene with a
  real key, then confirm both appear in the Agent health panel with latency, and
  that the forge page shows a real failure message rather than an endless spinner
  when its budget is exceeded.

## Risks & coordination

- **The active narrator-physical-guidance build.** None of this plan's files are in
  that build's affordances area, but slices 1 and 3 touch chat-state and
  chat-pipeline, which that build is editing. Sequence after its edits there settle,
  or agree the diff up front.
- **Budgets are a product decision, not a constant.** Character forge is *supposed*
  to take a long time; a chat-sized budget would break a working feature. Each site
  needs its own number from observed latency; scene render is the only tight one.
- **E3 changes what corrupt data degrades to.** Wiring the validator means a row that
  loads (badly) today may come back empty instead. That is the resilient answer, but
  it is a visible behaviour change and needs slice 5's census before it flips.
- **Non-chat failures need somewhere to land.** The existing failure record is keyed
  to a conversation; forge and item classify have none (OQ2). Worst case they are
  counted in the all-app tally without a per-chat home — still better than today.
- **Overlap with B1.** B2's schema wants the same contracts folder B1 would move
  ChatState's schema into. Landing B2 first helps; just don't pre-build B1 here.

## Open questions

- **OQ1.** Which model should chat summary use once its accidental use of the
  narrator model is removed: the standard cheap agent model, or a dedicated
  summary-model setting?
- **OQ2.** Should the targeted harness census be enforced by a test/lint gate, or
  remain a convention? The review recommends an automated census because the
  original gap survived convention alone.

Harness signatures, budgets, diagnostic codes, and the census mechanism belong
in `resilience-closures.spec.md`, written when the build starts.
