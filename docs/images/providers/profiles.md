# Task profiles

Beneath a model sit task profiles — "how to use this model for one job."
`image_model_profiles` (contract
`packages/image-core/src/models/image-model-profiles.ts`) is the extension point one permanent
`extraInput` bag could never be: the same Seedream row is an everyday 2K scene model in one place
and a slow 4K location model in another.

## What a profile carries

- `task` — `portrait` · `variant` · `scene` · `item` · `location` · `chat_look` · `chat_place` ·
  `text_repair` · `example_transform` · `image_set`;
- `operation` — `generate` or `edit`;
- `promptStrategy` — an enum resolved through a code registry, never prompt logic stored in the
  database;
- `referencePolicy` — allowed roles, required roles, role order, optional per-role caps, drawn
  from the `identity`/`location`/`style`/`object`/… role vocabulary;
- `controlDefaults` — the normalized control names plus a seed **policy** (`random` /
  `reuse_source` / `caller`, because a stored numeric seed is a pin, not a default);
- `providerOverrides`, `timeoutMs` (null, or 30s–15min), `enabled` / `isDefault` / `builtin`, and
  `sort`.

`(imageModelId, key)` is unique, at most **one enabled default per task globally** (a partial
unique index), and profiles cascade-delete with their model. A profile may *narrow* a model; it
can never claim a capability the model does not expose.

Profiles have a full admin write path — create/edit/delete routes under
`/api/admin/self/image-models/{modelId}/profiles`, managed from a nested section of each model
card. A saved configuration is validated against the model (eligibility, provider overrides
against `knownInputFields`, fail-closed when unprobed) **only while the merged row is enabled**:
a disabled row accepts any schema-valid patch, which is what makes "disable the broken profile
and retry" an action that actually works.

## Every render resolves a profile, and every picker lists profiles

All seven lanes call `resolveImageProfileForTask` for their own task before they reserve an image
row, then describe the render as an intent ([render-intents.md](render-intents.md)). Model-level
resolution does not exist, and neither does a model picker.

The player-facing selects (`ImageProfileSelect` — the portrait studio's two sections, the chat
scene strip, the scenario modal) list offered profiles grouped per model from
`GET /api/image-profiles?task=…`, lead with an explicit "Task default" option (an empty value;
the server resolves the task default), and show the selected profile's operator warning as helper
text. The stored value rides the same `modelId` / `sceneModel` fields, so a legacy stored model
id keeps resolving through the degrade chain below.

## The seeded standard set

Of the 29 built-in profiles, the 22 standard ones are each equivalent to what its lane rendered
before profiles existed; the seven curated ones are non-default alternatives a player or admin
must pick.

| Model                                                                                         | Standard profiles                                                                | Default for those tasks? |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------ |
| `qwen/qwen-image-2512`                                                                        | `portrait-standard`, `item-standard`, `location-standard`, `chat-place-standard` | yes                      |
| `qwen/qwen-image-edit-2511`                                                                   | `variant-standard`, `scene-standard`, `chat-look-standard`                       | yes                      |
| `bytedance/seedream-4.5`, `bytedance/seedream-5-lite`, `wan-video/wan-2.7-image-pro`          | `portrait-standard`, `variant-standard`, `scene-standard`                        | no                       |
| `stability-ai/stable-diffusion-3.5-large`                                                     | `portrait-standard`                                                              | no                       |
| `aisha-ai-official/nsfw-flux-dev`, `aisha-ai-official/likereality-pony-v1`, `prunaai/p-image` | `portrait-standard`                                                              | no                       |
| `nsfw-api/sdxl-pulid`                                                                         | `variant-standard`, `scene-standard`                                             | no                       |

The Qwen generate profiles run `generate` / `text_to_image_description`; the Qwen edit profiles
run `edit` / `instruction_edit`. Stable Diffusion 3.5's portrait-only set matches the row's
portrait-only toggles. The three `portrait-standard`-only rows publish **no reference input at
all**, so `canEdit` is false and the variant and scene surfaces are closed to them by capability,
not by a toggle. `nsfw-api/sdxl-pulid` has no portrait profile because it is an identity adapter,
and bare-prompt it is an ordinary SDXL generator; single reference only, so a `multi` scene render
degrades to the single-reference rung.

