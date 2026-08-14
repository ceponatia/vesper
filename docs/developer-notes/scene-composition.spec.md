# Scene image composition — technical spec

Status: companion to [scene-composition.plan.md](scene-composition.plan.md)

The implementation contract for coding agents. Product scope, priority, and
open questions live in the plan; this document is how the decisions in it get
built.

## Scope

Governs the chat-lane scene image composition path: the scene composer's
schema and rules (`apps/web/src/server/images/prompts-*.ts`), plan resolution
(`resolveScenePlan`), render-prompt assembly (`buildSceneRenderPrompt`), the
composer's context inputs (`apps/web/src/server/images/character-scene.ts`,
`apps/web/src/app/api/chats/[chatId]/scene/queue.ts`), and a read-only
consumption of the chat's committed scene state. Leaves alone: the model
registry and profiles, reference selection and the attempt ladder, identity
packs, per-model prompt rewriting (image-render-quality slice 1's exact-slug
policy), the selfie framing, and every narrator surface.

Everything this spec adds is deliberately application code, per the workspace
ownership rule ([docs/images/README.md](../images/README.md)): the camera and
staging vocabularies translate Vesper's narrative and scene state into prompt
text, so they stay in `apps/web` and meet `@vesper/image-core` only at the
render-intent seam the lane already crosses. Nothing here touches
`@vesper/image-replicate`.

## Implementation status

- **Slice 1 — camera vocabulary, composer read, prompt emission**: not
  started. Includes the composer-model seam (`sceneComposerModelId()`, default
  unchanged).
- **Slice 2 — staging registry, gates, composer-model move**: not started;
  builds on slice 1's camera vocabulary.
- **Slice 3 — committed-state override**: not started; consumes
  `character_chats.scene` (live dark since 2026-08-02) — sparse facing
  coverage is expected while `CHAT_CONTACT_ACTIONS` gathers data, and absence
  degrades to slices 1–2 behavior.

Each slice's **enable follows its probe**: land the code with behavior
unchanged where evidence is absent, run the paid A/B probe (owner-gated
spend), and record the verdict here before treating the slice as accepted.

## Owner rulings (2026-08-10)

- **Away means fully away; the glance back is itself evidence-gated.** A
  character established as facing away renders full back-to-camera by
  default. `away_glance_back` is proposed only when the chat history actually
  describes the glance — her looking back over her shoulder, peeking back —
  and its evidence quote must contain that glance language (the `GLANCE_WORDS`
  backstop below). A behind-position quote alone grounds `away`, never the
  glance. This supersedes any engaged-versus-absorbed heuristic: engagement is
  not glance evidence.
- **The composer should be less cautious.** Falling back to the chat's
  narrative model on refusal is approved, and the standing direction is
  stronger: the scene composer itself moves onto a less moderation-prone
  model (slice 2, verdict recorded by its probe). The propose-then-verify
  architecture is unchanged by the model choice — the registries own every
  explicit word for grounding reasons, not only moderation, and intimate
  anatomy stays injected deterministically because exposure gating is code's
  job regardless of how bold the composer is.
- **Orientation is focal-only in v1.** One-on-one chats are the current test
  bed; `others[]` entries carry no orientation, and per-subject orientation
  waits for multi-character chats to matter.

## Contracts

### Camera vocabulary — `apps/web/src/contracts/images/scene-camera.ts` (new, pure)

A registry, not free text — the phrasing is the feature, exactly as
`contracts/images/viewer-body.ts` established. Tuning a phrase is a data edit;
adding a member is one entry.

```ts
export const sceneSubjectOrientations = [
  "toward_viewer",    // default; today's behavior
  "three_quarter",
  "profile",
  "away_glance_back", // back to camera, face turned back over the shoulder
  "away",             // fully turned away, face hidden
] as const;

export interface SceneSubjectOrientation {
  id: SceneSubjectOrientationId;
  /** The shot line fragment: "seen from behind, her back to the camera, glancing back over her shoulder at the viewer". */
  phrase: string;
  /** How much of the face the shot can show — drives the identity-lock adaptation. */
  faceVisibility: "full" | "partial" | "hidden";
  /** Non-default orientations require a verbatim narration quote (anti-eagerness gate). */
  evidenceRequired: boolean; // false only for toward_viewer
}

export const sceneShotDistances = ["close", "medium", "full_figure", "wide"] as const; // default medium
export const sceneCameraHeights = ["eye_level", "high", "low"] as const;               // default eye_level
```

