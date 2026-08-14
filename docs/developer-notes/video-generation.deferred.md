# Video generation — reference-driven clips and keyframe stitching

Status: parked detail for [deferred.plan.md](deferred.plan.md) §"Video
generation — reference-driven clips and keyframe stitching" — not committed
work. Research run 2026-08-14; every price, catalog entry, and policy below is
dated then, and this market shifts monthly — re-verify before building.

## The idea

Generate short video clips the way Vesper already generates images: a portrait
or scene render as the visual reference, plus a prompt — free text in an admin
**video lab** first (the [Advanced Image Lab](../images/advanced-image-lab.md)
pattern), chat-context-driven later. Clips are ~10 seconds to start. Longer
sequences come later by chaining clips through keyframes — the end of one clip
is the start of the next — concatenated into one video.

Owner direction (2026-08-14): a future capability, deliberately not next on the
roadmap. This doc parks the feasibility research so promotion starts from facts
instead of a cold search.

## What the research settled

1. **Feasible today, API-only, no new infrastructure class.** Reference-image
   →video with ~10 s output is a commodity API capability in 2026. The async
   job + webhook + download-immediately shape the image pipeline already runs
   is exactly the shape video needs; generation latency is minutes instead of
   seconds and files are megabytes instead of kilobytes, and nothing else
   changes category.
2. **The image registry's moderation split is the video story too.** Open
   weights hosted on a provider's own GPUs (Wan 2.2 family, HunyuanVideo-1.5,
   LTX-2.5) can run with the safety checker off; vendor-API relays (Wan 2.5+,
   Kling, Seedance, Veo, hosted MiniMax H3) moderate upstream where no flag
   reaches — the same taxonomy
   [../image-models/README.md](../image-models/README.md) §"Moderation, by
   hosting model" already records, and Wan's video relays share the upstream
   that refuses ordinary Vesper character references on the image side
   ([../image-models/wan-2-7-image-pro.md](../image-models/wan-2-7-image-pro.md)).
   An adults-only product's backbone is therefore the **open-weights lane**;
   hosted flagships are the **SFW quality tier**.
3. **"H3" is MiniMax H3 (Hailuo 3.0)** — launched 2026-07-31, base weights
   open since ~2026-08-03, and on Replicate's official catalog as `minimax/h3`
   since ~2026-08-13. Its first+last-frame mode and 9-reference-image mode fit
   this pipeline unusually well; its license and hosted moderation keep it out
   of the explicit lane.
