# Mood-reactive character avatars (feasibility)

Status: **slices 1–2 shipped — 2026-06-27** (the `contracts/avatar/` cue contract +
`deriveAvatarCue`, and the CSS-keyframe `SpriteAvatarRenderer` + standing companion panel
in character-chat, with ~5 hand-seeded Lysandra frames — see "Implementation deviations"
below for where the build departed from the spec). **Slice 3** (auto-asset gen for the
whole cast) is **next** in `roadmap.md`. The 2026-06-21 feasibility study is below; the
2026-06-27 build decisions are locked in **"Locked decisions"** just under Scope.
Companion design notes from GPT live in [avatar-3d.notes.md](avatar-3d.notes.md) — read
it for the `AvatarCue` / `AvatarDirector` detail; the concrete cue contract + enums are
in [avatar-3d.spec.md](avatar-3d.spec.md).

## Locked decisions (2026-06-27 — build kickoff)

The four open questions are resolved (originals + answers retained under "Open
questions" below); the build-shaping calls:

- **v1 fidelity:** layered-sprite "card-with-life" — exact identity, no rig. Rive is a
  later, decision-gated upgrade, not now.
- **Cue source:** purely **derived** from already-computed state (zero added tokens). A
  refining model leg may come later.
- **Asset volume:** start **minimal** (the emotions + a few poses), lazy-gen the rest.
- **First surface:** character-chat (mood already reaches it via the shipped light-state
  + projection), as a **standing companion panel** beside the conversation.
- **First-frame fidelity (hybrid):** ship the renderer animating the **existing single
  portrait** (procedural breathing/drift/crossfade + reaction beats), and **hand-seed ~5
  real expression frames** (neutral/happy/sad/affectionate/concerned) for the **Lysandra
  Vane** dev character so the PoC already crossfades real expressions for one character —
  before any auto-gen pipeline. Missing expressions degrade to the base portrait.

### Build plan (slices)

1. **Slice 1 — contract + derivation (pure) — shipped 2026-06-27.** New `src/contracts/avatar/`:
   the `AvatarCue` Zod schema, the avatar-only enums (`PoseLabel`/`ReactionLabel`/
   `TransitionLabel`), the `AvatarManifest` type, and `deriveAvatarCue` (a pure read over
   the already-derived `EmotionResult` + the social-reaction beat + free-text posture +
   atmosphere). Unit-tested. Serialize the cue onto the chat-state snapshot
   (`chatStateSnapshot`, which already derives the emotion the cue wraps).
2. **Slice 2 — sprite renderer + chat panel — shipped 2026-06-27.** A server **manifest
   resolver** (reads the character's `portrait_variant` rows tagged `meta.avatarExpression`,
   falls back to the canonical avatar) behind `GET …/avatar/manifest`; a client
   `SpriteAvatarRenderer` (`motion`) doing breathing/drift, expression crossfade, one-shot
   reaction beats, and hysteresis; mounted as the standing companion panel in
   `character-chat.tsx`. Plus `scripts/seed-avatar-expressions.ts` to hand-seed Lysandra.
3. **Slice 3 — auto-asset gen (queued, `roadmap.md` Next).** Automate the per-character
   expression/pose frame set (extend the reference-edit pipeline), seed-at-creation +
   lazy-gen, then wire into in-session play.

### Implementation deviations from the spec (recorded 2026-06-27)

- **No Zustand/XState yet.** Neither is in the stack (the spec/notes assumed Zustand was);
  for one chat-mounted avatar the hysteresis + reaction-queue orchestration fits the
  `SpriteAvatar` component's render-adjust state (the codebase's EntityImage pattern).
  Revisit if MVP orchestration (interruption/priority/parallel regions) outgrows React.
- **No `motion` dep either.** Pure CSS keyframes (`globals.css`, gated under
  `prefers-reduced-motion`) cover breathing/drift, the expression crossfade, and the
  one-shot reaction beats — zero new deps. Revisit `motion` (or go straight to Rive) if the
  MVP wants spring physics / sequenced timelines.
- **Manifest = `portrait_variant` rows tagged `meta.avatarExpression`** (no new table) —
  reuses the shipped image infra; a dedicated table is a slice-3 option if it bites.
