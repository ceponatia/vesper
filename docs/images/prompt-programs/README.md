# Prompt programs — plain-English system guide

This folder describes the **finished prompt-program system as a product**, in plain English. It is meant to answer questions such as:

- What problem is this system solving?
- What are the major pieces and why does each exist?
- What should happen when Vesper makes a portrait, variant, scene, item image, or location image?
- What should stay the same when the image model changes?
- What can an admin test in Vesper to tell whether the system is behaving well?
- Where would another useful subsystem or operator tool fit?

It intentionally does **not** describe implementation steps, rollout order, code structure, or how a developer should build the system. For the technical contract and current implementation details, see [the prompt-program technical reference](../prompt-programs.md).

## The idea in one sentence

**Vesper decides what is true about the image first, then translates that truth into instructions suited to the particular image model that will render it.**

That order matters.

Without this system, each image route can gradually become its own little island. A portrait prompt may describe a character one way, a scene prompt another way, and a variant editor a third way. A new model can encourage yet another set of wording. As the game gains richer visual state, clothing state, anatomy, locations, items, camera rules, and references, it becomes increasingly easy for one route to forget a fact or for two prompt builders to contradict each other.

The prompt-program system treats those things as **world truth**, not prompt wording.

A model never gets to decide that a character suddenly has different hair, that a missing limb grew back, that a second person appeared, or that a sign no longer needs its authored lettering merely because a convenient generic prompt happened to say so. The model-specific wording comes after Vesper has already decided what the image is supposed to depict.

## The finished experience

Imagine a character named Mira. At the moment a scene is rendered, Vesper knows that:

- Mira is the person in the scene;
- her current appearance includes the visual facts selected for this camera view;
- she is wearing a particular outfit;
- her left sleeve is rolled up;
- she is holding a red umbrella;
- the scene is outside a particular café at night;
- the shot is full-figure;
- the café sign must read `MORROW` exactly;
- one image is Mira's identity reference;
- another image is the location reference;
- the requested operation is to depict the current scene, not redesign Mira.

Those are the **facts and requirements**. They should remain true whether Vesper uses Qwen, Seedream, Wan, Stable Diffusion, FLUX, or another future model.

The models may need very different instructions.

One model may respond best to numbered references such as “Image 1 is Mira; Image 2 is the café.” Another may want a natural-language scene description. Another may prefer terse tags. One may have a working negative-prompt field; another may ignore that field completely. One may support three references while another supports only one.

The prompt-program system allows those instructions to differ while keeping the underlying request the same.

## Truth first, wording last

The full conceptual flow is:

```text
Vesper's current world
        │
        ▼
one frozen picture of what this render knows
        │
        ▼
what this image must show + what operation is being requested
        │
        ├───────────────┐
        ▼               ▼
positive requirements   negative guardrails
        │               │
        └───────┬───────┘
                ▼
        contradiction check
                │
                ▼
       chosen model/profile
                │
                ▼
       model-specific dialect
                │
                ▼
 prompt + references + controls
                │
                ▼
             render
                │
                ▼
 provenance: what truth and prompt program produced this image?
```

The important boundary is near the top: **model-specific behavior does not get to reach back and reinterpret the game world.** It only decides how to communicate the already-selected truth to that model.

## What goes into the system

The prompt-program system does not own all image-related truth itself. It consumes decisions made by other Vesper systems.

### Character visual state

The visual-state system decides which character facts exist and which are relevant to this image. Permanent appearance, current state, body morphology, distinctive marks, exposure, and other visual facts can all contribute when their owning systems say they apply.

The prompt program should not re-infer those facts from biography text or from the narrator's prose.

### Wardrobe and body coverage

Clothing and exposure come from their authoritative state, not from whatever the reference image happens to show. This matters when a character has changed clothes since a canonical portrait was made.

A reference photograph can help preserve identity, but it is not allowed to become a time machine that silently restores old clothing or old state.

### Scene composition

The scene system decides who is present, who is in frame, what people are doing, where the camera is, and what the current place is. The prompt program expresses those decisions; it does not get to add a cast member or move the camera simply because a model tends to produce nicer compositions that way.

### Items and locations

Items and locations can contribute their own visual identity, current condition, relationships, exact text, and references. They are peers of character facts rather than decorative prose appended at the end.

### Identity packs and other references

The identity-pack system supplies reference images that are actually eligible to represent a character. Other references can represent places, objects, outfits, styles, before-images, examples, or future control inputs.

