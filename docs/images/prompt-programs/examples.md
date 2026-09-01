# Prompt programs — worked examples

These examples show how the finished system is meant to think about image requests.

They are **conceptual examples**, not exact production prompt strings. The point is to follow the same world truth through the major components and show where model-specific behavior is allowed to differ.

# Example 1 — create a portrait from scratch

## Situation

Mira has no identity reference yet. Vesper is generating her canonical portrait.

The relevant visual state says:

- apparent age: late twenties;
- hair: auburn, shoulder-length;
- eyes: grey;
- build: athletic;
- distinctive feature: a small scar under the left eyebrow;
- wardrobe: dark canvas work coat;
- intended framing: waist-up portrait;
- intended medium: realistic photograph.

## World snapshot

The snapshot contains those visual facts and the fact that this is a **portrait generation** operation.

There is no identity reference, so the prompt cannot rely on a photograph to establish Mira's face.

## Positive requirements

Conceptually, the prompt program needs to communicate:

- one adult woman;
- late-twenties apparent age;
- auburn shoulder-length hair;
- grey eyes;
- athletic build where visible;
- scar under left eyebrow;
- dark canvas work coat;
- waist-up portrait;
- realistic photographic rendering.

The exact sentences are not the truth. They are one model's way of expressing the truth.

## Negative guardrails

Useful candidates might include:

- no watermark/signature;
- no accidental caption text;
- no duplicate person;
- no malformed visible anatomy;
- no unrelated background clutter.

Because no authored lettering is required, a guardrail against accidental text does not conflict with the world.

## Model-specific result

A descriptive generation model may receive fluent prose describing Mira.

A tag-oriented model may receive a much more compact representation.

The prompts can look different while remaining equivalent if both preserve the same required facts.

## What to test

After generating several seeds:

- Does Mira repeatedly read as the same **conceptual character**, even before an identity reference exists?
- Is the eyebrow scar reliably present enough to be useful as a distinctive feature?
- Does optional styling ever crowd out apparent age or other important facts?
- If two models are used, do they receive equivalent obligations rather than entirely different character sheets?

---

# Example 2 — pose-only portrait variant

## Situation

Mira already has a canonical portrait. The user asks for a new variant:

> sitting sideways on a workshop stool

The canonical portrait is the identity reference.

## World snapshot

The system knows:

- who Mira is;
- the eligible identity reference;
- her apparent age and other protected identity information;
- any distinctive morphology/features that should survive;
- the current operation: **change the pose**;
- the requested new pose.

The reference image carries much of the fine visual identity through pixels.

## Operation contract

The requested delta is:

- change `pose` to “sitting sideways on a workshop stool.”

The preserve set includes the identity information that should not be redesigned simply because the pose changes.

## Positive requirements

The conceptual requirements become:

- Image 1 represents Mira's identity;
- preserve Mira's identity and apparent age;
- change the pose to sitting sideways on the workshop stool;
- keep protected unrelated features unchanged;
- allow the composition to adapt if the new pose needs more canvas space.

## Negative guardrails

The selected endpoint may have no usable negative channel at all.

That does **not** mean the prompt program should pretend a negative field exists. The system records which exclusions could not be delivered and relies on the positive edit instruction and reference behavior that the model actually supports.

## Qwen-style dialect

An instruction editor that prefers numbered references may receive a compact request shaped roughly like:

- identity lock first;
- `Image 1` assignment;
- requested pose change;
- limited preserve requirements;
- permission to recompose/extend the canvas when necessary.

The important behavior is that the model is told **what to change** instead of being given a broad scene description and asked to repaint Mira from scratch.

## What to test

Compare the canonical portrait with the variant:

- same recognizable face;
- same apparent age;
- same hair/skin/build identity;
- distinctive features preserved;
- requested sitting pose achieved;
- no squashing or extreme crop caused by trying to preserve the old canvas too literally.

If the pose succeeds but the face changes substantially, the request succeeded as an edit but failed as an identity-preserving variant.

---

# Example 3 — outfit change where the reference is stale

## Situation

Mira's canonical portrait shows a dark canvas work coat.

Her current state now says she is wearing a navy raincoat.

A reference-based render is requested using the old canonical portrait.