The four anchor tasks with no picker of their own (`item`, `location` and `chat_place` sit on the
general-purpose generator; `chat_look` on the instruction editor) are seeded **only on the model
that lane renders with**, so no model becomes newly eligible.

The seeded policies likewise reproduce current behavior: generate tasks allow no references at
all; `variant` and `chat_look` require `identity` and allow `style`; `scene` orders identity →
location → style → object and does not require a role at the **profile-definition** level,
because scenes may contain no portrait-bearing character.

That does **not** mean every scene model has a bare-prompt fallback. `routeSceneAttempts` adds
`generate` only when no usable reference exists **and** the selected model has `canGenerate`. An
edit-only model such as Qwen Image Edit 2511 with no usable reference yields an empty chain and a
visible refusal rather than a text-only stranger. `scene` profiles carry the `instruction_edit`
strategy even on the multi-reference models — the lane decides multi-versus-single at render
time, and changing that here would change a payload.

## The curated seven

The seven curated profiles ride the same machinery as alternatives, never defaults: Qwen 2512
`portrait-fast` and `portrait-quality`, Seedream 4.5 `ensemble-scene-2k` (multi-identity/object
reference policy) and `location-4k`, Seedream 5 Lite `quality-scene-3k`, Stable Diffusion 3.5
`stylized-portrait-high-guidance`, and Wan `multi-reference-edit-2k`. Each profile's control
values — step counts, guidance, resolution tiers, curated negatives — are stated on its model's
page in [../../image-models/models/README.md](../../image-models/models/README.md), which owns
the per-model rationale for them.

Control defaults that map through probed bindings sit inert until the model's version is probed
or pinned; Wan's 2K tier is effective the moment the profile is picked, because size-pair
negotiation needs no binding.

## Profile resolution is a five-step degrade

The stored value may be a profile id, a model id, a model slug, or a dead value from before any
of this existed, so `resolveImageProfile` degrades:

1. a profile id among the offered candidates;
2. a model id or slug → that model's **own** default profile, else its first offered profile in
   sort order;
3. the task's global default profile;
4. the first offered profile in sort order;
5. null, which the caller reports as `image_profile.none_offered` and fails the render on.

A stored pick the resolver did not honor raises `image_profile.pick_unavailable`. Step 2's second
half is load-bearing: `isDefault` is globally unique per task, so most models carry none, and
without that fallback a stored Seedream scene pick would silently jump to Qwen Edit — a render
change.

"Offered" is one shared candidate set (`imageProfileCandidates`, which pickers read too, so a
picker can never show an option resolution would refuse): right task, `enabled`, model present and
parsed, the task's **legacy surface toggle** still on where the task has one
(`forPortrait`/`forVariant`/`forScene` gate `portrait`/`variant`/`scene`; the anchor and new tasks
never had a toggle and use enabled profiles directly), and the profile eligible for its model.

Every step reads that same list, so an ineligible or disabled stored pick degrades instead of
failing. A malformed profile payload degrades to `[]` rather than throwing
(`imageModelProfileListSchema`, [../../resilience.md](../../resilience.md) §1), and a single
unparseable row is skipped with `image_profile.row_invalid` rather than emptying the list.

## Eligibility composes the mechanical and the reviewed

`profileEligibility` → `operation_unsupported` | `edit_kind_none` | `identity_too_weak` |
`img2img_identity_task`:

- a `generate` profile needs `canGenerate`;
- an `edit` profile needs `canEdit` **and** an `editKind` other than `none`; and
- the identity-critical tasks — `variant`, `scene`, `chat_look` — additionally refuse
  `identityPreservation: "weak"` and `editKind: "img2img"`, because `canEdit` alone was never
  evidence that a face survives.

`portrait` is deliberately not identity-critical: it *creates* the reference every other task
preserves. An img2img model stays usable through a deliberate remix profile on a non-identity
task, and `unknown` passes every semantic check.

`identity_conditioned` — an identity adapter that conditions generation on a supplied face
(PuLID, InstantID) — passes both semantic screens on purpose: it re-generates like img2img but
conditions **on** the subject instead of repainting it, so it is what the identity-critical tasks
want, and only its `identityPreservation` rating can still disqualify it.
