## Feasibility

This is very feasible in your React + TypeScript + Vite architecture. I would start with **2D**, not 3D. Without voice or lip-sync, the runtime logic is fairly contained; the expensive part is producing and maintaining the character artwork, rigs, poses, outfits, and animations.

A polished 3D avatar would effectively add a small game-rendering subsystem to the app. It is justified only if rotating cameras, highly modular customization, or spatial scenes are central to the experience.

## Recommended path

| Approach                | Best use                                         | Relative scope | Recommendation                          |
| ----------------------- | ------------------------------------------------ | -------------: | --------------------------------------- |
| Layered 2D sprites      | Validate expressions, poses, outfits, and scenes |            Low | Build this first                        |
| Rive 2D rig             | Fluid facial/body animation and outfit changes   |         Medium | Best production path                    |
| Live2D                  | Maximum anime-style facial expressiveness        |    Medium–high | Strong, but investigate licensing first |
| Spine 2D                | Full-body poses and many modular outfits         |    Medium–high | Good game-like alternative              |
| React Three Fiber + VRM | 3D camera, model customization, spatial scenes   |           High | Later upgrade, not initial MVP          |

### Phase 1: layered 2D sprite prototype

Use stacked transparent WebP, PNG, or SVG assets:

- Background scene
- Character body/pose
- Outfit
- Face or expression overlay
- Optional lighting, weather, or particle overlays

Use `motion` for crossfades, small breathing movement, camera pushes, shakes, and entrance/exit animation:

```bash
npm install motion
```

Motion integrates directly with React and supports enter/exit transitions through `AnimatePresence`, so changing a scene, pose, or expression can be a clean component-state operation rather than a canvas-rendering project. ([Motion][1])

This prototype could already look surprisingly polished with:

- Subtle vertical breathing
- Blinking as an occasional face-layer swap
- Gentle head/body drift
- Expression crossfades
- Scene parallax
- Lighting overlays tied to atmosphere

It would let you determine whether the reactive avatar actually improves the experience before commissioning an elaborate rig.

### Phase 2: Rive as the production 2D renderer

Rive is my preferred production choice for your current app. It has an official React runtime, data binding, animation state machines, parallel animation layers, and animation mixing. Its Solos and bindable artboards can switch skins, clothes, body parts, or even externally loaded character components at runtime. ([Rive][2])

The stack would be:

```bash
npm install @rive-app/react-webgl2 xstate @xstate/react
```

Keep Zustand and Zod from your existing architecture.

Inside the Rive asset, I would separate animation responsibilities into layers:

1. Ambient idle: breathing, hair movement, blinking
2. Face: neutral, happy, concerned, angry, afraid, surprised, affectionate
3. Body: idle, thinking, guarded, reassuring, excited
4. Reaction: one-shot flinch, laugh, gasp, nod
5. Wardrobe: outfit and accessory selection

That separation prevents the combinatorial disaster of authoring a distinct animation for every expression × pose × outfit combination.

Rive’s runtimes are open-source and MIT-licensed, but exporting production `.riv` files requires a paid editor plan; its current Cadet annual-plan rate is listed as $9 per seat per month. ([Rive][3])

## Do not drive everything from one “mood” value

The avatar should not simply receive `mood: "sad"`. That will produce odd results because the mood of a scene and the character’s own reaction are not always the same. A frightening scene might have a tense atmosphere while the companion remains calm and reassuring.

Use four distinct channels:

> **Note (2026-06-24):** the `emotion` enum below is GPT's original 8. The
> `EmotionLabel` vocabulary is now **owned by `mood.spec.md` §2 and locked at 11**
> (adds `playful`, `flustered`, `aroused`); the cue imports it from `contracts/mood`.
> Treat the inline enum here as illustrative — `mood.spec.md` is authoritative.

