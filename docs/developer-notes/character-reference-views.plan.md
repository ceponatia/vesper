# Character reference views — accepting a portrait, and the angles it unlocks

Status: next — written 2026-08-15, scoped by the owner rulings of the same date

Outcome: The owner can mark a character's portrait as final and get a small set
of extra views built from it — each side, and full-length from the front and the
back, dressed and undressed — so that a scene the story shot from behind is
drawn from that character's real back instead of an invented one.

Technical companion:
[character-reference-views.spec.md](character-reference-views.spec.md)

Related work, and the boundary with each:

- [scene image composition](finished/scene-composition.plan.md), shipped
  2026-08-15, owns **which shot the story asks for** — the camera vocabulary,
  the evidence gate, the staging catalog. This plan owns **what the app has to
  show the model** once that shot says "from behind". The two meet at one
  lookup: a resolved camera picks a view.
- [intimate-scene LoRA](finished/intimate-scene-lora.plan.md) owns **which model renders
  an intimate act** — staged intimate scenes route through the probe-proven
  anatomy LoRA. This plan owns **what reference that model is handed**. They are
  complementary and land on the same renders: the LoRA fixes what the model
  knows how to draw, the undressed view fixes what it is looking at. Neither
  substitutes for the other, and the slice-4 trial grades this plan's
  contribution with the LoRA routing already in place, never against a
  pre-LoRA baseline.
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
eight of the thirteen intimate staging entries are `away` shots — the character
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

A clothed reference is its own version of the same problem. The chat look exists
precisely because an always-dressed portrait argues an edit model out of an
undressed scene, and the scene prompt still has to close with "depict only the
clothing described … add no garment that is not listed" to stop a shed garment
being repainted. Handing the model a clothed back view for an intimate shot
repeats that fight from a new angle.

There is a second, smaller complaint tangled up in the same place. The app reacts
to a new canonical portrait **immediately**: an identity crop derives, chats
re-anchor their look. That is right when a portrait is final and wrong while the
owner is still trying options — and it becomes expensive rather than merely
noisy the moment reacting means paying for renders. There is no way today to say
"this one is the keeper".

## What the owner gets

- **A portrait that is a draft until it is accepted.** The portrait studio grows
  an **Accept this portrait** action and shows, at a glance, whether the current
  canonical portrait has been accepted. Generating a new portrait, promoting a
  variant, or uploading a picture leaves it unaccepted — the owner iterates as
  freely as today, and nothing downstream treats an experiment as final.
  Conversations keep rendering from the **last accepted** portrait meanwhile, so
  iterating never disturbs a chat in progress.
- **A reference sheet, built once, when they accept.** Accepting queues the extra
  views of that character, built from the accepted portrait, and the studio shows
  them arriving. Four angles in two wardrobe states — dressed as the portrait is,
  and undressed — so an intimate shot is anchored on a reference that is not
  wearing clothes the scene already removed. One payment, no repeat spend while
  the owner keeps that portrait.
- **A say over every view.** Each view can be regenerated on its own, or replaced
  with the owner's own upload when the app's attempt is wrong. A view the owner
  rejects is not used by anything.
- **Scenes drawn from the angle the story asked for.** When the shot puts the
  camera behind a character, the render is anchored on her back view; a profile
  shot anchors on the matching side; a scene where she is undressed anchors on
  the undressed view of that angle. The face-forward portrait keeps anchoring
  everything else, exactly as now.
- **Staleness that is visible instead of silent.** Changing the canonical
  portrait marks the views as belonging to an older picture and says so, rather
  than quietly feeding an out-of-date back view into new scenes.

## Boundaries

### In scope

- An explicit **accepted** state for a character's canonical portrait, and the
  studio controls that set and clear it.
- Moving **all** derived-reference work behind that state — the identity face
  crop included — with the last accepted portrait remaining the identity source
  while a newer one is unaccepted, and a one-time pass marking every existing
  character's current portrait accepted so nothing in the library breaks.
- Building, storing, and reviewing a fixed set of extra views derived from the
  accepted portrait, in both a dressed and an undressed wardrobe state.
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
- **A view set per outfit.** Two wardrobe states — as the portrait is dressed,
  and undressed — not one per garment combination. Tracking the fiction's
  changing clothes is already the chat look's job.
- **Changing how the face crop is *derived*.** Only what triggers it moves. The
  crop is the same deterministic crop, still free; this plan sits beside the
  identity pack, not inside it.