- **Blink deferred** — a convincing blink needs a closed-eye **face layer**, which a single
  full-frame portrait can't supply; it returns with slice-3 layering. Breathing + drift +
  crossfade + reaction beats carry the "alive" feel meanwhile.

Topic slug `avatar-3d` (historical — the conclusion is **2D-first, 3D later**, but
the slug stays stable so the plan + notes nest together; see CLAUDE.md).

## Scope (locked by the 2026-06-21 discussion)

- **Anime / stylized** aesthetic (not realistic).
- **Silent + mood-reactive.** No TTS, no lip-sync, no audio in v1. Voice is a
  later, separate effort.
- **2D-first.** A rigged/animated 2D avatar, not 3D. 3D (R3F + VRM) is a real
  later upgrade lane behind the same contract, not the MVP.
- **No per-turn generation.** Asset generation is **one-time per character**;
  runtime animation is **procedural and token-free**. The user's hard constraint:
  do **not** feed generated images into a per-turn video step — "slow and token
  exhausting." Per-turn cost must be ~zero.
- **Unbounded, user-created cast.** Every user-made character should be able to
  get an avatar → **automation of per-character assets is mandatory**; anything
  needing an artist-per-character does not qualify for v1.
- **Surface order:** character-chat first (testing ground), then in-session play.

## Verdict

**Feasible, and the cheap-at-runtime version is the right one.** Two findings make
this stronger than it first looked:

1. **The "rich reaction" engine already shipped** (`personality-and-state`,
   2026-06-18) — the avatar mostly _renders_ state we already compute.
2. **Runtime animation needs no generation.** A character "card with life"
   (procedural breathing, blink, drift, expression crossfade, one-shot reaction
   beats) is a solved, mobile-cheap web problem. The turn only emits/derives a
   small cue that _selects_ an animation — it never generates one.

The honest constraint: with an **unbounded auto-generated cast** and **no art
skills**, the fully-automatable ceiling for v1 is **"pre-generated expression/pose
layers + procedural motion,"** not a hand-rigged deforming avatar. True rig-grade
deformation (Rive/Live2D/VRM) is achievable but reintroduces per-character or
one-time-artist work — that's the open tradeoff below.

## The asset model: seed at creation + lazy async expansion (cached)

The user's question — _must we pre-generate every sprite/pose at creation, or can
the pipeline make new frames live as novel moods/poses/scenes arise?_ — resolves to
a **hybrid**, and it's the better design:

- **Seed a small base set at creation** (the core emotions + a blink, one pose) via
  the existing identity-locked image pipeline, so the avatar works immediately.
- **Lazily generate new frames on demand**: when a cue references a frame not yet
  cached (a new emotion×pose, an outfit, a scene), enqueue a **background job**,
  serve the **nearest existing frame** in the meantime, and **swap the new one in
  when ready** (not instant, but asynchronous and off the critical path).
- **Cache forever.** Each unique combination is generated **once**; thereafter it's
  free. Cost is amortized **one-time-per-novel-state**, bounded by what actually
  occurs — _not_ the full combinatorial space, and **never per turn**.

This maps directly onto Vesper's **existing async image infra** — `images` rows
(row-before-file), background `avatar` jobs, status polling, identity-lock /
reference-edit (`docs/images.md`). The avatar lazy-gen is one more job kind on
machinery already shipped. Crucially, **only stills are generated** (expression/pose
_frames_); the _motion_ is always procedural (Motion) — so we never touch the
rejected per-turn neural-video path.

### What costs tokens and what doesn't

| Step                                                       | When                                         | Cost                                                                            |
| ---------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------- |
| Seed base expression set                                   | once, at character creation                  | one-time image-gen                                                              |
| Generate a **novel** frame (new emotion/pose/outfit/scene) | first time it occurs, **async**, then cached | one-time, off critical path                                                     |
| Derive the per-turn `AvatarCue`                            | every turn                                   | **~zero** — derived from already-computed mood/reaction/posture, no new LLM leg |
| Play the animation (idle loop + crossfade + reaction beat) | every turn, client-side                      | **zero tokens**, GPU-cheap                                                      |

