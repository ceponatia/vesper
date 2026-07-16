# Deferred — unplanned-but-good ideas

Status: **parking lot** — ideas worth keeping that aren't yet promoted to a plan.
Not a commitment, not priority-ordered (priority lives in [roadmap.md](roadmap.md)).
When an idea graduates it becomes a `<topic>.plan.md`, gets a roadmap line, and
leaves here (a one-line "graduated → …" tombstone is fine). This file is the
anchor; supporting detail files named `<topic>.deferred.md` nest under it in the
editor.

## Owner-gated live eval runs — run on request, not roadmap items

_Removed from the roadmap 2026-07-13 (owner ruling: manual OpenRouter-spend
runs aren't tracked as roadmap items for now). Each is built and dry-run
validated; run when the owner asks, then record results in the owning plan._

- **Enactment measurement run** —
  [finished/character-chat-standalone.plan.md](finished/character-chat-standalone.plan.md)
  §slice 2 / spec §5: `pnpm eval:narration` then
  `pnpm eval:narration:compare --axis contrast`; bar ≥80% blind identification
  per axis. Also validates the 2026-07-10 trait-quota softening
  (narrator-prompt-consolidation slice 3 — below the bar ⇒ restore the
  commented pre-softening wording), and carries the multi-character fixtures
  (multi-character-chat followups ruling 7) + the `chat-secret-hold`/`-reveal`
  fixtures ([character-drives.plan.md](character-drives.plan.md) slice 4,
  `secretCue` metric). This is also the **measurement for character-fidelity
  slice 9** (the chat-lane consistency check —
  [character-fidelity.plan.md](character-fidelity.plan.md) slice 9): the
  blind-identification/contrast bar quantifies whether the one-turn corrective
  tail note actually holds voice/disposition/age register over a long chat.
- **`mt-chat-*` longitudinal baseline** and the **`CHAT_PROMPT_LAYOUT` A/B**
  (before its default flips) —
  [narrator-prompt-consolidation.plan.md](finished/narrator-prompt-consolidation.plan.md)
  §Rulings & leftovers.
- Older single-run leftovers recorded in their plans: `mt-chat-feeling-hurt`
  (emotional weather), the memory-callbacks judged run, the `chat-pov-*`
  scored run.

## Example-dialogue voice anchors

_Graduated 2026-07-14 → [character-fidelity.plan.md](character-fidelity.plan.md)
slices 6 (`profile.microExemplars` few-shots) + 7 (structured
`profile.voiceAnchors`: pet phrases / cadence / never-says)._ The authored
example-dialogue + voice-anchor levers this idea asked for shipped as those two
slices — few-shots in the chat prefix (and a one-line tail re-anchor near
generation). The enactment measurement run (§"Owner-gated live eval runs" above)
remains the before/after; ensemble cast-block parity is the recorded leftover
(character-fidelity §Follow-ups).

## Narration eval: self-consistency judge vote

_Raised 2026-06-29 (the one leftover when [finished/narrator-prompt-focus.plan.md](finished/narrator-prompt-focus.plan.md) shipped)._
The pairwise narration judge (`pnpm eval:narration:compare`) ranks each group **once**, with a
single judge. Run 2's close calls (and Run 3's 53/47 focus wash) would be firmer with a
**self-consistency vote**: rank each group N times (or with a second strong judge) and keep the
majority ordering. Position bias is already mitigated (shuffled labels) but not eliminated. A
methodology nicety, not blocking — the shipped rulings (per-lane profile, per-model reasoning,
"focus planner doesn't earn its keep") already stand on the current data. Pick up only if a future
ruling hinges on a margin this thin.

## Plan docs: drop hard phase numbers

_Raised 2026-06-16._ The `phase-N` scheme bakes **both** a doc's identity and its
priority order into the filename, so every time early work jumps the queue we
renumber/re-suffix files and chase every `.phaseN.md` cross-reference (docs +
`src/` comments) — the exact churn the "Phase-4/5 resequencing" item below is
about. Fix: **decouple identity from order.**

- **Plans are topic-named, never numbered:** `<topic>.plan.md`
  (`scene-images.plan.md`, `world-map.plan.md`, `non-human-species.plan.md`). The
  filename says _what_, never _when_, so it never has to change.
