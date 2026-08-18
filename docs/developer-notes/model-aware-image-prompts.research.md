# Model-aware image prompting — research baseline

Status: research baseline (2026-08-18)

Implementation plan: [model-aware-image-prompts.plan.md](model-aware-image-prompts.plan.md)

Related owners:

- [image render quality](image-render-quality.plan.md) owns model-native prompt quality, prompt budgets, and image trials;
- [image lane consolidation](image-lane-consolidation.plan.md) owns migration from route-specific character prose to semantic prompt segments;
- [visual state and attention](visual-state.plan.md) owns the committed visual snapshot and camera-aware character digest;
- [image model capabilities](finished/image-model-capabilities.plan.md) owns endpoint profiles, normalized controls, role-aware references, and provider transport.

## Outcome

This document records the evidence used to design Vesper's positive and negative image-prompt systems. It separates four things that are easy to conflate:

1. a model family's general prompting behavior;
2. the exact hosted endpoint and version Vesper calls;
3. the task being performed, such as generation, instruction editing, or multi-reference composition;
4. Vesper's own structured world facts.

The practical conclusion is that Vesper cannot have one universal positive template or one universal negative string. Prompt behavior must be selected by the exact endpoint/profile, while all model variants compile from the same authoritative facts.

## Evidence policy

Prompt advice changes quickly and is unusually vulnerable to copied folklore. Research for a production prompt pack should therefore use this order of confidence:

1. **The exact hosted endpoint schema and Vesper probe.** This decides what can actually be sent. A model family may support a feature that the current Replicate wrapper does not expose.
2. **The model creator's current model card and official prompting documentation.** This is the primary source for intended syntax and behavior.
3. **The hosting provider's current guide for that exact endpoint.** This is useful when the wrapper adds defaults, prompt rewriting, score tags, or other behavior.
4. **Reproducible community guides and Reddit reports.** These are useful for discovering failure modes and test hypotheses, not for silently changing production behavior.
5. **A pinned Vesper A/B trial.** This is the only evidence that promotes a prompt pack for Vesper's workload.

Every researched claim should be stored with the source URL, review date, endpoint/version, and confidence. A provider version change invalidates inherited prompt assumptions until the new version is probed and compared.

## Current Vesper endpoint matrix

The matrix below describes the endpoints currently documented in Vesper, not every way the underlying weights can be hosted elsewhere.

| Vesper endpoint | Positive prompt starting point | Negative transport available to Vesper | Initial ruling |
| --- | --- | --- | --- |
| `qwen/qwen-image-2512` | Detailed natural-language description: subject, state/action, setting, lighting, composition, and rendering intent | Dedicated `negative_prompt` field | Use short, contextual negative blocks. Never apply the official portrait cleanup example blindly to item, location, text, non-human, or stylized tasks. |
| `qwen/qwen-image-edit-2511` | Delta-first edit instruction with numbered reference roles, one clear requested change, explicit preserved facts, and explicit geometry/canvas changes | **None on the current Replicate endpoint** | Keep negative policy separately authored, but compile it as positive replacement/preservation language or record it as unexpressible. Do not fabricate a provider field. |
| `bytedance/seedream-4.5` | Concise, layered prose naming subject, reference roles, action/layout, setting, light, and style | None | Prefer positive visual replacements and narrowly tested inline exclusions. Respect the wrapper's 4,000-character maximum and its recommendation to stay below roughly 600 English characters. |
| `bytedance/seedream-5-lite` | Natural-language generation/edit instruction with explicit reference roles and authoritative details | None | Maintain a separate pack from 4.5 even if the first wording is similar. The model's reasoning and reference behavior are different and must be version-tested. |
| `stability-ai/stable-diffusion-3.5-large` | Natural-language prose, kept compact and subject-first | Dedicated `negative_prompt` field | Use small, targeted keyword groups. The official API supports negative keywords but does not establish one universal quality block. |
| `wan-video/wan-2.7-image-pro` | Structured natural language for scene, style, lighting, layout, reference roles, and required exclusions | None | Alibaba's current docs say Wan 2.7 Image does not support `negative_prompt`; guide it in the main prompt instead. Treat third-party wrappers exposing a negative field as different endpoints. |
| `aisha-ai-official/nsfw-flux-dev` | Subject + action + style + context, using concrete positive visual language | None | Follow FLUX's positive-replacement approach. Do not pass Stable Diffusion weighting syntax or a hidden negative string to this bare wrapper. |
| `aisha-ai-official/likereality-pony-v1` | Pony/SDXL Compel tags, including the wrapper's score-tag behavior | Dedicated `negative_prompt`; wrapper also injects its own positive/negative preprompt | Keep the authored negative minimal and wrapper-aware. Vesper must continue neutralizing the provider default `nsfw, naked` when it contradicts the requested state. |
| `nsfw-api/sdxl-pulid` | Compact SDXL-style subject and scene tags plus an explicit identity/reference role | Dedicated `negative_prompt` field | Start with targeted SDXL negatives. Whether tags beat compact prose on this little-used endpoint is an evaluation question, not a settled family rule. |
| `prunaai/p-image` | Short, concrete natural-language description | None | Use positive replacement. Keep provider prompt upsampling off for authoritative-state renders until a trial proves that it does not invent or erase facts. |