Distance and height entries carry a `phrase` each ("close-up, tight framing";
"the camera looks down at her from the viewer's standing height"). `high`/`low`
require evidence **or** a posture derivation (below); distances are lenient —
a wrong distance is a taste miss, not a contradiction, so `evidenceRequired`
is false for all four and the composer rule simply asks it to match the beat.

Orientation phrases must contain **no limb nouns** (the phantom-limb scar:
a limb noun summons a limb). "Seen from behind", "in profile", "over her
shoulder" are shoulder/back-region words and rendered safe by possessive
binding in the assembled line, which always names the subject.

`away_glance_back` carries one extra requirement beyond `evidenceRequired`
(owner ruling 2026-08-10): its evidence quote must itself contain glance
language — `GLANCE_WORDS = /\b(glanc\w*|look\w*\s+(back|over)|over\s+(her|his|their)\s+shoulder|peek\w*)\b/i`,
a lexical backstop in the `BLUSH_WORDS`/`BARE_LIMB` family. A quote that
grounds only the behind-position resolves to `away`.

### Composer schema additions — `sceneSpecSchema`

Lenient like `viewerBody` — a confused composer degrades to today's frontal
shot, never a failed render:

```ts
const DEFAULT_SCENE_CAMERA = { orientation: "toward_viewer", distance: "medium", height: "eye_level", evidence: "" };

camera: z
  .object({
    orientation: z.string().default("toward_viewer"),
    distance: z.string().default("medium"),
    height: z.string().default("eye_level"),
    /** Verbatim narration quote grounding any non-default orientation or height. */
    evidence: z.string().default(""),
  })
  .catch(DEFAULT_SCENE_CAMERA)
  .default(DEFAULT_SCENE_CAMERA),
// slice 2:
staging: z
  .object({ id: z.string().default(""), evidence: z.string().default("") })
  .catch({ id: "", evidence: "" })
  .default({ id: "", evidence: "" }),
```

### Resolved plan — `SceneRenderPlan`

```ts
camera: { orientation: SceneSubjectOrientationId; distance: SceneShotDistanceId; height: SceneCameraHeightId };
staging?: ResolvedSceneStaging; // present only when every gate passed
```

`emptySceneRenderPlan()` carries the defaults, so every existing caller and
test remains valid.

### Staging registry — `apps/web/src/contracts/images/scene-staging.ts` (new, pure)

One entry per stageable configuration. The composer proposes an `id` + a
quote; **the registry owns every word that reaches the model**:

```ts
export interface SceneStaging {
  id: string;                                  // "held_from_behind", "kneeling_before_viewer", …
  /** Camera implied by the configuration; overrides the composer's camera proposal. */
  camera: { orientation: SceneSubjectOrientationId; distance: SceneShotDistanceId; height: SceneCameraHeightId };
  /** Viewer parts the configuration puts in frame — resolved through the EXISTING resolveViewerParts gate. */
  viewerParts: readonly ViewerBodyPartId[];
  /** Regions of the SUBJECT that must read bare/sheer for the explicit template; [] = clothed staging. */
  requiresBare: readonly (keyof RegionExposure)[];
  /** True ⇒ emitted only when the route's allowIntimate is set, exactly like intimateAppearance. */
  intimate: boolean;
  /** The explicit staging sentence; `{name}` is the subject. Written once, here, never by a model. */
  template: string;
  /**
   * Overrides the camera orientation's derived faceVisibility for the lock
   * adaptation: a face can hide by head angle alone (a crown-of-the-head shot
   * on a subject who faces the viewer). Absent ⇒ the orientation's value.
   */
  faceVisibility?: "full" | "partial" | "hidden";
}
```

