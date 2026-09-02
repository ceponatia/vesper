# Prompt-program components

This page breaks the finished prompt-program system into conceptual pieces. The goal is to make the boundaries easy to inspect: **what does this component know, what does it do, and what must it not become responsible for?**

These are product/system responsibilities, not code modules.

## 1. World snapshot

The **world snapshot** is the frozen picture of what one render is allowed to know.

It can include:

- character visual facts;
- current wardrobe and body coverage, including whether the worn headwear fully hides the hair;
- current location facts;
- item facts;
- relationships such as “Mira holds the umbrella”;
- camera and framing facts;
- facts about the shot itself rather than about anyone in it — its mood, whose eyes it is seen through, and how two bodies are arranged;
- the requested image operation;
- the references that will be available;
- source revisions or other provenance that identifies the moment being rendered.

### What it does

It makes every later prompt decision refer to the same moment.

That prevents a render from accidentally combining, for example, yesterday's character appearance, today's outfit, and a location that changed while the request was being prepared.

### What it must not do

It must not contain model-specific wording. “Auburn hair” belongs here; “describe the hair in a concise natural-language sentence because Qwen prefers that” does not.

It also must not quietly refresh partway through a render. A retry that intentionally uses current state is a **new** world snapshot.

---

## 2. Visual selection

The prompt system should not automatically dump every fact Vesper knows into every image.

The **visual-selection** layer determines which facts are image-relevant for the requested shot.

For a close portrait, eye color and a facial scar may matter while footwear does not. For a full-figure scene, shoes and posture may matter. A fact hidden by clothing or outside the camera frame should not be treated as plainly visible merely because it exists in the database.

### What it does

It turns “all known character truth” into “the visual truth this image should actually care about.”

### What it must not do

It must not invent appearance from narrator prose, personality text, or guesses about what would look better.

It also must not become a model-specific filter. The decision that a scar is relevant to a close portrait should be independent of whether Qwen or Seedream paints it.

---

## 3. Operation contract

The **operation contract** states what kind of change the image request is asking for.

Examples:

- create a portrait from scratch;
- change only the pose of an existing portrait;
- change an outfit;
- create a scene from several references;
- preserve a character while changing the setting;
- render a location portrait;
- render an item;
- reproduce exact authored text.

### What it does

It separates “what is currently true” from “what this render is trying to do.”

That distinction is essential for edits. If the task is “change the pose,” the system can name the pose as the requested delta while treating identity, age, and other protected features as things to preserve.

### What it must not do

It must not contain vague instructions such as “make it better” that have no stable relationship to world state.

It must also not let a model-specific prompt style redefine the operation. An edit remains an edit even if one model wants it phrased as a detailed instruction and another wants a compact command.

---

## 4. Reference roles

A reference image is not meaningful enough on its own. The system needs to know **why it is being sent**.

Common roles include:

- identity reference;
- image to edit;
- location reference;
- object reference;
- outfit reference;
- style reference;
- example of the desired result;
- future structural references such as pose, depth, edge, or masks where a model truly supports them.

### What it does

Reference roles let the prompt dialect say the right thing about each image and let the transport send them in a meaningful order.

For a multi-character scene, reference roles also help keep “this face belongs to this person” separate from “this image shows the location.”

Because the roles travel with the images, the **final labels are assigned from the references that actually survive planning** — so “Image 1” names the image the provider receives first. Where planning would move an image out of the position a numbered label claims, the request is refused before any spend rather than sent with a label pointing at the wrong picture.

### What it must not do

It must not infer role from upload order alone.

An image route must not number its own references. A label written before planning describes a list the provider may never receive.

It also must not promise a model that an image is a pose control, mask, or depth map when the endpoint has no real mechanism for treating it that way. A content reference and a structural control are different things.

---

## 5. Positive requirements

**Positive requirements** describe what must appear, remain true, or change in the output.

Examples:

- Mira is the subject;
- Mira appears to be in her late twenties;
- preserve Mira's face;
- change her pose to sitting;
- keep the current coat;
- show two people;
- place the red umbrella in Mira's hand;
- use a full-figure frame;
- render the word `MORROW` exactly.

### What it does

It creates a model-neutral list of obligations before anyone writes the final prompt.

Some requirements are mandatory. Others are useful detail that may be sacrificed if an endpoint has a hard prompt budget.

### What it must not do

It must not confuse “important to the model” with “true in the world.” Priority can decide what survives a space limit; it cannot make an invented detail true.

---

