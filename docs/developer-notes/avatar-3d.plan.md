# Mood-reactive character avatars (feasibility)

Status: **draft** — feasibility study / not settled. Captures the 2026-06-21
investigation into a character avatar that **emotes in real time** as a
conversation progresses ("Grok companions, but more sophisticated"). Verdict and
recommended shape below; nothing committed. Companion design notes from GPT live
in [avatar-3d.notes.md](avatar-3d.notes.md) — read it for the `AvatarCue` /
`AvatarDirector` detail; this plan is the decision record + build order. The
concrete cue contract + enums are in [avatar-3d.spec.md](avatar-3d.spec.md).

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
   2026-06-18) — the avatar mostly *renders* state we already compute.
2. **Runtime animation needs no generation.** A character "card with life"
   (procedural breathing, blink, drift, expression crossfade, one-shot reaction
   beats) is a solved, mobile-cheap web problem. The turn only emits/derives a
   small cue that *selects* an animation — it never generates one.

The honest constraint: with an **unbounded auto-generated cast** and **no art
skills**, the fully-automatable ceiling for v1 is **"pre-generated expression/pose
layers + procedural motion,"** not a hand-rigged deforming avatar. True rig-grade
deformation (Rive/Live2D/VRM) is achievable but reintroduces per-character or
one-time-artist work — that's the open tradeoff below.

## The asset model: seed at creation + lazy async expansion (cached)

The user's question — *must we pre-generate every sprite/pose at creation, or can
the pipeline make new frames live as novel moods/poses/scenes arise?* — resolves to
a **hybrid**, and it's the better design:

- **Seed a small base set at creation** (the core emotions + a blink, one pose) via
  the existing identity-locked image pipeline, so the avatar works immediately.
- **Lazily generate new frames on demand**: when a cue references a frame not yet
  cached (a new emotion×pose, an outfit, a scene), enqueue a **background job**,
  serve the **nearest existing frame** in the meantime, and **swap the new one in
  when ready** (not instant, but asynchronous and off the critical path).
- **Cache forever.** Each unique combination is generated **once**; thereafter it's
  free. Cost is amortized **one-time-per-novel-state**, bounded by what actually
  occurs — *not* the full combinatorial space, and **never per turn**.

This maps directly onto Vesper's **existing async image infra** — `images` rows
(row-before-file), background `avatar` jobs, status polling, identity-lock /
reference-edit (`docs/images.md`). The avatar lazy-gen is one more job kind on
machinery already shipped. Crucially, **only stills are generated** (expression/pose
*frames*); the *motion* is always procedural (Motion) — so we never touch the
rejected per-turn neural-video path.

### What costs tokens and what doesn't

| Step | When | Cost |
| --- | --- | --- |
| Seed base expression set | once, at character creation | one-time image-gen |
| Generate a **novel** frame (new emotion/pose/outfit/scene) | first time it occurs, **async**, then cached | one-time, off critical path |
| Derive the per-turn `AvatarCue` | every turn | **~zero** — derived from already-computed mood/reaction/posture, no new LLM leg |
| Play the animation (idle loop + crossfade + reaction beat) | every turn, client-side | **zero tokens**, GPU-cheap |

This is the whole answer to "slow and token exhausting": per turn, **nothing is
generated** — a novel state triggers at most one cached-forever background still.
(Contrast the rejected path — neural image→video per turn — the slow/token-heavy
thing to avoid.) Lazy-gen also *strengthens* the sprite path: it gives near-unbounded
expressiveness (any mood/pose that arises eventually gets a real frame) **without a
rig** — narrowing the gap to Rive while staying fully automatable.

## The mood drive is mostly already built

The `personality-and-state` slices (shipped 2026-06-18) delivered the rich
reaction calc the user described. Verified in code:

| Signal | What it is | Source |
| --- | --- | --- |
| **`mood` meter** | valence `0`(low)–`0.5`(even)–`1`(bright); drifts to baseline; trait `optimism` shifts it; the reaction curve nudges it | `src/contracts/meters/registry.ts:94` |
| **`deriveMoodDescriptor()`** | blends mood × stress × energy → descriptor; already fed to the narrator | `:156`, used `engine/scene.ts:946` |
| **Social-reaction curve** | per-turn: intake tags the player's act → affinity-aware, trait-modulated curve → valence + magnitude + band → nudges mood/affinity | `contracts/personality/reactions.ts`, `modulation.ts`; `engine/merge.ts` |
| **Affinity stages / traits / conditions** | 11-stage relationship, disposition scalars, self-expiring "tipsy/flustered" | `contracts/relationships/`, `contracts/personality/`, `contracts/conditions/` |

