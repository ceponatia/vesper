# Real-time mood-reactive 3D avatars (feasibility)

Status: **draft** — feasibility study / not settled. Captures the 2026-06-21
investigation into a procedural **anime-style** 3D avatar of a character that
**reacts in real time to the character's mood** as a conversation progresses
("Grok companions, but more sophisticated"). **Voice/lip-sync is deferred** — v1
is a silent, expressive avatar. Verdict and recommended shape below; nothing
committed. Promote a slice to its own `## Shape` once we pick a v1.

Topic slug `avatar-3d`.

## Scope (locked by the 2026-06-21 discussion)

- **Anime / stylized** aesthetic (not realistic). This was the dominating fork;
  it is now decided, and it is the cheaper, cleaner-licensed, more scalable side.
- **Silent + mood-reactive.** No TTS, no lip-sync, no audio stack in v1. The
  avatar emotes — facial expression, gaze, idle body language — driven by the
  character's emotional state. Voice is a later, separate effort.
- **Driven by the existing emotion engine** (see next section), so the avatar is
  primarily a *renderer of state we already compute*, not a new simulation.

## Verdict

**Feasible — and stronger than the first pass suggested**, because the "rich
calculation to simulate how a real person reacts" **already shipped** (the
`personality-and-state` work, 2026-06-18). The avatar does not need a new mood
model; it needs to *read* the live emotional state and map it to expressions.

The genuine "more sophisticated than Grok" angle stands: Grok's companions are
hand-authored characters on a scripted affection state machine. Ours would be
driven by an **authoritative, already-built** model — a continuous mood/valence
meter, trait-modulated likes/dislikes reactions, affinity stages, and
deterministic wardrobe/exposure — so the face reflects a genuinely simulated
inner state, not a lookup table.

## The mood drive is mostly already built

The user's instinct was that there's no "current mood" state yet — but the
`personality-and-state` slices (shipped 2026-06-18) delivered exactly the rich
reaction engine described. Verified in code:

| Signal | What it is | Source |
| --- | --- | --- |
| **`mood` meter** | emotional valence `0`(low)–`0.5`(even)–`1`(bright); drifts back to an even keel; trait `optimism` shifts the resting point; the social-reaction curve nudges it | `src/contracts/meters/registry.ts:94` |
| **`deriveMoodDescriptor()`** | blends mood × stress × energy into a descriptor ("bright and playful" / "tired and terse") — already fed to the narrator | `src/contracts/meters/registry.ts:156`, used `engine/scene.ts:946` |
| **Other meters** | `stress`, `energy`, `arousal`, `intoxication`, `hygiene` — all `0..1`, drifting | `src/contracts/meters/registry.ts` |
| **Social-reaction curve** | per-turn: intake concept-tags the player's act (compliment/tease/insult/…), an affinity-aware, **trait-modulated** curve decides valence + magnitude + band → nudges mood & affinity | `src/contracts/personality/reactions.ts`, `modulation.ts`; `engine/merge.ts`, `scene.ts` |
| **Affinity stages** | 11-level relationship scale (hostile…smitten) toward the player | `src/contracts/relationships/stages.ts` |
| **Traits + likes/dislikes** | authored disposition (agreeableness, possessiveness, composure…) that scales how acts land | `src/contracts/personality/traits/` |
| **Conditions** | self-expiring texture ("tipsy", "flustered") with prompt hints | `src/contracts/conditions/` |

So the engine already knows, every turn, *how the character feels and how she
just took what the player did.* That is the expensive half of "react in real
time," and it exists.

### The one thin new layer: an expression mapper

The only genuinely new state-side piece is a pure function mapping the emotion
vector → avatar expression weights, ideally on **two timescales**:

- **Baseline mood (slow):** the meter vector / `deriveMoodDescriptor` → a resting
  blend of VRM expression presets (`happy`/`angry`/`sad`/`relaxed`/`surprised`
  /`neutral`, all standard in VRM 1.0). E.g. high mood + low stress → a light
  `happy`+`relaxed` resting face; low mood + high stress → `sad`/tense.
- **Reaction pulse (fast):** the per-turn social-reaction `valence`/`magnitude`
  /`band` → a *transient* expression spike (a flash of delight on a liked act, a
  flicker of hurt on a disliked one) that decays back to baseline over ~1–2s.
  **This is what reads as "reacting in real time to the chat."**