This is the whole answer to "slow and token exhausting": per turn, **nothing is
generated** — a novel state triggers at most one cached-forever background still.
(Contrast the rejected path — neural image→video per turn — the slow/token-heavy
thing to avoid.) Lazy-gen also _strengthens_ the sprite path: it gives near-unbounded
expressiveness (any mood/pose that arises eventually gets a real frame) **without a
rig** — narrowing the gap to Rive while staying fully automatable.

## The mood drive is mostly already built

The `personality-and-state` slices (shipped 2026-06-18) delivered the rich
reaction calc the user described. Verified in code:

| Signal                                    | What it is                                                                                                                         | Source                                                                        |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| **`mood` meter**                          | valence `0`(low)–`0.5`(even)–`1`(bright); drifts to baseline; trait `optimism` shifts it; the reaction curve nudges it             | `src/contracts/meters/registry.ts:94`                                         |
| **`deriveMoodDescriptor()`**              | blends mood × stress × energy → descriptor; already fed to the narrator                                                            | `:156`, used `engine/scene.ts:946`                                            |
| **Social-reaction curve**                 | per-turn: intake tags the player's act → affinity-aware, trait-modulated curve → valence + magnitude + band → nudges mood/affinity | `contracts/personality/reactions.ts`, `modulation.ts`; `engine/merge.ts`      |
| **Affinity stages / traits / conditions** | 11-stage relationship, disposition scalars, self-expiring "tipsy/flustered"                                                        | `contracts/relationships/`, `contracts/personality/`, `contracts/conditions/` |

So every turn the engine already knows _how she feels_ (baseline) and _how she
just took what you did_ (the reaction beat). That maps directly onto the cue.

**Mood is now its own plan.** The cross-app mood system — the deferred event→mood
table _and_ the **labeled-emotion projection** the avatar cue needs — is specced
separately in [mood.plan.md](mood.plan.md) (it serves the narrator, scene images,
UI, and chat too, not just the avatar). The avatar **consumes** that projection;
this plan does not define mood. The shared `EmotionLabel` enum is locked there.

## The cue contract — drive 4 channels, not one "mood"

Per GPT's notes (good call): never collapse to `mood: "sad"` — the scene's
atmosphere and the character's own reaction diverge (a tense scene, a calm
companion). The `AvatarCue` (Zod-validated, see notes) carries:

- **character**: `emotion` + `intensity` + `pose` + one-shot `reaction`.
- **environment**: `atmosphere` + `sceneId` (continuity, not sentiment).
- **wardrobe**: `outfitId`.
- **timing**: `transition` + `holdMs`.

**Vesper refinement (the token-free part):** derive the cue from existing state
rather than a new LLM emission — `emotion`/`intensity` from the `mood` meter +
`deriveMoodDescriptor`, `reaction` from the social-reaction band, `pose` from
`activityUpdates.posture`, `atmosphere` from scene/director, `outfitId` from
wardrobe. A new model leg is _optional_ (the already-running post-turn agents
could refine it at ~no marginal cost) but not required. The cue is built at the
trust boundary with `parseOr` (`docs/resilience.md`) and mapped through an **asset
manifest** — the model never invents asset names/filenames/URLs.

Add **hysteresis** (GPT): don't re-baseline expression on every slightly-different
label; let one-shot reactions play, change the sustained emotion only at beat
boundaries.

## Renderer-neutral architecture (adopt now)

Build the `AvatarCue` contract + an `AvatarDirector` with a swappable
`AvatarRenderer` interface (`preload`/`apply`/`playReaction`/`dispose`, see
notes). Implementations land in order: `SpriteAvatarRenderer` → `RiveAvatarRenderer`
→ `ThreeVrmAvatarRenderer` (later). This lets us ship the automatable 2D-sprite
renderer now and upgrade to a rig **without changing the turn pipeline, prompts,
or saves**. State split: **Zustand** for persistent visual state (scene, outfit,
baseline emotion, reduced-motion), **XState** for transient orchestration (load →
ready, parallel face/body regions, one-shot reaction queue, crossfade timing,
return-to-baseline).

