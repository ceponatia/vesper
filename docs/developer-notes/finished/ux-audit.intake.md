# Vesper — UI/UX Audit

**Date:** 2026-06-17 · **Build:** local dev (`pnpm dev`, Next.js 16 / Turbopack, port 3200) · **AI:** live OpenRouter + Venice keys (real models) · **Auditor:** automated end-to-end walkthrough via Playwright + chrome-devtools + Postgres inspection.

Screenshots referenced below live in `ux-audit-assets/` (this report's sibling folder). That folder is **git-ignored on purpose** — the screenshots embed app-generated imagery, which stays local to the server and is never committed/pushed. View them on the dev box; they won't travel with the repo.

---

## 1. Executive summary

Vesper is in remarkably good shape for an app in active development. A brand-new user can go from an empty account to a richly simulated, image-illustrated romance session in minutes, and the experience is **polished, resilient, and genuinely impressive** — the authoring forges, the streaming turn pipeline, the world-model state machine, and the image pipelines all work end-to-end with high output quality.

The strongest, most differentiated parts are: the **AI world/character forges** (breadth + editability), the **turn pipeline** (streaming narration + parallel state agents + visible diagnostics), and **resilience** (graceful degradation surfaced everywhere, never a hard failure). Across an entire multi-system session — two forges, ~13 turns, chat, 40 generated images, and a 4-way concurrent load test — there were **zero uncaught JS errors** (only a `favicon.ico` 404) and **zero failed background jobs**.

The issues worth attention are mostly **content-coherence and state-fidelity** gaps in the generative layer, plus a handful of polish items:

- The world forge's parallel section-agents **disagree on the cast** (lore/premise describe characters that aren't in the saved cast, and vice-versa).
- The defining premise feature (the onsen bath) was **silently dropped** from the map.
- **Narration can move the player to places the world-model doesn't track**, desyncing prose from state.
- A **session lock lingers ~8–10s after a turn's stream ends**, causing 409s for rapid/API-driven turns.
- **Dim secondary text fails WCAG contrast** on the dark theme.

None of these are blockers; all are addressable.

**Scores (Lighthouse, dashboard, desktop):** Accessibility **95**, Best Practices **100**, SEO **100**.

---

## 2. Methodology & scope

To exercise the genuine first-run experience, I created a fresh admin user (`uxtest-main@vesper.local`) via the dev-user switch, giving a truly empty library, and **built everything from scratch** — no seed assets used.

**Assets created during the audit**

- **World:** _Tsukikage Onsen_ — a snowbound mountain hot-spring inn (forged from a prose premise; 8 locations incl. one I added by hand, 13 lore chunks, 3 cast, 27 item placements, 4 norms, calendar).
- **Cast (forged on save):** Kaito, Ren, Akari.
- **Standalone character:** _Lysandra Vane_, a succubus (to exercise species inference, intimate anatomy, body features, and the uncensored image route).
- **Session:** _Snowbound — Opening Night_ — 3 turns across all author modes (player / director / companion).
- **Images:** world backfill (8 locations + 27 items), 4 avatars (3 cast + succubus), 1 session scene, 1 chat scene → **40 images, 0 failures**.
- **Chat:** a sessionless conversation with Lysandra + a chat scene image.

**Coverage:** empty states; world forge (all 5 tabs + add-location + save); character forge (all 6 tabs + intimate/body toggles); portrait studio (uncensored avatar); play screen (streaming, 3 author modes, Scene/Cast/World/Inspector panels, scene image, lightbox, message controls); in-character chat; gallery (filter, lightbox, delete); populated libraries; responsive/mobile drawer; accessibility + best-practices audit; DB integrity + health; and a **4-way concurrent load test** (3 background API agents driving the turn pipeline while I played in the browser).

**Tools:** Playwright MCP (primary driver), chrome-devtools MCP (Lighthouse), Postgres MCP (data integrity + health), the dev-only **Inspector** panel and `/api/.../inspect` (per-turn agent diagnostics).