- **Status, not a number, encodes lifecycle.** Each plan opens with `Status:` ∈
  `draft` · `next` · `active` · `shipped — <date>` · `parked`.
- **Order lives in ONE place** — a `roadmap.md` index listing plans in current
  priority order (+ a "someday" bucket). Reprioritizing = reorder one list, zero
  renames.
- **Supporting docs carry the topic slug:** `<topic>.spec.md` (design truth),
  `<topic>.followups.md` (post-ship fixes), `<topic>.<sub>.md` (detail). They nest
  by name prefix, and `grep <topic>` finds every pointer — a stable target that
  doesn't rot on resequencing.
- **deferred.plan.md stays the parking lot** for ideas not yet promoted; on
  graduation an idea becomes a `<topic>.plan.md`, gets a roadmap line, and leaves
  here.
- **Completed `phase-N` docs stay as historical record** — no mass rename (that's
  the churn we're killing). Only new plans use the topic scheme; the
  not-yet-started world-moves work (`*.phase5.md`) can optionally be renamed now
  since nothing depends on it as shipped.

**Adopted 2026-06-16.** Folded into `CLAUDE.md` (replacing the phase-N working-doc
convention); [roadmap.md](roadmap.md) now holds the priority order. First
instances: [scene-images.plan.md](finished/scene-images.plan.md) +
[scene-images.spec.md](finished/scene-images.spec.md) and
[non-human-species.plan.md](finished/non-human-species.plan.md) +
[non-human-species.spec.md](finished/non-human-species.spec.md); the world-moves specs were
renamed off `*.phase5.md` to `movement-authority.spec.md` /
`scheduled-arrivals.spec.md` / `pre-narrator-agents.spec.md`. Legacy `phase-N`
docs stay as historical record.

## Phase-4/5 resequencing — deeper prose sweep

_Update 2026-06-16 — largely superseded._ The project dropped hard phase numbers
(see §"Plan docs: drop hard phase numbers" above), so there is no future phase
"roll" to re-suffix for. The world-moves specs are now topic-named
(`movement-authority.spec.md` etc.). The open questions below are settled by the
standing ruling: **leave historical `phase-N` prose and `src/` comments as-is**
(they're the record of what happened); fix only live links when a target is
renamed. Kept for history; no action pending.

_Raised 2026-06-14, from the phase-4/5 renumber._ When the body-model work became
phase 4 and the "world moves" cluster became phase 5, the **structural** rename
was completed: the three world-moves specs (+ their gpt-review mirrors) were
renamed `*.phase5.md`, every `.phase4.md` filename link (docs + 4 `src/` comment
refs) was updated, the three living specs were swept to read as "phase 5"
internally, and resequencing banners were added to them and to
[phase-3-to-4.md](finished/phase-3-to-4.md). **Link integrity verified; no broken links.**

Deliberately **not** swept (left as historical, banner-only): the plain-prose
"phase 4" mentions — now meaning phase 5 — in dated/stable docs (the
`phase-3-to-4.md` body, completed [phase-3-plan.md](finished/phase-3-plan.md), the phase-3
design specs, gpt-review review snapshots) and ~11 `src/` code comments
(forward-references like "phase-4 NPC traversal reuses this"). Reasons: some are
semantically ambiguous, and churning shipped code / dated artifacts is low-value
and hard to review.

Open questions before doing the deeper sweep:

- **Scope.** Sweep _everything_, or only actively-maintained docs and leave
  dated/historical artifacts + shipped code comments as-is?
- **`phase-3-to-4.md` specifically.** Its body _is_ the original phase-4
  definition, which now **splits** between the new phase 4 (body model) and phase
  5 (world-moves) — e.g. the romance "consequence loop" bucket is arguably the new
  phase 4, not phase 5. So a blind "phase 4"→"phase 5" is wrong here. Leave
  banner-only (current), rewrite wholesale, or **split** it into real phase-4 vs
  phase-5 content (needs a human read of the buckets)?
- **`src/` code comments (~11 files).** Update the forward-reference "phase 4"
  comments in shipped phase-3 code to "phase 5" (comment-only churn of stable
  code), or leave them?
- **gpt-review snapshots.** These are dated reviews _of_ the renamed specs —
  rewrite their "phase 4" to match the new filename, or preserve them as the
  historical record they are?

My lean: leave the historical prose as-is (it's not misleading once the phase map
is known), and only act if a future reader trips on it. Revisit when phase 4
ships and the standard re-suffix pass runs anyway (see the naming note in
[phase-4-plan.md](finished/phase-4-plan.md)).

## Non-human races & additive body features — _graduated 2026-06-16, shipped 2026-06-18_

Promoted out of the parking lot to its own plan, now **shipped**:
[non-human-species.plan.md](finished/non-human-species.plan.md) (task list +
shipped/leftover summary) + [non-human-species.spec.md](finished/non-human-species.spec.md)
(design — the former `non-human-races-and-features.deferred.md`). The full feature
landed (8-species catalog with `appearance`/`lore` + heritages, wings/horns/tail
morphology, species-driven realization + forge species/heritage inference, editor
controls, and image-gen feature surfacing on every route). One strand parks back
here for its own later pass:

- **Wardrobe accommodation for features** — garments that fit winged/tailed bodies
  (back slits, tail openings, horn-cutout hoods) so outfits don't clip or
  contradict features. The seam is the `expand`/coverage question on the
  `coverageRelevant: false` `tail` location; solving it means excluding
  `featureGroup` locations from coverage `expand`, or per-garment "accommodates
  feature X" flags. (Incremental per-species attribute-rule data — e.g. `succubus`
  rules, finer coloration nudges — is plain data work tracked in the plan, not a
  parked idea.)

## Scene image: multi-reference & provider strategy — _graduated 2026-06-16, shipped 2026-06-19_

Promoted out of the parking lot to its own plan, now **shipped** and moved to
`finished/`: [scene-images.plan.md](finished/scene-images.plan.md) (task list +
completion note) + [scene-images.spec.md](finished/scene-images.spec.md) (design
truth) + [scene-images.notes.md](finished/scene-images.notes.md). The full arc
landed — provider-capability layer + `image_references` join table, then the
2026-06-19 pivot: Flux/OpenRouter dropped, Venice/Qwen everywhere, Venice
`/image/multi-edit` onboarded behind a per-session single↔multi reference toggle,
and the lustify/chroma/etc. t2i model set. Two never-built long-term items park
back here:

- **Uploaded-avatar intimate guard — a hard pre-production gate.** Not built in
  dev (no real users / no real uploads, so the misuse path can't fire), but a
  **launch blocker before the app accepts real user uploads in production**. The
  rule: stamp positive `source: "generated"` provenance at generation and
  **default-deny** the uncensored/intimate edit path to anything not provably
  generated (`isSyntheticAvatar`), so an uploaded real likeness is never the
  identity anchor for an intimate render. An uploaded-only scene renders through
  **Venice text-to-image with `safe_mode` forced on** (per-request knob —
  `veniceGenerateImage` already reads `VENICE_SAFE_MODE`) or skips the image; the
  Flux moderating-backend the original design named is gone. Acceptance test: the
  eval harness "safety row" must score zero. Full design in
  [scene-images.spec.md](finished/scene-images.spec.md) §3.
- **Self-hosted ComfyUI — the uncapped multi-character-NSFW upgrade.** The path
  beyond Venice's hosted `/image/multi-edit` 3-reference cap: pursue when we need
  > 3 references or premium multi-subject identity-locking (Chroma / Qwen-Edit-2511
  > base + InstantID/InfiniteYou identity + OpenPose ControlNet + regional masks on a
  > cloud GPU). It slots in behind the existing provider seam as one more provider,
  > and is the GPU background worker that is the most plausible **second deployable**
  > — decide it together with the monorepo split (§"Monorepo split" below; its
  > standalone evaluation doc was retired 2026-07-13). Stack + hosting recommendation in
  > [scene-images.spec.md](finished/scene-images.spec.md) §7. A cheaper interim lever
  > for the 3+-character case (a multi-pass hosted composite) is sketched in the
  > shipped plan before reaching for this.

## Comms expansions

_Raised 2026-06-13, from the phase-3 presence open questions._ Phase-3 comms
ships single-pair only. Deferred, none designed:

- **Group calls / group texts.**
- **Voicemail content** — a missed call carrying a message that becomes a
  told-fact.
- **Persistent text-thread history** the player can reread — the first thing
  players will ask for, and a natural UI surface for the pending-messages
  mechanic.

See
[presence-and-perception-spec.phase3.md](finished/presence-and-perception-spec.phase3.md)
§Gaps & opportunities.

## Chat story map — scene-memory places graph

_Raised 2026-07-14, from the world-sim carry-forward review (the chat-lane
descendant of the demoted [world-map.plan.md](world-map.plan.md))._ Chat's
`scene_memory` already stores places + connections — the same nodes-and-edges
shape the world map renders — and the graph component was written generically
(`lib/world-graph-layout.ts` + `components/worlds/world-map-graph.tsx`,
locations + links in). A small read-only "places this story knows" view (in the
Scenario modal or the desktop aside) is nearly free: nice texture for the
player and a useful QA window into scene memory. Not promoted because it's
garnish — pick up if players ask for it or scene-memory debugging warrants it.

## Item acquisition during play

_Raised 2026-06-13, from the location-design ownership ruling._ Spawn-time item
ownership ships with the location/ownership work (`owner_participant_id`,
written only at spawn). Deferred — needs its own design: characters **acquire**
items in play (purchases, gifts) that become owned at acquisition time, a
second provenance path the items model doesn't have yet.

See [location-design-spec.phase3.md](finished/location-design-spec.phase3.md)
§Ownership.

## Monorepo split (gated on a second deployable)

_Update 2026-06-16._ Permanently deferred for now. I don't foresee a second deployable
since this is one game. What I would like to know is if there are similar organization
schemas for repos. I like the way a monorepo breaks domains up into packages, and
having everything listed under src/ in this app has confused me a bit. If this is the
optimal way for Claude & GPT to code, I am okay with it. If there is another system
which could assist them in tracking the codebase better, let's look into that.

_Claude's note 2026-06-16:_ Agreed, no monorepo (no second deployable). On the real
question — is flat `src/` optimal for AI agents, or is there a better scheme: the
codebase is **already domain-segmented**, just folders instead of packages —
`contracts/` (pure domain), `lib/` (pure utils), `server/{ai,db,engine,images,
authoring,events}/` (each a domain behind a barrel), `components/`, `app/`. Those
boundaries are real and **enforced** (ESLint `no-restricted-imports` + barrels + the
`@/` alias) — "packages without the `package.json` tax." For Claude/GPT specifically,
physical packages don't improve navigation: agents grep and jump to symbols (same in
folders or packages), while packages _add_ indirection (cross-package builds, more
config). What actually helps an agent track a codebase is (1) a crisp **module map**,
(2) consistent **barrels** as each domain's public API, (3) a **boundary lint** so
violations are mechanical — all of which already exist here. **Recommendation:** don't
restructure; treat each `server/<domain>/` folder as an internal "package" (its barrel
= its public surface, already the design) and make the map legible.
[architecture.md](../architecture.md) already documents directory layout +
boundaries; if `src/` still confuses you, the cheap win is a one-screen **domain map**
(table: domain → folder → barrel → owns → may-import) at the top of that doc — I can
write it. If a _specific_ split is what trips you up, point at it and I'll propose a
targeted rename rather than a wholesale reshuffle.

_Raised 2026-06-14._ Evaluated converting the single Next.js app into a pnpm
workspace. **Verdict: not yet** — Vesper was deliberately collapsed _from_ a
12-package monorepo because every package had one consumer, and that still holds
(one deployable). Boundaries are already clean and enforced by convention +
barrels + the `@/` alias. Park behind a **trigger**: the first second consumer of
the engine — most likely a phase-4 background **world-simulation / scheduled-
arrival worker**. When it fires, do a small **4-package, consumer-driven** split
(`core` / `engine` / `web` / `worker`), not the old 12-package shape. Interim
action available now: an ESLint boundary rule + gating the one `process.env` read
in `lib/log.ts`.

The full analysis doc (`monorepo-evaluation.md`, with the package outline and
boundary-enforcement design) was retired 2026-07-13 — permanently deferred; the
verdict and trigger recorded here are what survives.

## Visual world map — _graduated 2026-06-16_

Promoted out of the parking lot (flagged a potential priority):
[world-map.plan.md](world-map.plan.md). Render locations as graph nodes + their
undirected links as edges, replacing the flat card column on `/worlds/:id` and the
editor map tab. The data already exists; first slice is a read-only force-directed
graph.

## Observer / god-mode session POV

_Raised 2026-06-13, from the phase-3 presence open questions._ The
presence/perception design assumes a player POV; observer / god-mode
("omniscient") sessions have no player participant to anchor awareness
blocks to (followups.phase2.md #10). Omniscient mode is **less relevant
to this fork's romance scope**, but the user wants to support it
eventually. Needs its own think — likely narrator-omniscient with no
awareness blocks, but deferred rather than ruled. Phase 3 takes no
stance for observer sessions.

See [presence-and-perception-spec.phase3.md](finished/presence-and-perception-spec.phase3.md).

## Companion role as romance eligibility

_Update 2026-06-16._ Let's think about whether there is any real value in doing
this. My initial thought was that we would use Companion and NPC tiers to determine
how much context to send to the narrator for those characters, but so far context
window has not been an issue (current models are capable of handling a _lot_ of tokens).
If there is no real benefit to this, perhaps we remove the tier and Companion systems
entirely.

However, it is possible that in large worlds with many characters running in the background,
this would become an issue and tiers / companion flags would be necessary.

_Claude's note 2026-06-16:_ Grounded check on what these actually do today: `tier`
(major/minor/extra) and `role` (companion/npc) are **stored and snapshotted but
nothing branches on them at runtime** — the only consumers are `spawnTier` (companion
`minor`→`major` bump) and the `MAJOR_TIER_SOFT_CAP` spawn/editor warning
(`lib/cast-tiers.ts`). So you're right that context window isn't the justification, and
it was never the real lever anyway. The lever these fields exist _for_ is **simulation
cost**: the per-character post-turn agent fan-out + memory writes each turn, and (once
it lands) offscreen simulation — compute/latency/token spend that scales with **cast
size**, not context length. **Recommendation:** keep the fields (nearly free as data,
and forward-looking per your schema preference) but **don't build
companion-as-romance-eligibility now** — it would add the first runtime `role` branch
for a speculative benefit. Revisit both together when offscreen sim or large background
casts actually land and the per-character cost bites; that's when tiers earn their keep.
If that moment never comes, deleting two inert fields later is trivial. Net: park,
don't build, don't remove.

_Raised 2026-06-13, brainstorm from the cast-tiers investigation._ Use the
existing cast **`role`** field (not tier) to designate romance targets:
**`role: companion` characters are the session's valid romance targets;
`role: npc` are not.** `npc`s stay fully fleshed (forge, facts, schedule,
presence) but are background flavor — the narrator deflects or gently redirects
romance gestures aimed at them. This keeps `tier` (`major`/`minor`/`extra`)
free for its existing job — _simulation/narration depth_ — orthogonal to who
can be romanced.

It rides machinery that already exists: `spawnTier` auto-promotes a `companion`
authored `minor` to `major` (`cast-tiers.ts`), so romance leads already get the
deepest simulation — wardrobe, meters, per-character memory, perspective
memories — for free, while a background `npc` sits at whatever tier its world
texture needs. Romance would still gate on the **affinity edge**, not the role
alone — the `close`/`devoted` stages and the perceived-affinity model are the
mechanical substrate; the `companion` role just decides _who is eligible to
climb that ladder at all_.

Note this gives `role` a concrete gameplay meaning. The cast-tiers spec today
calls `role: companion | npc` "an authoring/POV distinction, not a simulation
one" — this would make it the **first behavior to branch on `role` at runtime**
(nothing branches on role _or_ tier today). Tradeoff to weigh: a non-companion
you later want romanceable must be re-cast as a `companion` (or we add a
separate `romanceable` flag); coupling to the existing role is cheapest and
matches the framing.

See [cast-tiers-and-affinity-spec.phase3.md](finished/cast-tiers-and-affinity-spec.phase3.md)
§Problem (role definition) and §Design: tiers.

## Natal sex — structured sex-at-birth

_Raised 2026-06-29, alongside the gender born-variant change._ The character
`identity.gender` enum now splits androgynous / nonbinary by sex at birth
(`androgynous_born_female` / `…_born_male` / `nonbinary_born_*`) so image generation
gets the natal build, and a separate **`identity.natal_sex`** attribute (enum
`female`/`male`) was created as a **scaffold** — flagged `excludeFromPrompts` (stored

- authored + editable, but not yet surfaced in any generated prompt) and shown in the
  editor **only for an androgynous / nonbinary presentation** (redundant for plain
  female/male). The born-variant on `gender` carries natal sex into rendering for now;
  `natal_sex` is the placeholder for doing this properly later. See
  [../contracts/attributes.md](../contracts/attributes.md) §"`natal_sex` is a
  forward-looking scaffold".

What "fleshing it out" should cover (none built yet):

- **Wire `natal_sex` into prompts** as the source of truth (drop `excludeFromPrompts`
  and add render logic to the attribute-iterating builders that currently skip it —
  `characterAppearanceSummary` / `buildAvatarPrompt` in `images/prompts.ts`,
  `buildGlanceImpressions` in `engine/scene.ts`, the chat loop in
  `prompts/character-chat.ts`), and decide whether it then **supersedes** the gender
  born-variants (collapsing `gender` back toward `female`/`male`/`androgynous`/
  `nonbinary` + a separate natal-sex axis) — which would also cleanly cover **trans
  presentations** the born-variant enum can't (e.g. female-presenting, natal male).
- **A model-facing definition of each gender term** — the open question from the
  2026-06-29 discussion: tell the narrator/image models what `androgynous` vs
  `nonbinary` actually _mean for this game_ (presentation vs identity), since for a
  purely visual prompt they otherwise overlap. Likely a `promptHints`-style gloss or a
  small rulebook note, gated on whether `natal_sex` becomes the visual driver.
- **Wider value set** — `intersex` (and possibly more) on `natal_sex`, and the matching
  body-config seeding story.
- **Auto-consistency** — keep `natal_sex` and the gender born-variant in agreement
  (derive one from the other, or warn on mismatch) instead of two hand-set fields.
- **A general conditional-visibility mechanism** — the editor currently hard-codes the
  `natal_sex`↔gender dependency in `attribute-picker.tsx`; a declarative `showWhen` on
  the attribute definition would generalize it (only worth building if a second
  conditional attribute appears).

## Relationship & meter timeline — _UX audit feature #4_

_Raised 2026-06-17 (UX audit §6 #4). **Graduated at chat scale 2026-07-02** →
[character-chat-standalone.plan.md](finished/character-chat-standalone.plan.md) slice 8: the chat
Relationship panel ships an affinity sparkline (`relationship_history` ring) + milestones._
What stays parked: the **session-scale** version — a sparkline/timeline in the Cast panel
charting affinity + meters across a session (the per-turn deltas the post-turn agents
already emit). Promote it by porting the chat panel's shape onto session data.

## Session transcript export / share — _UX audit feature #8_

_Raised 2026-06-17 (UX audit §6 #8). **Graduated at chat scale 2026-07-02** →
[character-chat-standalone.plan.md](finished/character-chat-standalone.plan.md) slice 8:
`GET /api/chats/:id/export?format=md|json` (+ optional memory appendix) ships from the
chat Relationship panel._ What stays parked: the **session** narrative-feed export
(and/or a shareable read-only view) — port the chat exporter's shape onto the
episode/feed data when wanted.

## Scene image: pin / set as session cover — _UX audit feature #9_

_Raised 2026-06-17, from the UX audit ([ux-audit.intake.md](finished/ux-audit.intake.md) §6 #9)._
Let a player promote a favorite generated **scene image** to the session header as its
cover. A small surface on top of the existing scene-image + gallery machinery. From
[ux-audit.plan.md](finished/ux-audit.plan.md).

## First-run guided tour — _UX audit feature #10_

_Raised 2026-06-17, from the UX audit ([ux-audit.intake.md](finished/ux-audit.intake.md) §6 #10)._
The empty states are already strong (the audit praised them); a light **3-step coachmark**
("forge → begin → play") could shorten time-to-first-turn for a brand-new user. Lowest
priority of the audit ideas. From [ux-audit.plan.md](finished/ux-audit.plan.md).

## NPC puppeting — the full handling system

_Raised 2026-06-18, from personality Slice 2._ Slice 2 shipped the **deflection
directive** half of the puppet guardrail: intake flags player-authored NPC behaviour
(`narratedNpcBehaviors`), a deterministic rule refuses behaviour that contradicts
disposition, and the narrator answers with a cheeky meta aside. That is the working
v1; the broader system around "the player tries to puppet an NPC" is deferred to
[npc-puppeting.deferred.md](npc-puppeting.deferred.md) — merge-level state stripping,
stronger refusal (disallowing player-authored NPC behaviour from the player prompt
entirely, routed through the companion/narrator out-of-POV affordances), and richer
contradiction judging once full traits + affinity + mood exist (personality Slice 3).

## Production-build performance pass — _UX audit §5_

_Raised 2026-06-17, from the UX audit ([ux-audit.intake.md](finished/ux-audit.intake.md) §5)._
The audit **deliberately skipped** perf benchmarking because the dev Turbopack build
(unminified, HMR) isn't representative. Run a **production-build Lighthouse-perf + trace
pass** focused on the dashboard and the play screen (the heaviest route) for real numbers.
Not blocking — do it when perf becomes a question. From [ux-audit.plan.md](finished/ux-audit.plan.md).

## State-aware chat scene image — _graduated 2026-06-30 → [character-chat-state-narration.plan.md](finished/character-chat-state-narration.plan.md) (slice 7 / spec §8, D4)_

_Raised 2026-06-24, the one piece of [character-chat-state.plan.md](finished/character-chat-state.plan.md)
slice 4 not built. Graduated 2026-06-30 into the state-as-narration plan, which bundles the
visual axis with the prose enactment so they reuse the same state derivations — fold the chat's
light state (mood/meters: flushed, tipsy, tired; active conditions; the `mindNote`) into the
**chat scene-image prompt** (`renderCharacterSceneImage`) so a generated scene reflects how the
character actually is right now. Detail now lives in that plan/spec._

## Old World-Model Plans from the Roadmap

These items were in the roadmap and are holdovers from the world-model system which is being deprecated in favor of expanding and perfecting the character-chat system _first_ and then deciding if we want to incorporate that into a bigger world system. My current lean is we will eventually incorporate all desired features into character chat and character chat will become less 1-on-1 focused. We may want to branch to a different app route for that or it may make sense to keep everything in one chat system.

- **Visual world map** — [world-map.plan.md](world-map.plan.md). Slice 1 (read-only
  force-directed graph) shipped 2026-06-18; slices 2–3 (editable layout, play-screen
  minimap) remain — optional polish on a feature already delivering its core value.
  _Demoted to the bottom 2026-07-14 (owner): character chat is now the app's main
  focus and the world model is headed for deprecation or refactor — don't polish it.
  A chat-lane descendant (a read-only scene-memory places graph) is parked in
  [deferred.plan.md](deferred.plan.md) §Chat story map._
- **World simulation ("the world moves")** — the former "phase 5" cluster, not
  yet started, and now **direction-dependent**: character chat is the test bed
  for what the world/session model will eventually look like (owner direction
  2026-07-13 — see `CLAUDE.md`), so the movement-authority and
  scheduled-arrivals specs were retired (deleted) 2026-07-13 rather than built
  against the possibly-deprecated session model.
  [pre-narrator-agents.spec.md](pre-narrator-agents.spec.md) remains as
  findings (its intake half shipped). A future `world-simulation.plan.md` — or
  the chat-successor equivalent — re-derives what it needs when this becomes
  active. **Re-derived 2026-07-16 as that chat-successor equivalent:
  [world-engine-refactor.plan.md](world-engine-refactor.plan.md)** (draft) — chat
  generalized, not the session model revived. Its thesis is that a *derived* world
  needs no tick, which is why the session-side remainder named here (movement
  authority, world-scale simulation) stays parked rather than becoming its
  prerequisite. _Demoted to the bottom 2026-07-14 (owner) with the map, same rationale._
  _Carry-forward 2026-07-14: the chat-applicable ideas graduated to
  [chat-plans-promises.plan.md](chat-plans-promises.plan.md) (scheduled arrivals
  reborn) and [chat-offscreen-life.plan.md](chat-offscreen-life.plan.md) (the
  world moves, scoped to the cast's lives) — see the top of this list. What
  stays here is only the session-side remainder (movement authority, world-scale
  simulation), pending the direction._
