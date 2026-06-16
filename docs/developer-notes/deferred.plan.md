# Deferred — unplanned-but-good ideas

Status: **parking lot** — ideas worth keeping that don't belong to a phase
yet. Not a commitment, not priority-ordered. When an idea graduates, move it
into the relevant phase plan and delete it from here. This file is the anchor;
supporting detail files named `*.deferred.md` nest under it in the VS Code
workspace (the same nesting idea as `phase-N-plan.md`).

## Phase-4/5 resequencing — deeper prose sweep

*Raised 2026-06-14, from the phase-4/5 renumber.* When the body-model work became
phase 4 and the "world moves" cluster became phase 5, the **structural** rename
was completed: the three world-moves specs (+ their gpt-review mirrors) were
renamed `*.phase5.md`, every `.phase4.md` filename link (docs + 4 `src/` comment
refs) was updated, the three living specs were swept to read as "phase 5"
internally, and resequencing banners were added to them and to
[phase-3-to-4.md](phase-3-to-4.md). **Link integrity verified; no broken links.**

Deliberately **not** swept (left as historical, banner-only): the plain-prose
"phase 4" mentions — now meaning phase 5 — in dated/stable docs (the
`phase-3-to-4.md` body, completed [phase-3-plan.md](phase-3-plan.md), the phase-3
design specs, gpt-review review snapshots) and ~11 `src/` code comments
(forward-references like "phase-4 NPC traversal reuses this"). Reasons: some are
semantically ambiguous, and churning shipped code / dated artifacts is low-value
and hard to review.

Open questions before doing the deeper sweep:

- **Scope.** Sweep *everything*, or only actively-maintained docs and leave
  dated/historical artifacts + shipped code comments as-is?
- **`phase-3-to-4.md` specifically.** Its body *is* the original phase-4
  definition, which now **splits** between the new phase 4 (body model) and phase
  5 (world-moves) — e.g. the romance "consequence loop" bucket is arguably the new
  phase 4, not phase 5. So a blind "phase 4"→"phase 5" is wrong here. Leave
  banner-only (current), rewrite wholesale, or **split** it into real phase-4 vs
  phase-5 content (needs a human read of the buckets)?
- **`src/` code comments (~11 files).** Update the forward-reference "phase 4"
  comments in shipped phase-3 code to "phase 5" (comment-only churn of stable
  code), or leave them?
- **gpt-review snapshots.** These are dated reviews *of* the renamed specs —
  rewrite their "phase 4" to match the new filename, or preserve them as the
  historical record they are?

My lean: leave the historical prose as-is (it's not misleading once the phase map
is known), and only act if a future reader trips on it. Revisit when phase 4
ships and the standard re-suffix pass runs anyway (see the naming note in
[phase-4-plan.md](phase-4-plan.md)).

## Non-human races & additive body features (wings · horns · tail)

*Raised 2026-06-14, expanding the phase-4 species scaffolding.* Phase 4 built the
gating engine + `species/` registry and shipped **`human` only**, deferring "novel
body plans (tails/wings/gills)" and real non-human species. This designs the
**tractable middle ground**: wings/horns/tail as **additive features on the
humanoid plan** (a succubus is a humanoid + extra parts, not a new body plan),
gated by the same default-absent-tag + per-character-list mechanism phase 4 shipped
for intimate anatomy — a second list (`bodyFeatures`) defaulted from **species**
instead of gender. Adds the first real species records (`faerie`, `succubus`). The
real cost is image generation: features are visible + SFW, so they surface in the
always-visible appearance prompt on **both** image routes (unlike the
exposure-gated, Flux-excluded intimate set). True **structural** body plans
(mermaid/naga/quadruped) stay deferred beyond this.

See [non-human-races-and-features.deferred.md](non-human-races-and-features.deferred.md)
for the full design, the realize-engine change, the field mapping, and the build
order.

## Scene image: multi-reference & provider strategy

*Raised 2026-06-16, from external feedback on scene image generation.* Today's
scene render is single-reference (Venice/Qwen `/image/edit` takes one buffer);
multi-character scenes get one identity anchor + textual others. Design note
covers: a provider-capability abstraction + multi-reference plumbing (atop the
existing `meta.references` seam), the SFW-only hosted multi-ref lane (FLUX.2 /
Gemini / GPT-Image — all policy-walled for the intimate core), the brittle
reference-sheet stopgap, and self-hosted ComfyUI as the long-term home for the
uncensored core. **One item is not deferrable:** an uploaded real-person avatar
can currently anchor an intimate scene render (`allowIntimate: true` for any
Venice reference, `scene.ts:103-106`) — a safety bug to lift into
[followups.phase4.md](followups.phase4.md) immediately.

See [scene-image-references.deferred.md](scene-image-references.deferred.md) for
the full review, the exact fix, and my recommendation order.

