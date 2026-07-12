# Chat selfies — character-sent photo messages

Status: **shipped — 2026-07-11** (planned, ruled, and built the same day — the
fourth of the seven-plan engagement batch. Shipped: the `SELFIE_FRAMING` swap +
`framing`/`flavor` threading through the scene render, the always-reference
selfie branch with the retry-once/sanitize/fail-debuggable policy (ruled), both
triggers (request regex + apart-only offer gates over the new `selfie_history`
ring, migration `0034`) with the pulse `sentPhoto` read as the queue decision,
the one-turn license lines, the route hook, and the transcript treatment
(accent-rounded selfie tiles + the "Failed" placeholder enlarging to the sent
prompt). Design deviation from the draft, recorded: the queue decision moved
from a plan-time pulse flag to POST-turn (`sentPhoto` + deterministic arming) so
a declined request or unfired offer never renders a contradicting photo. Slice-3
caption polish and the initiative-opener attach hook remain with
[chat-initiative.plan.md](chat-initiative.plan.md).)

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

## Rulings (owner, 2026-07-11)

- **Always reference-edit**: selfies ignore the per-chat `scene_model` pick —
  identity is the point; no t2i, and (per the retry ruling below) no silent
  ladder fallback either.
- **Retry once, then a debuggable failure**: a failed render classifies WHY
  (`classifyImageFailure`) and retries ONCE — a content rejection retries with
  a sanitized prompt (intimate/exposure phrasing stripped), a transient failure
  retries as-is. A second failure marks the row `failed` and the transcript
  shows a **"Failed" placeholder** in the selfie's spot; clicking it enlarges
  to a panel showing the prompt that was sent, for debugging.
- **No offer toggle, but offers are APART-ONLY**: an unprompted selfie
  simulates texting, so the character only offers one when she and the player
  are not in the same scene — gated deterministically on the comms register
  (the player's message or the last reply carried `*Name: …*` texted lines).
  Player-asked selfies are not apart-gated (handing over a photo face-to-face
  is the player's call).

## Cross-links

- [chat-initiative.plan.md](chat-initiative.plan.md) — a warm opener may attach
  a selfie: the "thinking of you" photo is the strongest reopen hook.
- [chat-scene-references.plan.md](chat-scene-references.plan.md) — the
  current-look reference upgrades outfit fidelity when it lands; v1 rides the
  outfit text exactly as scenes do today.
- [emotional-weather.plan.md](emotional-weather.plan.md) — `feeling` enriches
  `visualStateNote` for selfie expression.
