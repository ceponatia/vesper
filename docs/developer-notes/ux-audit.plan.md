# UX-audit remediation — plan

Status: **shipped — 2026-06-18** (on branch `ux-audit-rest`) — §1–§6, §8, §9 built and
verified (`pnpm verify` green); §7 routed to movement-authority; three follow-ups parked.
See the completion note below.

## Completion note (2026-06-18)

Built & verified on branch `ux-audit-rest` (forked to isolate from concurrent
personality-slice-2 work in the main checkout):

- **§9 quick-wins** — `late_twenties` age enum (P5); image-prompt double-period `clause()` +
  `*.color` forge steering (P4); "Generate images" hidden on empty libraries (P3); favicon
  (P7); two redundant indexes dropped (P8, migration `0006`).
- **§1 world-forge intake** — world-level `playerCharacterId` (pick existing / observer;
  migration `0007`), 0–5 location/character auto-generate counts (skip on 0), `{{player}}`
  display substitution (P2), session-wizard pre-fill + neutral "You" player name (P1),
  0-location session-start gate, `MAX_GENERATED_CAST` 3→5.
- **§2 forge canon** — staged DAG (premise+map → canonical cast → lore+items) + lore gets the
  cast (M1); one-click "Create location" remediation for dropped links (M2).
- **§3** "Generating artwork" progress surface on world detail (M7).
- **§4** faint-text token raised to WCAG AA (M6).
- **§5** post-`done` session-lock wait so back-to-back turns don't 409 (M3).
- **§6** dev Inspector surfaces tokens + intake LLM-vs-fallback (M5 measurement).
- **§8** top-level `items` in the status payload — fixed the always-empty "Items here" (P6, a
  real bug, not cosmetic).

**Routed:** §7/M4 (narration ↔ tracked-location divergence) → movement-authority work.

**Parked follow-ups:** inline-forge-a-new-player-character (§1a; pick-existing ships, forge
one in /characters then pick it); high-contrast theme toggle (§4/feature #6; the AA fix
shipped); the **M5 intake-budget tuning** itself stays gated on the §6 fallback-rate
measurement (don't tune blind). The "add to cast / drop orphan lore" remediations (§2.2) are
now largely **prevented** by feeding the canonical cast to the lore prompt.

Source: [ux-audit.intake.md](ux-audit.intake.md) — the end-to-end walkthrough (2026-06-17,
live models) that produced every finding below. PM caveats/additions:
[ux-audit.notes.md](ux-audit.notes.md). **Per the PM: every audit item not amended by the
notes is accepted as-is** — the notes are the only caveats. (Audit screenshots live in the
git-ignored `ux-audit-assets/`; they're local-only, don't cite them as durable evidence.)

This is a **triage + dispatch** plan, not one linear build: the audit spans many systems.
Each finding is either (a) built here, (b) routed to an existing plan, or (c) deferred. The
one substantial **net-new** item is the PM's world-forge intake redesign (§1) — the natural
candidate to split into its own `world-forge-intake.plan.md` when it goes active.

## Goal

Close the content-coherence, state-fidelity, and polish gaps the audit surfaced, and land
the PM's forge-intake fields — without regressing the parts the audit praised (resilient
degradation, the turn pipeline, the forges, image quality).

---

## 1. World-forge intake fields — _net-new (PM notes §1); the headline_