**Vesper boundary note:** the renderer is a **client component** consuming the
serialized cue from the turn stream — it never imports `server/*` (CLAUDE.md
module boundaries). The cue derivation is pure (`src/contracts`/`src/lib`).

## Renderer options (v1 vs upgrade lanes)

| Renderer                          | What it gives                                                                                  | Per-character work                                                                                                | Fits unbounded auto cast?                                                                    | License                         |
| --------------------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------- |
| **Layered sprites + Motion** (v1) | pre-gen expression/pose layers; procedural breathing, blink, drift, crossfade, reaction bounce | **none** (reuse existing image pipeline)                                                                          | **Yes — fully automatable, identity-exact**                                                  | free (`motion`)                 |
| **Rive** (upgrade)                | true continuous deformation, blend-states for valence, layered face/body/wardrobe              | none per char **iff** art conforms to one **reusable** hand-built rig (one-time artist)                           | partial — scales but **identity capped** to the rig                                          | runtime MIT; editor ~$9/seat/mo |
| **Live2D**                        | best anime facial deformation                                                                  | full GUI rig **per character**                                                                                    | **No** — non-automatable rig **+** "Expandable App" license (approval + ~20%/$1.86-per-sale) | restrictive                     |
| **R3F + VRM** (3D, later)         | 3D camera, customization, spatial scenes                                                       | none per char, but a **one-time artist** base + part library + Blender-headless harness; identity template-capped | partial                                                                                      | check UniVRM                    |

**v1 = layered sprites + Motion.** It is the only renderer that is fully
automatable for an unbounded cast, reuses the pipeline already shipped, is
identity-exact (it renders the character's actual portraits), runs well on mobile,
and is free. Rive is the natural production upgrade _if_ we accept a reusable rig.

Note: **Grok's Ani is actually 3D and hand-built per character** (not Live2D, not
auto-generated) — a hand-crafted-cast benchmark, the opposite of our unbounded
constraint. Matching its _feel_ with an auto cast is a different problem; the 2D
procedural path is the right tool for _our_ constraints, not a downgrade from Grok.

## The real tradeoff (needs a call)

For the unbounded cast, fluidity and full automation pull against each other:

- **Sprites + Motion:** zero per-character work, exact identity, but motion is
  "card with idle life + reaction beats," not deforming animation.
- **Rive reusable-rig + texture-swap:** genuinely fluid, scales to unbounded, but
  needs a **one-time artist** to build the rig and **caps every character to that
  rig's proportions/layout** (arbitrary AI faces must conform) — a real identity
  hit on a product whose whole point is per-character generated looks.

The renderer-neutral architecture lets us **defer this**: ship sprites, prove the
value, then decide whether the Rive fidelity is worth the artist + identity cap
(possibly only for a curated subset). Recorded as the lead open question.

## Host surface — character-chat first needs mood there