Initial catalog (~a dozen entries; each is a data edit): `held_from_behind`
(clothed-capable, `requiresBare: []`), `held_from_behind_bare`,
`kneeling_before_viewer`, `kneeling_before_viewer_guided`,
`astride_viewer_facing`, `astride_viewer_away`, `bent_over_surface`,
`on_all_fours`, `lying_beneath_viewer`, `lying_face_down`,
`spooned_from_behind`, `pressed_to_wall_facing`, `pressed_to_wall_away`. Away-facing entries carry camera orientation `away`
per the glance ruling; glance-back variants are separate entries added as
data edits, and a `_glance_back` staging's evidence quote must pass
`GLANCE_WORDS` like the bare orientation does. Template style follows the viewer-body registry:
possessively bound, geometry-first, positive phrasing — e.g.
`kneeling_before_viewer` ⇒ camera `{toward_viewer, close, high}`, template
"Seen from above at the viewer's standing height: {name} kneels facing the
camera, looking up at the viewer". Templates for `intimate: true` entries may
name the act explicitly; they ride only the uncensored route, so the
moderation exposure is the same as `intimateSceneAppearance`'s today.

**A staging template owns the viewer-limb phrasing for the parts it names** —
"the viewer's own hands resting on {name}'s hips" — because the generic
viewer-body framing lines ("entering frame from the lower edge, close to the
lens…") describe foreground limbs near the camera, not hands placed on a
subject. `viewerParts` is therefore the **gate list**: every id still passes
`resolveViewerParts` (registry membership, route, coverage), while the staged
sentence supplies the geometry. Unlike the composer, a staging may list
intimate parts directly — it is registry data, not model output — and the
route/coverage gates still decide whether they render.

Every template's limb nouns must be possessive-bound — enforced by a registry
test running the existing `BARE_LIMB` pattern over each template with `{name}`
substituted (no bare "a hand"/"one leg" survives into a template).

## Ownership rules

- **Registries own phrasing; the composer owns only ids and quotes;
  `resolveScenePlan` owns the clamps; `buildSceneRenderPrompt` owns
  emission.** No prompt text is ever taken from the composer's camera or
  staging output beyond the id lookup.
- **Committed scene facts outrank the composer.** A slice 3 fact present for
  the focal pair replaces the corresponding proposal before clamping;
  `staging.camera` outranks the composer's camera; the composer's camera fills
  whatever remains.
- **Nothing writes state.** The resolved camera and staging exist only inside
  the render job and its recorded prompt/meta. No scene fact, no chat state,
  no memory is written — consistent with the scene owner's no-prose law
  (`romantic-contact-affordances.spec.scene.md` §Provenance law) and the
  spatial plan's render-inference rule.
- **The identity-lock adaptation composes with, and must not fork from, the
  per-model lock rewriting** in image-render-quality slice 1: the adaptation
  changes the lock's *content* (what to preserve when the face is partial or
  hidden); the exact-slug policy translates that content per model. When the
  Qwen rewrite maps the lock, it must map the adapted lock too — extend its
  idempotent rewrite, never bypass it.
- **The selfie route ignores all of this**: `framing: "selfie"` keeps
  `SELFIE_FRAMING` and drops camera/staging emission entirely (a selfie's
  camera is the subject's own). `sanitizeScenePlan` (the selfie
  content-rejection retry) strips `staging` alongside
  `exposure`/`intimateAppearance`.

## Algorithms

### Composer prompt and rules (slice 1)

- `composerRules` gains a camera rule: propose `camera` from the fixed ids;
  default `toward_viewer`/`medium`/`eye_level`; any other orientation or
  height MUST carry `camera.evidence` — a short phrase copied exactly from the
  recent narration or the player's own words that establishes where the viewer
  is relative to the subject or which way she faces. If nothing establishes
  it, keep the defaults. Behind-position evidence proposes `away`;
  `away_glance_back` is proposed only when the history describes her actually
  glancing or looking back, and the quote must be that glance (owner ruling
  2026-08-10).
- The gaze-translation rule becomes orientation-aware: with `away` /
  `away_glance_back` proposed, player-directed gaze translates to "glancing
  back over her shoulder toward the viewer", not "toward the viewer".
- `buildSceneComposerPrompt` gains the player's recent messages, clearly
  labeled (`The player's own words (their stated position and actions):`),
  budgeted like narration with a smaller cap (newest player message only,
  ~300 chars). Queue-side: `queue.ts` fetches recent rows of **both** roles
  (same total row budget) and threads user-role content separately; the
  narration list keeps its current meaning (assistant rows only), so every
  existing consumer — including viewer-body evidence grounding, which must now
  ground against narration **plus** player messages — states its corpus
  explicitly.

