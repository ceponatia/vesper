# Character reference views — accepting a portrait, and the angles it unlocks

Status: draft — written 2026-08-15; the three owner rulings under
[Open questions](#open-questions) settle the shape of slice 2 before it starts

Outcome: The owner can mark a character's portrait as final and get a small set
of extra views built from it — each side, and full-length from the front and the
back — so that a scene the story shot from behind is drawn from that character's
real back instead of an invented one.

Technical companion:
[character-reference-views.spec.md](character-reference-views.spec.md)

Related work, and the boundary with each:

- [scene image composition](scene-composition.plan.md) owns **which shot the
  story asks for** — the camera vocabulary, the evidence gate, the staging
  catalog. This plan owns **what the app has to show the model** once that shot
  says "from behind". The two meet at one lookup: a resolved camera picks a
  view.
- [spatially controlled scene images](spatial-scene-images.plan.md) owns the
  long-horizon structural route, and already names "multi-view identity
  references" as something it needs and does not have. This plan builds that
  piece on its own terms, reachable now without a 3D frame, a pose solver, or a
  new provider.
- [image render quality](image-render-quality.plan.md) owns per-model prompt
  dialects and identity-lock wording. This plan hands it one more reference to
  bind; it does not re-word the lock.
- **Character-LoRA training** (`deferred.plan.md`) is where this eventually
  leads. Its own note says the pilot's limiting factor was its training set and
  that "the first thing it should make cheap is a deliberately varied training
  set" — a reviewed set of angles per character is exactly that seed. This plan
  does not train anything.

## Why

The app has one picture of each character: a waist-up portrait, facing the
camera. Every scene image is an edit off that single view.

That was survivable while every scene came back front-facing anyway. It stopped
being survivable the moment the scene composer learned to move the camera. The
shot vocabulary now includes profile, three-quarter, and fully-away framing, and
seven of the thirteen intimate staging entries are `away` shots — the character
seen from behind is now a routine request, not an exotic one. When one of those
renders, the model is handed a front-facing waist-up photo and told to draw the
same person from behind at full length. Everything not in the portrait is
invented: the back of her head, how her hair falls from behind, her build below
the waist, the way her clothes hang.

Invention is not consistent. Two rear shots of the same character, in the same
conversation, come back as two different people's backs. The identity work that
went into the front view — the face crop, the identity lock, the anchor
wording — buys nothing in a shot where the face is turned away, because the one
thing the app can prove about the character is the one thing the shot does not
show.

There is a second, smaller complaint tangled up in the same place. The app reacts
to a new canonical portrait **immediately**: an identity crop derives, chats
re-anchor their look. That is right when a portrait is final and wrong while the
owner is still trying options — and it becomes expensive rather than merely
noisy the moment reacting means paying for four renders. There is no way today
to say "this one is the keeper".

## What the owner gets

- **A portrait that is a draft until it is accepted.** The portrait studio grows
  an **Accept this portrait** action and shows, at a glance, whether the current
  canonical portrait has been accepted. Generating a new portrait, promoting a
  variant, or uploading a picture leaves it unaccepted — the owner iterates as
  freely as today, and nothing downstream treats an experiment as final.
- **A reference sheet, built once, when they accept.** Accepting queues a small
  set of extra views of that character built from the accepted portrait, and the
  studio shows them arriving. Four views, one payment, no repeat spend while the
  owner keeps that portrait.
- **A say over every view.** Each view can be regenerated on its own, or replaced
  with the owner's own upload when the app's attempt is wrong. A view the owner
  rejects is not used by anything.
- **Scenes drawn from the angle the story asked for.** When the shot puts the
  camera behind a character, the render is anchored on her back view; a profile
  shot anchors on the matching side. The face-forward portrait keeps anchoring
  everything else, exactly as now.
- **Staleness that is visible instead of silent.** Changing the canonical
  portrait marks the views as belonging to an older picture and says so, rather
  than quietly feeding an out-of-date back view into new scenes.

## Boundaries

### In scope

- An explicit **accepted** state for a character's canonical portrait, and the
  studio controls that set and clear it.
- Building, storing, and reviewing a fixed set of extra views derived from the
  accepted portrait.
- Choosing the right view at render time from the shot the composer resolved,
  and recording which view was used.
- Cost control: what an accept costs, what it may not cost twice, and what
  happens when the budget refuses.
- Lifecycle: staleness on portrait change, deletion with the character, exclusion
  from every player-facing surface.
- A trial that says whether view-matched renders actually beat today's
  front-only anchoring.

### Non-goals

- **Training a character LoRA.** The reviewed view set is a seed for one, and
  that work stays where it is (`deferred.plan.md` §"Character-LoRA training as an
  in-app tool", built together with free-form image iteration).
- **A 3D frame, pose solving, or control images.** Those belong to
  [spatial-scene-images.plan.md](spatial-scene-images.plan.md), which this plan
  partially unblocks and does not replace.
- **A view set per outfit.** Views are about the character's geometry, not her
  wardrobe; the outfit-true anchor is already the chat look's job.
- **Changing how the face crop is derived.** The identity pack keeps deriving
  automatically and free of charge; this plan sits beside it, not inside it.
- **Automatic quality judgment of a view.** The owner's eye is the gate in v1.
  No detector decides whether a back view looks like the right person.
- **Views for locations, items, or personas.** Characters only.

## Slices

- **Slice 1 — a portrait is accepted, or it is not.** Status: next. The character
  gains an accepted-portrait state, the studio gains the control and the badge,
  and changing the canonical portrait clears acceptance. Nothing new is generated
  yet: this slice is worth shipping alone because it is the thing that stops the
  app treating an experiment as final, and it is the trigger everything after it
  hangs from.
- **Slice 2 — accepting builds the views.** Status: queued. Accepting queues the
  view renders as background work, the studio shows them arriving and lets the
  owner regenerate one or replace it with an upload, and the set is marked stale
  when the portrait moves. The views are visible to the owner and to nobody else.
  **The first few accepts are the probe**: four renders and a review screen is
  the same evidence a lab fixture would produce, so this slice answers whether
  the technique works at all before anything consumes it.
- **Slice 3 — the render picks the matching view.** Status: queued. A scene whose
  camera faces away anchors on the back view, a profile shot on the matching
  side, a full-length shot on the full-length front — with the current behavior
  as the fallback everywhere a view is missing, unreviewed, or stale. Which view
  was used is recorded on the image.
- **Slice 4 — the trial that says whether it helped.** Status: queued. A graded
  comparison of view-matched renders against today's front-only anchoring, on the
  shots that motivated the plan: away, away-with-a-glance, profile, and the
  intimate staging entries that imply a rear camera.

## Where the work stands

- **[character-reference-views.spec.md](character-reference-views.spec.md)** —
  written 2026-08-15, no slice built. It owns the contracts, the storage shape,
  the selection rule, and the cost and lifecycle decisions.

## Risks worth naming up front

- **The edit may not hold the person.** Asking an edit model to rotate a subject
  is a harder ask than changing her clothes, and identity drift is the known
  failure mode of every Qwen edit in this codebase. If the back views come back
  as a plausible stranger, the honest outcomes are: fall back to the owner
  uploading their own views, or wait for the structural route. Slice 2 is
  deliberately ordered before anything consumes a view so this costs four renders
  to find out, not a subsystem.
- **A full-length view invents the lower body.** The source portrait is waist-up,
  so a full-figure render is partly invention whatever angle it is at. The
  existing body-reveal attribute line is the mitigation — the same text that
  already supplements scene renders — and a view built with it becomes the
  durable answer to a question the app currently re-guesses on every render.
- **Cost is per accept, and accepts repeat.** A character re-accepted after every
  portrait tweak pays every time. The mitigation is that acceptance is explicit
  and its cost is stated at the point of clicking.

## Success criteria

- Generating, uploading, or promoting a portrait never builds a view, and never
  costs a render. Only accepting does.
- A character with an accepted portrait shows four views in the studio, each one
  regenerable and replaceable on its own.
- A scene whose resolved shot faces away is rendered against that character's
  back view, and the image records which view it used.
- Removing or rejecting a view degrades that shot to today's behavior — a
  front-anchored render — rather than failing it.
- Changing the canonical portrait shows the views as stale and stops them being
  sent, without deleting them.
- The slice-4 trial reports, per shot type, whether a view-matched render was
  preferred to the front-only baseline, and names the shots where it was not.

## Open questions

- **Which views, exactly?** Four (both sides, full-length front, full-length
  back) is the owner's request and the recommended starting set. The composer's
  most common non-default orientation is `three_quarter`, which has no exact
  match in that four and would fall to the nearest neighbour; adding two
  three-quarter views makes six and raises the per-accept cost by half
  ([detail](character-reference-views.spec.md#the-view-registry)).
- **What do the views wear?** Recommended: whatever the accepted portrait wears,
  so the render is a rotation and nothing else. The alternative — a neutral,
  minimal-garment set — makes a better geometry reference and a worse wardrobe
  one, and doubles the set if both are wanted
  ([detail](character-reference-views.spec.md#what-a-view-depicts)).
- **Does acceptance gate the free work too?** Recommended: no. The identity face
  crop costs nothing and refusing to derive it until acceptance would block
  identity-critical renders for every character nobody has accepted yet, existing
  characters included. Acceptance gates the **paid** view set only
  ([detail](character-reference-views.spec.md#what-acceptance-gates)).
- **Is a bare view set wanted for uncensored routes?** A clothed back view is a
  poor anchor for a scene rendering the same character undressed. Deferred until
  the slice-4 trial says whether the clothed set holds up there at all
  ([detail](character-reference-views.spec.md#what-a-view-depicts)).
