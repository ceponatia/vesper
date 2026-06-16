# Scene image references — multi-reference & provider strategy

Status: **evaluation / brainstorm** — _raised 2026-06-16_ in response to external
feedback on scene image generation. Anchored under
[deferred.plan.md](deferred.plan.md). One item here (the uploaded-avatar
intimate guard, §3) is **not** deferrable — it is a safety bug in shipped code
and should graduate to a [followups.phase4.md](followups.phase4.md) entry / fix
immediately. Everything else is forward-looking design.

This is my review of the feedback, grounded in the current pipeline
([../images.md](../images.md), `src/server/images/`, `src/server/ai/`). Short
version: **I agree with the shape of the feedback and disagree on two specifics
(the join table, and how central FLUX.2 should be).** The feedback also omits
three invariants our pipeline already enforces that any multi-reference path
must preserve.

## 1. What we actually have today (the baseline the feedback describes)

- **Two image backends, selected by ad-hoc branching, no abstraction.** Flux via
  OpenRouter (`imageModel()` in `ai/provider.ts`, default `flux.2-pro`) for
  text-to-image; Venice/Qwen (`veniceEditImage` / `veniceGenerateImage` in
  `ai/venice.ts`) for single-reference edit and uncensored text-to-image. The
  scene renderer picks between them with inline `if` branches in
  `images/scene.ts:96-161`.
- **Single reference is a hard model limit, not a code choice.** `veniceEditImage`
  sends exactly one `image` (`ai/venice.ts:33`); the `/image/edit` shape takes one
  buffer. The feedback reads this correctly.
- **The forward seam already exists.** Scenes already record a typed
  `meta.references` list — `{ kind: "character" | "location", id, name }`
  (`contracts/images/scene-reference.ts`), populated in
  `scene.ts:172-205`. The contract docstring literally says it is "shaped for a
  future multi-reference image model." So the codebase _already anticipates_ this
  work; the feedback is pushing on a door we left open.
- **The intimate route is the product, not an edge case.** Per
  [../README.md](../README.md), Vesper forks reverie specifically to make
  "uncensored imagery" first-class. That reframes the whole provider question (see
  §5).

## 2. Overall verdict on the feedback

Agree with the architecture: keep single-reference Venice/Qwen, add a
provider-capability layer, add a multi-reference path for SFW multi-character,
and treat self-hosted diffusion as the long-term home for the intimate core.
Agree the reference-sheet "paste portraits" idea is a brittle experiment, not a
production strategy. Agree the safety guard is the #1 priority.

Where I push back:

- **The join table is premature** (§4) — start by enriching the existing JSONB
  reference list; a join table is a migration we don't need yet.
- **FLUX.2 should be demoted to an SFW-only lane, not a candidate default
  multi-character renderer** (§5) — we have direct evidence in our own codebase
  that flux.2 input-moderates nudity, and the intimate scene _is_ the core
  product.
- **The feedback omits three invariants** our pipeline enforces — first-person
  POV, session-snapshot freeze, and degrade-never-fail resilience — that a
  multi-reference path can silently break (§8).

## 3. Immediate: the uploaded-avatar intimate guard (a real bug — do now)

**The claim is correct and I can make it precise.** `renderSceneImage` sets
`allowIntimate: true` for _any_ Venice reference, unconditionally:

```ts
// images/scene.ts:103-106
const prompt = buildSceneRenderPrompt(
  input.plan,
  useReference ? { referenceName: reference.name, allowIntimate: true } : {},
);
```

`allowIntimate` is the switch that injects exposure-gated explicit anatomy via
`intimateSceneAppearance` (`images/prompts.ts:672,677`). The reference avatar
comes from `findParticipantAvatar` → `session_participants.avatarImageId`
(`scene.ts:249-269`), and **that avatar can be an uploaded image** — uploads are
promoted to the canonical avatar (`images/upload.ts:81`) and snapshotted into the
participant at spawn (`engine/spawn.ts:366`). So an uploaded, possibly
real-person face can become the identity anchor for an intimate render. This is
the non-consensual-intimate-imagery footgun the feedback names, and it is live.

**The fix is small because the provenance data already exists** — uploads stamp
`meta.source: "upload"` (`upload.ts:54`). Minimal patch:

```ts
const allowIntimate = useReference && isSyntheticReference(reference.row);
```

But there is a subtlety that decides whether we build a **denylist or a
default-deny**, and I strongly favor default-deny:

- Generated avatars carry `meta: { style, model, demo }` (`avatar.ts:60`) — **no
  `source` field at all.** Only uploads are tagged. So a denylist
  (`source === "upload"` → no intimate) works _today_ but is fragile: any future
  ingest path (a "composite", an imported entity image, a real photo used as a
  location ref) that forgets to set the tag silently re-opens the hole.
