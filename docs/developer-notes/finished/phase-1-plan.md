# Phase 1 response plan

Status: **completed** (2026-06-11) — T13 and T16 deferred by decision;
everything else landed. See the decision log and the
findings-during-implementation section below.

Investigation of every item in [phase-1.md](phase-1.md), with root causes confirmed in code, a task-based plan ordered by priority, and a decision log at the end. File references are starting points, not exhaustive change lists.

## Root-cause summary

| #   | Finding                                                   | Root cause                                                                                                                                                                                                                                                                                                                               | Where                                                                                                         |
| --- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 1   | World save erases forged cast/items                       | The forge page sends the raw draft to `worldsApi.create`, but the server schema expects `cast` (with `characterId`) and `items` (with `itemId`/`definition`), not `castSuggestions`/`itemPlacements`. Zod strips the unknown keys and the `.default([])` masks the mismatch — silent data loss.                                          | `src/components/worlds/world-forge-page.tsx:57`, `src/server/api/worlds.ts:82–114`                            |
| 2   | Character outfit items disappear on save                  | Same shape-mismatch pattern: client sends `suggestedItems`, but `characterCreateSchema` (`src/server/api/schemas.ts:43`) doesn't accept them and the POST handler has no auto-create pipeline. The outfit editor even promises "saved as new items with this character" — never fulfilled.                                               | `src/app/api/characters/route.ts:27–37`, `src/components/characters/outfit-editor.tsx:79–110`                 |
| 3   | Portrait variants 405                                     | The client GETs `/api/characters/{id}/portraits` but the route only exports `POST` (create variant). Next.js returns 405 for the missing method. The empty state ("No variants yet.") already exists and will work once GET exists.                                                                                                      | `src/app/api/characters/[id]/portraits/route.ts:20`, `src/lib/client/api.ts:249`                              |
| 4   | World forge "dropped link" errors                         | **Not** an ordering bug — all locations come from a single LLM call, and links are validated only after the full set exists. The LLM hallucinated link targets ("West Farmlands") that it never generated. The validator correctly drops them (`world-forge.ts:208`); the prompt just doesn't constrain link targets to generated names. | `src/server/authoring/world-forge.ts:184–237, 274–301`                                                        |
| 5   | "repair round-trip" messages                              | `generateChecked` retries a failed structured-output parse once by sending the model its own invalid output plus the Zod error ("repair"). The `info`-level "needed one repair round-trip" diagnostic means it _recovered_ — surfacing it as an error-styled message in the UI is a presentation bug, not a generation bug.              | `src/server/ai/generate-checked.ts:31–86`                                                                     |
| 6   | No AI-assigned character attributes                       | The attribute agent has the full registry vocabulary, but its system prompt says "Omit any attribute the concept gives no basis for — sparse is correct," so the model skips hair/skin/eyes/height even when the concept implies them.                                                                                                   | `src/server/authoring/character-forge.ts:224, 244–256`                                                        |
| 7   | Cast/items tabs can't import existing entries             | By design the tabs edit draft stubs (name + concept note). Post-generation name matching against the library exists (`matchCastSuggestions`, ILIKE) but there's no picker UI and no way to link manually.                                                                                                                                | `src/server/authoring/drafts.ts:70–78`, `src/components/worlds/world-editor.tsx:441–625`                      |
| 8   | New-session embodiment buttons look identical             | Selected card styling is `border-accent-500/70 bg-ink-750` — nearly indistinguishable from the unselected `bg-ink-800`. `aria-pressed` is already correct.                                                                                                                                                                               | `src/components/sessions/new-session-wizard.tsx:127–147`                                                      |
| 9   | Coverage checkbox indentation                             | Body locations form a real tree (`src/contracts/body/locations.ts`), and checking a parent **does** expand to all descendants at evaluation time (`registry.expand`, confirmed by `visibility.test.ts`). The editor renders the hierarchy as a single `pl-3` indent and never communicates the expansion semantics.                      | `src/components/items/item-editor-page.tsx:237–326`                                                           |
| 10  | No clothing types / object subtypes / quantified capacity | Not implemented. `ItemDefinition.kind` is just `clothing \| object \| container`; container capacity is a free-text string in `fields.capacity`. companion-app has a full clothing-category system with default coverage worth porting.                                                                                                  | `src/contracts/items/item.ts:17–31`, `~/projects/companion-app/packages/contracts/src/clothing-categories.ts` |

