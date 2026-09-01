# Testing prompt programs in Vesper

Prompt-program testing has two different jobs:

1. **Did Vesper prepare the right request?**
2. **Did the image model produce the right picture from that request?**

Those questions must stay separate.

A perfect-looking image can hide a bad request that happened to get lucky. A semantically perfect request can still produce a bad image because the model ignored it. The finished testing system should let an admin tell which failure happened.

This guide describes practical tests from Vesper's image surfaces and the kinds of operator views that make prompt-program behavior understandable. It does not define release gates or implementation steps.

## The basic rule: change one thing at a time

The most useful image comparisons hold as much as possible constant:

- the same world state;
- the same character/reference images;
- the same model and provider version;
- the same seed when the model is deterministic enough for paired comparison;
- the same dimensions and aspect ratio;
- the same LoRA and other controls;
- the same requested operation.

Then change only the thing being investigated.

Examples:

- old prompt behavior versus new prompt behavior;
- prompt pack A versus prompt pack B;
- one model dialect versus another version of that same dialect;
- negative guardrail off versus on;
- one model versus another while keeping the world request equivalent.

If several things change at once, a better-looking result does not tell you why it improved.

# Existing Vesper surfaces and what they are good for

## Image Generator: raw model behavior

The admin Image Generator is the right place to answer questions such as:

- Does this model understand this kind of wording at all?
- Does this provider field actually work?
- Does changing guidance, steps, seed, strength, or another exposed control materially change the result?
- How does the model treat one versus several references?
- Does a negative field suppress something that the positive prompt merely implies?
- Does this model respond better to prose or terse wording?

The Generator is deliberately **not** proof that Vesper's production prompt program is correct. The admin authors the whole prompt directly, so the test bypasses the world snapshot, positive requirements, negative collision rules, and production binding.

Think of it as a microscope for the model itself.

### Useful prompt-program questions to investigate there

- Does Qwen Edit respond better when the requested change comes before descriptive context?
- Does a model understand numbered-reference assignments?
- Does an endpoint's negative field actually influence output?
- Does a high guidance value improve adherence or merely create artifacts?
- Does a model retain identity better with one face reference or several?

A result from the Generator can justify testing a new prompt behavior in Vesper. It does not by itself justify making that behavior production truth.

---

## Advanced Image Lab: controlled evidence

The Advanced Image Lab is the right place when the question has a defined experiment shape and the result should become durable evidence.

Existing experiment types already cover production-shaped portrait and scene baselines, controlled portraits/scenes, two-character identity tests, finishing passes, staged scenes, and structural-control probes.

For prompt-program work, the Lab is especially useful for questions such as:

- Does a candidate scene prompt preserve both identities in a two-character composition?
- Does a production-shaped portrait keep a distinctive morphology feature?
- Can a finishing pass improve identity without damaging clothing or pose?
- Does a structural control continue to work when production-style subject description is present?

The Lab should remain an experiment bench rather than becoming the sole place to inspect production prompt programs. It answers **visual-evidence questions**; a dedicated prompt-program inspector answers **why Vesper built a particular request**.

---

## Portrait Studio variants: identity-preserving edit tests

Portrait variants are one of the clearest in-app ways to judge prompt-program quality because the requested change is narrow and the canonical portrait provides a visible before-image.

Useful variant kinds include:

- pose;
- outfit;
- expression;
- setting.

### What to check

For every variant, ask two questions:

**Did the requested thing change?**

and

**Did everything that was supposed to remain stable stay stable?**

A useful review checklist is:

- Is this still recognizably the same person?
- Is apparent age stable?
- Did hair, skin tone, body proportions, and distinctive features drift?
- Did the requested pose/outfit/expression/setting actually change?
- Did unrelated clothing change when clothing was not the target?
- Did morphology such as horns, wings, tail, scars, or other distinctive features survive?
- Did the model compress, stretch, crop, or otherwise damage body geometry to satisfy the edit?

A beautiful result that changed the wrong person is a failure.

### A particularly useful manual test

Use the same canonical portrait and make several variants whose requested changes are intentionally different:

1. pose only;
2. expression only;
3. outfit only;
4. setting only.

Compare how much unrelated content changes in each case. A good edit dialect should make the requested delta obvious without behaving like a full repaint every time.

---

## Character Chat scene images: composition and reference tests

Chat scenes exercise more of the system at once:

- current cast;
- current visual state;
- wardrobe;
- actions;
- setting;
- camera/framing;
- one or more identity references;
- optional place references;
- reference-capacity limits;
- model selection.

This makes scene images a powerful system test, but a poor first test when something is already broken. Too many components are involved.

### Single-character scene test

Use one present character with a strong canonical identity reference.

Check:

- recognizable identity;
- current outfit rather than stale clothing from the reference;
- current action;
- correct framing;
- current location;
- distinctive morphology and marks;
- no invented extra person.

If this fails, investigate before moving to multi-character scenes.

### Two-character scene test