- The resilient choice — and the one that matches our own rules
  ([../resilience.md](../resilience.md): degraded **defaults**; default-deny at
  trust boundaries) and the forward-compatible-schema preference — is to **stamp
  positive provenance on generation** (`source: "generated"` in `avatar.ts` and
  `variants.ts`) and gate on _that_: `allowIntimate` only when
  `meta.source === "generated"`. Unknown / missing / uploaded → deny. New paths
  are then safe-by-default.

**This guard is necessary but not sufficient — and the feedback stops too early.**
Even with `allowIntimate: false`, an uploaded real face is still sent to the
_uncensored_ Venice/Qwen edit model with `safe_mode` off (`venice.ts:34`). A
suggestive pose/setting with no explicit-anatomy text can still produce
problematic output from a real likeness. So "uploaded avatars are SFW-only"
(which I endorse) has to mean more than withholding anatomy text. Options, in
order of how much I'd trust them:

1. **Don't use uploaded references on the uncensored edit path at all** — if the
   only available reference is uploaded, render the scene text-to-image (Flux,
   which moderates) or skip the image. Cleanest; uploaded-avatar characters
   simply never anchor an uncensored edit.
2. Force `safe_mode: true` for that specific edit when the reference is uploaded.
   Weaker — relies on Venice's safe mode, and the rest of the cast may need
   uncensored treatment in the same frame.

I lean (1): it's a clean invariant ("uncensored edit ⇒ synthetic reference only")
that the provider router (§4) can own in one place.

**Centralize it.** Add `isSyntheticAvatar(row): boolean` next to the asset
helpers, used by both the scene render and any future provider router, with a
unit test that an uploaded row is never synthetic and a generated row is. This is
exactly the "shared predicate" lesson [../images.md](../images.md) already records
for `intimateAttrRendersExposed` — don't let the rule diverge across call sites.

## 4. Provider-capability abstraction & multi-reference plumbing (agree, with one disagreement)

Strongly agree, and it fits our conventions: registries/capability tables are the
extension point ([../../CLAUDE.md](../../CLAUDE.md)), and provider SDK calls must
live in `src/server/ai` (the `@openrouter`-only boundary rule — Venice already
obeys it in `ai/venice.ts`). Concretely:

- A `ImageProviderCapabilities` table (the feedback's fields are good:
  `maxReferenceImages`, `supportsReferenceRoles`, `supportsLocationReference`,
  `supportsMask`, `supportsAdultFictionalNudity`,
  `supportsUploadedRealPeopleInNsfw: false`, `maxPromptChars`, `aspectRatios`,
  `policyMode`).
- A **router** that takes a `SceneRenderRequest` (references + content rating +
  frame composition) and selects a provider + a **fallback chain**. The router's
  inputs already exist in the pipeline: character count
  (`plan.focal` + `plan.others`), exposure state (`exposedRegions` /
  `formatExposure`), reference provenance (§3), and location-reference
  availability. Routing is computable from data we already produce — low new
  plumbing.
- Extend the render input from "maybe one avatar" to a `SceneVisualReference[]`
  (`kind`, `imageId`, `role`, `characterName?`, `source`, `allowForIntimate`),
  as the feedback proposes. This is the natural superset of today's
  `SceneReference`.

**Where I disagree: don't add a join table yet.** The feedback wants an
`image_references` join table "because you'll want to query which scenes used
this portrait." We already store the reference list as JSONB on
`images.meta.references` and the Gallery already filters on it client-side
([../images.md](../images.md) §Gallery). Phase 4 shipped its entire body model
with **no migration** by staying JSONB-first, and the house rule is "vocabulary
changes are data edits, not schema migrations." So:

- **Now:** enrich the existing JSONB list with `role` / `source` / `imageId`
  (extend `sceneReferenceSchema`, `.catch([])` keeps old rows safe — it already
  does). Keep `source_image_id` as the edit-lineage column for backward compat;
  the multi-ref list is purely additive.
- **Later, only when a real reverse-query feature exists** ("show every scene
  that used this portrait"): add the join table. Until that feature is on the
  roadmap, the table is a migration + a second source of truth to keep in sync,
  for a query nobody runs. YAGNI.

**PM Note**: Let's build out this feature now rather than deferring. I think we should
track as many metrics as possible in all parts of the app, so having this
query available will be useful.

## 5. Hosted multi-reference providers — the SFW lane only

The feedback's survey (BFL FLUX.2 ≤10 refs; Gemini multi-image compose but
SFW-only policy; GPT-Image multi-input but strict filters) is plausible, but two
codebase facts sharpen it:

- **We already run flux.2-pro and already know it moderates nudity.** It's the
  default image model (`provider.ts:15`), and [../images.md](../images.md)
  documents the `"Sexual Content"` rejection on revealing portraits (the whole
  `describeImageGenError` recovery exists because of it). So "FLUX.2 could become
  the default multi-character renderer" is true **only for SFW scenes**. For the
  intimate core it is a non-starter — same policy wall as Gemini and GPT-Image.
