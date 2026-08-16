# Phase 4 plan — the body model (intimate anatomy, sensory, species scaffolding)

Status: **completed** (2026-06-14) — W0–T5 shipped: the gating engine
(`species/realize.ts` + `rules/attribute-rule.ts` + `species/` registry with
`human`), region-split body locations with intimate anatomy, the per-character
body-config (`CharacterProfile.intimateRegions`), intimate attribute groups
(`attributes/groups/intimate/`), the `taste` exposure axis + kiss/lick intent,
exposure-gated impression surfacing, the Qwen-include / Flux-exclude image switch,
and forge seeding + the editor body-config toggles. Gates green via `pnpm verify`
(lint + typecheck + test + jscpd); no DB migration (all state is JSONB). Leftovers
and tight-start omissions tracked in [followups.phase4.md](followups.phase4.md);
the **full aionchat anatomy catalog + port plan** for the non-intimate fields T1
skipped (buttocks, groin, abdomen, nose, …) is in
[supplemental-anatomy.phase4.md](supplemental-anatomy.phase4.md).
This is a **standalone** phase with no dependency on phase 5 — the body data it
produces is later *consumed* by phase 5's intimacy steering, not the reverse.

**Phase map.** Phase 3 (presence & perception v1) is
[completed](phase-3-plan.md). This phase 4 is the body model. The previously-
planned phase-4 cluster — "the world moves" (movement authority, scheduled
arrivals, pre-narrator intake) — was renumbered **phase 5** on 2026-06-14
(`*.phase5.md`). See the resequencing note in
[phase-3-to-4.md](phase-3-to-4.md).

The full design — every decision, the disk layout, the aionchat field-preservation
audit — lives in the spec:
[intimate-anatomy-sensory-and-species-spec.phase4.md](intimate-anatomy-sensory-and-species-spec.phase4.md).
This plan is the task list; the spec is the truth.

## Scope

The "body model" cluster, three folded ideas (romance-core, not deprioritized
RPG mechanics):

- **Idea 4 — intimate body regions.** Port the explicit anatomy onto the body
  tree, gated per character.
- **Idea 3 — sensory + taste.** A fourth `taste` exposure axis and per-region
  scent / taste / texture.
- **Idea 5 — non-human species (scaffolding only).** Build the species machinery
  and wire the dormant seams; ship `human` only, no non-human content.

The unifying mechanism is **one gating filter** — body plan → species → per-
character body-config → realized body — that decides which anatomy a character
has. Idea 4 populates it; Idea 5 is the same filter with the species layer turned
on; Idea 3 enriches what flows out of it.

## Design — settled