4. **Replicate is the recommended first provider.** Deep, current catalog (the
   whole Wan line, H3, Kling, Seedance, Veo, LTX, Sora 2, plus the `nsfw-api`
   publisher's Hunyuan tooling), the same predictions/webhook API the app
   already speaks, the most adult-content-permissive terms of the hosts
   examined, LoRA URL inputs on the open Wan endpoints, and video LoRA
   trainers on-platform.
5. **Hugging Face: plain HTTP API, a Space is never required.** Serverless
   "Inference Providers" routes text-to-video and image-to-video to fal and
   WaveSpeed at pass-through prices; dedicated Inference Endpoints host
   arbitrary checkpoints in a custom container. Neither adds capability Vesper
   cannot get more directly from the underlying provider — an option, not a
   dependency.
6. **Keyframe stitching is a proven pattern with one right architecture:**
   generate the keyframes with the *image* pipeline — identity-pack-anchored
   stills — then have the video model interpolate first→last between
   consecutive keyframes. Identity drift cannot compound across segments
   because every joint is pinned to an image-grounded anchor, and Vesper's
   [identity packs](../images/identity-packs.md) are precisely the anchor
   source. Naive last-frame→i2v chaining drifts; provider "extend" endpoints
   exist but live mostly on moderated closed models.

## Model landscape (as of 2026-08-14)

**Open weights end at Wan 2.2.** Alibaba's 2.5/2.6/2.7 are API-only relays,
and the "Wan 3.0 open weights" stories circulating are fabricated — Wan 3.0
exists only as an application-gated API beta (opened 2026-08-06, ~30 s clips).
Tencent's HunyuanVideo-1.5 and Lightricks' LTX-2.5 are the other serious open
lines. Every closed flagship API moderates sexual content server-side.

Open-weights lane (self-host or permissive hosting; the explicit-capable one):

| Model               | Native length    | Keyframe / identity inputs              |
| ------------------- | ---------------- | --------------------------------------- |
| Wan 2.2 (A14B / 5B) | ~5–7.5 s @16 fps | i2v + `last_image`; LoRA URL pair       |
| HunyuanVideo-1.5    | 5 / 8 / 10 s     | i2v; LoRA-trainable; HunyuanCustom refs |
| LTX-2.5 / 2.3       | ~10 s (2–20 s)   | i2v; multi-keyframe; native audio       |
| MiniMax H3 (base)   | 4–15 s           | first+last frame; 9-image reference set |

Hosted-API lane (upstream-moderated; the SFW quality tier):

| Model            | Length  | Notable                                       |
| ---------------- | ------- | --------------------------------------------- |
| Wan 2.5/2.6/2.7  | 5–15 s  | FLF + clip continuation (2.7); R2V (2.6/2.7)  |
| Kling 3.0        | 3–15 s  | Elements refs; start+tail image; NSFW-blocked |
| Seedance 2.5     | to 30 s | ~50 multimodal refs; multi-turn extend        |
| Veo 3.1          | 4/6/8 s | 3 refs; FLF; Extend (input ≤141 s); priciest  |
| MiniMax H3 (API) | 4–15 s  | 2K pass, native audio, voice transfer         |

### Open-weights lane detail

- **Wan 2.2** (Apache 2.0 — the cleanest license here) is the workhorse: MoE
  A14B i2v/t2v, a 5B tier, speech-to-video, Animate (character ref + pose/face
  driving videos — the model
  [spatial-scene-images.plan.md](spatial-scene-images.plan.md) §Animation
  extension already names), and by far the largest uncensored
  LoRA/merge/workflow ecosystem (Civitai). On Replicate as `wan-video/*` with
  per-video pricing: `wan-2.2-i2v-fast` is **$0.05–$0.145 per clip** (480p to
  720p+interpolation), takes `image` + optional `last_image` (end-frame
  conditioning), **two LoRA URL inputs** (separate high/low-noise
  transformers), `disable_safety_checker`, and 81–121 frames @16 fps — ~33 s
  generation. `lucataco/wan-2.2-first-last-frame` is a dedicated FLF endpoint
  (start+end image, 0.5–10 s, ~$0.07/run). Native clips are ~5 s; ten seconds
  needs one continuation/FLF hop.
- **HunyuanVideo-1.5** (Tencent, open since 2025-11): 8.3B, i2v, **native
  5/8/10 s**, 480/720p with built-in super-resolution to 1080p, no audio, runs
  in ~14 GB VRAM, full training code released. Not on Replicate as 1.5 (only
  the original `tencent/hunyuan-video` t2v, time-billed); hosted on fal
  (`fal-ai/hunyuan-video-v1.5`) and WaveSpeed. Large uncensored finetune
  scene. The Replicate `nsfw-api` org's video tooling is Hunyuan-based — see
  the Replicate section.
- **LTX-2.5** (Lightricks, open weights; community license — free commercial
  use under $10M annual revenue): 22B, synchronized audio+video, multishot
  mode, multi-keyframe conditioning, extremely fast (vendor claim: a 10 s clip
  in ~7 s on top-end hardware). `lightricks/ltx-2.5-fast` on Replicate:
  **$0.03/s at 720p, 2–20 s clips**. Weakest NSFW ecosystem of the open trio;
  the older open LTXV 0.9.8 line did native 60 s with forward/backward
  extension.
- **MiniMax H3 base** is open-weight in name but poor self-host material: 33B
  needing multi-GPU, the instruction refiner and 2K upscaler are API-only
  (native output is 768p short-edge), and the "MiniMax H3 Community License"
  **excludes the USA, EU, UK, and South Korea from local deployment by
  default** (application form required), caps commercial use above $20M
  revenue, and carries anti-pornography guardrail clauses. Treat H3 as
  hosted-only in practice.

### Hosted-API lane detail

- **Wan 2.5/2.6/2.7** (`wan-video/*` on Replicate, relayed to Alibaba):
  2.5 does 5/10 s with background audio ($0.05–$0.15/s by resolution); 2.6
  adds 15 s, multi-shot, and reference-to-video, with a `wan2.6-i2v-flash` at
  **$0.05/s 720p**; 2.7 does **any integer 2–15 s**, first+last frame
  (`first_frame`/`last_frame`), **clip continuation** (`first_clip`: extend an
  existing 2–10 s video), reference-to-video (`wan-2.7-r2v`), and
  natural-language video editing (`wan-2.7-videoedit`), $0.10–$0.15/s. All
  inherit Alibaba's upstream moderation — the same one that refuses ordinary
  character references on the image side.
- **Kling 3.0** (`kwaivgi/kling-v3-video`/`-omni-video`): 3–15 s, start+end
  image on the same endpoint, Elements multi-reference (up to 4 images; Omni
  takes a reference video), $0.168–$0.336/s by tier/audio, 4K option. Older
  `kling-v2.5-turbo-pro` is a cheap SFW FLF workhorse at **$0.07/s** (5/10 s,
  start+end image). NSFW is hard-blocked at every tier including the API,
  prompt-stage.
- **Seedance 2.5** (ByteDance): native 30 s single-run, multi-turn extension,
  ~50 multimodal reference inputs on the 2.0 line (9 images + 3 videos + 3
  audios on Replicate's `seedance-2.0`), $0.02–$0.45/s across tiers. Under
  active copyright fire (Disney C&D, Senate letter) — expect moderation to
  tighten, not loosen.
- **Veo 3.1** (Google): 4/6/8 s, up to 4K, audio always on, up to 3 reference
  images, first+last-frame interpolation, and the strongest native **Extend**
  (continue from a clip's final second; input up to 141 s). $0.05/s (Lite
  720p) to $0.60/s (4K). Strictest content policy of the set.
- **MiniMax H3 hosted**: on Replicate (`minimax/h3`, **$0.08/s 768p, $0.13/s
  2K**, full schema: `first_frame_image`, `last_frame_image`,
  `reference_image_urls`, `reference_video_urls`, `reference_audio_urls`,
  duration 4–15); on fal with extra 480p/$0.05 and 4K/$0.16 tiers; on
  OpenRouter 2K-only. Native 32 kHz stereo audio, voice transfer from audio
  refs, 24 fps. Moderated upstream.

## Provider paths

### Replicate — recommended first path

Everything transfers. Video models run through the **same predictions API and
webhook flow as images** — `POST /v1/models/{owner}/{name}/predictions`, then
webhook or poll; the `Prefer: wait` sync mode caps at 60 s and every serious
video model exceeds that (15 s–4 min typical), so the async path is simply
mandatory. `Cancel-After` gives a hard deadline for stuck jobs. **API
prediction outputs are auto-deleted after one hour**, so download-immediately
— already the image pipeline's lifecycle — is not optional. Clips run
**1–10 MB** at 5–10 s / 720–1080p. Input uploads cap at 100 MB via the files
API; data-URI inputs are advised only under 1 MB.

The schema inconsistency that motivated the image model registry is fully
present in video — the start image is `image`, `first_frame_image`,
`start_image`, or `first_frame` depending on the model; the end frame is
`last_image`, `last_frame`, `end_image`, or `last_frame_image` — so the
probe-and-store registry pattern ([../images/providers.md](../images/providers.md))
transfers directly.

LoRA support is real but thinner than Flux's: the open Wan 2.2 fast endpoints
take arbitrary `.safetensors` URLs (a high/low-noise pair);
`wavespeedai/wan-2.1-*` accept HuggingFace/CivitAI/direct URLs; and Replicate
hosts video LoRA **trainers** — `ostris/wan-lora-trainer` (trains Wan 2.1 14B
**from images**, autocaption included) and the Hunyuan trainers below. No Wan
2.2 trainer on Replicate yet (fal and WaveSpeed have them). Closed-API relays
take no LoRA at all.

**The `nsfw-api` publisher** (replicate.com/nsfw-api, 9 public models, all
runnable via the ordinary predictions API, GPU-time billed): its video side is
Hunyuan-based — `hunyuan-custom` (identity-preserving video from a reference
image, with an on-platform **Train** tab), `hunyuan-character-lora-trainer`
(HunyuanVideo LoRA from a video dataset ZIP), and `oldcore` (HunyuanVideo
runner taking two LoRA URLs). Its image side already overlaps Vesper's
registry (`sdxl-pulid`, `pony-realism-v2.3`, `realvis-hyper-lora`). Video run
counts are tiny (tens); treat these as leads to trial, not proven capacity. No
Wan models under this org on Replicate.

Terms (effective 2026-04-01): no blanket adult-content ban — the ToS
explicitly acknowledges the services can generate pornographic/fetish content
and disclaims monitoring of third-party model outputs; prohibited are
non-consensual nudity, illegal pornographic content, child exploitation,
real-person impersonation, extreme gore. Individual marketplace models can
carry stricter provider-specific terms. Open-weight models expose
`disable_safety_checker` per Replicate's own safety-checking doc.

### fal.ai — the broadest catalog, one policy question

fal has the widest video catalog (all the models above, day-0 H3 partner,
plus hosted **Wan 2.2 LoRA trainers**), clean queue mechanics
(`queue.fal.run` submit + `fal_webhook` callback signed with
`X-Fal-Webhook-Signature`), and open-Wan pricing of $0.04–$0.08/s by
resolution. It would be the natural second transport if Replicate's Wan/LoRA
coverage falls short.

The policy picture is genuinely ambiguous for the explicit lane: the AUP bans
"indecent" content in an illegal-acts enumeration, while the Trust & Safety
page describes a formal "NSFW content policy" that "balances platform
openness" with bans on the illegal categories — and platform-wide OpenAI Omni
moderation is integrated. Whether an explicit Wan LoRA request actually
completes on fal is untested. Closed models on fal inherit upstream vendor
moderation regardless of fal-side settings. Treat fal as pipeline/SFW-capable,
and get a direct policy answer before routing the explicit lane there.

### Hugging Face — plain API, no Space required

The direct answer: **HF video models are callable via plain HTTP/SDK; Spaces
are demo surfaces and never required.** Two distinct products:

- **Inference Providers** (serverless router, `router.huggingface.co` /
  `InferenceClient`): text-to-video is a documented task;
  image-to-video is live via `InferenceClient.image_to_video()`
  (huggingface_hub ≥0.34.4) even though its docs task page lags. The reference
  image is passed as an https URL or auto-encoded data URI. Under the hood the
  live video providers are **fal and WaveSpeed** (Replicate serves only fast
  t2v via a 60 s sync call; Novita and Together have zero live video mappings
  today), using each provider's own async queue. Billing is **pass-through at
  provider list price with no HF markup**; PRO's $2/month of included credits
  is noise against video costs. Notably, community Wan 2.2 LoRA repos —
  including explicitly fetish ones — have live routed mappings; HF does not
  filter the catalog, the serving provider's moderation decides.
- **Dedicated Inference Endpoints**: deploy any Hub checkpoint — including an
  uncensored Wan finetune — in a custom Docker container on rented GPUs (A100
  $2.50/hr, H100 $10/hr, smaller cards down to $0.50/hr), with scale-to-zero
  after 15 min idle (cold requests get 502 until a replica warms; no
  server-side queue). Economics only work with distilled/accelerated variants:
  undistilled Wan 2.2 A14B is ~10–12 min per 5 s 720p clip on one H100
  (≈$1.70–$2.00/clip) vs $0.40 on fal; lightx2v distill LoRAs close most of
  that gap.

Verdict for Vesper: the serverless router is a thin layer over the same two
providers Vesper would otherwise integrate directly, and the dedicated
endpoints are a managed self-host. Useful options; neither is a reason to
route through HF when a first-party Replicate/fal integration is simpler to
reason about.

### OpenRouter — a real video API with real gaps

OpenRouter shipped a dedicated async video API (~2026-04): `POST
/api/v1/videos` → poll or HMAC-signed webhooks, 23-model catalog (Seedance,
Veo, Kling, Wan 2.6/2.7, H3, Sora 2 Pro, Grok — no Hunyuan). For H3
specifically it is measurably thinner than Replicate/fal: **2K-only** at
$0.13/s (no 768p tier — cheapest clip $0.65 vs $0.25–$0.40 elsewhere), 5 s
minimum (model does 4), `input_references` accepts **images only** (dropping
H3's reference-video/audio legs and voice transfer), `seed: false`, provider
passthrough limited to a watermark toggle, no video-editing/regeneration
mode, single upstream with no failover, not ZDR-eligible. Fine as a
convenience aggregator; the wrong tool for a reference-heavy controlled
pipeline.

### Self-hosting — the escape hatch

RunPod/Lambda-class GPU rental ($0.50–$2/hr) or HF dedicated endpoints running
Wan 2.2 / HunyuanVideo-1.5 / LTX-2.5 with ComfyUI workflows: full control, no
filter, LoRA freedom — at the cost of operating GPU infrastructure, which the
image side deliberately avoided. Third-party "uncensored video API" hosts
exist (e.g. Atlas Cloud's catalog advertising Wan 2.2 variants at ~$0.01/s);
unvetted — leads, not answers. Not the first move; the Replicate open-Wan lane
covers the same ground without new operations.

## Ten-second clips today

Native 10 s+ in one call: Wan 2.5 (5/10), Wan 2.6 (5/10/15), Wan 2.7 (2–15),
H3 (4–15), Kling v3 (3–15), Seedance (2–12, 2.5 to 30), LTX-2.3/2.5-fast
(2–20), Pixverse v6 (5–15), Hailuo 02 (6/10), Sora 2 (4/8/12), Vidu Q3 (≤16).
In the open-weights lane: HunyuanVideo-1.5 does native 10 s, LTX-2.5 ~10 s,
and Wan 2.2 tops out ~5–7.5 s — a 10 s Wan 2.2 clip is one FLF/continuation
hop. Latency norms: accelerated open models ~15–60 s per clip; closed
flagships 1–4 min.

## Keyframe stitching for longer videos

Three chaining patterns are in production use:

- **(a) Last-frame → i2v continuation.** Extract the final frame (`ffmpeg
  -sseof -0.5 -i clip.mp4 -update 1 -q:v 1 last.png`), feed it as the next
  clip's start image. Simplest, and drift compounds — each segment's only
  grounding is the previous AI output, so color, exposure, and identity walk
  segment by segment.
- **(b) First+last-frame interpolation between pre-made stills — the
  identity-safe pattern and the recommended architecture.** Generate all N+1
  keyframes with the image pipeline first (same identity pack, outfit, set,
  lighting), then segment_i = FLF(keyframe_i, keyframe_i+1, motion prompt).
  Every segment is pinned to image-grounded anchors at both ends, so drift
  cannot compound across joints — and producing consistent stills is exactly
  what the identity-pack pipeline already does. Native FLF support: Wan 2.2
  (open; plus the dedicated Replicate FLF endpoint), Wan 2.7, Kling
  (start+tail), Veo 3.1, H3, LTX multi-keyframe, Luma Ray 3.2 (up to 16
  keyframes in a single call).
- **(c) Provider-native extend.** Wan 2.7 `first_clip` continuation, Veo 3.1
  Extend, Seedance 2.5 multi-turn, H3 Extend (~30 s), LTX-2.3's `extend`
  task, Grok's video input. Convenient, but concentrated on moderated closed
  models.

Known failure modes and standard mitigations: cumulative color/exposure
drift and identity melt (mitigate with pattern b, short 5–10 s segments, and
anchors generated from the same reference); motion discontinuity at joins
(the open-lane state of the art is the SVI2Pro-FLF ComfyUI workflow, which
carries the last temporal latent slots across segments so motion is
continuous, not just pixel-matched — SFW and NSFW finetunes exist); visible
seams (drop the duplicated boundary frame via concat `inpoint`, else a ~0.2 s
`xfade`, per-segment color match, one global upscale/refine pass to
homogenize grain).

Concatenation mechanics: with every segment from the same endpoint and
settings, streams are identical and the ffmpeg **concat demuxer** joins
losslessly (`ffmpeg -f concat -safe 0 -i list.txt -c copy out.mp4`); anything
mismatched needs the concat filter or `xfade` re-encode. Generate audio as
one track over the finished cut — per-segment native audio does not stitch
coherently.

## Integration sketch (monorepo)

Nothing here is a design commitment; it is where the pieces would naturally
land, to size the work.

- **Transport.** `@vesper/image-replicate`'s mechanics — predictions,
  uploads, output download, schema probing — are exactly what video needs;
  its result contract is image-shaped, so whether video shares the package or
  gets a sibling transport is a promotion-time design call. The
  detached-job/webhook machinery and one-hour-retention discipline carry over
  unchanged.
- **Capability/profile layer.** Video wants its own vocabulary — duration,
  fps, resolution tier, start/end frame, reference set, audio toggle, LoRA —
  and the same probe-and-registry treatment as image models, given identical
  provider schema chaos. Whether that is a sibling domain beside
  `@vesper/image-core` or a generalization of it is an open question for
  promotion; the layer-rank rules in the root CLAUDE.md apply either way.
- **Assets.** Video files are `data/`-stored assets like images
  (row-before-file, serving gate, sweep — [../images/asset-registry.md](../images/asset-registry.md)),
  at 1–10 MB per clip instead of ~100 KB — storage quotas and Fly volume
  sizing need an explicit look.
- **Prompts and references.** The i2v reference is a render the image
  pipeline already produces (canonical portrait, pack-anchored still, scene
  image). The video prompt describes **motion, camera, and acting beats
  only** — identity rides the reference image — so the prompt builder is
  smaller than the image ones. Lab surface first (free-text, fixtures,
  verdicts, like the image lab); a chat-scene-queue analog later.
- **Costs.** Clips are 10–100× a still; the identity-pack per-user quota
  precedent applies from day one.
- **LoRA synergy.** `ostris/wan-lora-trainer` trains video LoRAs **from
  images** — the parked character-LoRA training tool's dataset-assembly work
  (deferred.plan.md §"Character-LoRA training as an in-app tool") would serve
  both image and video identity if both are built.

## Costs at a glance (2026-08-14)

- Cheapest real i2v clip: `wan-video/wan-2.2-i2v-fast` at **$0.05–$0.145 per
  ~5–7 s clip**; the 5B tier is $0.0125–$0.025.
- A 10 s 720p clip: LTX-2.5-fast ~$0.30; H3 768p ~$0.80; Wan 2.2 via fal
  ~$0.80; Kling 2.5-turbo ~$0.70; Kling 3.0 standard ~$0.84 silent; Veo 3.1
  Fast (8 s max) ~$0.80–$1.20.
- A 60 s stitched sequence (6×10 s FLF segments): ~$1–2 on the open-Wan/LTX
  lane, ~$4–5 on Kling, ~$24 on Veo 3.1.
- A Stage-0-style probe across three endpoints with pack-anchored references
  is tens of dollars, not hundreds.

## Policy and licensing cautions

Universal across every ToS examined: no CSAM, no non-consensual imagery, no
real-person likeness without consent — fictional-character adult content is
inside the written terms everywhere it is not explicitly banned. The split
that matters is tolerance for legal adult content:

- **Replicate**: permissive by ToS text (acknowledges pornographic/fetish
  output capability; does not monitor third-party model outputs); per-model
  provider terms can be stricter.
- **fal**: moderated-permissive with ambiguous AUP wording; platform-wide
  automated moderation; needs a direct policy conversation before carrying
  the explicit lane.
- **Novita** (AUP effective 2026-08-05) and **Together**: prohibit sexually
  explicit content outright in current policy text.
- **Licenses**: Wan 2.2 is Apache 2.0 (cleanest); LTX-2 community license is
  free under $10M revenue; HunyuanVideo-1.5 is a Tencent community-style
  license (verify exact terms at promotion); MiniMax H3's community license
  excludes US/EU/UK/KR self-hosting by default and carries anti-pornography
  clauses.

## Why it is parked

Owner direction (2026-08-14): a for-the-future capability, not next work —
the roadmap's committed image and engine work comes first. The market also
argues for waiting: H3 is two weeks old, Wan 3.0's API beta is days old, and
LTX iterates monthly, so any model choice made now would be re-litigated at
build time anyway. No player-facing surface is designed.

## What promotion would require

1. **A lane ruling**: SFW-first on hosted flagships, explicit-first on the
   open-Wan/Hunyuan lane via Replicate, or both from the start. This decides
   the model set and whether fal needs a policy conversation.
2. **A paid Stage-0-style probe** (the image lab's Stage 0 is the model):
   pack-anchored references through 2–3 endpoints — `wan-video/wan-2.2-i2v-fast`
   (+ LoRA pair), `minimax/h3` (FLF + reference set), and one of
   `lucataco/wan-2.2-first-last-frame` / `nsfw-api/hunyuan-custom` — scored
   for identity survival, motion quality, and moderation behavior.
3. **Design calls**: video asset registry (extend `images` vs sibling),
   package boundary (sibling video domain vs generalizing
   `@vesper/image-core`), storage/quota rules.
4. Then a real `video-lab.plan.md` (or similar) with a roadmap line; this doc
   feeds it and retires.

## Key sources

- Replicate: replicate.com/wan-video · replicate.com/minimax/h3 ·
  replicate.com/nsfw-api · replicate.com/terms ·
  replicate.com/docs/topics/predictions/data-retention
- fal: fal.ai/models/fal-ai/wan/v2.2-a14b/image-to-video ·
  fal.ai/models/minimax/h3/reference-to-video ·
  fal.ai/legal/acceptable-use-policy · fal.ai/legal/trust-and-safety ·
  docs.fal.ai/model-apis/model-endpoints/webhooks
- Hugging Face: huggingface.co/docs/inference-providers ·
  huggingface.co/docs/inference-endpoints/en/pricing ·
  huggingface.co/MiniMaxAI/MiniMax-H3 · huggingface.co/Wan-AI ·
  huggingface.co/Lightricks/LTX-2.5
- OpenRouter: openrouter.ai/docs/guides/overview/multimodal/video-generation ·
  openrouter.ai/minimax/hailuo-3 · openrouter.ai/api/v1/videos/models
- Models: github.com/Wan-Video/Wan2.2 ·
  github.com/Tencent-Hunyuan/HunyuanVideo-1.5 ·
  github.com/Lightricks/LTX-Video · ai.google.dev/gemini-api/docs/veo ·
  alibabacloud.com/help/en/model-studio/image-to-video-general-api-reference
- Stitching: github.com/thinkWHY2046/comfyui-wan-svi2pro-flf ·
  github.com/SkyworkAI/SkyReels-V2 · ffmpeg.org/ffmpeg-formats.html (concat)