### Composer model (slices 1–2)

`composeSceneSpec` stops hardcoding `toolModelId()`: slice 1 introduces
`sceneComposerModelId()` as its own `MODEL_DEFAULTS` key (initial value = the
tool default, so slice 1 changes no call). Slice 2 flips that default to a
less moderation-prone model per the owner ruling — candidates are the chat's
narrative default or a designated uncensored tool-class model; the slice-2
probe records which. Refusal handling stays layered: a refusal or schema miss
on the primary model retries once on `narrativeModelId()` (the approved
fallback) before `generateChecked`'s existing heuristic fallback takes over —
so the terminal degrade remains today's deterministic spec, never a failed
render. `characterAppearanceSummary` keeps `allowIntimate: false` for the
composer either way: the composer picks ids, and explicit content enters at
render assembly only.

### Resolution and clamps (`resolveScenePlan`)

1. Look up orientation/distance/height ids; unknown id ⇒ default +
   `images.scene_composer.camera_invalid` (warn).
2. Evidence gate: a non-default orientation or height whose `camera.evidence`
   fails the verbatim-substring check (reuse `normalizeEvidence` +
   `VIEWER_EVIDENCE_MIN_CHARS` against narration + player messages) degrades
   to the default + `images.scene_composer.camera_ungrounded` (info). Two-step
   for the glance: an `away_glance_back` whose quote matches the transcript
   but fails `GLANCE_WORDS` degrades to `away` — the behind-position stands,
   the glance does not — with `images.scene_composer.glance_ungrounded`
   (info); a quote matching nothing degrades all the way to the default.
3. Posture derivation for height (needs no evidence): focal posture
   kneeling/crouching/sitting/lying with no committed viewer posture ⇒ `high`
   is permitted without a quote (the geometry is entailed by the pose text the
   composer already wrote); `low` always needs evidence.
4. Slice 2: staging id looked up (`unknown` ⇒ drop +
   `images.scene_composer.staging_invalid` warn); evidence gate as above
   (`staging_ungrounded` info); exposure gate — every `requiresBare` region of
   the SUBJECT must read bare/sheer (`staging_blocked` info); route gating is
   NOT done here — `intimate` stagings are filtered per-prompt where
   `allowIntimate` is known, exactly like `intimateAppearance`.
5. A surviving staging **overwrites** `plan.camera` with its own and unions
   its `viewerParts` into `plan.viewerBody` (they then pass the existing
   coverage/route gates in `resolveViewerParts` per prompt — a staging never
   bypasses the player-side exposure rules).
6. Slice 3: committed facts, when present, replace the corresponding camera
   fields BEFORE steps 1–5's clamps and count as evidence for the matching
   staging geometry (a provenance-carrying fact beats a prose quote). Mapping
   below.

### Prompt emission (`buildSceneRenderPrompt`)

- A **shot line** is assembled from the camera phrases and emitted immediately
  after `framingFor(...)` on every non-selfie route, e.g. `Shot: seen from
  behind, her back to the camera, glancing back over her shoulder at the
  viewer; full-figure framing.` Defaults emit **nothing** (`toward_viewer` +
  `medium` + `eye_level` ⇒ no line), keeping today's prompts byte-identical
  when no evidence moved the camera — that is the slice's no-regression
  anchor.
- The staging sentence (uncensored routes only) leads the pose: `Pose:
  <staging template with {name} bound>; <composer pose/activity text>.` On
  moderated rungs the staging is absent and the composer's (cautious) pose
  stands alone, as today.
- A surviving staging also reshapes the framing clause: `framingFor` still
  gates the parts and emits the embodied POV opening, the person-count
  assertion, and the viewer's own body facts — but the generic "Also in frame,
  in the viewer's immediate foreground: …" geometry line omits every part the
  staging names, so the same limb is never described twice with conflicting
  geometry. Parts the staging does not name (a composer-proposed extra) keep
  their registry framing lines.