## 6. Negative guardrails

**Negative guardrails** represent unwanted outcomes that Vesper would like the model to avoid.

Examples:

- accidental watermark;
- duplicate people;
- malformed hands;
- unrelated clutter;
- unwanted caption text;
- identity drift;
- accidental cropping;
- media/style artifacts that contradict the chosen rendering medium.

### What it does

It makes exclusions explicit, named, reviewable, and testable instead of hiding them inside a giant generic negative string.

A guardrail can be enabled for one model/task and absent from another depending on evidence.

### What it must not do

It must never overrule authoritative world truth.

A rule against text cannot erase required lettering. A rule against extra appendages cannot erase authored wings or a tail. A single-subject rule cannot erase a second person who is actually in the scene.

It also must not be sent through a negative field merely because a provider schema happens to expose one. The field needs evidence that it actually works.

---

## 7. Collision resolver

The **collision resolver** is the referee between positive truth and negative guardrails.

Its basic law is simple:

> If a generic exclusion conflicts with something Vesper explicitly requires, the required world truth wins.

### What it does

It can narrow or remove a negative guardrail before the prompt reaches the model.

For example:

| Positive truth | Generic guardrail | Result |
| --- | --- | --- |
| Sign must say `MORROW` | Avoid generated text | Do not suppress the required lettering |
| Two people are present | Avoid extra people | Do not tell the model to render only one person |
| Character has horns | Avoid extra appendages | Preserve the horns |
| Portrait is intentionally cropped | Avoid cropped subjects | Permit the requested crop |
| Character has an authored amputation | Avoid missing limbs | Preserve the authored anatomy |

### What it must not do

It must not “split the difference” by weakening required truth to preserve a quality rule.

The world is authoritative. The quality rule is optional guidance around it.

---

## 8. Prompt pack

A **prompt pack** is the reviewed behavior configuration for a particular prompt strategy.

It can describe things such as:

- which optional guardrails are enabled;
- which concepts are not useful for a particular model;
- which kinds of information deserve more or less prompt space;
- which reviewed wording style a dialect should use;
- which general rendering descriptors should be added when the operation does not already specify them.

### What it does

It makes prompt behavior versioned and testable.

That means Vesper can compare “pack version 2” with “pack version 1,” decide version 2 is worse, and return to the earlier behavior without pretending nothing changed.

### What it must not do

It must not contain character-specific facts, hidden world state, or an alternate scene description.

A pack controls how truth is presented, not what truth is.

---

## 9. Model dialect

The **model dialect** is the translator for one endpoint's preferred instruction style.

Examples of differences a dialect may handle:

- a text-to-image model wants a descriptive scene;
- an edit model wants the requested change first;
- a multi-reference editor wants “Image 1,” “Image 2,” and explicit assignments;
- one model responds to natural language while another prefers compact tags;
- one endpoint has a working negative field while another does not;
- one wrapper secretly injects a default that Vesper must neutralize.

### What it does

It converts model-neutral requirements into the actual positive prompt, negative channel, and reference wording appropriate to that endpoint.

### What it must not do

It must not read the character sheet, wardrobe, scene memory, or database directly.

It must not invent omitted facts.

It must not change the requested operation because another task happens to look visually similar.

### The one exception to “wording last”

A small closed set of intimate staging arrangements carries wording that was measured rather than chosen — a handful of words in each sentence accounts for almost the whole difference between a usable render and a broken one, and that residue describes how models behave rather than what the scene means. So the reviewed sentence travels with the fact, under a version number and a content check that says which exact words the version meant.

This is not a general prose channel. A caller cannot supply a sentence; only the registry that authored and measured it can. And each dialect has to decide **explicitly** whether it is using the reviewed wording or writing its own, because a later reader needs to know whether the measurements behind that version describe the image in front of them.

---

## 10. Binding

A **binding** is the answer to:

> Which reviewed dialect and prompt packs belong to this model doing this task?

A Qwen portrait and a Qwen variant can therefore use different prompt behavior even though the model family is related. Likewise, two models doing the same “scene” task can have very different bindings.

### What it does

It joins together:

- the task;
- the selected model/profile;
- the appropriate dialect;
- the chosen positive behavior;
- the chosen negative behavior.

It also gives Vesper a clean way to distinguish experimental behavior from trusted production behavior.

### What it must not do

It must not act as a placeholder for combinations that do not really exist.

If a profile uses Stable Diffusion, there should not be a pretend Qwen binding attached to that profile merely because someone expects to support it later.