This matrix must remain keyed to the **endpoint and version**, not only to names such as “Qwen,” “FLUX,” or “SDXL.” For example, upstream/local Qwen Image Edit 2511 pipelines and some other hosts expose a negative-prompt input, while Vesper's current Replicate 2511 endpoint does not.

## Model-specific findings

### Qwen Image 2512

The official [Qwen Image 2512 model card](https://huggingface.co/Qwen/Qwen-Image-2512) demonstrates long, concrete prose rather than comma-tag shorthand. Its example identifies the person, age, face, hair, clothing, setting, lighting, camera feel, and composition. It also supplies a negative prompt targeting low resolution, low quality, malformed limbs and fingers, oversaturation, waxy skin, missing facial detail, excessive smoothness, an AI-generated look, confused composition, and blurry or distorted text.

That example is useful evidence for the model's **negative dialect**, but not a universal Vesper default. Several terms conflict with legitimate tasks:

- text may be required on a sign, garment, interface, or poster;
- smooth or synthetic surfaces may be correct for an android, doll, sculpture, or stylized render;
- unusual appendage counts and authored absences may be correct morphology;
- oversaturation, blur, or low-resolution media may be intentional style.

The correct Vesper starting point is therefore a set of named, guarded blocks derived from the official example, activated only when the world digest and task make them safe.

Current sources:

- [Qwen Image 2512 official model card](https://huggingface.co/Qwen/Qwen-Image-2512)
- [QwenCloud text-to-image documentation](https://docs.qwencloud.com/developer-guides/image-generation/text-to-image)
- [Vesper endpoint notes](../image-models/qwen-image-2512.md)

### Qwen Image Edit 2511

The official [Qwen Image Edit 2511 model card](https://huggingface.co/Qwen/Qwen-Image-Edit-2511) emphasizes improved consistency, reduced image drift, character consistency, and geometric reasoning. Current provider guides consistently recommend a clear instruction that says both what changes and what remains fixed, with the first image treated as the base and additional images assigned explicit purposes.

For Vesper, the positive compiler should be delta-first:

1. identify each numbered reference and its role;
2. state the one requested change;
3. state the authoritative replacement facts;
4. state the limited preserve set;
5. state any required canvas, crop, or geometry change;
6. avoid repeating broad “preserve everything” clauses that contradict the requested edit.

The current Replicate endpoint documented in Vesper exposes no negative prompt. This is an endpoint fact, not a claim that the underlying model can never use negative guidance. The negative system must still resolve semantic exclusions for the render, then transport them honestly as positive replacements or narrowly phrased edit constraints when appropriate.

Current sources:

- [Qwen Image Edit 2511 official model card](https://huggingface.co/Qwen/Qwen-Image-Edit-2511)
- [fal endpoint schema, showing how another 2511 host differs](https://fal.ai/models/fal-ai/qwen-image-edit-2511/api)
- [Vesper endpoint notes](../image-models/qwen-image-edit-2511.md)

### Seedream 4.5 and Seedream 5 Lite

ByteDance's [Seedream 4.5 page](https://seed.bytedance.com/en/seedream4_5) emphasizes multi-image subject identification, detail preservation, text rendering, and consistent editing. Its examples use complete natural-language composition instructions. [Seedream 5 Lite](https://seed.bytedance.com/seedream5_0_lite) goes further toward reasoning over complex instructions and references. That does not justify treating the versions as one prompt target; each should have its own pack and trial record.

Neither current Vesper Replicate endpoint exposes a negative field. The first implementation should therefore use:

- explicit positive descriptions of the desired replacement state;
- reference-role assignments;
- affirmative composition and camera language;
- narrowly tested inline exclusions only when a positive opposite cannot state the requirement;
- no copied SDXL negative boilerplate.

Seedream 4.5's current wrapper warns that prompts may be up to 4,000 characters but recommends fewer than roughly 600 English characters. That makes semantic fitting and per-model budgets especially important.

Current sources:

- [Seedream 4.5 official page](https://seed.bytedance.com/en/seedream4_5)
- [Seedream 5 Lite official page](https://seed.bytedance.com/seedream5_0_lite)
- [Seedream 5 Lite release article](https://seed.bytedance.com/en/blog/deeper-thinking-more-accurate-generation-introducing-seedream-5-0-lite)
- [Vesper Seedream 4.5 endpoint notes](../image-models/seedream-4-5.md)
- [Vesper Seedream 5 Lite endpoint notes](../image-models/seedream-5-lite.md)

### Stable Diffusion 3.5 Large

Stability's [current API reference](https://platform.stability.ai/docs/api-reference) exposes a `negative_prompt` described as keywords that should not appear, along with CFG and style controls. Its official examples favor natural-language prompts, and the model supports substantially more text context than older SDXL-style checkpoints. That makes a giant inherited SDXL tag wall unnecessary and potentially counterproductive.

Vesper should begin with compact natural-language positives and short, targeted negative keyword groups. The existing opt-in stylized profile's cleanup block is a reasonable trial arm, not a global default. Effective prompt length and whether prose or compact tags perform better must be measured against the exact Replicate version.

Current sources:

- [Stable Diffusion 3.5 Large model card](https://huggingface.co/stabilityai/stable-diffusion-3.5-large)
- [Stability API reference](https://platform.stability.ai/docs/api-reference)
- [Vesper endpoint notes](../image-models/stable-diffusion-3-5-large.md)

### Wan 2.7 Image Pro

Alibaba's [current image-generation documentation](https://docs.qwencloud.com/developer-guides/image-generation/text-to-image) explicitly says `wan2.7-image-pro` and `wan2.7-image` do not support `negative_prompt`. It recommends guiding generation in the positive prompt instead. The current Vesper Replicate schema agrees: there is no negative field.

This is another reason to model hosted endpoints rather than aggregate internet advice. Some third-party Wan wrappers expose a field called `negative_prompt`; that does not make it valid for Vesper's endpoint. Vesper should compile exclusions into desired visual replacements first, and use an inline “do not include …” clause only when the exact exclusion matters and a fixed trial shows that wording helps.

Current sources:

- [QwenCloud text-to-image documentation](https://docs.qwencloud.com/developer-guides/image-generation/text-to-image)
- [Vesper endpoint notes](../image-models/wan-2-7-image-pro.md)

### FLUX Dev

Black Forest Labs' official [Working Without Negative Prompts](https://docs.bfl.ai/guides/prompting_guide_t2i_negative) guide says FLUX models do not support negative prompts and often react poorly to negation because the excluded concept remains present in the text. Its recommended strategy is to describe the concrete visual opposite: “an empty plaza” rather than “no crowds,” for example. The current FLUX guide organizes positive prompts around subject, action, style, and context.

The Vesper `nsfw-flux-dev` wrapper is especially simple and exposes no negative input. The negative system should still produce semantic exclusions so behavior remains separately manageable, but the FLUX compiler should turn them into positive replacements and record that transport choice in provenance.

Current sources:

- [Black Forest Labs: Working Without Negative Prompts](https://docs.bfl.ai/guides/prompting_guide_t2i_negative)
- [Black Forest Labs prompting guide](https://docs.bfl.ai/guides/prompting_summary)
- [Vesper endpoint notes](../image-models/nsfw-flux-dev.md)

### LikeReality Pony v1

This endpoint is not merely “an SDXL model with a negative field.” Its wrapper uses Compel syntax, defaults `prepend_preprompt` to true, prepends Pony score tags and a matching negative preamble, and separately exposes face/hand/person ADetailer prompt pairs. Its provider default negative is `nsfw, naked`, which Vesper already clears because it can directly contradict authored wardrobe and exposure state.

Community Pony guides generally lead with score tags such as `score_9, score_8_up, score_7_up`, use compact tags, and caution that giant generic negatives are not automatically better. In Vesper, wrapper-injected text must be represented as a first-class hidden/default source in diagnostics. Otherwise an operator can edit the visible negative pack while an invisible provider preamble continues to change the result.

Current sources:

- [Pony Diffusion prompting guide](https://stable-diffusion-art.com/pony-diffusion-v6-xl/)
- [Vesper endpoint notes](../image-models/likereality-pony-v1.md)

### SDXL PuLID

The current community wrapper exposes a dedicated negative prompt, one PuLID identity reference, and a separate depth image that Vesper intentionally does not use. Its very low run count and lack of a Vesper trial mean prompt syntax remains a hypothesis. Compact SDXL-style tags are a sensible first arm because of the checkpoint lineage, but compact prose should be tested beside it.

Identity language must not compete with the reference adapter. The positive prompt should describe the target person and scene without trying to replace the face supplied by `reference_image`; the negative prompt should remain short and avoid banning intended morphology.

Current source:

- [Vesper endpoint notes](../image-models/sdxl-pulid.md)

### Pruna P-Image

The current endpoint is a fast text-to-image wrapper with no negative prompt and optional prompt upsampling. Its sparse model-page guidance does not justify a special syntax beyond concise, concrete natural language. Prompt upsampling should remain off for authoritative-state renders until an A/B proves that expansion does not invent clothing, people, objects, text, or environmental details.

Current source:

- [Vesper endpoint notes](../image-models/p-image.md)

## Reddit and community findings

Reddit is valuable here mainly because users post the failures that polished model cards omit. It is not a source of production defaults.

### Qwen edit geometry failure

A [Qwen image-edit discussion](https://www.reddit.com/r/StableDiffusion/comments/1mhikh2/qwen_image_is_even_better_than_flux_kontext_pro/) includes an edit where a standing subject becomes unnaturally short. A commenter offers a plausible explanation: the model was told to preserve the existing background and placement while changing the pose, but not told to expand the canvas or outpaint the newly required space, so it compressed the person to satisfy both instructions.

This is anecdotal, but it creates a strong Vesper test hypothesis: edit contracts that change pose, camera distance, body extent, or occupied geometry must say whether the canvas/crop may change. “Preserve everything except the pose” is not safe wording when the new pose physically requires more room.

### FLUX negatives and concept collisions

A [Reddit discussion about FLUX negative prompts](https://www.reddit.com/r/StableDiffusion/comments/1eqgrn3/why_flux_does_not_have_negative_prompt/) repeatedly reports that ordinary negation is unreliable and that positive scene/camera descriptions work better. It also contains a useful warning that placing a positive concept such as hands in both channels can make the model suppress or damage the concept rather than merely fix it.

The thread's technical explanations are community interpretations and should not be treated as authoritative architecture documentation. The operational conclusion is nevertheless independently supported by Black Forest Labs' current official guidance: use positive replacement rather than a conventional negative prompt.

### Community-source limitations

Search indexing for current Reddit threads is incomplete and inconsistent, especially for Seedream, small community wrappers, and specific pinned Replicate versions. The absence of a useful thread is not evidence that no thread exists. The research process should retain exact URLs for findings it uses and never promote a Reddit-derived rule without a reproducible Vesper trial.

## Cross-model conclusions

### Negative prompting is a semantic policy, not necessarily a provider field

Vesper needs a separately managed negative system even for endpoints with no `negative_prompt` input. The system's job is to express undesired outcomes as structured constraints. A model compiler may then transport a constraint as:

- a dedicated provider negative field;
- a short inline exclusion inside the positive instruction;
- an affirmative visual replacement;
- or an explicitly dropped, unexpressible constraint with a diagnostic.

This preserves independent management without lying about endpoint capabilities.

### Positive and negative text must be compiled together

Separately managed does not mean independently ignorant. Both channels must resolve from the same immutable world digest and be linted together. A negative compiler cannot safely ban `text`, `extra limbs`, `missing fingers`, `blur`, `multiple people`, `logos`, or `smooth skin` without knowing what the positive facts actually require.

### Model family is too broad a key

Prompt packs must be bound to endpoint/profile/version. Qwen Image 2512 and Qwen Image Edit 2511 need different positive strategies; two hosts of 2511 may expose different inputs; a Pony wrapper may inject preprompts that the checkpoint itself does not own; and third-party Wan wrappers may expose controls absent from Alibaba's and Vesper's endpoints.

### Long generic negative strings are not a safe baseline

The recurring reliable pattern is short and targeted:

1. render from a strong positive prompt;
2. identify the actual failure class;
3. add the smallest compatible constraint;
4. hold seed/profile constant and compare;
5. stop once the problem is resolved.

Vesper can automate this discipline with named blocks, applicability guards, collision checks, and fixed trials rather than one copied “bad anatomy” paragraph.

## Required research and evaluation gaps

The implementation plan should not claim these are settled before trials answer them:

- effective positive and negative prompt budgets for each pinned endpoint version;
- English versus Chinese negative wording for Qwen Image 2512;
- whether SD 3.5 Large performs better with compact prose or SDXL-like tags on Vesper scenes;
- whether any inline exclusion improves Seedream 4.5, Seedream 5 Lite, or Wan 2.7 over positive replacement alone;
- how LikeReality's visible negative pack interacts with its hidden Pony preprompt and optional ADetailer channels;
- whether PuLID benefits from SDXL tags, prose, or different identity phrasing;
- whether P-Image prompt upsampling preserves authoritative state;
- whether negative guidance measurably improves anatomy after intended morphology and authored absences are subtracted;
- whether a prompt pack remains stable across portrait, item, location, single-character scene, and ensemble tasks.

## Refresh protocol

Research is not “done” forever. Re-run the source review when any of the following occurs:

- the provider reports a new executed version;
- a schema probe adds, removes, renames, or changes a prompt-related input;
- the model creator publishes a new guide or model card revision;
- a Vesper trial reveals a repeatable failure not represented by existing blocks;
- a prompt pack has not been reviewed within the configured review interval.

A refresh records the old and new evidence revision. It does not silently mutate an active pack. Changed guidance creates a candidate pack version that must pass compilation tests and the fixed image trial before promotion.