- **The intimate scene is the product** ([../README.md](../README.md)). So _all
  three_ hosted multi-ref options serve the secondary (SFW romance / clothed /
  location-continuity) lane. None of them serve the core lane. That's the single
  most important strategic point and the feedback under-weights it: the hosted
  APIs solve multi-character _SFW_; they do nothing for multi-character
  _intimate_, which is exactly where we most want multiple identity anchors.

**So I'd reorder priorities relative to the feedback:** FLUX.2 multi-ref is worth
a spike, but as the SFW lane, not a path to a new default. The real strategic
investments for the core are the reference-sheet stopgap (§6) and self-hosted
diffusion (§7).

**Verify before building** (these are time-sensitive external claims I won't
assert from memory):

- Whether FLUX.2 multi-image _edit_ is reachable through our existing OpenRouter
  image path, or needs a **BFL-direct provider module** mirroring `venice.ts`
  (new `ai/bfl.ts`, same never-throws / diagnostic shape). My guess: direct BFL,
  because the AI-SDK image surface we use is single-output text-to-image.
- Current Gemini / GPT-Image content policy + practical filter behavior (the
  written policy and what the filter actually rejects differ, as the feedback
  notes). I can run these checks with the docs/web tools if you want — I left them
  out to keep this doc to design, not a vendor audit.

**PM Note**: I agree, use the web to find the API fields available for Flux on OpenRouter
and if it says multi-image reference is possible, build a simple test script to
send two reference images and validate what is returned.

## 6. Reference-sheet "Strategy B" — agree it's brittle, but it has one real niche

I agree with every caution: the model gets a picture of a contact sheet, not
structured slots; it can copy the layout, blend identities, ignore the location
panel, or render the panels as objects. Labeled zones + "do not render as a
collage" help and will sometimes work — best for vibe / hair / body type /
wardrobe / location atmosphere, worst for exact faces and two-people-in-contact.

**But the feedback misses why it's still worth keeping:** it is the _only_
near-term option for multi-character **intimate** scenes. The hosted multi-ref
APIs are all SFW-walled (§5), and self-hosted ComfyUI (§7) is months out. Today,
intimate multi-character = one Qwen identity anchor + textual others (already
shipped, `scene.ts:103-106` + `buildSceneRenderPrompt`). The reference-sheet hack
on the uncensored Qwen edit model is the one cheap thing that could give a
_second_ identity anchor before ComfyUI exists. So I'd keep it, scoped to exactly
that niche, behind evals — not as a general SFW strategy (FLUX.2 beats it there).

Implementation notes I'd add: track `meta.copied_reference_sheet: boolean` as a
graded failure mode, and if the model reproduces the board frame, crop it (we
already own webp post-processing in `assets.ts`). And it must still obey the POV
rule (§8) — the board is reference input, never the composition.

**PM Note**: I think we should build a quick test and send Qwen-Image a combined
reference-sheet image with a prompt to create a scene based on the two characters
and the location (or scene, if it understands that better) and then validate
what comes back for quality.

## 7. Self-hosted ComfyUI — the long-term home for the core (agree)

Agree this is where a romance game with generated adults and occasional nudity
ends up: identity adapters per character (InstantID / IP-Adapter-style),
ControlNet/OpenPose or depth for composition, regional prompting for who-appears-
where, location reference for background, and a content policy we enforce at the
app layer instead of discovering through API rejections. It's a project (GPU
hosting, workflow management, output moderation), not a toggle — agreed.

Two codebase-specific hooks:

- **It slots in behind the provider abstraction (§4) as one more provider.** Build
  the capability layer first and ComfyUI is "register a provider with
  `maxReferenceImages: N, supportsAdultFictionalNudity: true,
supportsReferenceRoles: true`," not a rewrite of `scene.ts`.
- **It is plausibly the trigger for the deferred monorepo split.** The
  [monorepo-evaluation.md](monorepo-evaluation.md) note parks the split behind
  "the first second deployable… most likely a background worker." A GPU
  ComfyUI/diffusion worker is exactly that second deployable. Worth noting so the
  two decisions are made together rather than twice.

**PM Note**: Determine what models would be most useful for self-hosted ComfyUI NSFW
images. We would preferably run them in a cloud environment as local resources are
limited.

## 8. Invariants the feedback omits (a multi-ref path must preserve these)