The rich mood/reaction state lives in **in-session play** today. The
sessionless **character-chat** (the chosen first surface) is **stateless** — no
meters/mood. So "react to the chat" there depends on **mood reaching chat**, which
is now planned in [mood.plan.md](mood.plan.md) (its chat consumer rides
[character-chat-state.plan.md](character-chat-state.plan.md)'s light-state slice).
Sequence: mood-in-chat → avatar in chat (testing) → avatar in session play
(richest data). Worth confirming the dependency chain is acceptable.

## Effort tiers (renderer integration only — excludes asset/art production)

| Tier              | Scope                                                                       | Effort           |
| ----------------- | --------------------------------------------------------------------------- | ---------------- |
| **Contract**      | `AvatarCue` (Zod) + `AvatarDirector` + manifest + cue-derivation from state | days             |
| **Sprite PoC**    | one character, layered WebP + Motion idle/blink/crossfade                   | 2–4 days         |
| **Sprite MVP**    | preloading, cue orchestration (XState), reaction beats, hysteresis          | 1–2 weeks        |
| **+ Auto assets** | one-time expression/pose layer generation wired into character creation     | weeks (pipeline) |
| **Rive upgrade**  | reusable rig + state machine + texture-swap (needs the artist)              | 1–2 weeks + art  |
| **VRM/3D**        | (later) R3F + `@pixiv/three-vrm`, parametric base                           | weeks + art      |

**Recommendation:** Contract → Sprite PoC → MVP first, on **in-session play** (data
exists) or behind a stubbed cue, to validate the feel before building auto-asset
generation or committing to a rig.

## Landmines

- **Per-turn neural video/image gen** = the slow/token-heavy thing to avoid
  (explicit user constraint). Keep generation one-time, runtime procedural.
- **Live2D** — non-automatable rigging **and** an "Expandable Application" license
  (Live2D approval + ~20%/$1.86-per-sale rev-share) for an unbounded auto cast.
  Effectively disqualified here; confirm with counsel only if ever reconsidered.
- **3D auto-rig is unsolved** — no tool auto-rigs facial blendshapes onto a
  free-form AI anime mesh (2026). The only hands-free 3D path (parametric VRM)
  caps identity. Reason 3D is a later lane, not v1.
- **Rive identity cap** — a reusable rig constrains every character's proportions.
- **Asset identity-consistency** across a character's expression set — the
  existing reference-edit/identity-lock already addresses this; reuse it.

## A possible build order

1. **Contract + Director** — `AvatarCue` (Zod, `parseOr`), `AvatarDirector`,
   `AvatarRenderer` interface, asset manifest, Zustand/XState wiring.
2. **Cue derivation** — pure function from existing state (`mood` →
   emotion/intensity, reaction band → reaction beat, posture → pose). Unit-tested.
3. **SpriteAvatarRenderer** — layered WebP + `motion`: breathing, blink, drift,
   expression crossfade, one-shot reaction beats; hysteresis.
4. **Auto-asset generation** — extend the image pipeline to emit a character's
   expression/pose layer set once at creation (identity-locked).
5. **Wire into character-chat** — gated on `character-chat-state` mood; then
   in-session play.
6. **(Decision-gated upgrades)** Rive renderer (reusable rig); later VRM/3D.

## Open questions (resolved 2026-06-27 — see "Locked decisions" above)

- **Fidelity vs automation (lead):** accept sprite "card-with-life" for the
  unbounded cast as v1 (exact identity, no art), and treat Rive's fluid
  deformation as an opt-in upgrade (one-time artist, identity cap, maybe a curated
  subset)? Or invest in the Rive rig up front?
  - v1 should be the card-with-life build. Rive build will be a follow up later.
- **Character-chat dependency:** OK that avatar-in-chat waits on
  `character-chat-state` shipping a mood signal? (Or add a minimal mood just for
  the avatar?)
  - Yes
- **Cue source:** purely derived from existing state (zero added tokens,
  recommended) vs an optional refining field on the already-running post-turn
  agents? (Emotion derivation itself is owned by [mood.plan.md](mood.plan.md).)
  - For now derived from existing state. Note that we may plan out a more robust system later.
- **Expression/pose vocabulary:** the `emotion` enum is locked in
  [mood.plan.md](mood.plan.md) (shared `EmotionLabel`); this plan owns the `pose`/
  `reaction` enums and the matching layer set each character generates.
- **Asset volume per character:** how many expression × pose layers to pre-gen
  (cost vs expressiveness) — start minimal (the 8 emotions + a blink + a few poses)?
  - Minimal start.

## Related

- [avatar-3d.notes.md](avatar-3d.notes.md) — GPT's `AvatarCue`/`AvatarDirector`
  design, renderer comparison, Motion/Rive/VRM specifics.
- [mood.plan.md](mood.plan.md) — the app-wide mood system the avatar consumes
  (labeled-emotion projection + the `EmotionLabel` enum + event→mood table).
- `docs/developer-notes/finished/personality-and-state.plan.md` / `.spec.md` — the
  shipped mood/reaction engine the avatar reads.
- `src/contracts/meters/registry.ts` (`mood`, `deriveMoodDescriptor`),
  `src/contracts/personality/` — the live signals to derive the cue from.
- `docs/images.md` — the identity-locked image pipeline that generates the
  one-time expression/pose layer sets.
- [character-chat-state.plan.md](character-chat-state.plan.md) — prerequisite for
  the character-chat surface (supplies mood).