- **Identity-lock adaptation** when the reference subject's effective face
  visibility is `partial`/`hidden` — the orientation entry's value, or the
  surviving staging's `faceVisibility` override where one is set: append one
  sentence after the lock —
  partial: "Her face is turned away and seen in profile/over her shoulder;
  preserve the visible features, hair color and style, build and skin tone
  exactly from the reference — do not rotate her to face the camera."
  hidden: same, with "her face is not visible in this shot". The lock itself
  is never removed (hair/build/tone still bind), and `identityAnchors` keep
  emitting — the reference stays authoritative for whatever is visible.
- Budget: the shot line and staging sentence join the never-dropped tier
  (identity lock, POV rule, pose, bare-region phrasing); they are short and
  fixed-vocabulary, and the existing outfit/setting excerpting absorbs the
  cost. `EDIT_RENDER_PROMPT_LIMIT` is unchanged.
- `images.meta` records `{ camera, staging }` resolved ids on scene rows (via
  the existing `imageMeta` narrowing) for the dev lightbox and probe grading.

### Committed-state mapping (slice 3)

Read `character_chats.scene` through `parseSceneState` (its healing laws
already answer garbage with the empty scene). Resolve the focal character's
and the player's participant ids the way the lane adapter does
(`apps/web/src/server/engine/chat-contact-adapter.ts`); then, all reads through
the scene module's own accessors:

- facing (focal → player, ordered): `toward` ⇒ `toward_viewer` · `side_on` ⇒
  `profile` · `away` ⇒ `away`. A committed facing fact never produces
  `away_glance_back` on its own — the glance needs narration evidence
  passing `GLANCE_WORDS`, which may then upgrade the state-mapped `away`
  (owner ruling 2026-08-10).
- postures: viewer standing + focal kneeling/sitting/crouching/lying ⇒ `high`;
  the inverse ⇒ `low`; equal ⇒ leave to the composer.
- proximity: `touching`/`close` ⇒ `close` · `near` ⇒ `medium` · `distant` ⇒
  `full_figure`.
- active contacts on the focal pair (the housed `ContactLifecycleState`) may
  satisfy a staging's evidence requirement when the contact's location pair
  matches the staging's geometry; the mapping table lives beside the registry
  and starts tiny (only unambiguous pairs).