So every turn the engine already knows *how she feels* (baseline) and *how she
just took what you did* (the reaction beat). That maps directly onto the cue.

**Mood is now its own plan.** The cross-app mood system — the deferred event→mood
table *and* the **labeled-emotion projection** the avatar cue needs — is specced
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
wardrobe. A new model leg is *optional* (the already-running post-turn agents
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

| Renderer | What it gives | Per-character work | Fits unbounded auto cast? | License |
| --- | --- | --- | --- | --- |
| **Layered sprites + Motion** (v1) | pre-gen expression/pose layers; procedural breathing, blink, drift, crossfade, reaction bounce | **none** (reuse existing image pipeline) | **Yes — fully automatable, identity-exact** | free (`motion`) |
| **Rive** (upgrade) | true continuous deformation, blend-states for valence, layered face/body/wardrobe | none per char **iff** art conforms to one **reusable** hand-built rig (one-time artist) | partial — scales but **identity capped** to the rig | runtime MIT; editor ~$9/seat/mo |
| **Live2D** | best anime facial deformation | full GUI rig **per character** | **No** — non-automatable rig **+** "Expandable App" license (approval + ~20%/$1.86-per-sale) | restrictive |
| **R3F + VRM** (3D, later) | 3D camera, customization, spatial scenes | none per char, but a **one-time artist** base + part library + Blender-headless harness; identity template-capped | partial | check UniVRM |

**v1 = layered sprites + Motion.** It is the only renderer that is fully
automatable for an unbounded cast, reuses the pipeline already shipped, is
identity-exact (it renders the character's actual portraits), runs well on mobile,
and is free. Rive is the natural production upgrade *if* we accept a reusable rig.

Note: **Grok's Ani is actually 3D and hand-built per character** (not Live2D, not
auto-generated) — a hand-crafted-cast benchmark, the opposite of our unbounded
constraint. Matching its *feel* with an auto cast is a different problem; the 2D
procedural path is the right tool for *our* constraints, not a downgrade from Grok.

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

| Tier | Scope | Effort |
| --- | --- | --- |
| **Contract** | `AvatarCue` (Zod) + `AvatarDirector` + manifest + cue-derivation from state | days |
| **Sprite PoC** | one character, layered WebP + Motion idle/blink/crossfade | 2–4 days |
| **Sprite MVP** | preloading, cue orchestration (XState), reaction beats, hysteresis | 1–2 weeks |
| **+ Auto assets** | one-time expression/pose layer generation wired into character creation | weeks (pipeline) |
| **Rive upgrade** | reusable rig + state machine + texture-swap (needs the artist) | 1–2 weeks + art |
| **VRM/3D** | (later) R3F + `@pixiv/three-vrm`, parametric base | weeks + art |

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

## Open questions

- **Fidelity vs automation (lead):** accept sprite "card-with-life" for the
  unbounded cast as v1 (exact identity, no art), and treat Rive's fluid
  deformation as an opt-in upgrade (one-time artist, identity cap, maybe a curated
  subset)? Or invest in the Rive rig up front?
- **Character-chat dependency:** OK that avatar-in-chat waits on
  `character-chat-state` shipping a mood signal? (Or add a minimal mood just for
  the avatar?)
- **Cue source:** purely derived from existing state (zero added tokens,
  recommended) vs an optional refining field on the already-running post-turn
  agents? (Emotion derivation itself is owned by [mood.plan.md](mood.plan.md).)
- **Expression/pose vocabulary:** the `emotion` enum is locked in
  [mood.plan.md](mood.plan.md) (shared `EmotionLabel`); this plan owns the `pose`/
  `reaction` enums and the matching layer set each character generates.
- **Asset volume per character:** how many expression × pose layers to pre-gen
  (cost vs expressiveness) — start minimal (the 8 emotions + a blink + a few poses)?

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