All eleven decisions are recorded in the spec's
[Decisions log](intimate-anatomy-sensory-and-species-spec.phase4.md#decisions-resolved-2026-06-14).
The load-bearing ones for the task plan:

- **Gating (D1):** gender sets a *default* anatomy at creation, always
  overridable, over an aionchat-style optional-anatomy layer.
- **Body-config (D1a):** stored **explicitly** as a short list of present region
  groups on the profile (JSONB, no migration).
- **Live state (D2):** erect/lubricated/aroused ride the existing `arousal` meter
  + conditions — **no new mutability tier**.
- **Images (D3):** intimate fields go to the **uncensored Qwen** routes (scene
  generator + character-studio Qwen pose/outfit) at full detail; **withheld from
  Flux** (portrait). Keyed on the image route.
- **Layout (D11):** dedicated `intimate/` attribute subfolder + region-split body
  locations — which also makes the Flux-exclusion / moderation filter a one-liner.
- **Player (D10):** the player uses the same body model as any NPC.

## Task plan (build order forced by dependency)

**W0 — contracts foundation (pure, tested; the gating engine).**
- `rules/attribute-rule.ts` — the shared required/optional/forbidden +
  default/allowed/disallowed primitive (from aionchat).
- `species/` registry seeded with `human`; wire `appliesToBodyPlans` /
  `excludesBodyPlans` + species allow/disallow so they actually filter (today
  inert).
- Per-character **body-config** field on `CharacterProfile` (explicit region-group
  list), read through `parseOr` with a gender-derived/empty default.
- Region-split `body/locations/` (everyday + `intimate.ts`); new intimate
  **categories**; the **realized-body** filter (body plan ∩ species − disallow,
  intimate subset narrowed by body-config).

**T1 — intimate regions + descriptive attributes.** Port the anatomy attribute
groups into `attributes/groups/intimate/` (clinical values, prose `promptHints`),
gated by W0. Anus in scope (D7). Vocabulary starts tight (D6).

**T2 — sensory + taste.** Add the `taste` exposure axis + its raise trigger
(kiss → touch + taste at `close`, D5); per-region scent/taste/texture
`sensory`-kind attributes on the new regions and lips/skin/neck. Extend
`exposureRules`, the `includeSensory` gate, the intent regex + `tasteTarget`, the
raise function, and the intake adapter (each has a scent/touch sibling to copy).

**T3 — image generation.** Add the model-gated "allow intimate detail" switch to
the scene-composer / variant / avatar prompt builders (true for Venice/Qwen,
false for Flux); extend `RegionExposure` grouping with the new regions / a finer
genital-exposure state on the Qwen routes.

**T4 — forge + editor.** Forge seeds body-config from `identity.gender`; the
attribute picker and character editor filter offered attributes through the
realized set and expose body-config toggles; live state surfaces via arousal-meter
threshold hints / conditions.

**T5 — integration, tests, docs.** Degradation tests (empty body-config = today's
behavior; absent species self-heals) asserting fallback **and** diagnostic code;
confirm **no DB migration**; update `docs/contracts.md`, `prompts.md`, `images.md`,
and the body/attribute guide pages in the same change.

## Out of scope (deferred)

- Actual non-human species records and **novel body plans** (tails/wings/gills) —
  Idea 5 is scaffolding only; novel plans are a later phase with image gen in the
  room from day one. The *additive*-feature slice of this (wings/horns/tail bolted
  onto the humanoid plan + the first `faerie`/`succubus` records) is now designed
  in [non-human-species.spec.md](non-human-species.spec.md);
  true *structural* plans (mermaid/naga) stay deferred beyond it.
- The `runtime` mutability tier (D2), and `requiresAttributes` /
  `conflictsWithAttributes`, `itemSchema` / `collection` (spec field table) — each
  re-addable later as a no-migration edit.
- The intimacy **steering** block + dialogue economy (feedback ideas 1/2) — those
  are phase 5; they consume this phase's data.

## Open questions

All *original* design questions are resolved (spec Decisions log). Two items
remain:

- **Anatomy port granularity** (raised 2026-06-14, detail in
  [supplemental-anatomy.phase4.md](supplemental-anatomy.phase4.md) §P1): when
  porting aionchat's remaining anatomy vocabulary, do we **fold** segment
  attributes (upper_arms/forearms/thighs/calves → `arms`/`legs`; cheeks/chin/
  forehead → `face`) into Vesper's coarse groups (recommended), or match aionchat
  **1:1** with a group per region? The field data is identical either way; only
  the `category`/file layout differs. Defaults to fold; confirm before the port.
- **Housekeeping** (tracked in [deferred.plan.md](../deferred.plan.md) §"Phase-4/5
  resequencing — deeper prose sweep"): whether to chase the remaining historical
  "phase 4" prose mentions (dated phase-3 docs, the `phase-3-to-4.md` body,
  gpt-review snapshots, ~11 `src/` code comments) now meaning phase 5, or leave
  them banner-only.

## Naming note

Standard convention: when this phase ships, re-suffix any surviving cross-phase
docs and fix pointers — `grep -rn '\.phase4\.md' docs/ src/` finds every link
(a few `src/` code comments point at these files too).