Absent facts constrain nothing. Facts are threaded queue-side into
`buildCharacterSceneContext` as an optional `committedScene` input; the
composer prompt states them as authoritative context lines ("Committed scene
facts (authoritative): Mira faces away from the player; both are standing;
they are touching.") so the proposal and the clamp agree instead of fighting.
Successor chats: same seam, fed from the engine's physical state when a read
exists; until then successor chats behave like slices 1–2.

## Persistence

None. No schema change, no migration. The only stored artifacts are the
existing `images.prompt` and the `images.meta.camera`/`staging` ids above.

## Resilience

| Code                                          | Severity | Cause                                                         |
| --------------------------------------------- | -------- | ------------------------------------------------------------- |
| `images.scene_composer.camera_invalid`        | warn     | Camera id outside the registry — degraded to default.         |
| `images.scene_composer.camera_ungrounded`     | info     | Non-default camera without a matching quote — degraded.       |
| `images.scene_composer.glance_ungrounded`     | info     | Glance-back quote lacks glance language — degraded to away.   |
| `images.scene_composer.staging_invalid`       | warn     | Staging id outside the registry — dropped.                    |
| `images.scene_composer.staging_ungrounded`    | info     | Staging without a matching quote or contact fact — dropped.   |
| `images.scene_composer.staging_blocked`       | info     | Subject exposure fails the staging's bare requirement.        |
| `images.scene_render.camera_from_state`       | info     | Committed facts replaced a composer proposal (slice 3).       |

Every new schema field is `.catch`-lenient; every degradation lands on
today's behavior (frontal default, no staging) — a camera problem must never
fail a render. Degradation tests assert the fallback **and** the code
(docs/resilience.md).

## Code organization

- `apps/web/src/contracts/images/scene-camera.ts` — orientations, distances,
  heights, resolvers; exported via the contracts barrel.
- `apps/web/src/contracts/images/scene-staging.ts` — the staging registry, its
  gates' pure halves, the contact→staging evidence table.
- `apps/web/src/server/images/prompts-*.ts` — schema fields, clamps, shot-line
  and staging emission, lock adaptation (existing module; no split required by
  this work).
- `apps/web/src/server/images/character-scene.ts` +
  `apps/web/src/app/api/chats/[chatId]/scene/queue.ts` — player-message and
  committed-scene threading.
- `scripts/eval/scene-images/` — fixture rows for the orientation/staging
  cases and an `orientation-ab.ts` probe on the `phantom-limb-ab.ts` pattern.

## Fixtures and tests

Pure suites (the `pnpm test` tier, run by the `test` gate of `pnpm verify`):

- Registry integrity: unique ids, non-empty phrases, no bare limb nouns in
  orientation phrases, `BARE_LIMB`-clean staging templates, every staging
  camera id resolving.
- Evidence gating: ungrounded orientation/height/staging degrade with their
  codes; grounded ones survive; player-message text counts as corpus; a
  glance-back quote without `GLANCE_WORDS` lands on `away`, not the default,
  and a behind-position quote alone never yields the glance.
- Exposure gating: `requiresBare` stagings blocked on covered subjects;
  clothed stagings unaffected; staging `viewerParts` still pass
  `resolveViewerParts` (a covered player pelvis keeps intimate parts out).
- Emission: default camera emits no shot line (byte-identical prompt to
  today's — the regression pin); each orientation/distance/height emits its
  phrase; staging rides only `allowIntimate` prompts; selfie route emits
  neither; lock adaptation appears exactly when `faceVisibility` isn't full;
  budget caps never drop the shot line.
- Scrub interaction: orientation-aware gaze rewrite; `bindLimbsToOwner` over
  staged pose text.
- Committed-state mapping: each facing/posture/proximity value to its camera
  field; absent facts change nothing; state beats composer; contact-as-
  evidence only for listed pairs.

Fixture scenarios (extend `scripts/eval/scene-images/fixtures.ts`):
behind-clothed, behind-nude, glance-back, kneeling-before-viewer (high angle),
on-all-fours, lying-face-down, spooned, astride-facing, astride-away,
wall-press-away, plus the existing frontal rows as the identity-regression
control. Probe runs are paid and owner-gated; no gate asserts anything about
rendered pixels.

### Acceptance scenes (owner-specified, 2026-08-10)

Three staged acts graded **pass/fail per visible element** inside slice 2's
probe — not preference-ranked like the general A/B rows. All three run the
uncensored reference-edit route; each fixture's narration must contain the
evidence lines its gates need, and the player persona's wardrobe must leave
the pelvis bare wherever the viewer's anatomy is a required element (the
coverage gate is real in the probe, not bypassed).

- **Doggy style** → staging `on_all_fours`, camera `{away, close, high}`,
  `viewerParts: [hands]` (template: the viewer's own hands resting on her
  waist/hips). Pass: she is on all fours with her back to the camera, face
  not toward the lens, and the viewer's hands are on her waist or hips.
- **Oral** → staging `kneeling_before_viewer`, camera
  `{toward_viewer, close, high}`, `viewerParts: [genitals]` — or the
  `kneeling_before_viewer_guided` variant, same camera but
  `faceVisibility: "hidden"` and `viewerParts: [hands, genitals]` (the
  viewer's hand resting on the top of her head; she faces the viewer with
  her head bowed, so the face hides by angle and the lock adaptation's
  `hidden` branch fires). Pass: either composition — her face visible
  looking up mid-act, or the top of her head under the viewer's hand.
- **Missionary** → staging `lying_beneath_viewer`, camera
  `{toward_viewer, close, high}`, `viewerParts: [hands, genitals]`
  (template: she lies on her back looking up; the viewer's genitals enter
  frame at the bottom edge, penetration explicit; the viewer's hands holding
  her legs or her waist). Pass: on her back facing up at the camera,
  penetration visible at the bottom frame edge, and the viewer's hands on
  her legs or waist — either hand position passes.

A scene fails on any missing required element, any extra person, or an
unbound limb readable as a third party — the person-count assertion and
possessive binding are part of what is being graded. These three catalog
entries (`on_all_fours`, `kneeling_before_viewer` + its `_guided` variant,
`lying_beneath_viewer`) may not ship with templates that cannot express the
elements above.