```ts
import { z } from "zod";

export const AvatarCueSchema = z.object({
  character: z.object({
    emotion: z.enum([
      "neutral",
      "happy",
      "concerned",
      "sad",
      "angry",
      "afraid",
      "surprised",
      "affectionate",
    ]),
    intensity: z.number().min(0).max(1),
    pose: z.enum([
      "idle",
      "open",
      "thinking",
      "guarded",
      "reassuring",
      "excited",
    ]),
    reaction: z
      .enum(["none", "nod", "laugh", "gasp", "flinch", "sigh"])
      .default("none"),
  }),

  environment: z.object({
    atmosphere: z.enum([
      "calm",
      "warm",
      "romantic",
      "tense",
      "ominous",
      "melancholy",
      "hopeful",
    ]),
    sceneId: z.string(),
  }),

  wardrobe: z.object({
    outfitId: z.string(),
  }),

  timing: z.object({
    transition: z.enum(["cut", "crossfade", "soft"]),
    holdMs: z.number().int().min(500).max(30_000),
  }),
});
```

Facial expression comes from `emotion`. Pose comes from narrative action. Scene and outfit are continuity state, not sentiment. A sad sentence should not teleport the character into rainwear.

The story model should emit this semantic cue alongside the prose. It should never be allowed to invent animation names, filenames, or asset URLs. Validate the cue through Zod, then map its controlled values through an asset manifest:

```ts
const avatarManifest = {
  expressions: {
    concerned: "face_concerned",
    affectionate: "face_affectionate",
  },
  poses: {
    reassuring: "pose_reassuring",
    thinking: "pose_thinking",
  },
  outfits: {
    casual_evening: "outfit_casual_evening",
  },
};
```

That also lets you replace the sprite renderer with Rive or 3D later without changing story-generation prompts or saved games.

## Runtime architecture

I would add a renderer-neutral `AvatarDirector`:

```ts
export interface AvatarRenderer {
  preload(cue: AvatarCue): Promise<void>;
  apply(cue: AvatarCue): Promise<void>;
  playReaction(reaction: AvatarCue["character"]["reaction"]): Promise<void>;
  dispose(): void;
}
```

Then implement:

```text
SpriteAvatarRenderer
RiveAvatarRenderer
ThreeVrmAvatarRenderer   // later
```

Use **Zustand** to store persistent visual state:

- Current scene
- Current outfit
- Baseline emotion
- Last pose
- Reduced-motion preference

Use **XState** for transient orchestration:

- Loading → ready → error
- Parallel face/body/scene/wardrobe regions
- One-shot reaction queue
- Crossfade timing
- Return from a reaction to the sustained baseline mood
- Interruption and priority handling

This is one of the cases where XState becomes genuinely useful rather than decorative architecture.

Also add hysteresis: do not change expressions every time the model produces a slightly different emotional label. Let one-shot reactions play briefly, and only replace the baseline emotion at paragraph or story-beat boundaries.

## What a 3D implementation would require

For a web-first 3D version, I would use:

```bash
npm install three @react-three/fiber @react-three/drei @pixiv/three-vrm
```

React Three Fiber is a React renderer for Three.js and works directly with Vite. Match its major version to your React version: the current documentation pairs R3F 8 with React 18 and R3F 9 with React 19. ([GitHub][4])

The asset pipeline would be:

```text
Blender
  → humanoid skeleton
  → facial morph targets
  → animation clips
  → GLB or VRM
  → React Three Fiber
```

VRM is attractive because it standardizes humanoid bones, expressions, gaze, and avatar metadata. VRM 1.0 includes standard facial presets such as happy, angry, sad, relaxed, and surprised, as well as mouth shapes that would help with later lip-sync. `@pixiv/three-vrm` provides Three.js support. ([GitHub][5])

Use:

- `AnimationMixer` or Drei’s animation helpers for body clips
- VRM expressions or morph targets for the face
- Separate skinned clothing meshes bound to the same skeleton
- A simple 2D or lightly rendered background rather than building complete 3D rooms
- Camera and lighting presets for environmental mood

Material variants can change colors or textures, but they cannot turn a shirt into a coat because the glTF `KHR_materials_variants` extension swaps materials, not geometry. Actual garment changes need separate skinned meshes or a complete model swap. ([GitHub][6])

