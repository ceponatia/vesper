# OpenRouter adult-image smoke test

Status: closed — not viable 2026-08-04

## Decision

OpenRouter is not a viable image provider for Vesper's visible-adult-nudity
requirement. Its dedicated Images API is technically suitable — it has the
reference-image support the render path needs — but provider moderation rejects
the required output class outright, so no image comes back at all. This is a
provider-capability finding, not a model quality judgment: neither candidate
model was ever allowed to render. The provider evaluation that ran this test
settled on Replicate as the one image backend
([finished/image-model-registry.plan.md](../finished/image-model-registry.plan.md)).

## What we checked

Two candidate models on OpenRouter's Images API — `black-forest-labs/flux.2-pro`
and `x-ai/grok-imagine-image-quality` — each asked for the two prompts that
bracket the requirement: an explicit full nude, and a deliberately narrower
topless fine-art portrait probing where the moderation boundary sits. Every
request was rejected by provider moderation before any image was generated;
none returned image data or a usage record. FLUX.2 Pro was called with Black
Forest Labs' least restrictive documented setting (`safety_tolerance: 5`), so
the rejections are not a configuration artifact.

## Evidence appendix

Run 2026-08-04 against OpenRouter's dedicated Images API, using the valid
deployed OpenRouter credential (the repository's local credential returned
`401 User not found` and appears stale).

| Model                             | Explicit full nude                                         | Topless fine art         |
| --------------------------------- | ---------------------------------------------------------- | ------------------------ |
| `black-forest-labs/flux.2-pro`    | HTTP 400: `Request Moderated: Content Policy Violation`    | HTTP 400: same rejection |
| `x-ai/grok-imagine-image-quality` | HTTP 400: `Generated image rejected by content moderation` | HTTP 400: same rejection |

### Explicit prompt

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

### Topless boundary prompt

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