Today the world forge is a single prose box (`world-forge-page.tsx:21` `prompt`,
`world-forge-page.tsx:85-96` the one `<Textarea>`). The PM wants a few structured inputs
alongside the premise so authors and agents both get more signal. This also subsumes audit
feature **#1** (it relocates "player setup" from the session wizard to the **world**) and is
the fix path for **P1**/**P2**.

### 1a. Player character (world-level)

A "play as" picker on the intake page, with three outcomes:

- **Pick an existing library character** — embodied; that character is the player.
- **Forge a new player character inline** — embodied; the PM explicitly wants generation of
  an embodied player available here, not just selection.
- **Leave blank ⇒ observer** (the default). Per the PM amendment, **observers need no
  persona** — they only inject narrative direction, so drop the audit's "optional persona"
  idea for the unembodied case (an embodied player's persona is just its character profile).

Plumbing:
- Persist on the world: add `playerCharacterId text` to `worlds` (`schema.ts:148-170`,
  alongside the existing `playerStartWorldLocationId` at `:164`). `null` ⇒ observer default.
  Editable after generation in the world editor (PM: "can be changed after the world is
  generated").
- **Resolves P2** — `{{player}}` display substitution. Current behavior is *intentional*:
  library/editor views show the raw token because resolution is per-session
  (`authoring.md` §"The `{{player}}` token"). New rule: **when a world defines
  `playerCharacterId`, world-detail/library display substitutes the token with that
  character's name**; worlds with no defined player keep the raw token.
- **Resolves P1** — the new-session wizard (`new-session-wizard.tsx:30-46`, which already has
  embodied/observer + `playerCharacterId` selection) **pre-fills from the world default**.
  And `bundlePlayerName`/`loadPlayerSeed` (`bundle.ts:216-218`, `spawn.ts:511-538`) must
  **never fall back to the account name**: an embodied player with no character resolves to a
  neutral default ("you"/the protagonist), not "UX Tester".
- **Resolved (2026-06-18):** the world's `playerCharacterId` is a **changeable default**,
  not a lock. The new-session wizard pre-fills from it and **keeps its per-session override**
  (the existing embodiment step at `new-session-wizard.tsx:127-203` stays) — so a one-off
  observer run or an alternate-character playthrough just works. The session bundle still
  resolves the *session's* player, not the world's.

### 1b. Auto-generate counts

Two dropdowns, **0–5 each** (PM: "for now"): number of locations, number of characters.
Forge-time inputs threaded into `forgeWorld` (`world-forge.ts:78-94`), **not** persisted
world columns.

- Replaces the hardcoded ranges: locations "4–10" (`world-forge.ts:337`, `LOCATIONS_SYSTEM`)
  and cast "1–3" (`world-forge.ts:577`, `CAST_SYSTEM`).
- **Defaults (resolved 2026-06-18):** characters **0–5, default 3** — a 5-cast world is a
  deliberate opt-in, not the norm; lift `MAX_GENERATED_CAST` from 3 to **5**
  (`world-from-draft.ts:27`) so the dropdown's max is actually honored. Locations 0–5 too;
  pick a sensible default (suggest **4**, the low end of today's 4–10 range).
- **0 is allowed** (PM: authors may import a full existing set) ⇒ skip that family's
  generation. Guard the dependents: the locations agent's "connected / no orphans"
  validation must accept an empty map, and cast/items that reference locations must tolerate
  zero locations.
- **0 locations (resolved 2026-06-18):** the forge **creates the world empty** — no places —
  and the author adds or imports locations afterward in the editor. A **session cannot start
  until ≥1 location exists** (an embodied player needs somewhere to stand); gate *session
  creation* (`spawn.ts` `createSessionFromWorld`), not the world save.

---

## 2. Forge canon & one-click remediation — _M1, M2; audit feature #2_

The parallel section-agents share no character/location bible, so they disagree:

- **M1** — premise/lore describe Akari=proprietress, Kaito=painter, Genzo=caretaker, but the
  saved cast is Kaito=writer, Akari=geisha, Ren=chef, and **Genzo is never created** (yet
  secret lore + a narrated NPC reference him). No shared canon across agents.
- **M2** — a hot-spring world forged **no bath**; three location links pointed at a missing
  "The Grand Onsen Bath" (caught as `dropped link … no such location` diagnostics, but
  un-actionable).

Build:
1. **Canonical cast/location bible first** — generate the cast list (sized by §1b's
   character count) and the location set up front, then pass them to the lore/items/map
   agents so cross-references resolve against real entities. This is a **sequencing change**
   to today's fully-parallel fan-out (`world-forge.ts` `worldForgeSections`); it composes
   naturally with §1b (the counts feed the canonical pass).
2. **Actionable diagnostics** — when a dropped link names a missing location, offer
   **"Create this location"** inline; for orphan lore about a non-existent character, offer
   **"add to cast" / "drop orphan lore"**. Extends the existing severity-aware diagnostic
   list (`components/forge/diagnostic-list.tsx`, `authoring.md` §Guardrails).
3. Map-agent self-validation: every referenced location must exist before the section
   returns (belt-and-suspenders behind #1).

---

## 3. Background-work progress surface — _M7; audit feature #3_

On world save, one `world_backfill` job generates ~35 entity images + cast avatars
**sequentially** (observed 85s+), but the UI shows bare monogram placeholders with no hint
art is coming. Add a global, unobtrusive **"Generating artwork… (n/total)"** indicator +
per-entity shimmer until each asset is `ready`. (Surfaces the work the audit already
confirmed succeeds — 40 images, 0 failures.)

## 4. Accessibility contrast + high-contrast theme — _M6; audit feature #6_

Lighthouse a11y **95**; the one failure is `color-contrast`. Offender: the dark theme's
secondary-text tokens (`text-paper-500`/`paper-400`) on dark cards — labels, hints, meter
captions, relationship sub-text. Raise the secondary tokens to ≥4.5:1 (≥3:1 large), and/or
add the high-contrast theme toggle (feature #6) that lifts them.

## 5. Turn concurrency: post-`done` session-lock window — _M3_

After the SSE `done` fires, the per-session turn lock is held ~8–10s for post-turn
persistence/extraction, so a back-to-back turn gets `409 session_busy` (one probe saw the
lock held +0.15s→+8.36s after `done`). The browser hides it (composer stays disabled) but
API clients and rapid-Enter paths hit it. Fix: expose an explicit **readiness** signal the
UI already gates on (verify composer stays disabled until truly `ready`, not just stream
close), document the post-`done` window for API consumers, and consider **queueing** a
second turn instead of rejecting. (See `turn-engine.md`, `streaming-api.md`.)

## 6. Intake budget + dev turn HUD — _M5; audit feature #7_

Turn 1 logged `agent.intake.timeout — intake exceeded 1500ms; using regex fallback` (likely
aggravated by the concurrent load test). If it fires often, the intake LLM is paid-for but
unused. **Measure the fallback hit-rate first** (don't tune blind), then raise the budget,
make intake non-blocking, or drop it.

> **Measured (2026-06-18):** the hit-rate is **91% fallback** (31/34 player turns time out),
> and the investigation found two root causes beyond budget — the intake model burning its
> time/token budget on reasoning, and an orphaned post-timeout call leaking `error`-level
> diagnostics onto already-successful turns. Full analysis + ordered fixes in
> [pre-narrator-agents.followups.md](pre-narrator-agents.followups.md). The budget re-tune
> below (#5 there) stays gated on the HUD, but it should run *after* the reasoning fix, not
> before — most of the timeouts are not a budget problem. Surface it via the **dev turn HUD** (feature #7,
dev-only): per-turn token usage + latency + intake-timeout rate, all already in the
`/inspect` payload. **Cross-ref:** the personality plan adds `socialAct` tagging to this same
intake agent ([personality-and-state.plan.md](personality-and-state.plan.md) §1.3) — more
intake work means this budget call matters more; coordinate.

## 7. Narration ↔ tracked-location divergence — _M4; route out_

A Director turn narrated the player into "a small guest room" the map doesn't have; the
world-model kept location = Main Hallway (and the scene image correctly rendered the
hallway — state, not prose). Options: constrain narration to known locations, snap to the
nearest node, mint an ad-hoc location, or at minimum emit a continuity diagnostic.
**Route to** the movement/world-simulation work
([movement-authority.spec.md](movement-authority.spec.md), roadmap "Next") rather than
solving in isolation — it's the same authority problem.

## 8. Item-placement → world-state surfacing — _P6; verify_

World tab showed "Items here: Nothing of note." for Main Hallway despite Wooden
Bench/Paper Lantern/Snow Shovel being placed there. Verify the placement → session
world-state path; likely a real bug, not cosmetic. (See `turn-engine.md` world-state
assembly + `authoring.md` item placements.)

## 9. Quick-wins batch — _trivial polish_

Low-risk, ship in one pass (fold into the next major commit per `CLAUDE.md` git rule):

- **P5** — add `late_twenties` to the `apparent_age` enum (a **registry data edit**, the
  blessed one-file extension point; the model's natural output was being dropped as invalid).
  Map other near-synonyms while there.
- **P4** — forge free-text "color" fields accept non-colors ("Tail color: *slender*") that
  leak into image prompts; and a cosmetic double-period (`…sharp fangs..`) in the prompt
  join. Normalize/validate (or enum-ify) the color fields and fix the join punctuation.
- **P3** — hide/disable the "Generate images" batch button on **empty** Locations/Items
  libraries (nothing to generate).
- **P7** — `favicon.ico` 404 (only console error in the whole run).
- **P8** — drop the two redundant indexes: `participant_relationships_session_idx` (covered
  by `…_edge_unique`) and `session_participants_session_idx` (covered by `…_name_unique`).
  Via the migration workflow (`schema.ts` → `db:generate` → review → `db:migrate`), never
  `drizzle-kit push`.

---

## Routed / deferred audit features (§6)

| Audit feature | Disposition |
|---|---|
| #1 Player setup in session wizard | **Relocated to §1a** (world-level, per PM notes). |
| #2 Forge consistency + remediation | **§2.** |
| #3 Background-work progress | **§3.** |
| #4 Relationship & meter timeline | **Defer** → [deferred.plan.md](deferred.plan.md). Agent outputs already carry per-turn affinity/meter deltas; render a Cast-panel sparkline. Pairs with the affinity-levels work in [personality-and-state.plan.md](personality-and-state.plan.md) §4, but that plan is **mid-build** — parked separately, promote alongside it. |
| #5 Map view | **Route** → existing [world-map.plan.md](world-map.plan.md) (roadmap "Next"). Would have made **M2** obvious; bump its priority given the forge-canon work. |
| #6 High-contrast theme | **§4.** |
| #7 Dev turn HUD | **§6.** |
| #8 Transcript export | **Defer** → [deferred.plan.md](deferred.plan.md). |
| #9 Scene "pin / set as cover" | **Defer** → [deferred.plan.md](deferred.plan.md). |
| #10 First-run guided tour | **Defer** → [deferred.plan.md](deferred.plan.md). |

Also recommended by the audit and **parked in [deferred.plan.md](deferred.plan.md)** (not
blocking): a **production-build** Lighthouse-perf + trace pass on the dashboard and the play
screen — the audit deliberately skipped perf because the dev Turbopack build isn't
representative.

## Suggested build order

Roadmap owns cross-plan priority — this is the intra-plan proposal: **§9 quick-wins**
(trivial, anytime) → **§1 forge intake** (headline; gates §2's canonical pass) → **§2 forge
canon** → **§3 progress surface** → **§4 contrast** → **§5 lock window** → **§6 intake
budget/HUD** → **§8 P6 verify**; **§7/M4** rides the movement-authority plan, **feature #5**
rides world-map, and **features #4/#8/#9/#10** + the perf pass are parked in
[deferred.plan.md](deferred.plan.md).

## Open questions

The three forge-intake forks — **player authority**, **cast cap**, and **0-count
semantics** — were **resolved 2026-06-18** (rulings recorded inline in §1). Remaining:

- **Intake budget (§6).** Don't pick a fix until the fallback hit-rate is measured — gate the
  M5 decision on that number. (Not a product call; an engineering gate.)