Use two visually distinct characters and a scene where each has a clearly different action or object.

For example:

- Mira holds the red umbrella on the left;
- Sayed carries the black case on the right.

Check:

- both characters appear exactly once;
- identities are not merged;
- faces are not swapped;
- the umbrella belongs to Mira;
- the case belongs to Sayed;
- left/right or other strong spatial relationships are respected;
- the place remains recognizable when a location reference is included.

This is a stronger test than “render two people standing together” because incorrect role binding becomes visible.

### Reference-capacity test

Create a scene whose ideal request has more references than a model can accept.

The important question is not merely whether an image comes back. Check which information degrades first.

A good system should make the loss understandable and intentional — for example, preserving character identity references before a lower-priority place reference — rather than silently dropping an arbitrary image.

---

## Chat look anchors: stale-reference resistance

The chat look anchor exists partly to stop a canonical portrait's old clothing from fighting current conversation state.

A useful behavioral test is:

1. start with a character whose canonical portrait shows outfit A;
2. establish outfit B in the chat's current state;
3. allow or trigger the look anchor to update;
4. render later identity-locked scenes using that look.

Check whether the character consistently appears in outfit B rather than snapping back to outfit A because the old canonical portrait was visually persuasive.

This tests the boundary between **identity reference** and **current state**: the reference owns who the person is; world state owns what is true now.

---

## Portrait generation: from-scratch description tests

A portrait generated without an identity reference tests a different side of the system from variants.

There is no source face to preserve, so the prompt program has to communicate enough selected appearance truth for the model to establish the character visually.

Check:

- apparent age;
- hair, skin, build, and other required appearance facts;
- distinctive features;
- intended wardrobe;
- framing;
- style/medium;
- whether optional details crowd out more important identity information.

Once a portrait becomes canonical, later identity tests can ask whether reference-based lanes preserve what this generation established.

---

## Item and location images: simpler prompt-program controls

Item and location renders are useful because they remove character identity from the equation.

They are good tests for:

- descriptive fact coverage;
- exact lettering;
- clean-background guardrails;
- material/color/shape preservation;
- location lighting and atmosphere;
- model dialect quality without face-preservation noise.

A location with a named sign is especially useful for collision testing: if the world requires exact lettering, a generic no-text guardrail must not sabotage it.

# Tests for the prompt-program rules themselves

## 1. World truth versus generic quality rules

Choose cases where a generic quality rule is intentionally wrong for the world.

Examples:

- required sign text versus “avoid text”;
- two people versus “single subject”;
- horns/tail/wings versus “no extra appendages”;
- an authored amputation versus “no missing limbs”;
- a requested close crop versus “do not crop the subject.”

The expected result is not merely “the image looks okay.” The inspector should show that the conflicting negative guidance was narrowed or removed **before** rendering.

---

## 2. Current state versus stale reference pixels

Use a reference that visibly disagrees with current state in one controlled way.

Examples:

- old outfit versus current outfit;
- clean hair versus currently wet hair, where the lane is meant to depict that state;
- no glasses versus glasses currently worn;
- old location versus current scene.

The expected rule is:

> Reference images help with what their role owns; authoritative current state wins everywhere else.

This is a crucial test because image models naturally copy pixels even when the prompt says otherwise.

---

## 3. Same truth, different model

Render the same conceptual request through two models that support the task.

Do **not** expect byte-identical prompts. The prompts should differ because the dialects are different.

Instead check that both prompts represent the same underlying obligations:

- same people;
- same requested change;
- same current state;
- same required relationships;
- same camera facts;
- same reference roles, adjusted only when a model's real capacity forces an explicit degradation.

This test answers whether the system is genuinely model-aware without becoming model-owned.

---

## 4. Prompt-budget pressure

Use a deliberately rich character and scene.

Include many optional visual facts, a detailed location, wardrobe, relationships, and camera information.

Check that:

- mandatory identity facts survive;
- the requested operation survives;
- required subject count survives;
- exact lettering survives when required;
- optional flavor/detail disappears before mandatory truth;
- the system refuses rather than knowingly sending a request missing a protected fact.

This reveals whether prompt fitting is behaving as a priority system rather than simple truncation.

---

## 5. Exact retry versus current-state rerender

The finished system distinguishes two user intentions that can otherwise look like the same “try again” button.

### Retry the same composition

The render should use the same frozen world moment and prompt-program identity, changing only sampling when appropriate.

Use this when asking:

> Was that result just a bad roll from the model?

### Render current state again

The system should take a fresh world snapshot.

Use this when asking:

> What does the scene look like now?

A good provenance view should make those two cases visibly different.

---

## 6. Missing mandatory information

Deliberately create or use a case where an image-critical requirement cannot be established.

Examples:

- an identity-critical edit has no eligible identity reference;
- a required character visual fact cannot be resolved;
- a model/task combination cannot express a protected requirement;
- the selected endpoint cannot perform the requested kind of operation.

Expected behavior:

- the system does not quietly invent a substitute;
- the request does not spend provider money when Vesper already knows it is incomplete;
- the resulting failure tells the operator which requirement could not be satisfied.

“Best effort” is useful for optional detail. It is dangerous for identity and other mandatory truth.

# Shadow comparison tests

Shadow comparison answers whether a candidate request is semantically safe enough to keep investigating.

A useful production-facing summary groups candidate renders into:

- **parity** — every required comparison was measured and matched;
- **divergence** — a real unexplained difference exists;
- **unmeasured** — some required comparison could not be made;
- **error** — the measurement itself failed.

Do not treat `unmeasured` as “probably fine.” It means there is not enough evidence for a parity claim.

## What to investigate when parity is low

### Fact loss

The candidate omitted something the current request actually said.

Question: is that an intentional improvement or a bug?

If intentional, the difference should be explicitly named as an accepted delta rather than disappearing into the statistics.

### Unexpected fact

The candidate states something the old request did not.

Question: is this newly available world truth that should be added, or did the compiler invent something?

### Mandatory loss

Stop. A protected fact did not survive.

### Transport mismatch

The two prompts are not the only difference. A reference, control, model choice, shape, or other provider input moved too.

That comparison cannot cleanly answer a prompt-only migration question.

### Payload jump

A much larger candidate may be semantically correct but still degrade model performance or hit practical budget limits. A much smaller one may reveal that useful detail vanished.

# Visual A/B grading by lane

Different tasks need different grading forms.

## Variant grading

| Dimension | Question |
| --- | --- |
| Identity | Is this clearly the same person? |
| Requested change | Did the requested pose/outfit/expression/setting change succeed? |
| Preservation | Did unrelated identity or appearance drift? |
| Apparent age | Did the character become noticeably older or younger? |
| Morphology | Were distinctive anatomy/species features preserved? |
| Geometry | Did the edit squash, stretch, crop, or distort the subject? |
| Overall regression | Did anything obviously become worse despite task success? |

## Portrait grading

| Dimension | Question |
| --- | --- |
| Character facts | Are required appearance facts depicted correctly? |
| Distinctive features | Are the features that make this character recognizable present? |
| Wardrobe | Is the intended presentation correct? |
| Framing | Does the portrait match the requested shot? |
| Style | Is the chosen medium/rendering intent obeyed without overwhelming identity? |

## Scene grading

| Dimension | Question |
| --- | --- |
| Cast | Is everyone who should be present shown, and nobody else? |
| Identity | Is each person recognizably themselves? |
| Binding | Are actions/items assigned to the correct person? |
| Location | Does the scene match the intended place? |
| Wardrobe/state | Does current state beat stale reference content? |
| Composition | Are camera/framing/spatial requirements respected? |
| Duplication/merge | Are people duplicated, merged, or swapped? |

## Item/location grading

| Dimension | Question |
| --- | --- |
| Identity | Does the object/place match its authored definition? |
| Required details | Are required materials, colors, landmarks, signs, etc. present? |
| Exact text | Is authored lettering correct when required? |
| Artifacts | Did generic quality failures appear? |
| Composition | Is the item/location presented in the intended clean or environmental context? |

# A useful end-state in-app diagnostic flow

When an image looks wrong, an admin should be able to move through the problem in this order:

1. **Open the image.** Identify the visible failure.
2. **Inspect the world snapshot.** Was the correct state selected?
3. **Inspect the positive requirements.** Did Vesper ask for the missing/correct fact?
4. **Inspect negative collisions.** Did a guardrail accidentally fight the fact?
5. **Inspect references.** Was the right image sent for the right role?
6. **Inspect the binding/dialect.** Was this the intended model-specific prompt behavior?
7. **Inspect fitting.** Was anything important trimmed?
8. **Inspect final transport.** What did the provider actually receive?
9. **Compare other renders using the same prompt-program identity.** Is the failure consistent or just sampling variance?
10. **Move to Image Generator or Image Lab only when the remaining question is about model behavior rather than Vesper's request.**

That flow keeps diagnosis disciplined. It avoids spending time tuning a model when the real problem is stale world state, or changing world-state logic when the real problem is a model that ignores its negative field.

# Suggested regression scenario library

A small set of memorable characters/scenes can exercise most of the system repeatedly. The point is not to have hundreds of pretty screenshots; it is to make failures obvious.

Useful fixtures include:

- a human character with a facial scar and distinctive hair;
- a non-human character with horns, wings, or a tail;
- a character with an authored anatomy absence or prosthetic;
- a canonical portrait whose clothing intentionally differs from current wardrobe;
- a two-character scene with strongly distinct appearances and role-bound objects;
- a location with exact required lettering;
- a cluttered location where a clean-background rule should **not** apply;
- an item with exact markings or text;
- a rich scene designed to pressure the prompt budget;
- a model with a known working negative field and one with a known inert/unsupported negative field.

When the same fixtures are used repeatedly, a new dialect or prompt pack can be compared against known hard cases instead of being judged only on whichever image happened to be generated that day.