The prompt system records **what job each reference is doing**. “Here are three images” is not enough information.

### Model profiles and capability knowledge

The model/profile system decides which model is being used for this task and what that endpoint can actually accept. Prompt programs should never assume that a field exists merely because another host or another version of the same model supports it.

## The two halves of a prompt program

A prompt program has two complementary products.

### Positive requirements

These say what the output **must contain or preserve**.

Examples:

- this is Mira;
- she has auburn hair;
- preserve her apparent age;
- she is wearing the current navy coat;
- she is holding the red umbrella;
- render two people, not one;
- show a full-figure composition;
- the sign reads `MORROW`;
- change the pose to sitting while preserving the rest of the identity.

These requirements are structured before they become prose. “Auburn hair” is a fact; the sentence used to communicate it is model-specific.

### Negative guardrails

These say what unwanted outcomes should be discouraged when doing so does not contradict the world.

Examples include:

- no watermark or signature;
- no accidental caption text;
- no duplicate person;
- no malformed hands when hands are visible;
- no unrelated background clutter;
- no identity drift when a valid identity reference is present.

Negative guardrails are not a universal magic string pasted onto every model. Each guardrail applies only when it makes sense, and it is used only through a transport the selected endpoint has actually proven it understands.

## World truth always wins a contradiction

This is one of the most important behaviors in the system.

Suppose a generic quality rule says “avoid text,” but the café sign is required to say `MORROW`.

The system should not send both instructions and hope the model chooses correctly. The required lettering wins, and the conflicting “avoid text” portion is removed or narrowed.

The same principle applies elsewhere:

- a two-character scene defeats a generic “single subject only” guardrail;
- a requested portrait crop defeats a generic “do not crop the subject” guardrail;
- authored horns or a tail defeat generic anatomy exclusions that would erase them;
- an authored missing limb defeats a generic “no missing limbs” exclusion;
- an illustrated scene defeats a generic “avoid illustration” exclusion.

The negative side exists to improve the image **around** Vesper's truth, never to overrule it.

## The model dialect is a translator, not an author

A dialect is the communication style for one model/endpoint.

Its job is to answer questions such as:

- Should this be a scene description or an edit instruction?
- Should references be numbered and assigned explicit roles?
- Does the model benefit from terse tags or ordinary prose?
- Can exclusions travel in a real negative field?
- Does the model need an affirmative replacement because it has no usable negative channel?
- Does a hidden provider default need to be neutralized?

The dialect is allowed to change the **form** of the request. It is not allowed to change its meaning.

This gives Vesper a clean way to become better at using a particular model without rewriting the game systems that own the facts.

There is one narrow exception, and it exists because of measurement rather than convenience. A small closed set of intimate staging arrangements has wording that was tuned against real renders, where a handful of words in each sentence carries almost the whole difference between a good result and a broken one. That wording travels with the fact under a version number, and each model dialect has to say explicitly whether it is using the reviewed sentence or writing its own. It is never a way for a caller to hand the model an arbitrary paragraph.

## There is no alternative route

A character image has exactly one assembly path. When a render cannot be described honestly — a lost identity anchor, an unregistered pack, a reference label that would no longer match the image being sent — Vesper refuses that render instead of reaching for a simpler prompt written somewhere else. A picture that looks acceptable but was assembled a different way hides the fault rather than reporting it.

Where a route has a degradation ladder, as a chat scene does, the attempt that cannot be described is dropped and the next one is tried. The render fails only when no attempt is left.

## Prompt packs are tunable behavior, not world truth

A prompt pack is the versioned set of prompt-behavior choices for a model/task combination.

It can express decisions such as:

- which reviewed quality guardrails are enabled;
- which optional concepts are not useful on this model;
- which kinds of facts deserve more prompt space;
- which reviewed wording family is being used;
- what general rendering intent should be added when the scene itself did not specify one.

A pack should never become a second character sheet, second wardrobe database, or hidden scene description. It shapes how truth is communicated; it does not own the truth.

Keeping packs versioned means Vesper can test a new prompt approach and later answer, “Which prompt behavior produced this image?” rather than silently changing the meaning of every old render.

## Bindings answer “which prompt behavior belongs to this job?”

A binding connects a real production lane to the correct model dialect and prompt packs.

Conceptually it says:

> When this particular model performs this particular kind of image task, use this reviewed prompt behavior.