## Comms expansions

*Raised 2026-06-13, from the phase-3 presence open questions.* Phase-3 comms
ships single-pair only. Deferred, none designed:

- **Group calls / group texts.**
- **Voicemail content** — a missed call carrying a message that becomes a
  told-fact.
- **Persistent text-thread history** the player can reread — the first thing
  players will ask for, and a natural UI surface for the pending-messages
  mechanic.

See
[presence-and-perception-spec.phase3.md](presence-and-perception-spec.phase3.md)
§Gaps & opportunities.

## Item acquisition during play

*Raised 2026-06-13, from the location-design ownership ruling.* Spawn-time item
ownership ships with the location/ownership work (`owner_participant_id`,
written only at spawn). Deferred — needs its own design: characters **acquire**
items in play (purchases, gifts) that become owned at acquisition time, a
second provenance path the items model doesn't have yet.

See [location-design-spec.phase3.md](location-design-spec.phase3.md)
§Ownership.

## Monorepo split (gated on a second deployable)

*Raised 2026-06-14.* Evaluated converting the single Next.js app into a pnpm
workspace. **Verdict: not yet** — Vesper was deliberately collapsed *from* a
12-package monorepo because every package had one consumer, and that still holds
(one deployable). Boundaries are already clean and enforced by convention +
barrels + the `@/` alias. Park behind a **trigger**: the first second consumer of
the engine — most likely a phase-4 background **world-simulation / scheduled-
arrival worker**. When it fires, do a small **4-package, consumer-driven** split
(`core` / `engine` / `web` / `worker`), not the old 12-package shape. Interim
action available now: an ESLint boundary rule + gating the one `process.env` read
in `lib/log.ts`.

See [monorepo-evaluation.md](monorepo-evaluation.md) for the full analysis,
package outline, and the architectural + `CLAUDE.md` boundary-enforcement design.

## Visual world map (node/path graph)

*Raised 2026-06-13, from the `/worlds/:id` Map section.* The Map section on
the world detail page (and the editor's map tab) lists location **cards** in a
flat column. Production worlds will have many locations, so the column grows
unwieldy — for now the detail-page Map section is collapsed by default
(`world-detail-page.tsx`). The real fix is a **visual map**: render locations
as nodes and the undirected links between them as edges (a force-directed or
hand-layout graph), so adjacency is read at a glance instead of from
per-card "↔ …" lists. Open questions: read-only vs. editable layout, where
node positions are stored (new per-location `x/y`, or auto-layout only),
and whether the play screen reuses it as a minimap. Replaces the flat list,
not just decorates it.

## Observer / god-mode session POV

*Raised 2026-06-13, from the phase-3 presence open questions.* The
presence/perception design assumes a player POV; observer / god-mode
("omniscient") sessions have no player participant to anchor awareness
blocks to (followups.phase2.md #10). Omniscient mode is **less relevant
to this fork's romance scope**, but the user wants to support it
eventually. Needs its own think — likely narrator-omniscient with no
awareness blocks, but deferred rather than ruled. Phase 3 takes no
stance for observer sessions.

See [presence-and-perception-spec.phase3.md](presence-and-perception-spec.phase3.md).

## Companion role as romance eligibility

*Raised 2026-06-13, brainstorm from the cast-tiers investigation.* Use the
existing cast **`role`** field (not tier) to designate romance targets:
**`role: companion` characters are the session's valid romance targets;
`role: npc` are not.** `npc`s stay fully fleshed (forge, facts, schedule,
presence) but are background flavor — the narrator deflects or gently redirects
romance gestures aimed at them. This keeps `tier` (`major`/`minor`/`extra`)
free for its existing job — *simulation/narration depth* — orthogonal to who
can be romanced.

It rides machinery that already exists: `spawnTier` auto-promotes a `companion`
authored `minor` to `major` (`cast-tiers.ts`), so romance leads already get the
deepest simulation — wardrobe, meters, per-character memory, perspective
memories — for free, while a background `npc` sits at whatever tier its world
texture needs. Romance would still gate on the **affinity edge**, not the role
alone — the `close`/`devoted` stages and the perceived-affinity model are the
mechanical substrate; the `companion` role just decides *who is eligible to
climb that ladder at all*.

Note this gives `role` a concrete gameplay meaning. The cast-tiers spec today
calls `role: companion | npc` "an authoring/POV distinction, not a simulation
one" — this would make it the **first behavior to branch on `role` at runtime**
(nothing branches on role *or* tier today). Tradeoff to weigh: a non-companion
you later want romanceable must be re-cast as a `companion` (or we add a
separate `romanceable` flag); coupling to the existing role is cheapest and
matches the framing.

See [cast-tiers-and-affinity-spec.phase3.md](cast-tiers-and-affinity-spec.phase3.md)
§Problem (role definition) and §Design: tiers.