## The conflict

The reference pixels visually say:

> dark canvas work coat

The current world says:

> navy raincoat

These are not equal sources of truth.

The reference image is being used for **identity**. It does not own current wardrobe state.

## Expected prompt-program behavior

The world snapshot says the navy raincoat is current.

The positive program tells the model to preserve Mira's identity while depicting the current coat.

The reference-role assignment tells the model why the old portrait is present: it is the identity source, not a command to reproduce every pixel.

## What should not happen

The system should not silently decide:

> The reference image looks more reliable than the wardrobe database, so keep the canvas coat.

That would allow old images to overwrite simulated state.

## What to test

Use several state changes where the reference visibly disagrees with current truth:

- coat A → coat B;
- no glasses → glasses on;
- hair dry → hair damp, in a lane where current surface state is meant to apply;
- clean clothing → visibly dirty clothing, where current garment condition is included.

The test asks whether references remain powerful for the thing they own without becoming more authoritative than current state everywhere else.

---

# Example 4 — two-character scene with bound objects

## Situation

Mira and Sayed are both present outside the café.

The scene state says:

- Mira is on the left;
- Sayed is on the right;
- Mira holds a red umbrella;
- Sayed carries a black instrument case;
- the café is behind them;
- both characters have eligible identity references;
- a location reference is available;
- the intended framing is full-figure.

## World snapshot

The system records two separate subjects and explicit relationships:

- Mira → holds → red umbrella;
- Sayed → holds/carries → black case;
- Mira → left of → Sayed;
- both → located at → café.

Those relationships are not decorative English glue. They are part of what the scene means.

## Positive requirements

Conceptually:

- show Mira exactly once;
- show Sayed exactly once;
- preserve each person's identity from their own reference;
- Mira is left, holding the red umbrella;
- Sayed is right, carrying the black case;
- use the café as the setting;
- render the requested full-figure composition.

## Reference roles

The references might be:

1. Mira — identity;
2. Sayed — identity;
3. café — location.

If the model accepts only two references, the system needs an explicit degradation decision. It should not arbitrarily drop one of the two identities simply because the location was appended earlier in some array.

## Negative collision

A generic single-subject guardrail is incompatible with this world.

The collision resolver removes or narrows it before compilation.

The system may still keep a more appropriate multi-character guardrail such as “do not duplicate, merge, or swap the people.”

## What to test

This scene is successful only if:

- two people appear;
- Mira looks like Mira;
- Sayed looks like Sayed;
- identities are not swapped;
- the umbrella belongs to Mira;
- the case belongs to Sayed;
- the spatial relationship is broadly correct;
- no third person appears;
- the café remains the intended place.

A gorgeous image with the objects swapped is a prompt-following failure.

---

# Example 5 — exact lettering versus “no generated text”

## Situation

A location definition says the storefront sign reads:

`MORROW`

The location image is supposed to show that sign clearly.

A generic image-quality guardrail normally discourages accidental generated text because image models often create gibberish.

## Positive requirement

The world explicitly requires:

- the sign reads `MORROW` exactly and legibly.

## Negative guardrail

The generic pack contains something equivalent to:

- avoid unintended text/captions/gibberish.

## Collision resolution

The system must not send an undifferentiated contradiction:

> Render `MORROW` exactly. No text.

The authored lettering is protected truth.

The text-artifact guardrail is narrowed so it can still discourage **unrelated** captions or gibberish without forbidding the required sign.

## What to test

Use several locations/items:

- no authored text;
- one required word;
- multiple required labels;
- a logo or symbol;
- intentionally blank packaging.

The negative behavior should adapt to the content rather than applying the same “no text” rule to every image.

---

# Example 6 — non-human anatomy versus generic anatomy cleanup

## Situation

A character is canonically humanoid but has:

- two horns;
- a tail;
- otherwise ordinary human limbs.

A generic anatomy-quality rule exists to discourage accidental extra limbs and appendages.

## Positive truth

The horns and tail are required morphology, not defects.

## Negative guardrail

The generic guardrail may include concepts meant to suppress accidental extra appendages.

## Collision resolution

The authored horns and tail protect those concepts.

The system can still discourage genuinely unwanted anatomy errors, such as:

