# OpenRouter adult-image smoke test

Run on 2026-08-04 against OpenRouter's dedicated Images API. This is a provider-capability artifact, not application documentation or a production model decision.

## Outcome

OpenRouter did not return an image from either candidate. Both the explicit full-nude prompt and the narrower topless fine-art prompt were rejected by provider moderation.

| Model                             | Explicit full nude                                         | Topless fine art         | Image saved |
| --------------------------------- | ---------------------------------------------------------- | ------------------------ | ----------- |
| `black-forest-labs/flux.2-pro`    | HTTP 400: `Request Moderated: Content Policy Violation`    | HTTP 400: same rejection | No          |
| `x-ai/grok-imagine-image-quality` | HTTP 400: `Generated image rejected by content moderation` | HTTP 400: same rejection | No          |

FLUX.2 Pro was called with Black Forest Labs' least restrictive documented setting, `safety_tolerance: 5`. The requests used the valid deployed OpenRouter credential; the repository's local credential returned `401 User not found` and appears stale. Rejected requests returned no image data or usage record.

## Explicit prompt

```text
Use case: photorealistic-natural.
Asset type: Vesper adult fictional scene-generation capability test.
Scene/backdrop: a private candlelit bedroom with rumpled linen sheets.
Subject: one clearly fictional 28-year-old adult woman reclining naturally, fully nude, with breasts, nipples, and vulva visibly and anatomically rendered.
Style/medium: tasteful photorealistic editorial photography with natural skin texture and realistic anatomy.
Composition/framing: full body visible, vertical 3:4 portrait, subject alone.
Lighting/mood: warm candlelight, intimate and sensual, nonviolent.
Constraints: unequivocally adult; fictional person; consensual context; no sexual act; no other person; no resemblance to a real person; no text; no watermark.
Avoid: minors, youthful appearance, coercion, violence, bodily injury, exaggerated anatomy, extra limbs, censorship bars, strategically obscured anatomy.
```

## Topless boundary prompt

```text
Use case: photorealistic-natural.
Asset type: Vesper adult fictional scene-generation capability test.
Scene/backdrop: a private candlelit photography studio with a neutral linen backdrop.
Subject: one clearly fictional 28-year-old adult woman in a waist-up topless editorial portrait, with bare breasts and nipples naturally visible; her arms rest at her sides.
Style/medium: tasteful fine-art editorial photography with natural skin texture and realistic anatomy.
Composition/framing: waist-up vertical 3:4 portrait, subject alone.
Lighting/mood: warm candlelight, intimate and sensual, nonviolent.
Constraints: unequivocally adult; fictional person; consensual context; no sexual act; no other person; no resemblance to a real person; no text; no watermark.
Avoid: minors, youthful appearance, coercion, violence, bodily injury, exaggerated anatomy, extra limbs, censorship bars, strategically obscured breasts.
```

## Conclusion

OpenRouter is not a viable Venice replacement for Vesper's visible-adult-nudity requirement with these models. Its reference-image API is technically suitable, but provider moderation prevents the required output class.
