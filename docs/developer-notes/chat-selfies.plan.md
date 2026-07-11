# Chat selfies — character-sent photo messages

Status: **next** (planned 2026-07-11, from the character-chat & schema engagement
review — seven-plan batch at the top of [roadmap.md](roadmap.md) §Next; effort
**M+**)

The character can't send a picture. A "selfie" — an inline photo message in the
comms register — is the highest-leverage image feature for engagement, and it is
a recomposition of shipped parts: the identity-locked Venice single-reference
edit from the avatar, the chat state's live `outfit`/`outfit_exposed`,
`visualStateNote` (flushed/tipsy/tired), and the scene-memory place sketch as a
backdrop. The one genuinely new prompt piece is a **selfie framing block**
replacing `SCENE_POV_RULE` — the exact inverse of the player-POV scene: her
camera, her framing (held-at-arm's-length or mirror shot, subject aware of the
lens), the player nowhere in frame.

## Design

- **Render path**: a `framing: "selfie" | "scene"` switch on the chat scene
  builder (`server/images/character-scene.ts`) — one builder, two framing
  blocks — rather than a sibling module. Assets stay `kind: "scene"` with
  `meta.flavor: "selfie"` so the whole lifecycle (chat-keying, message anchor,
  Gallery, delete/scrub, `image_references`) rides unchanged.
- **Triggers**:
  1. **Player asks** — a regex arm in `engine/chat-intent.ts` ("send me a
     pic/photo/selfie", "show me what you're wearing"): sets a one-turn flag;
     the reply gets a one-turn tail license ("if you choose to send it, say so
     naturally — or decline in character"); after settle, the route queues the
     render anchored to the reply via the shared `queueChatScene` (same
     one-live-render-per-chat dedupe).
  2. **Character offers** — the pulse gains an optional `selfieOffer` boolean,
     gated deterministically on the state side: regard band warm-or-better, a
     flirt/intimate concept family this exchange, and a cooldown (≥15 exchanges
     since the last offer, a small ring on state). On true: same queue + reply
     cue.
- **Exposure**: identical gates to chat scenes — `outfit_exposed` +
  `intimateSceneAppearance` on the uncensored route only. The parked
  uploaded-avatar guard ([deferred.plan.md](deferred.plan.md)) applies before
  production accepts real uploads.
- **Display**: an anchored image message rendered SMS-style (the comms bubble
  treatment) when `meta.flavor === "selfie"`, distinct from the scene-moment
  treatment; also present in the scene strip and Gallery.
- **Declining is content**: a guarded or low-regard character refusing the ask
  — teasing, deflecting, "earn it" — is as valuable as the photo; the tail
  license must make declining first-class, not a failure.

## Slices

1. Framing block + render switch + player-request trigger + queue + SMS-style
   inline display.
2. Character-offer trigger (pulse flag + cooldown state) + tests.
3. Polish: caption line woven into the reply, lightbox, a Gallery flavor chip.

## Open questions

- Model pick: always reference-edit, or honor the per-chat `scene_model` t2i
  hot-swap? Lean **always reference** — identity is the whole point of a
  selfie; a t2i selfie loses the face.
- Failed render: an in-fiction excuse line, or silently no image? Lean
  **silent** — the reply already stands alone; the strip shows the failure.
- Do offers need a scenario-modal opt-out (like `scene_auto`)? Lean no — offers
  are rare and player-visible; add the toggle only if they annoy.

## Cross-links

- [chat-initiative.plan.md](chat-initiative.plan.md) — a warm opener may attach
  a selfie: the "thinking of you" photo is the strongest reopen hook.
- [chat-scene-references.plan.md](chat-scene-references.plan.md) — the
  current-look reference upgrades outfit fidelity when it lands; v1 rides the
  outfit text exactly as scenes do today.
- [emotional-weather.plan.md](emotional-weather.plan.md) — `feeling` enriches
  `visualStateNote` for selfie expression.