**Not covered / caveats:** detailed performance benchmarking was intentionally skipped — this is a Turbopack **dev** build, so timing numbers wouldn't represent production (recommend a production-build Lighthouse-perf pass). Edit/Rerun/Delete message controls were confirmed present and reachable but not mutated (to avoid long reconcile cycles under load). World Edit/Duplicate/Delete buttons were observed but not exercised.

---

## 3. What works well

**First-run & information architecture**

- Empty states are consistent and inviting across every page (dashboard hero "Welcome to Vesper", per-section "No worlds/characters/locations yet" with a clear primary CTA). See `01-dashboard-empty.png`.
- Navigation is simple and predictable (Worlds / Characters / Locations / Items / Gallery); the new-session wizard smartly skips the world-selection step when arriving from a world (`?worldId=`).

**World forge** (`02-world-forge-draft.png`, `03-world-detail.png`)

- Exceptional breadth from a single prose premise: name, calendar start, synopsis, style directives, narrator guidance, **social norms with severities**, 7–8 locations (scale/area/ambient/undirected links), 13 lore chunks (category / tier `always·scene·retrieval` / visibility / **secrets wired to unlock-tag discovery arcs**), cast with **relationship stages**, and 27 item placements (kind / location / cast / `worn`).
- The editors are excellent: drag-reorder with disabled boundary states, per-section **regenerate**, copy, filtered "add link" dropdowns, live cross-references (a new location instantly appears in other rooms' link menus and in cast "starts at").

**Character forge & attributes** (`07-character-forge-draft.png`, `08-succubus-avatar.png`)

- Species **correctly inferred** ("succubus") and seeded the right morphology: horns, membranous wings, reptilian tail, fangs.
- The **mature/intimate system works as designed**: Body-configuration toggles (breasts/vulva on; penis/testicles off) and Body-features toggles (wings/horns/tail) unlock the right attribute groups; each attribute carries an **"AI" provenance badge + clear** affordance; fantasy options are first-class (crimson skin, solid-black eyes, fanged teeth).

**Turn pipeline & world model** (`04-play-first-turn.png`)

- Narration quality is high and on-style; streaming UX is clear ("The narrator considers… / is writing…", disabled composer, speaker bubbles for each NPC).
- All three author modes work and are context-aware (Director placeholder "Direct the story (out of world)…"; Companion shows a speaker dropdown scoped to **present** NPCs only).
- The world model is real: forged **norms are enforced in narration** (Akari makes you remove outdoor footwear), meters drift over time (Energy 90→89, Hygiene 90→89), the **clock advances** ("4:10pm · +2m · 10 minutes into the story"), **bidirectional relationship perception** ("Acquaintance toward you / thinks you're acquaintance toward them"), and the director agent spawns **story threads**. Narrator + agent **models are switchable mid-session**.
- The dev **Inspector** is a standout: per-turn agent results (clock/director/simulant/archivist/continuity), diagnostics, and retrieval events — e.g. the simulant emitted structured activity/posture/salience per participant, `minutesAdvanced: 3`, and a `stress −0.05` meter adjustment "entering the warm hallway and being welcomed".

**Image pipelines** (`05-scene-image-generated.png`, `06-scene-lightbox.png`, `09-locations-library.png`)

- **40 images generated, 0 failures.** Scene image was photoreal and **state-accurate** (rendered Akari in her actual yukata at her actual location — it followed world-state, not prose). Location backfill produced fitting establishing shots for all 8 rooms.
- **Exposure-gating is correct**: the succubus avatar rendered fully clothed (corset + skirt) despite intimate anatomy being configured, because the outfit covers — the avatar prompt is transparent and shows the "Wearing (authoritative…)" clause driving this. The **uncensored Venice route** works and renders non-human morphology faithfully.

**In-character chat** — faithful to the character's attributes, voice, and personality; sessionless; integrates cleanly with the gallery's "Character chats" group.

**Gallery** (`10-gallery.png`) — grouped by session and "Character chats", filterable by world/character, lightbox enlarge, and **delete with a clear confirmation** that reactively updates filters.

**Resilience** (a mandated project principle, and it shows): every degradation was **caught, defaulted, and surfaced** rather than failing — dropped invalid map links, a dropped out-of-enum attribute, the intake agent timing out and falling back to regex, a benign spawn self-reference, and a `400 invalid_body` for empty input. This is the system's best quality.

**Reliability under load** — see §5. Zero 5xx, zero malformed streams, all turns reached `ready`.

**Robustness** — across the whole session the only console error was `favicon.ico` 404; no JS exceptions, failed fetches, or React warnings.

**Responsive** (`11-dashboard-mobile.png`, `12-play-mobile-drawer.png`) — at 390px the play screen collapses the side panel into a clean full-screen drawer (tabs + scene image + cast meters), and the dashboard reflows well.

---

## 4. What needs improvement

Severity: **Major** (hurts core experience) · **Medium** (notable, not blocking) · **Minor/Polish**.

### Major

**M1. World-forge section agents disagree on the cast (no shared canon).**
The Premise/Synopsis and Lore describe _Akari = proprietress, Kaito = painter, Genzo = caretaker_, but the saved **Cast** is _Kaito = writer, Akari = geisha entertainer, Ren = chef_, and **Genzo is never created**. There are even secret lore chunks about Genzo ("Genzo's Past Affection") and Akari's parents — attached to a character who doesn't exist in the cast. The parallel section-agents clearly don't share a character bible.
_Evidence:_ Cast tab vs Lore table in `02-world-forge-draft.png` / `03-world-detail.png`; in play, the narrator referenced _"The caretaker, Genzo, confirmed it…"_ — a phantom NPC.
_Suggested fix:_ generate a canonical cast list first and pass it to the map/lore/items agents; or add a post-forge reconciler that aligns names and emits a "cast/lore mismatch" diagnostic with a one-click "add missing cast member / drop orphan lore".

**M2. The defining premise feature was silently dropped from the map.**
For a hot-spring-inn world, the forge produced **no bath location** — three location links pointed at a non-existent "The Grand Onsen Bath". The diagnostics caught and surfaced it ("dropped link … no such location"), but there was no way to act on it; I had to add the bath by hand.
_Evidence:_ the three "dropped link" diagnostics atop the forge draft; the 7-location map with no bath.
_Suggested fix:_ when a dropped link names a missing location, offer **"Create this location"** inline; and/or have the map agent self-validate that every referenced location exists before returning.

**M3. Session lock lingers ~8–10s after the turn stream ends → 409s for rapid/back-to-back turns.**
All three load agents independently hit this: after the SSE `event: done` fires and the connection closes, the server holds the per-session turn lock for several more seconds (post-turn persistence/extraction), so an immediately-issued next turn gets `409 session_busy`. One agent measured the lock still held from +0.15s through +8.36s after `done`.
_Impact:_ the browser UI mostly hides this (it disables the composer), but API clients and any "rapid Enter" path will 409. It also means "ready" can lag the visible stream-end by several seconds.
_Suggested fix:_ expose an explicit readiness signal the UI already gates on (verify the composer stays disabled until truly ready, not just until stream close); document the post-`done` window for API consumers; consider queueing a second turn instead of rejecting it.

### Medium

**M4. Narration can move the player to a location the world-model doesn't track.**
A Director turn ("Akari shows me to a small guest room…") produced prose placing me in a private room, but the world-model kept my location as **Main Hallway** (the map has no generic "guest room"; only Proprietress's Quarters / Painter's Studio are bedrooms). Prose and tracked state diverged, and the scene image correctly rendered the _hallway_ (state), not the narrated room.
_Suggested fix:_ constrain narration to known locations, snap movement to the nearest defined node, or mint an ad-hoc location when narration implies one; at minimum flag the divergence as a continuity diagnostic.

**M5. Intake agent times out at 1500ms and falls back to regex — possibly often.**
Turn 1 logged `warn agent.intake.timeout — intake exceeded 1500ms; using regex fallback` (likely aggravated by the concurrent load). If this fires on most turns, the intake LLM is paid-for but unused.
_Suggested fix:_ measure the fallback hit-rate; raise the budget, or make intake non-blocking (let it land when ready), or drop it if regex is good enough.

**M6. Accessibility: dim secondary text fails WCAG AA contrast.**
Lighthouse flagged `color-contrast` (a11y 95). The offender is the dark theme's secondary text token (`text-paper-500`/`paper-400`) on dark cards — used widely for labels, hints, meter captions, and relationship sub-text ("thinks you're acquaintance toward them").
_Suggested fix:_ raise the secondary-text tokens to ≥4.5:1 (≥3:1 for large text), or add a high-contrast theme toggle.

**M7. No "generating artwork" indicator after world save.**
On save, a single `world_backfill` job generated ~35 entity images + the cast avatars **sequentially** (observed running 85s+), but the world-detail page and library just show monogram placeholders with **no progress hint** — a user won't know art is coming.
_Suggested fix:_ a subtle "Generating artwork… (n/total)" badge on the world detail + per-entity shimmer until `ready`.

### Minor / Polish

- **P1. Unembodied player uses the account name in-world.** Narration/state referred to me as "UX Tester" ("talking to UX Tester"). Add a player-character name (and optional persona) step to the session wizard; default to a neutral "you".
- **P2. Raw `{{player}}` token** shows un-substituted in the synopsis on the world-detail page. Substitute or strip for display.
- **P3. "Generate images" batch button** appears on empty Locations/Items libraries (nothing to generate). Hide/disable when the library is empty.
- **P4. Forge free-text "color" fields accept non-color values** ("Tail color: **slender**") which then leak verbatim into the image prompt; also a cosmetic double-period ("…sharp fangs..") in the prompt join. Normalize/validate these fields (or make them enums) and fix the prompt punctuation.
- **P5. `apparent_age` enum lacks "late_twenties"** — the model's natural output was dropped as invalid (defaulted to "young adult"). Add it or map synonyms.
- **P6. Item placements may not surface in session state.** The World tab showed "Items here: Nothing of note." for the Main Hallway even though Wooden Bench / Paper Lantern / Snow Shovel were placed there. Verify placement → world-state surfacing.
- **P7. `favicon.ico` 404** — only console error in the whole run; trivial.
- **P8. DB hygiene: two duplicate indexes** — `participant_relationships_session_idx` (covered by `participant_relationships_edge_unique`) and `session_participants_session_idx` (covered by `session_participants_name_unique`). Safe to drop.

---

## 5. Performance, load & accessibility findings

**Concurrency / load** (3 background API agents driving the turn pipeline as separate sessions while I played a 4th in the browser):

- **All sessions stayed healthy** — every turn across **11 sessions reached `ready`** (0 not-ready), well-formed SSE (`start → chunk×N → done`), 188–314 chunks/turn, **zero `event: error`, zero 5xx, zero failed jobs**.
- **Latency degraded gracefully** under contention (single shared OpenRouter account): solo turns ~28–30s; under 4 concurrent streams, turn latency rose to a median ~50–68s and a peak ~91s. No failures — just slower.
- **Finding (M3):** the post-`done` session-lock window (~8–10s) is the one real concurrency rough edge.
- Input validation is correct: empty input → `400 invalid_body`.

**Accessibility (Lighthouse, dashboard, desktop):** Accessibility **95**, Best Practices **100**, SEO **100**, Agentic-Browsing 67. Failures: `color-contrast` (M6) and `llms.txt` (experimental category; low priority — add an `llms.txt` if agent-discoverability matters).

**Performance:** not benchmarked — dev build (Turbopack, unminified, HMR) is not representative. **Recommend** a production-build Lighthouse-perf + trace pass, focused on the dashboard and the play screen (the heaviest route).

**Data integrity / DB health:** no invalid indexes or constraints; connections healthy; all generated turns/episodes/facts persisted; embeddings refreshed fast (avg ~0.6s/job). Only the duplicate-index nit (P8).

---

## 6. Proposed new features

Prioritized by value-to-effort.

1. **Player character setup in the session wizard** _(high value, low effort)_ — name + short persona for the unembodied player; fixes P1 and deepens immersion. Persist and reuse across sessions.
2. **Forge consistency pass + one-click remediation** _(high value)_ — a reconciler that cross-checks cast/lore/map names, plus actionable buttons on diagnostics ("create missing location", "add Genzo to cast", "drop orphan lore"). Directly addresses M1/M2.
3. **Background-work progress surface** _(medium)_ — a global, unobtrusive "Generating artwork (12/36)" indicator and per-entity shimmer; addresses M7 and makes the post-save minute feel intentional.
4. **Relationship & meter timeline** _(medium)_ — the agent outputs already carry affinity/meter deltas per turn; visualize them as a small sparkline/timeline in the Cast panel so players can _see_ the romance arc progressing.
5. **Map view** _(medium)_ — render the location graph (the undirected-link data already exists) so authors can spot orphans/missing rooms (would have made M2 obvious at a glance).
6. **High-contrast / accessibility theme** _(medium)_ — a toggle that lifts the dim secondary tokens; pairs with the M6 fix.
7. **Dev turn HUD** _(low effort, dev-only)_ — surface per-turn token usage + latency (already in the inspect payload) to tune cost/latency, including the intake-timeout hit-rate (M5).
8. **Session transcript export / share** _(low)_ — export the narrative feed as Markdown; nice for a romance-story product.
9. **Scene-image "pin / set as session cover"** _(low)_ — promote a favorite scene to the session header.
10. **First-run guided tour** _(low)_ — the empty states are good; a 3-step "forge → begin → play" coachmark could shorten time-to-first-turn for brand-new users.

---

## 7. Appendix

**Test users created (clearly labeled; safe to delete):** `uxtest-main@vesper.local` (admin, owner of all audit assets) and the load-test traffic ran under that same user across throwaway sessions (titled "Load Agent 1/2/3", "race probe", "linger probe", etc.).

**Screenshot index** ([`ux-audit-assets/`](./ux-audit-assets/)):
| File | What it shows |
|---|---|
| `01-dashboard-empty.png` | Fresh-account dashboard empty state |
| `02-world-forge-draft.png` | World forge draft + dropped-link diagnostics |
| `03-world-detail.png` | Saved world detail (cast/lore/map) |
| `04-play-first-turn.png` | Play screen after first turn (streaming, cast panel) |
| `05-scene-image-generated.png` | Scene tab with generated image + gallery strip |
| `06-scene-lightbox.png` | Scene image enlarged (state-accurate render) |
| `07-character-forge-draft.png` | Succubus character forge draft |
| `08-succubus-avatar.png` | Uncensored avatar (exposure-gated, clothed) |
| `09-locations-library.png` | Populated Locations library (entity images) |
| `10-gallery.png` | Gallery grouped by session + character chats |
| `11-dashboard-mobile.png` | Dashboard at 390px |
| `12-play-mobile-drawer.png` | Play-screen mobile drawer (Scene/Cast tabs) |

**Notable raw diagnostics observed:** `dropped link … no such location` (×3, M2); `dropped attribute "identity.apparent_age": Invalid option` (P5); `warn agent.intake.timeout … using regex fallback` (M5); `spawn.relationship.self_reference` (benign); `409 session_busy` post-`done` (M3); `400 invalid_body` for empty input (correct).