The big systemic finding: **issues 1 and 2 are the same bug class** — forge drafts and create-endpoint inputs are different shapes with no conversion layer, and Zod's strip-unknown + defaults policy turns the mismatch into silent data loss instead of a visible error. This violates the spirit of the resilience rules (degraded defaults are for _recovering_, not for _hiding_ a contract mismatch).

---

## Task plan

### P0 — Bugs blocking the core loop (sessions are currently untestable)

**T1. World save: materialize forged cast and items.**
The keystone task — it unblocks session testing (no companion exists today because cast never persists).

- Add a `worldDraftToCreateInput` conversion (pure function, lives in `src/lib` or alongside the draft contracts) that maps `castSuggestions` → `cast` and `itemPlacements` → `items`, resolving draft cast names to character ids.
- For cast stubs with no `existingCharacterId`: run the character forge server-side at save time to create real character rows (per your stated preference for generation on save), then link them. Skip generation for matched library characters — never regenerate existing entities.
- Map item placements: `castName` → `castCharacterId`, preserve `worn`, pass `definition` for new items.
- Guard against recurrence: make the create endpoints **reject** (or at minimum emit a diagnostic for) unknown top-level keys instead of stripping them silently. A draft posted to a create route should be a loud failure, not an empty world.
- Tests: degradation test asserting that an unmatched cast name produces a diagnostic _and_ a created character, not silence.
- Cap forge-generated cast at 3 per save (the forge prompt already asks for 1–3; enforce the cap in the save pipeline too so manual edits can't exceed it).
- Partial failure policy (decided): if one cast generation fails, save the world anyway with that member kept as an unlinked stub plus a diagnostic. Post-save recovery (regenerate / generate new / import from library) lives in the world editor — see T8.

**T2. Character save: auto-create suggested outfit items.**
Same pattern, smaller scope.

- Add `suggestedItems: z.array(itemDefinitionSchema).default([])` to `characterCreateSchema`.
- In the POST handler, insert each suggested item as a real `items` row (tagged `suggested` per the existing draft contract comment), then append the new ids to `profile.defaultOutfit`.
- Dedupe against the library by name before creating (matches your "should not try to generate existing items" requirement); reuse the matching helper from T1 if practical.
- This is the user-preferred path for organically populating the clothing library.
- Provenance (folded from opportunities): forge-created items keep the `suggested` tag, so future "regenerate outfit" flows can tell forge picks from manual ones and avoid clobbering the latter.

**T3. Portrait variants: add the missing GET handler.**

- Add `GET` to `src/app/api/characters/[id]/portraits/route.ts` returning the character's images (mirror the query already in `/api/characters/[id]/route.ts:28–37`: ownership check, then `images` filtered by `entityKind = "character"`).
- Verify the 2.5s generation polling in `portrait-studio.tsx` reloads silently (no error flash between polls).

### P1 — Forge quality (the errors and gaps you hit on first run)

**T4. World forge: constrain and repair location links.**

- Tighten `locationsPrompt` (`world-forge.ts:274–281`): state explicitly that every `links` entry must exactly match the `name` of another location in the same response, with a short self-consistent example.
- On dropped links, attempt fuzzy rescue (case-insensitive / near-match against generated names) before dropping; include "did you mean" in the diagnostic when no rescue is possible.
- Downgrade presentation: a dropped link is a `warn`, not a red error banner.

**T5. Diagnostics presentation: severity-aware UI.**

- "needed one repair round-trip" is `info` — it means recovery succeeded and should render as a muted notice (or be hidden by default), not alongside real failures. Only `error` severity ("failed after repair") warrants the red treatment with the "regenerate or write manually" call to action.
- Audit the forge pages' diagnostic rendering so severity maps to visual weight consistently.

**T6. Character forge: baseline physical attributes.**

- Two-tier fill policy (decided): nuance attributes stay confidence-gated ("sparse is correct"), but core visual attributes — hair color, eye color, skin tone, height, apparent age, build frame — must always end up filled so quick-spin characters need no manual editing.
- Tier 1, LLM inference: amend the attributes system prompt (`character-forge.ts:224–256`) to infer plausible baselines for the core groups whenever the concept supports it (heritage, profession, age cues). Values stay registry-validated and user-overridable ("AI drafts, human owns").
- Tier 2, code-level random fallback: after grounding, any core attribute still unset gets a uniform random pick from the registry's value list (in or near `groundAttributeValues`). Real randomness in code, not "pick randomly" in the prompt — an LLM asked to randomize converges on the same statistically-likely defaults (brown hair, brown eyes) every time, so the code tier is what actually delivers variety.
- Tests: a heritage-rich prompt yields inferred core values; a minimal prompt still yields fully populated core groups.

**T7. World forge: cast/item linkage in the items agent.**

- Make `itemsPrompt` (`world-forge.ts:563–571`) directive about ownership: enumerate cast members and instruct "assign personal items (especially clothing) to the obvious cast member; set worn for clothing being worn."
- The grounding already clears unresolvable `castName`s — add a fuzzy pass here too, since "Dr. Thorne's lab coat" → "Dr. Thorne" is exactly the near-match case you observed failing.

**T16. Stream forge diagnostics per-section.** (folded from opportunities; **deferred**)

- Diagnostics currently arrive as one batch after the whole forge completes; surface each section's diagnostics as that section finishes. Deferred: the forge endpoints are plain POSTs, so this needs an SSE protocol change — revisit if forge latency becomes a complaint. T5's severity-aware rendering (plus repaired→info) already removes the alarming-noise problem.

### P2 — Editor UX

**T8. Cast/items tabs: import from library.**

- Add a picker (combobox listing saved characters/items) to the Cast and Items tabs in `world-editor.tsx`, alongside the existing "new stub" free-text path. Selecting sets `existingCharacterId`/`itemId` and locks the name; the existing "library match" / "new stub" tags already give the right affordance.
- Consider upgrading `matchCastSuggestions` from exact ILIKE to trigram/fuzzy matching so post-generation auto-linking catches more.
- Post-save cast management (decided, pairs with T1's partial-failure policy): in a saved world, unlinked stubs left by failed generations get actions to regenerate, generate fresh, or link to a library character — reusing the same picker component.

**T9. New-session embodiment selection state.**

- Apply the codebase's established active-selection pattern from `attribute-picker.tsx:197–199` (`border-accent-500/60 bg-accent-500/10 text-accent-300`) to the selected card, optionally with a small check indicator. One-file change.

**T10. Coverage editor: tree presentation + parent semantics.**

- Replace the lone `pl-3` with a deliberate design: group by root (as today), render children as a connected tree (indent guides or left borders, consistent per level).
- Interaction rule (decided — R1 confirmed): checking a parent acts as a select-all cascade. All descendants become checked but stay individually togglable; unchecking a child puts the parent in a partial (indeterminate) state. Coverage is stored as the explicit exploded set.
- Why cascade instead of disabled-children-with-an-eyes-exception: a hardcoded eyes exception leaks a specific body-location id into the component, against the registry principle (locations are data, the UI shouldn't know their names). With the cascade, the ski-mask case falls out naturally — check Head, uncheck Eyes — and the same mechanism gives fingerless gloves (Hands minus Fingers) and open-toed shoes for free. `registry.expand` is per-id, so exploded arrays evaluate identically to minimal ones; nothing in the engine changes.

**T17. Session deletion (unblocks world deletion).**
Worlds correctly refuse deletion with a 409 `in_use` while a session references them, but sessions have no delete affordance at all — so the reference can never be cleared.

- Backend: check whether `DELETE /api/sessions/:id` exists; add it if missing. Unlike library entities, a session owns its subordinate rows (turns, episodes, facts, session state) — cascade or explicit cleanup is appropriate there; the "never cascade" rule protects shared library entities, not session-scoped data. Clean up generated session images via the same pattern character delete uses (`deleteEntityImages`).
- UI: a delete action on the sessions list (and/or session page) with a confirmation step, since it destroys play history. After that, deleting the world works through the existing flow.

### P3 — New systems (design-first, registry-driven)

**T11. Clothing categories with default coverage.**

- Port companion-app's `CLOTHING_CATEGORY_DEFAULTS` concept as a new registry `src/contracts/items/clothing-categories.ts` (data-only, per the registry rule — no schema migration). Map old `BodyRegion`s onto vesper's deeper body-location tree.
- Add optional `category` to clothing definitions; editor gets a category select that pre-fills coverage (user can override); the character/world forges emit a category instead of hand-rolling coverage arrays — this directly improves T2/T1 output quality.
- Trimmed vocabulary (decided — R2 confirmed): `top`, `outerwear`, `dress`, `pants`, `shorts`, `skirt`, `bra`, `underwear`, `socks`, `footwear`, `gloves`, `headwear`, `eyewear`, `jewelry`. Expand later as needed.
- Straddling garments (your abaya example): pick the closest coverage template — for an abaya that's `dress` (torso/arms/legs), not `outerwear` — then adjust coverage and set `layer` to outer. Categories are coverage pre-fills and nothing more: the name never reaches gameplay prompts (rule below) and carries no jacket/coat semantics; layering behavior comes entirely from the item's `layer` field.
- Hard constraint (decided): category names are authoring-time templates only and must never appear in gameplay prompts. The narrator and state agents see only the item's name, description, and resolved coverage set — so a t-shirt whose arm coverage was removed reads as the sleeveless garment it now is. Enforce by keeping `category` out of the prompt-assembly serializers, and document the rule in `docs/prompts.md`.

**T12. Object subtypes registry.**

- Create `src/contracts/items/object-subtypes.ts` (furniture, vehicle, weapon, tool, food, …) + optional `subtype` on object definitions + editor select. Land the vocabulary now; behavioral systems are separate, later efforts that each get a docs/ design note first.
- First behavior (decided): hand-equippable items (umbrellas, TV remotes, …) rather than weapons or vehicles. Model equippability as a capability on the definition (e.g., `holdable: true` or a subtype trait), never as a hand-slot binding — where the item currently sits (a character's hand, a container, a location) is session state, so equippables remain container-storable by construction. Weapons arrive later as a specialization of holdable; vehicles are late-stage.

**T13. Container capacity model.**

- Deferred (decided): implement in a later phase. Keep this sketch as the starting point when it comes up — items get an optional `size` (small abstract unit scale), containers get `capacity: { slots?: number; unitsPerSlot?: number }` per your bookcase example, with a short design doc written first. The free-text capacity note stays as-is until then.

### Cross-cutting

**T14. Establish "draft → create-input" as a documented pattern.**
After T1/T2, write the pattern into `docs/authoring.md`: every forge that produces a draft must ship a typed conversion to the create-input shape, and create endpoints must not silently strip draft-shaped payloads. This prevents the next forge (sessions? scenes?) from reintroducing the data-loss class.

**T15. Docs coverage and user-guide structure.**
Per your note: every task above updates the relevant `docs/` system doc in the same change (already the CLAUDE.md rule — this task is the reminder that it applies to each task in this plan), and a user guide starts growing alongside the system docs. Proposed shape: a `docs/guide/` subfolder with task-oriented manual pages (`creating-characters.md`, `creating-items.md`, `building-worlds.md`, `running-sessions.md`), kept separate from the system docs so each stays focused — system docs explain how Vesper works, guide pages explain how to use it. Guide pages get stubbed as their flows stabilize, starting with the P0/P1 work. Audience (decided — R3): developer-operator for now — free to reference code and architecture — with end-user polish later.

---

## Suggested sequencing

1. **T3** (trivial, immediate win) → **T2** → **T1** (largest P0; T2 builds the item-creation muscle T1 reuses) → **T14** (document while fresh).
2. **T5 + T4 + T7** together (one pass over forge prompts + diagnostics rendering); **T16** rides along if the forge already streams section results, otherwise it follows.
3. **T9** (one file), **T6**, **T8**, **T10**, **T17**.
4. **T11 → T12** (T13 is deferred to a later phase); T11 first since it feeds forge quality.
5. **T15** runs alongside everything — system-doc updates land with each task; guide stubs start once the P0/P1 flows ship.

## Other opportunities noticed during investigation

All four are now folded into tasks:

- **Cast matching is exact-match only** (ILIKE) → fuzzy matching in T7/T8.
- **Forge diagnostics arrive as a batch** → T16.
- **Outfit provenance** (forge picks vs manual picks in `profile.defaultOutfit`) → T2.
- **No guard against draft/input drift** → T1's test work: an integration test posts a full forge draft through the real create route, failing CI if client and server schemas diverge again.

## Findings during implementation (2026-06-11)

Issues discovered and fixed while executing the plan, beyond the original ten:

- **Saved-world edit page had the same silent data-loss bug as T1** — it PATCHed the raw draft, stripping `castSuggestions`/`itemPlacements`, and replacing `locations` alone cascaded item placements away. Worse, draft locations carried no `locationId`, so every edit-save would have duplicated all library locations. Fixed: `POST /api/worlds/:id/from-draft` (`updateWorldFromDraft`) reuses the T1 conversion; linked locations round-trip as world-local overrides; `quantity` and `manuallyUnlocked` now survive the draft round-trip. Known limitation: container nesting between world items isn't in the draft shape, so an edit-save flattens it.
- **Avatar prompts ignored the default outfit** (user report: abaya/hijab character rendered in headband and cardigan). `buildAvatarPrompt` now includes the default outfit (names + sensory appearance) as an authoritative "Wearing" line; lookup failure degrades to the attributes-only prompt.
- **Coverage partial-state readability** (user report): an ancestor of a checked location shows an indeterminate dash that read like auto-selection. Checking "eyes" never selects "face" — the dash means "partially covered". The partial checkbox is now dimmed with a tooltip, and the editor explains the dash; a regression test pins the glasses case (eyes-only stays eyes-only).
- **Body tree restructure** (user feedback round 2): `neck` moved under torso (no more lone neck column); new `upper_arms` under arms (a t-shirt can finally cover arms without covering forearms/hands); new `pelvis` root grouping reparented `hips`/`groin` plus new `buttocks`. Editor columns are now head · torso · arms · pelvis · legs. All clothing templates and demo outfits rewritten to use specific parts — bare `arms`/`torso`/`legs` over-imply (hands, neck, feet) and are avoided everywhere, including a new instruction in the outfit agent prompt.
- **Client detail unwrap discarded world families** (user report: edit-save erased Greywater Harbor's map and lore). `detailOf` in `lib/client/api.ts` unwrapped `{ world, locations, cast, … }` by returning only `obj.world`, silently dropping every sibling family — so the world page never showed map/cast/items from the detail endpoint, the edit page always seeded empty families, and any edit-save then faithfully erased the real `world_locations`/`lore_chunks` rows. Fixed by merging siblings with the entity row (regression test added). The library `locations` rows were untouched (only links erased); Greywater Harbor's eight locations were re-linked by hand — its `world_links` and `lore_chunks` rows were unrecoverable. The edit page also now shows an in-flight save notice (cast forging takes ~a minute).
- **Cast outfit visibility**: linked cast members in the world editor now show a read-only "wears by default: …" line (outfits are live references — cast spawn wearing their `profile.defaultOutfit` in every session, deduped against world placements — so they're displayed, never duplicated into world items).
- **Avatar prompt now occlusion-filtered** (user report: abaya worn over t-shirt/jeans rendered open with the under-layers showing because the prompt listed them). `visibleAvatarOutfit` runs the default outfit through the same `resolveWardrobeVisibility` rule scene images already use: fully hidden layers are omitted, sheer-covered items become a vague hint, coverage-less items (jewelry) stay. Applying the same filter to the narrator's wardrobe block in-game is deliberately deferred (scene prompts already filter; the narrator block is a separate decision).

## Decision log (reviewed 2026-06-11)

All seven open questions from the first draft are resolved and folded into the tasks above:

1. **Cast generation at save time** — blocking save with per-character progress; cap generated cast at 3 (T1).
2. **Partial failure** — save anyway with an unlinked stub + diagnostic; saved worlds get regenerate / generate-new / import-from-library actions (T1, T8).
3. **Attribute fill** — two-tier: confidence-gated inference for most attributes, guaranteed fill for core visuals like hair and eye color (T6).
4. **Coverage parent-check** — select-all cascade with carve-outs rather than a hardcoded eyes exception (T10; rationale in the task — confirm via R1).
5. **Clothing categories** — trimmed/renamed template set, expandable later; category names never enter gameplay prompts (T11; list sign-off via R2).
6. **Container capacity** — deferred to a later phase (T13).
7. **First item behavior** — hand-equippable items before weapons/vehicles; equippability is a capability, not a hand-slot binding, so equippables stay container-storable (T12).
8. **Docs** — every task updates its system doc in the same change, and a user guide grows under `docs/guide/` (new T15).

Second-round answers (reviewed 2026-06-11, all questions now closed):

9. **Coverage cascade (R1)** — confirmed; T10 proceeds as written.
10. **Category list (R2)** — confirmed. On the abaya: it takes the `dress` template (closest coverage match) with an outer `layer`. Categories are coverage pre-fills only and never reach gameplay prompts, so no jacket/coat semantics attach — note added to T11.
11. **Guide audience (R3)** — developer-operator now, end-user polish later (T15).

On the random-fill question (decision 3): agreed, with one implementation nuance. Asking the LLM to "pick randomly" doesn't produce randomness — it converges on the same statistically-likely defaults (brown hair, brown eyes) for every quick-spin character. So the guaranteed tier is real code: after grounding, any still-unset core attribute gets a uniform random pick from the registry's value list. The LLM infers when the concept gives it something to work with; the code supplies genuine variety for the rest. Details in T6.

All questions are resolved — see the decision log above. Implementation proceeds in the suggested sequencing.
