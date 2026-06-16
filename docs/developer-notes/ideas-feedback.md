# Feedback on `user-guidance/ideas.md`

Status: **initial thoughts** (2026-06-14). My first-pass assessment of the five
raw ideas in
[user-guidance/ideas.md](user-guidance/ideas.md). Grounded in the current code,
the in-flight phase-4 intake work, and the aionchat contracts the user points to
for the body plan. Not a plan — input for deciding what graduates into a phase
and in what order. Where I disagree or see a complication I say so; per
[CLAUDE.md](CLAUDE.md), user-guidance outranks my notes, so treat this as
argument, not veto.

---

## Bottom line up front

- **None of these are greenfield.** Every one rides infrastructure that already
  exists or is being built: the pre-narrator **intake** agent (idea 1), the
  body-location + attribute **registries** with their `sensory` kind and
  `bodyPlans`/`appliesToBodyPlans` seams (ideas 3–5), and the **exposure mask**
  (idea 3). The work is mostly *populating data and wiring deterministic
  consumers*, not new architecture. That's the good news.
- **Ideas 1–4 are one cluster: the intimacy beat done well.** Intake classifies
  `actionType: "intimate"` → a deterministic steering block limits dialogue
  (idea 2) and surfaces the right intimate regions (idea 4) and sensory detail
  (idea 3). They should be specced together; building any one alone leaves the
  beat half-served. Idea 5 (species) is a separate, broader thrust.
- **One framing correction to idea 1.** The agent must **classify**, not **write
  the narrator's instructions**. The intake spec is explicit that LLM output
  never reaches the narrator as prose (hallucinated-plan risk); a *deterministic*
  block composes the steering from intake's classification + authored data. The
  user's "agent provides fields and instructions to steer it" lands as: intake
  tags the beat, the engine assembles the steering. See idea 1 below.
- **Registries mean no migrations for 3–5.** Per CLAUDE.md, body locations and
  attributes are data edits in one file. Expanding the body plan, adding sensory
  attributes, and adding humanoid species are additive registry changes — not
  schema work. Novel body plans (mermaid/alien) are the one real exception.
- **Stale decision note:** ideas.md idea 1 reverses followups.phase2 #15/#16
  ("no LLM before narration"). That reversal is already settled — Stack A intake
  is approved and partly built (see idea 1). My auto-memory still records the old
  decision; I'll correct it.

---

## How this maps to what's already moving

| Idea | Already-built substrate | Net-new work |
| --- | --- | --- |
| 1. Pre-narrator field agent | **Intake / `IntentBrief`** (built, Stack A) — `actionType:"intimate"`, `check.relevantAttributeIds` seams exist | A deterministic *steering block* consuming the brief |
| 2. Limit dialogue in intimacy | `buildTurnDigest` (deterministic guardrail pattern) | A dialogue-economy block keyed on `actionType:"intimate"` |
| 3. Sensory schema | `sensory` attribute kind; `scent_baseline`, `voice.*`, `*.texture`; item `{appearance,scent,tactile}`; location `ambient`; exposure scent/touch axes | **Taste/flavor** (new sense + exposure axis); per-region sensory |
| 4. Intimate body regions | Body-location registry (27 humanoid entries, `parentId`/`side`/`coverageRelevant`); aionchat (~62, with explicit sexual anatomy) as the template | New region entries + attribute categories; anatomy gating; exposure-region extension |
| 5. Non-human species | `bodyPlans` array (humanoid only); `appliesToBodyPlans`/`excludesBodyPlans` (unused); `identity.species_presentation` (free text) | Species-as-body-plan-variant model; humanoid variants cheap, novel plans expensive |

---

## Idea 1 — Pre-narrator agent(s) feeding the narrator relevant fields

**What's there today.** This is largely *already designed and in build*. The
[pre-narrator-agents-spec](pre-narrator-agents.spec.md) approved **Stack
A**: a single latency-hidden intake agent emitting an `IntentBrief`
(`src/contracts/turns/intent-brief.ts`, `src/server/engine/intake.ts`). The
brief already carries the exact seams this idea needs:

- `actionType: "intimate"` is in the enum today.
- `check.relevantAttributeIds` + `check.stakes` — a persisted seam for "what
  attributes are most relevant," recognized but not yet consumed.