---

## 11. Budget and fitting

Image models have practical limits on useful prompt length, even when the provider's hard limit is larger.

The **fitting** component decides how to keep the most important requirements when the request is too large.

### What it does

It protects mandatory information first and trims optional detail in a predictable order.

A rich character sheet should not cause the identity lock or requested edit to fall off the end of the prompt merely because a long location description consumed all the space.

### What it must not do

It must not silently trim mandatory truth and still call the request successful.

A render that cannot express a required fact should be treated as ineligible rather than spending money on a request Vesper already knows is incomplete.

---

## 12. Transport

The **transport** is the final provider-shaped request: prompt text, negative prompt if there is one, references, dimensions, seed, guidance, LoRA settings, and other controls.

### What it does

It takes the compiled prompt program and the selected profile's real capabilities and produces the request that the provider actually receives.

### What it must not do

It must not secretly add model behavior that the prompt system cannot see.

If a provider wrapper injects a default prompt, default negative, preamble, or other hidden steering, that behavior belongs in Vesper's capability/provenance model so the “effective prompt” is explainable.

---

## 13. Provenance

**Provenance** is the image's receipt.

It should make a generated image explainable later without copying the entire world state into the image row.

Useful questions include:

- Which world snapshot was rendered?
- Which selected facts were involved?
- Which model/profile/version ran?
- Which references were sent and what were their roles?
- Which binding and pack versions were active?
- Which positive requirements survived fitting?
- Which negative guardrails were delivered, narrowed, or dropped?
- What final prompt and transport hashes identify the request?

### What it does

It separates two classes of failure:

- **Vesper asked for the wrong thing.**
- **Vesper asked for the right thing and the model failed to follow it.**

Without provenance those two problems can look identical.

### What it must not do

It must not become another mutable source of truth. It is a record of what happened, not the state future renders should read from.

---

## 14. Visual evaluation

The **visual-evaluation** layer asks the one question no inspection of the request can answer:

> Did the image actually get better, stay equivalent, or get worse?

### What it does

A controlled visual trial changes one meaningful variable at a time and grades the resulting pictures.

For an identity edit, the important scores may be:

- identity fidelity;
- requested change success;
- preservation of unrelated features;
- apparent age;
- geometry;
- clothing consistency.

For a multi-character scene, the important scores may instead be:

- both people present exactly once;
- identities not swapped;
- actions assigned to the correct person;
- place/reference fidelity;
- camera/framing success.

### What it must not do

It must not collapse every model behavior into one vague “looks good” score.

A model can produce a beautiful image that failed the actual task.

---

## 15. Promotion state

A candidate prompt behavior should have a clearly different status from production behavior.

Conceptually there are three useful states:

- **candidate** — real enough to measure, not trusted to drive production;
- **active** — approved for the matching production job;
- **retired** — retained for history or rollback, no longer selected for new renders.

### What it does

It makes “we are testing this” different from “players now depend on this.”

That distinction is especially important when multiple model/task lanes migrate at different speeds.

### What it must not do

It must not imply that a whole model family is approved because one task succeeded.

A Qwen portrait result does not prove Qwen's variant wording, and a single-character scene does not automatically prove a multi-character scene.

---

# Operator and testing surfaces

The components above describe the prompt system itself. A finished system benefits from operator-facing surfaces that make those components visible without requiring someone to read raw database records.

These are useful conceptual surfaces because each answers a different diagnostic question.

## Prompt Program Inspector

For a selected image, show:

- the world snapshot identity;
- selected facts;
- operation;
- reference roles;
- positive requirements;
- negative guardrails;
- collisions that were resolved;
- chosen binding, dialect, and packs;
- final prompt/negative output;
- anything trimmed or dropped;
- model/profile/version and final controls.

Its job is to answer **“What did Vesper tell the model, and why?”**

## Visual Comparison View

Present paired renders with the controlled variables visible and a grading form suited to the task.

Its job is to answer **“Did this prompt behavior actually improve or preserve image quality?”**

## Lane Matrix

A high-level matrix can show which model/task combinations are:

- unsupported;
- candidate;
- active;
- retired;
- missing evidence.

Its job is to answer **“Which parts of the image system are actually using prompt programs?”** without assuming that support is model-wide.

These surfaces are not replacements for the Image Generator or Advanced Image Lab. The Generator answers raw model questions; the Lab answers structured experiment questions. The prompt-program views answer questions about **Vesper's own production prompt behavior**.