1. **First-person player POV is a hard rule.** Every scene is from the player's
   eyes; the player never appears and the player's appearance/wardrobe is never
   fed to the composer or render ([../images.md](../images.md), `SCENE_POV_RULE`).
   A multi-reference provider makes this _easier to break_ — you're now handing it
   2+ character refs + a location, and must guarantee the player's avatar is never
   among them. (It isn't today: refs come from present NPCs + location only,
   `scene.ts:112-115`. The new path must keep that.)
   **PM NOTE**: Yes, we my want to redesign the prompt once we start testing this
   system because the image model might mistake one of the characters provided as
   'player' and omit them from the image. Does the prompt say from the players eyes
   explicitly? We might want to reword that to something better like 'camera viewpoint
   is from viewers POV' or something similar, because image models might not understand
   or care about 'player'.
2. **Session-snapshot freeze.** Scene references read the participant's
   spawn-snapshot avatar (`findParticipantAvatar`, `session_participants.avatarImageId`),
   never the live library portrait — a deliberate fix for wrong-character scenes
   when a portrait changes mid-session (`scene.ts:240-269`). A multi-ref builder
   must resolve every character ref through the snapshot, not the library row.
   **PM Note**: We don't want sessions to pull in live character portraits. We could
   potentially add a feature to update existing sessions with new live portraits, but
   the reason we do this is some characters will be made by other users and shared
   publicly. If the owner updates the portrait, we don't want it to change all
   existing user's games that use that character.
3. **Degrade, never fail.** Per [../resilience.md](../resilience.md), the session
   is never blocked by image work. The router must be a **fallback ladder** with a
   diagnostic per downgrade, mirroring the existing
   `images.scene_render.reference_fallback` info diag: multi-ref provider →
   single-ref Venice → reference-sheet → text-to-image → (demo monogram). Each
   step `parseOr` at the trust boundary, diagnostics over exceptions.
   **PM Note**: This is correct, scene images are 'nice to have' but not required
   for the game, so they should never disrupt the chat when they fail. Of course,
   we want to reduce the chance of failure as much as possible... maybe with a 'retry'
   once or twice on failure depending on the reason the API provides. If it's an
   outright rejection, we shouldn't try again. If it's a connection issue or something
   similar we can try a couple times and then log it as potential service outage.

## 9. Eval harness (agree — with a caveat on what's automatable)

Agree completely, and it matches our testing ethos (degradation tests assert
fallback **and** diagnostic code). Caveat: image identity/quality is
**human-scored**, so this is a fixtures + manual-scoring harness, not a `pnpm
test` gate. Concretely:

- ~20 fixed scenes spanning the routing matrix: one character; two clothed; two
  partially clothed; three characters; character+location; location-only; and a
  few high-risk wardrobe/exposure cases. Park them next to the existing
  `scripts/fixtures/` (harbor-house) seed data.
- Save per run: every input reference, provider, prompt, seed/settings, output,
  and manual scores for identity-A, identity-B, location match, clothing
  accuracy, exposure accuracy, and collage contamination.
- **Crucially, an explicit safety row:** "did an uploaded/real-face reference ever
  reach an uncensored or intimate render?" must always score zero. The §3 guard
  is what this row tests.
- Later you _can_ semi-automate identity scoring (face-embedding distance ref↔output)
  and collage detection, but manual first — don't block on tooling.

## 10. My recommendation order (refined from the feedback)

1. **Uploaded-avatar intimate guard (§3) — now, as a bug fix.** Default-deny on
   explicit `source: "generated"` provenance (stamp it on generation), _and_
   keep uploaded references off the uncensored edit path entirely. File as a
   [followups.phase4.md](followups.phase4.md) entry. Correctness + safety.
   **PM Note**: Defer this for now. We are in dev so there is 0 chance of an
   uploaded avatar being used in this way.
2. **Provider-capability layer + reference-list enrichment (§4)** — no default-
   behavior change. Enrich JSONB, _not_ a join table. Builds the seam everything
   else slots into.
3. **Spike FLUX.2 multi-ref for the SFW lane (§5)** — scoped to SFW; verify
   reachability (OpenRouter vs BFL-direct) first. Do **not** plan it as a new
   default; the intimate core stays on Venice/Qwen.
4. **Reference-sheet experiment (§6)** — behind evals, scoped to its real niche
   (intimate multi-character stopgap before ComfyUI), with `copied_reference_sheet`
   tracking and POV enforcement.
5. **Self-hosted ComfyUI (§7)** — the long-term home for the core lane; build it
   behind the §4 abstraction; co-decide with the monorepo-split trigger.

## 11. Filing

- This doc: `scene-image-references.deferred.md`, nested under
  [deferred.plan.md](deferred.plan.md) (pointer added there).
- §3 is the exception to "deferred": it should be lifted into a
  [followups.phase4.md](followups.phase4.md) entry (or a small fix PR) right
  away — the `allowIntimate` scene switch is phase-4 T3 shipped code, so its bug
  belongs in that phase's followups.
- When §4 graduates, move it from here into the relevant phase plan and delete the
  deferred entry, per the deferred-doc convention.