**Assessment.** The idea is sound and mostly underway — but the user's phrasing
("the agent will provide the narrator with fields and **instructions** related
to intimacy to steer it") describes a different boundary than the spec endorses.
The spec (§4.4) is firm: **intake output must never reach the narrator as prose
instructions** — that's the hallucinated-plan failure mode #16 worried about.
Intake *classifies*; a deterministic block *steers*.

**Recommendation.** Realize the idea as two pieces:

1. **Intake classifies the beat** — already does (`actionType:"intimate"`), and
   should populate `check.relevantAttributeIds` with the body/sensory attributes
   in play (e.g. the touched region's texture, scent at this exposure level).
2. **A deterministic "intimacy steering" block** — a sibling of
   `buildTurnDigest` — composes the narrator guidance from that classification
   plus *authored* character/scene data. This is where idea 2's dialogue limits
   and idea 3's sensory cues actually land. No LLM prose, no invented plan.

This keeps idea 1 inside the architecture already chosen and makes it the host
for ideas 2–4. The `check` field is the seam; this idea is what finally consumes
it.

**Effort & landing.** Low–medium given the substrate. It is the connective
tissue for the intimacy cluster, so spec it first, alongside 2–4.

---

## Idea 2 — Limit character dialogue in certain situations (esp. intimacy)

**What's there today.** Nothing dedicated. Dialogue volume is purely the
narrator's discretion, governed by the static rulebook prompt.

**Assessment.** Real and well-observed — "characters narrate intimacy like a
Q&A" is a known LLM failure. The fix is **prompt discipline conditioned on the
beat**, and idea 1 supplies the condition (`actionType:"intimate"`). Concretely:
a steering block that says *"prose is sensory/visual first; at most one or two
dialogue lines, only when they add something; no logistical or check-in
questions."*

Two honest caveats:

- **"Only when useful" can't be enforced deterministically.** It's an
  instruction to the narrator, not a gate. A pre-turn block raises the floor; it
  can't guarantee the narrator obeys mid-stream. If violations persist, the real
  enforcement is the **mid-stream tag/quality gate** (Stack C "during" in the
  intake spec, still unbuilt) or a post-turn continuity check — not a pre-turn
  field. Worth flagging so we don't over-promise from a prompt alone.
- **Generalize carefully.** "limit dialogue in *certain situations*" is broader
  than intimacy (action beats, tension, etc.). Start with intimacy where the
  failure is sharpest and the trigger is clean; treat other situations as later
  `actionType` cases, not a v1 scope.

**Effort & landing.** Low (a prompt block + a test asserting it fires on
`intimate`). Pairs with idea 1; ship together.

---

## Idea 3 — Add a sensory schema to characters

**What's there today — more than the idea assumes.** Sensory is *partly* built:

- `sensory` is already an attribute **kind** (`attributes/types.ts`).
- Scent: `presentation.scent_baseline` (with exposure-gated prompt hints).
- Sound: the full `voice.*` group (pitch / timbre / accent / cadence).
- Tactile: `hands.texture`, `skin.texture` (and `hair.texture`).
- Items carry `{appearance, scent, tactile}`; locations carry
  `ambient.{scent,sound,light}`.
- The **exposure mask** already has `scent` and `touch` axes, raised by
  `smellTarget`/`touchTarget` intents and gating when sensory detail surfaces.

So this is an **extension, not a new system**. What's genuinely missing:

1. **Taste / flavor — absent entirely.** No taste attributes, and crucially **no
   `taste` axis on the exposure mask** (`appearance | scent | touch` only). Taste
   is the most intimate sense — earned only at intimate contact — so adding it
   means a new exposure axis and a new raise-trigger, not just attributes. This
   is the one part with real design surface.
2. **Per-region sensory.** Attributes can already bind to a region
   (`bodyLocationId`), but coverage today is sparse. Idea 3 + idea 4 intersect
   here: scent/taste/texture want to attach to the new intimate regions.

**Assessment & recommendation.** High value for romance-core, and cheap where it
reuses the existing mask; the work is (a) decide the taste axis + its raise
trigger, (b) add `sensory`-kind attributes (taste, per-region scent/texture)
bound to body locations, (c) extend the gating in `pipeline.ts`/`scene.ts` so the
new senses surface only at the right exposure. Author per-character (consistent
with `scent_baseline`), don't leave it to the narrator to improvise — improvised
scent/taste drifts turn to turn.

**Effort & landing.** Medium. Sequence *after* idea 4 (regions) so per-region
sensory has somewhere to attach.

---

## Idea 4 — Add intimate body regions (expand toward the aionchat body plan)

**What's there today.** Vesper's body registry (`src/contracts/body/locations.ts`,
27 entries) is the **wardrobe-granularity** humanoid tree it forked from reverie
— no genitalia, no explicit intimate regions; `buttocks`/`groin` exist only for
coverage. aionchat (`~/projects/aionchat/packages/contracts`) is the fuller
template the user names: ~62 locations including explicit sexual anatomy (vulva
with labia/clitoris/vestibule sub-parts, penis, testicles), and — notably — a
**`runtime` mutability tier** for simulation state (e.g. arousal/lubrication)
distinct from descriptive attributes.

Good news: **the two schemas are the same shape** (registry, `parentId`, `side`,
attribute categories, `bodyPlans`). Expanding is additive registry edits — no
migration (CLAUDE.md). This is squarely romance-core, so high priority, not a
deprioritized general-RPG mechanic.

**Assessment — the design surface that makes this non-trivial:**

1. **Anatomy must be gated, not universal.** You can't just add a `vulva` region
   to every character. aionchat gates anatomy via species/attribute rules; Vesper
   needs an equivalent — likely keyed off `identity.gender` and/or a body-config
   — so the right anatomy is present and the wrong anatomy is absent. This is the
   crux of the idea, and it's shared with idea 5's machinery.
2. **Exposure-region grouping must extend.** `contracts/items/visibility.ts`
   groups regions into torso/pelvis/legs/feet for coverage + image generation;
   new intimate regions slot under pelvis and need coverage/exposure semantics.
3. **Descriptive vs. simulation state.** If we want arousal/state (aionchat's
   `runtime` tier), Vesper has `inherent|mutable|temporary` but no `runtime`
   tier. Decide whether intimate state is simulated (a meter/condition) or purely
   narrated. I'd lean: keep v1 descriptive + reuse the meter/condition system for
   state rather than adding a tier.
4. **Image-generation ripple.** Avatars/portraits and the visibility regions feed
   image prompts (`server/images/*`, portrait-studio). Intimate regions and
   exposure changes ripple into image generation and into SFW/safety handling for
   portraits. Flag this early — it's the hidden cost.

**Recommendation.** Port aionchat's intimate regions + their attribute
categories into the registry; add the anatomy-gating rule; extend
visibility/exposure grouping; defer simulation state to meters. Borrow aionchat's
`promptHints`-per-attribute discipline so the narrator knows *when* a region is a
touch/scent detail vs. a visual one.

**Effort & landing.** Medium–large (data port is mechanical; gating + exposure +
image ripple are the work). The data foundation ideas 2/3 depend on — spec it
**first** in the cluster.

---

## Idea 5 — Non-human species

**What's there today.** The seams exist, unused: `bodyPlans` holds only
`humanoid`; `appliesToBodyPlans`/`excludesBodyPlans` on attributes are defined but
never consumed; `identity.species_presentation` is free-form text (aliases
species/race) with no enum or gating. aionchat's model — and the one to copy — is
**species as constrained variants of a body plan** (allow/disallow body locations
+ per-attribute rules), e.g. human vs. elf share `humanoid` but differ on ear
shape.

**Assessment — split this idea in two; the halves have very different cost:**

- **Humanoid variants (elves, orcs, most "aliens" that read as humanoid):
  cheap.** A species record that pins a few attribute rules (ear shape, skin
  palette, build, the `species_presentation` text) over the existing humanoid
  plan. Mostly data; reuses everything (wardrobe, image gen, regions). This is
  achievable soon and unlocks a lot of fantasy/sci-fi worlds.
- **Novel body plans (mermaids, true non-humanoids — tails, wings, gills,
  digitigrade legs): expensive.** These require *new body plans* — new region
  trees, new wardrobe coverage logic, and substantial image-generation work.
  Worth noting **aionchat itself only ships the humanoid plan**; its avian/aquatic
  plans are planned-not-built. So this half is genuinely hard everywhere, not
  just here.

**Recommendation.** Do the humanoid-variant half first (build the species-record
model + wire `appliesToBodyPlans`/`excludesBodyPlans`, ship human + a couple of
variants). Treat novel body plans as a later, separately-scoped effort with image
generation in the room from day one. Romance still works fine with humanoid
variants, so this half also serves the romance-first priority; the mermaid/alien
half is world-type breadth and can wait.

**Effort & landing.** Variant half: medium. Novel-plan half: large; its own
future phase.

---

## Suggested sequencing

The four-idea intimacy cluster has a clean dependency order; species is parallel.

1. **Idea 4 (intimate regions)** — the data foundation; everything else attaches
   to it. Settle anatomy-gating here (shared with idea 5).
2. **Idea 3 (sensory)** — add taste axis + per-region sensory onto the new
   regions; extend the exposure mask.
3. **Ideas 1 + 2 (intake steering + dialogue limits)** — the deterministic
   intimacy steering block that consumes `actionType:"intimate"` + the
   region/sensory data, and enforces dialogue economy.
4. **Idea 5, variant half** — independent of the cluster; can run in parallel.
   Novel body plans deferred.

Cross-cutting flags to carry into any spec: **image-generation ripple** (4 and 5
both hit it), **no schema migrations for registry edits** (3–5), and the **honest
limit of pre-turn steering** (idea 2 — pre-turn raises the floor; mid-stream/
post-turn gates are what actually enforce).

---

## Note on graduating these into phases

Per ideas.md's own convention, when an idea is expanded into its own doc that
should be noted back in ideas.md with a link. I've held off editing ideas.md (it's
user-authored guidance) — happy to add those backlinks, or to draft the cluster
spec (`intimacy-and-anatomy-spec.phase?.md`) and the species spec, on your word.