- a second tail;
- three arms;
- duplicated hands;
- merged legs.

But it must not “clean up” the canonical character into an ordinary human.

## What to test

This is a strong regression fixture because generic image-model quality language often assumes ordinary human anatomy.

Check:

- required non-human features survive;
- those features do not multiply;
- unrelated anatomy remains normal;
- changing models does not change whether the features are considered legitimate.

---

# Example 7 — authored missing limb or prosthetic

## Situation

A character's canonical body state includes an authored limb absence, with or without a prosthetic.

## Why this is difficult

A generic quality prompt often includes language designed to prevent “missing limbs.”

For this character, that instruction is wrong.

## Expected behavior

The positive side states the authored anatomy.

The collision resolver removes the negative concept that would restore the missing limb.

If a prosthetic is present, the positive side also identifies it as an intentional synthetic structure rather than a surface artifact.

The rest of the anatomy-quality guardrails can remain active where they do not conflict.

## What to test

The model should not:

- restore the absent limb;
- duplicate the remaining limb to “balance” the body;
- erase the prosthetic;
- turn the prosthetic into malformed flesh because a generic realism rule rejected synthetic surfaces.

This example shows why negative prompt behavior has to understand the same world truth as the positive prompt.

---

# Example 8 — same scene, different model dialects

## Situation

Use the exact same frozen scene request with two models that can both perform the task.

The world says:

- Mira is the only subject;
- identity reference available;
- navy coat;
- standing under a streetlamp;
- wet pavement;
- full-figure shot;
- nighttime café exterior.

## Model A

Model A is an instruction editor that wants an identity reference and a direct edit request.

Its prompt may focus on:

- explicit reference assignment;
- preserving identity;
- changing the scene around the person;
- current wardrobe;
- framing and setting.

## Model B

Model B may prefer a more natural multi-reference scene description.

Its prompt may read more like a cohesive paragraph describing the finished image.

## What must stay equivalent

Despite different wording, both requests should agree on:

- subject identity;
- subject count;
- current coat;
- place;
- action/posture;
- camera/framing;
- reference roles;
- required visual facts.

## What is allowed to differ

- sentence order;
- prose versus tags;
- reference syntax;
- negative transport;
- wording used to preserve identity;
- model-specific quality descriptors that have supporting evidence.

This is the core promise of prompt programs: **same world request, different competent translators.**

---

# Example 9 — prompt budget pressure

## Situation

A scene contains:

- a richly described focal character;
- several distinctive marks;
- layered wardrobe;
- one important held object;
- a detailed location;
- exact sign text;
- camera requirements;
- rendering-style detail.

The selected model has a practical prompt budget smaller than the complete description.

## What fitting should protect

Highest-protection information includes things such as:

- identity requirements;
- requested operation;
- subject count;
- required morphology;
- current wardrobe/exposure facts that would make the image wrong if lost;
- exact authored lettering when the operation requires it;
- essential reference assignments.

Lower-priority detail can include atmospheric flourish or redundant descriptive color already strongly represented by a reference.

## What to test

The resulting image may lose some richness. It must not become a different task.

Bad fitting:

> beautiful atmosphere, wrong person, missing second character, requested edit forgotten.

Good fitting:

> correct people and task, less decorative location detail.

An inspector should make it clear what was trimmed so an admin does not have to infer the loss from the image alone.

---

# Example 10 — retry the same image versus render the world now

## Situation

At 8:05 PM Mira is outside the café in a navy coat.

A scene is generated and the model produces a poor face.

At 8:07 PM, before another render, Mira enters the café and removes the coat.

There are now two legitimate requests.

## Retry same composition

The user wants another sampling attempt of the 8:05 PM scene.

The world snapshot and prompt-program identity remain tied to:

- outside the café;
- navy coat;
- 8:05 PM state.

The goal is to answer:

> Can the same request produce a better result?

## Render current state

The user wants a new picture of what is happening now.

Vesper takes a new snapshot:

- inside the café;
- coat removed;
- 8:07 PM state.

The goal is to answer:

> What does the current scene look like?

## Why the distinction matters

Without explicit world/prompt provenance, both operations can look like “regenerate.”

With prompt programs, they have different semantic identities and should be explainable as different requests.