This belongs in `src/contracts` (pure, registry-style, unit-testable) — the same
discipline as `deriveMoodDescriptor`. No new simulation, no new LLM call.

## Can LLM agents create the avatars autonomously?

This was the headline question (the user has no 3D-modeling skills). Honest 2026
answer, from current research:

**Fully autonomous "an agent generates a fresh anime mesh, auto-rigs it, auto-adds
facial expression morphs, and emits a clean VRM" does NOT exist as a robust
pipeline.** The single un-automated link is **facial blendshapes on an arbitrary
mesh**: body skeletons auto-rig fine (Mixamo/Tripo/Meshy/UniRig), but **no
mainstream text/image-to-3D tool or auto-rigger produces the facial expression
morphs** the mood drive needs. (RigAnyFace, a Nov-2025 paper, targets exactly this
but has no shipped tool — one to watch.)

**What IS feasible** — ranked most→least automatable:

1. **Parametric base VRM + agent-driven variation (recommended).** Make/curate a
   small number of base anime VRMs that *already carry the VRM expression set*,
   then have an agent vary them **per character**: body-shape morphs + HSV tint
   (hair/eye/skin) + **AI-generated textures project-and-baked onto the fixed UVs**
   (SDXL/Flux via tools like StableGen/Dream Textures), re-exported with the
   **VRM Blender Add-on** driven by **headless Blender** (`blender --background
   --python`). Expressions are inherited from the base → **free and consistent**;
   distinct looks come from textures + morphs. Per-character cost ≈ **zero artist
   time**; the one-time cost is the base mesh(es). This is the published
   "SmartAvatar" agent pattern (arXiv 2506.04606) retargeted to VRM.
2. **Commercial turnkey "image/text → expressive anime VRM" API** (e.g. Neural4D
   *AnimeArt*, Sideload) — *if validated*. Product pages claim anime VRM with full
   blendshapes; the API surface is **unconfirmed** for that exact output. Least
   engineering if it delivers; vendor + IP + NSFW-policy risk; **must trial before
   betting.**
3. **VRoid Studio as a one-time base maker.** Free, anime-native, exports VRM with
   the expression set built in — but **GUI-only** (no CLI/API/headless), an
   undocumented proprietary project file, and a license that **restricts
   programmatic mass-generation** off its meshes/textures. *Good news for a
   non-modeler:* VRoid is slider-based character creation, **not 3D modeling** —
   accessible without the skills the user lacks. Best used to hand-make the base(s)
   that path #1 then varies, or to author a small curated cast directly.
4. **Text/image-to-3D (Tripo/Meshy/Rodin) → manual face rig.** Anime meshes of
   varying quality, **body rig only, no facial morphs, no VRM**. Gets ~70% (a
   textured, body-rigged mesh) then strands at exactly the expressions we need plus
   VRM packaging. Most flexible meshes, least automatable end-to-end.

**Bottom line for the user:** agents *can* autonomously handle the **per-character
variation** and the **runtime mood-drive**; they *cannot* yet autonomously produce
the **rigged, expression-capable anime base** from scratch. Someone provides the
base once — cheapest via VRoid hand-work (no modeling skill needed), or a validated
commercial API, or a single commissioned model. Runtime drive is trivial:
`@pixiv/three-vrm` `expressionManager.setValue('happy', w)` per frame.

## Recommended render stack (all MIT, browser-native, true 3D)

- **Render:** `three` + `@react-three/fiber` + `@react-three/drei`.
- **Avatar format:** **VRM** (`@pixiv/three-vrm` — loader + `expressionManager`,
  the runtime mood drive).
- **Expression set:** VRM 1.0 presets (`happy`/`angry`/`sad`/`relaxed`/`surprised`
  /`neutral` + blink + gaze) — enough for v1; ARKit-52 is a later upgrade.
- **Idle life:** auto-blink, breathing, subtle sway, gaze-at-camera — local loops,
  no network.