- **Automatic quality judgment of a view.** The owner's eye is the gate in v1.
  No detector decides whether a back view looks like the right person.
- **Views for locations, items, or personas.** Characters only.

## Slices

- **Slice 1 — a portrait is accepted, or it is not.** Status: next. The character
  gains an accepted-portrait state, the studio gains the control and the badge,
  changing the canonical portrait clears acceptance, and the identity face crop
  moves onto the accept trigger while the last accepted portrait keeps serving
  live chats. A one-time pass marks every existing character's current portrait
  accepted. Nothing new is generated yet: this slice is worth shipping alone
  because it is the thing that stops the app reacting to an experiment, and it is
  the trigger everything after it hangs from.
- **Slice 2 — accepting builds the views.** Status: queued. Accepting queues the
  view renders as background work, the studio shows them arriving and lets the
  owner regenerate one or replace it with an upload, and the set is marked stale
  when the portrait moves. The views are visible to the owner and to nobody else.
  **The first few accepts are the probe**: eight renders and a review screen is
  the same evidence a lab fixture would produce, so this slice answers whether
  the technique works at all before anything consumes it.
- **Slice 3 — the render picks the matching view.** Status: queued. A scene whose
  camera faces away anchors on the back view, a profile shot on the matching
  side, a full-length shot on the full-length front — undressed where the
  character is undressed and the route allows it — with the current behavior as
  the fallback everywhere a view is missing, unreviewed, or stale. Which view was
  used is recorded on the image.
- **Slice 4 — the trial that says whether it helped.** Status: queued. A graded
  comparison of view-matched renders against today's front-only anchoring, on the
  shots that motivated the plan: away, away-with-a-glance, profile, and the
  intimate staging entries that imply a rear camera. It also settles the
  remaining open question about partial undress.

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
- **Cost is per accept, and accepts repeat.** Two wardrobe states put eight
  renders behind one click, and a character re-accepted after every portrait
  tweak pays every time. The mitigations are that acceptance is explicit, that
  its cost is stated at the point of clicking, and that re-accepting the same
  portrait is free.

## Success criteria

- Generating, uploading, or promoting a portrait derives nothing and costs
  nothing. Only accepting does.
- While a newer portrait sits unaccepted, conversations keep rendering from the
  last accepted one, and no identity-critical render starts refusing.
- Every character that has a portrait today is treated as accepted after the
  one-time pass, with no owner action and no change to their renders.
- A character with an accepted portrait shows eight views in the studio — four
  angles, dressed and undressed — each regenerable and replaceable on its own.
- A scene whose resolved shot faces away is rendered against that character's
  back view, in the wardrobe state the scene has her in, and the image records
  which view it used.
- Removing or rejecting a view degrades that shot to today's behavior — a
  front-anchored render — rather than failing it.
- Changing the canonical portrait shows the views as stale and stops them being
  sent, without deleting them.
- The slice-4 trial reports, per shot type, whether a view-matched render was
  preferred to the front-only baseline, and names the shots where it was not.

## Owner rulings (2026-08-15)

- **Four angles, not six.** Both sides, full-length front, full-length back.
  Three-quarter shots — the composer's most common non-default orientation — have
  no exact match and fall through to today's front anchor rather than being
  approximated. Revisit only if the slice-4 trial says three-quarter is where the
  remaining failures are.
- **Two wardrobe states: as the portrait is dressed, and undressed.** A clothed
  reference pushes clothing into an intimate scene — the complaint that produced
  the chat look and the "add no garment that is not listed" clause — so the
  undressed set exists to stop that fight at the reference rather than in the
  prompt.
- **Acceptance gates every derivation, the free crop included.** With the
  refinement that makes it safe: the last accepted portrait stays the identity
  source while a newer one is unaccepted, so a chat in progress is never
  disturbed by portrait iteration, and existing characters are marked accepted by
  a one-time pass.

## Open questions

- **Which set does a partly undressed character get?** Fully dressed and fully
  undressed are obvious; topless-but-clothed-below is not, and both answers are
  defensible. The slice-4 trial grades it rather than guessing
  ([detail](character-reference-views.spec.md#selection)).
- **Should the undressed set be optional per character?** Some characters never
  appear in an intimate scene, and skipping their undressed views halves what
  their accept costs. It also adds a decision to a button whose whole appeal is
  that it is one click
  ([detail](character-reference-views.spec.md#cost-and-quota)).