That matters because “portrait,” “variant,” and “scene” are not interchangeable even when they happen to use the same model.

A binding's status also keeps a prompt behavior that exists for testing apart from one that is trusted for production: only an `active` binding is ever used for a render, and a lane whose model has no active binding refuses rather than wording the render another way.

## Visual evidence still decides whether a prompt is good

Prompt programs can prove that Vesper communicated the intended facts. They cannot prove that the model followed them well.

For that, Vesper needs controlled image comparisons.

A good comparison holds the model, version, seed, references, dimensions, and controls constant while changing only the prompt behavior under test. Human review then looks for things that matter to the lane, such as:

- recognizable identity;
- requested edit success;
- preservation of facts that were supposed to remain unchanged;
- correct character count;
- correct reference-to-character binding;
- correct clothing and exposure;
- geometry and framing;
- lettering;
- unwanted artifacts;
- regressions elsewhere in the image.

The [testing guide](testing.md) describes practical ways to do this across Vesper's image surfaces.

## Provenance makes old images explainable

A finished image should carry enough history to answer questions such as:

- Which moment in the world did this image depict?
- Which character facts were selected?
- Which model and provider version ran?
- Which references were sent, and what role did each have?
- Which prompt-program binding and pack versions were used?
- Which positive requirements survived fitting?
- Which negative guardrails were delivered, narrowed, or dropped?
- Was this an exact retry of an old composition or a fresh render of current state?

The point is not to store a second copy of the whole world beside every image. The point is to keep stable identifiers and fingerprints so a render can be traced back to the state and prompt behavior that produced it.

This becomes especially valuable when an image looks wrong. “The model failed” and “Vesper told the model the wrong thing” are very different bugs.

## What should feel different to the user?

Ideally, very little about the interface and a great deal about consistency.

A player should notice that:

- changing image models does not randomly change which parts of the character sheet matter;
- characters keep distinctive visual facts across portraits, variants, and scenes;
- reference-based edits change the requested thing without needlessly redesigning everything else;
- current clothing and scene state beat stale information visible in an old reference image;
- multi-character scenes are less likely to merge or swap identities, because the images the prompt describes are the images actually sent;
- authored unusual anatomy is preserved instead of “corrected” into generic human anatomy;
- exact text is not sabotaged by a generic no-text rule;
- retries are understandable: retrying the same composition means something different from rendering the current world again.

The complicated machinery should primarily be visible to admins and developers through testing and provenance surfaces, not as additional work for the player.

## What this system does not own

The prompt-program system is deliberately narrower than “everything about image generation.” It does not decide:

- what a character looks like;
- what clothing they are wearing;
- who is present in the scene;
- what happened in the story;
- which pose the scene composer selected;
- whether an identity reference is high enough quality to use;
- which provider is healthy;
- whether a generated image actually resembles the intended person;
- how generated image files are stored or displayed.

Those systems can feed information into prompt programs or consume their output, but keeping the ownership separate is what prevents the prompt layer from becoming another source of world state.

## The surrounding system at a glance

| System                        | What it contributes                                                                             |
| ----------------------------- | ----------------------------------------------------------------------------------------------- |
| Visual state                  | Which character facts are visually true and relevant to this render                             |
| Wardrobe / coverage           | Current clothing and what body regions it covers                                                |
| Scene composition             | Cast, action, setting, lighting, mood, camera, framing, whose eyes the shot is through, staging |
| Items / locations             | Their visual identity, state, relationships, and authored text                                  |
| Identity packs                | Eligible character reference images                                                             |
| Model profiles / capabilities | Which model is doing the job and what that endpoint can really accept                           |
| Prompt program                | Positive requirements + negative guardrails over one frozen world snapshot                      |
| Dialect                       | How the selected endpoint should be told those requirements                                     |
| Prompt packs                  | Versioned, evidence-backed prompt behavior for that lane                                        |
| Render system                 | Sends the final request to the provider                                                         |
| Provenance                    | Records what world and prompt behavior produced the image                                       |
| Visual evaluation             | Proves a prompt change is useful before trusting it broadly                                     |

## Reading this conceptual guide

- [Components](components.md) — each major subsystem, what it knows, what it does, and what it should never be responsible for.
- [Testing](testing.md) — how to reason about and exercise the finished system from Vesper's image surfaces.
- [Worked examples](examples.md) — several image requests followed from world truth through model-specific instructions.
- [Technical reference](../prompt-programs.md) — exact contracts and current implementation behavior.