For production delivery, Three.js supports Draco-compressed geometry and KTX2 GPU-compressed textures, although these add decoding and asset-pipeline complexity. ([Three.js][7])

## Where Live2D and Spine fit

**Live2D** is the strongest choice when the character’s face is the centerpiece and the target aesthetic resembles an anime companion or VTuber. Its Web SDK is implemented in TypeScript/WebGL and supports motions, expressions, parameter control, blinking, breathing, physics, poses, and eventual lip-sync. ([Live2D Docs][8])

The concern is licensing. Live2D has a specific AI/chatbot licensing path, and applications considered “Expandable Applications” require review and a special publication agreement even when the publisher would otherwise be exempt. A fixed character with a finite wardrobe may not qualify as expandable, but I would obtain written confirmation before selecting it as the app’s foundation. ([Live2D Cubism][9])

**Spine** is better when full-body animation and mix-and-match clothes are more important than subtle facial deformation. Spine skins explicitly support swapping outfits or assembling characters from multiple attachments, and the official runtimes include WebGL, Canvas, Web Components, TypeScript, PixiJS, and Three.js options. ([Esoteric Software][10])

## Rough implementation scope

Assuming one character, a web-first app, and usable assets already prepared:

- Layered sprite proof of concept: roughly **2–4 development days**
- Productionized sprite system with preloading and cue orchestration: **1–2 weeks**
- Rive integration and a complete first-state machine: **1–2 engineering weeks**
- 3D proof of concept: **2–3 weeks**
- Production-ready 3D with outfits, optimization, mobile QA, and polished transitions: **4–8+ engineering weeks**

These do not include custom artwork, rigging, or animation production. That work is likely to exceed the renderer integration effort, especially for Live2D or 3D.

## Final recommendation

Build the semantic `AvatarCue` contract and `AvatarDirector` now. Implement the first renderer with layered 2D assets and Motion. Once the behavior and timing feel worthwhile, replace the sprite renderer with Rive for continuous animation.

Use Live2D only when its particular facial style is essential and its licensing is settled. Move to React Three Fiber + VRM only when camera movement, extensive character customization, or genuine spatial scenes become core product requirements. Otherwise, 3D is mostly a very convincing scope-creep machine.

[1]: https://motion.dev/docs/react-animate-presence?utm_source=chatgpt.com "AnimatePresence | React exit animations | Motion React"
[2]: https://rive.app/docs/editor/state-machine/layers?utm_source=chatgpt.com "Layers - Rive"
[3]: https://www.rive.app/pricing?utm_source=chatgpt.com "Rive Pricing"
[4]: https://github.com/pmndrs/react-three-fiber?utm_source=chatgpt.com "GitHub - pmndrs/react-three-fiber: 🇨🇭 A React renderer for Three.js · GitHub"
[5]: https://github.com/vrm-c/vrm-specification/blob/master/specification/VRMC_vrm-1.0/expressions.md?utm_source=chatgpt.com "vrm-specification/specification/VRMC_vrm-1.0/expressions.md at master · vrm-c/vrm-specification · GitHub"
[6]: https://github.com/KhronosGroup/glTF/blob/main/extensions/2.0/Khronos/KHR_materials_variants/README.md?utm_source=chatgpt.com "glTF/extensions/2.0/Khronos/KHR_materials_variants/README.md at main · KhronosGroup/glTF · GitHub"
[7]: https://threejs.org/docs/pages/KTX2Loader.html?utm_source=chatgpt.com "KTX2Loader - Three.js Docs"
[8]: https://docs.live2d.com/en/cubism-sdk-manual/cubism-sdk-for-web/?utm_source=chatgpt.com "Cubism SDK for Web | SDK Manual | Live2D Manuals & Tutorials"
[9]: https://www.live2d.com/en/sdk/license/?utm_source=chatgpt.com "SDK Release License (Publication License Agreement) | Live2D Cubism"
[10]: https://en.esotericsoftware.com/spine-skins?utm_source=chatgpt.com "Skins - Spine User Guide"