- Optional later: **TalkingHead.js** if/when voice is added (it bundles the audio
  + viseme layer we're deferring).

All additive — lives in a client component consuming engine state; never touches
the turn pipeline's correctness path.

## The real gaps (where the work is)

1. **Asset creation** — the central cost (see autonomous-creation section). Pick a
   strategy; everything else is downstream of it.
2. **The expression mapper** — the thin new pure function (above). Small.
3. **Host surface / data availability** — the rich mood state lives in
   **in-session play**. The sessionless **character-chat** is stateless (no
   meters/mood) unless [character-chat-state.plan.md](character-chat-state.plan.md)
   ships first. "Reacts to the chat" needs disambiguating (open question).
4. **Posture/body language** — `activityUpdates.posture` is free text; for body
   gestures we'd add a `poseId` registry or classify text → clip. v1 can ship with
   face + idle only and defer body gesture.
5. **Local smoothing** — buffer per-turn state, tween over ~1–2s, degrade to
   last-known on slow post-turn agents (`docs/resilience.md`).

## Effort tiers

| Tier | Scope | Effort | New backend? |
| --- | --- | --- | --- |
| **Spike** | One hand-made VRM in-session; idle blink/breathe; one expression bound to the live `mood` meter | days | none |
| **MVP** | Silent mood-reactive face: baseline-mood blend + per-turn reaction pulse + gaze/idle | weeks | none |
| **+ Variation** | Agent-driven per-character avatars (parametric base + AI textures, headless Blender) | weeks–months | offline gen job |
| **+ Body** | Posture → gesture clips; wardrobe-aware region visibility | +weeks | `poseId` registry |
| **+ Voice** | (deferred) streaming TTS + viseme lip-sync | +months | TTS + viseme channel |

**Recommendation:** **Spike → MVP first** on a single hand-made VRM, proving the
expression mapper against the live `mood` meter. That validates the whole concept
with zero backend work *before* committing to the asset-automation pipeline.

## Landmines (carry forward)

- **Ready Player Me is dead** (API off 2026-01-31). Don't architect on it.
- **Text-to-3D ≠ talking/emoting avatar** — meshes come without facial morphs.
- **VRoid license** restricts programmatic mass-generation off its meshes/textures
  — fine for a curated cast or hand-made bases, check before automating *off it*.
- **Live2D** — licensing trigger + stale web renderer + only 2.5D. Avoid.
- **NSFW** constrains hosted vendors → favors self-hosted VRM (matches
  `docs/images.md`'s uncensored posture).
- **AI texture identity-consistency** across a character's face/hair/outfit is the
  fiddly part of path #1; expect conditioning tuning + occasional cleanup.

## A possible build order

1. **Spike** — `three`/R3F/drei + one hand-made VRoid VRM on the in-session play
   screen; idle blink/breathe; bind `happy` weight to the live `mood` meter.
2. **Expression mapper** — pure `contracts` function: meter vector → baseline
   blend; per-turn reaction `valence/magnitude` → transient pulse. Unit-tested.
3. **Wire the pulse** — feed the social-reaction result (already computed in
   `merge`/`scene`) to the client so a liked/disliked act visibly lands.
4. **Local smoothing** — buffer + tween; degrade to last-known.
5. **(Decision-gated)** asset-automation pipeline (parametric base + AI textures)
   OR commercial-API trial — to scale past a curated cast.
6. **(Later)** body gesture (`poseId`), wardrobe visibility, then voice.

## Open questions

- **Avatar-creation strategy** — curated VRoid cast (hand-made, accessible, best
  quality, doesn't scale) vs the parametric-base + AI-texture pipeline (most
  automatable per-character, real eng) vs a commercial-API trial (least eng if it
  works, unvalidated). *Lead question — gates the plan.*
- **Host surface** — in-session play (rich mood state today) vs sessionless
  character-chat ("the chat", but stateless — blocked on `character-chat-state`).
  Which did "reacts to the chat" mean?
- **Cast scale** — a handful of curated characters vs many/unbounded user-created
  ones? Determines whether hand-authoring suffices or automation is required.
- **Expression fidelity for v1** — VRM 6-preset blend (simple, ships now) vs
  ARKit-52 (richer, more setup). Lean presets first.
- **Body language in v1?** Face + gaze + idle only, or also posture→gesture? Lean
  face-only first.

## Related

- `docs/developer-notes/finished/personality-and-state.plan.md` /
  `.spec.md` — the shipped mood/reaction engine the avatar reads.
- `src/contracts/meters/registry.ts` (`mood`, `deriveMoodDescriptor`),
  `src/contracts/personality/` (reactions, traits, modulation) — the live signals.
- `docs/images.md` — the existing appearance→render contract; 3D is a second
  renderer over the same data.
- `docs/turn-engine.md` — per-turn `meterAdjustments` / social-reaction outputs.
- [character-chat-state.plan.md](character-chat-state.plan.md) — would make the
  sessionless chat a viable avatar host (otherwise in-session only).
</content>
