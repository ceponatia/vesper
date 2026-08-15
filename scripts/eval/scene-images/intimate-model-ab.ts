import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { emptyImageModelAdvancedCapabilities, type ImageModel, withReviewedImageQuality } from "@vesper/image-core";
import type { ReplicateImageResult } from "@vesper/image-replicate";
import type { ViewerBodyPartId } from "@/contracts/images/viewer-body";
import { replicateClient } from "@/server/ai";
import { buildSceneRenderPrompt, resolveScenePlan, type SceneRenderPlan } from "@/server/images";
import { evalEdit, evalEditModel, hasImageProvider } from "./model";
import { type Beat, BEATS } from "./orientation-ab";

/**
 * Intimate MODEL A/B (scene-composition follow-on, PAID and owner-run, NOT a test gate).
 *
 * The staging work landed and the geometry renders: `orientation-ab.ts` on
 * `qwen/qwen-image-edit-2511` puts her on all fours, on her knees, on her back, with the
 * camera where the sentence says. What it cannot do is draw what the act consists of — the
 * viewer's genitals are omitted outright or come back as an uncanny smooth shape (owner
 * report, 2026-08-14). That is a MODEL limit, not a prompt limit, and no further wording
 * fixes it. So the next question is which model can, and this probe asks it.
 *
 * Same four intimate beats as `orientation-ab.ts` — imported from it, never restated, so a
 * grading here is comparable with a grading there — rendered across up to four arms:
 *
 * - `qwen` — THE BASELINE, and the reason the run is same-session. Byte-identical to
 *   orientation-ab's `new` arm: the staged EDIT prompt, the anchor as the reference, on the
 *   eval edit model. Answers nothing on its own; it is what every other arm is graded
 *   against, on the same day, with the same eyes.
 * - `pulid` — can an ADULT-TRAINED IDENTITY ADAPTER draw the acts? `nsfw-api/sdxl-pulid` is
 *   the registry's one identity-preserving adult model (migration 0104). It takes identity
 *   from a face embedding rather than from an edit, so it gets the TEXT route:
 *   `buildSceneRenderPrompt` with no `referenceName`, because the identity-lock sentence
 *   ("preserve the exact face … from the reference") would be a claim about an edit that is
 *   not happening. The anchor still rides as its single reference image.
 * - `pulid_compact` — the same question MINUS CLIP TRUNCATION. SDXL's text encoder truncates
 *   around 77 tokens and the pipeline prompt is ~1300 characters, so a bad `pulid` result on
 *   its own is uninterpretable: model, or truncation? This arm sends a hand-written ~60-token
 *   SDXL-dialect prompt derived from the same staging entry, so the two answers separate.
 * - `lora` — does an ANATOMY LoRA RESCUE THE QWEN EDIT PATH? Optional; runs only when
 *   `EVAL_LORA_WEIGHTS` names one. `qwen/qwen-image-edit-plus-lora` at its probed pin, with
 *   the `qwen` arm's prompt and reference UNCHANGED, so the only variable is the LoRA. (It is
 *   a generation behind 2511 and carries no reviewed quality overlay — compare it with `qwen`
 *   knowing that, per docs/image-models/qwen-image-edit-plus-lora.md.)
 *
 * TWO THINGS THE OWNER IS GRADING, not one:
 *
 * 1. **The act** — the pass/fail elements below, the same ones orientation-ab grades. Each
 *    beat fails on ANY missing element, any extra person, or an unbound limb readable as a
 *    third party. They print above the prompts at run time from the beat's own list.
 *    - `doggy` — on all fours, back to camera, face not toward the lens; the viewer's own
 *      hands on her waist or hips, on arms entering from the lower corners; nobody but her
 *      and the viewer's own hands and forearms in frame.
 *    - `oral` — her face visible, looking up mid-act; the act legible AS the act rather than
 *      a nude portrait of someone kneeling; nobody but her and the viewer's own body.
 *    - `oral_guided` — the top of her head under the viewer's own hand; same two riders.
 *      **Either oral composition passes the owner's "Oral" scene**; both run so both are seen.
 *    - `missionary` — she is on her back facing up at the camera; the viewer's own genitals
 *      enter frame at the bottom edge with penetration visible; the viewer's own hands hold
 *      her legs or her waist (either passes); nobody else in frame.
 * 2. **Likeness** — is the woman in the picture the woman in the anchor? sdxl-pulid's own
 *    registry row says likeness is UNMEASURED in Vesper ("PuLID identity adapter with 283
 *    lifetime Replicate runs and no Vesper trial"; both reviewed ratings are `unknown`), so
 *    this run is the first look at it. A pulid arm that draws the act perfectly on a stranger
 *    has not solved the problem. sdxl-pulid is SINGLE-REFERENCE, so identity rides exactly
 *    one portrait — there is no multi-reference rung to fall back to.
 *
 * Outputs land in the untracked screenshots/ folder, one directory per beat, for eyeball
 * review: `screenshots/intimate-model-ab/<beat>/<arm>-<n>.webp`.
 *
 * Run: `pnpm tsx scripts/eval/scene-images/intimate-model-ab.ts [anchor.webp]`
 * - `AB_BEAT` — `all` (default) | doggy | oral | oral_guided | missionary
 * - `AB_RUNS` — renders per arm per beat (default 2)
 * - `EVAL_LORA_WEIGHTS` — a HuggingFace repo slug or a direct .safetensors URL. Unset, a
 *   `CIVITAI_API_TOKEN` in the env builds the tokened Civitai URL for the curated
 *   all-inclusive LoRA instead (`EVAL_LORA_CIVITAI_VERSION` overrides its version id,
 *   default 3160956 = v2.0). With neither, the `lora` arm is skipped and says so.
 * - `EVAL_LORA_SCALE` — 0–4, default 1
 * - `EVAL_OUT` — output directory, default `screenshots/intimate-model-ab`. A run that varies
 *   a lever (a different LoRA scale, say) writes to its own directory, so two gradings never
 *   overwrite each other and the comparison survives the second run.
 *
 * Prompts are printed and every honesty check runs BEFORE anything is sent, so the wording
 * and the arm matrix can be reviewed for free; only the renders cost money.
 */
const OUT = process.env.EVAL_OUT ?? "screenshots/intimate-model-ab";
/** Reference portrait: argv override for ad-hoc anchors; the eval portrait (untracked, regenerable) by default. */
const ANCHOR = process.argv[2] ?? "docs/scene-image-eval/portraits/Mira.webp";
const RUNS_PER_ARM = Number(process.env.AB_RUNS ?? 2);
const BEAT = process.env.AB_BEAT ?? "all";
/**
 * `AB_ARMS` — comma-separated arm ids to RENDER (default: every built arm). Scopes the
 * spend, never the checks: every arm is still built and every honesty check still runs on
 * the full set, so a scoped run cannot silently skip the drift guard between `qwen` and
 * `lora`. Unknown ids throw before anything is paid for.
 */
const ARM_FILTER = (process.env.AB_ARMS ?? "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);
/**
 * The Civitai fallback source (owner setup 2026-08-15): "Qwen Image Edit 2511 NSFW all
 * inclusive" v2.0 — the only LoRA found whose training data explicitly covers the
 * mouth-level acts the 2026-08-15 run showed no other arm can draw. Civitai gates NSFW
 * downloads behind login, so the download endpoint takes the owner's API key as a query
 * parameter and 302s to a signed CDN URL.
 *
 * Precedence: an explicit `EVAL_LORA_WEIGHTS` always wins (any HF slug or URL); otherwise a
 * `CIVITAI_API_TOKEN` in the environment builds this URL. THE TOKEN IS A CREDENTIAL — it
 * must never be printed, and every log line below that names the weights uses
 * {@link describeLoraWeights}, which strips the query string exactly like the LoRA
 * library's `redactImageLoraLocator` does.
 */
const CIVITAI_LORA_VERSION = process.env.EVAL_LORA_CIVITAI_VERSION?.trim() || "3160956";
const CIVITAI_TOKEN = process.env.CIVITAI_API_TOKEN?.trim() ?? "";

function civitaiLoraUrl(): string {
  if (!CIVITAI_TOKEN) return "";
  const url = new URL(`https://civitai.com/api/download/models/${CIVITAI_LORA_VERSION}`);
  url.searchParams.set("type", "Model");
  url.searchParams.set("format", "SafeTensor");
  url.searchParams.set("token", CIVITAI_TOKEN);
  return url.toString();
}

const LORA_WEIGHTS = process.env.EVAL_LORA_WEIGHTS?.trim() || civitaiLoraUrl();
const LORA_SCALE = Number(process.env.EVAL_LORA_SCALE ?? 1);

/** The weights source as it may appear in output: scheme+host+path only — never the token. */
function describeLoraWeights(): string {
  if (!LORA_WEIGHTS) return "(none)";
  try {
    const url = new URL(LORA_WEIGHTS);
    return `${url.origin}${url.pathname} (query redacted)`;
  } catch {
    return LORA_WEIGHTS; // a bare HF slug carries no secret
  }
}

/** The four acceptance scenes, in orientation-ab's own order. Nothing else in this probe is intimate. */
const INTIMATE_BEATS = ["doggy", "oral", "oral_guided", "missionary"] as const;
type IntimateBeatId = (typeof INTIMATE_BEATS)[number];

/** Words, whitespace-split — a deliberately crude stand-in for CLIP tokens (which run higher). */
const COMPACT_WORD_BUDGET = 60;

// ---------------------------------------------------------------------------
// The compact SDXL-dialect prompts
// ---------------------------------------------------------------------------

/**
 * ONE HAND-WRITTEN PROMPT PER BEAT, and the arm that exists to make `pulid` interpretable.
 *
 * SDXL's CLIP encoder truncates around 77 tokens, and the pipeline prompt
 * (`buildSceneRenderPrompt`) is ~1300 characters — several times that. Without this arm a bad
 * `pulid` result cannot be read: was it the model that cannot draw the act, or was it the
 * truncation that never let the model hear the act described? Each prompt below therefore
 * stays inside {@link COMPACT_WORD_BUDGET} words and is checked before any spend.
 *
 * Each is DERIVED from its staging entry's semantics (`scene-staging.ts`), not invented:
 * the same geometry, the same possessive binding ("the viewer's own"), the same anatomy the
 * template names, in the subject / act / camera / anatomy / quality-tail order SDXL steers
 * best on. The viewer's anatomy is the pipeline's own exposure-gated wording
 * (`PLAYER_INTIMATE` in orientation-ab: circumcised, above average length, erect) rendered
 * as SDXL nouns. The subject line is one clause because PuLID takes identity from the
 * reference image, not from adjectives.
 *
 * That includes the registry's FRAME ANCHORS, which are findings rather than decoration: the
 * 2026-08-14 probe run added "the viewer's own hands entering frame from the lower edge" to
 * `on_all_fours` (without it the model gave the hands to her and the viewer left the shot)
 * and "kneeling on the floor below the camera and facing up toward it" to
 * `kneeling_before_viewer` (a stated camera height alone moved her gaze but never the
 * camera), and the 2026-08-15b run strengthened two of them again — the doggy and guided-oral
 * templates now name the viewer's ARM as well as the hand, place the SUBJECT's hands, and (in
 * the guided-oral entry) anchor the act itself to the lower frame edge, so the LoRA has
 * neither a hand without an origin, nor a free pair of hers to recruit, nor a piece of the
 * composition that no line ever locates. All of it is carried below. **When a template's geometry changes, re-derive its compact prompt** —
 * nothing can check this automatically, because the whole point of the arm is that it is a
 * different dialect saying the same thing.
 */
const COMPACT_PROMPTS: Readonly<Record<IntimateBeatId, string>> = {
  // `on_all_fours`: away / close / high, the viewer's HANDS AND FOREARMS — this composition
  // puts no viewer anatomy in frame, so the compact prompt names none either. Both of the
  // template's 2026-08-15 attribution fixes are carried: her arms straight and ahead (so she
  // has no free pair to be given the hips), and the viewer's hands AND forearms entering
  // from the lower corners (so the hands have an arm and an origin outside the frame).
  doggy:
    "POV first person. Auburn-haired woman on all fours on a bed, her arms straight ahead, palms planted, her back to the camera, her bare hips raised toward the viewer, her head lowered away from the lens. The viewer's own hands and forearms enter frame from the lower corners onto her waist and hips. Close, high angle. Photorealistic, warm lamplight.",
  // `kneeling_before_viewer` (composition A): toward_viewer / close / high, viewer's GENITALS.
  oral: "POV first person. Auburn-haired woman kneeling on the floor below the camera and facing up toward it, her face tilted up and her mouth on the viewer's own erect circumcised penis, her eyes on the viewer. Close, high angle looking down at her. Explicit, photorealistic, dim lamplight.",
  // `kneeling_before_viewer_guided` (composition B): the crown of the head to the lens, so
  // the face is hidden by head angle and the viewer's own hand is the second staged part —
  // carried here with the template's 2026-08-15 fixes: the arm and upper entry edge that give
  // the hand a body, her hands pinned cheaply so none are spare, and the act's own frame
  // anchor at the opposite edge — the lever that two attempts at moving her hands could not
  // supply, because the part that kept vanishing was the one nothing had ever located. A
  // contact verb was probed here too and reverted; see the template's note before retrying.
  oral_guided:
    "POV first person. Auburn-haired woman kneeling, head bowed, the crown of her head toward the camera, her mouth on the viewer's own erect circumcised penis rising into frame from the lower edge, her palms on the floor. The viewer's own arm enters frame from the upper edge, hand resting flat on top of her head. High angle. Explicit, photorealistic, lamplight.",
  // `lying_beneath_viewer`: the heaviest of the four — her face up, penetration at the bottom
  // frame edge, and the viewer's own hands on her, all three in one compact prompt.
  missionary:
    "POV first person. Auburn-haired woman on her back on a wide bed beneath the viewer, her face turned up toward the camera, her bare legs raised. The viewer's own erect circumcised penis enters frame at the bottom edge, penetrating her. The viewer's own hands hold her thighs and waist. Close shot, high angle. Explicit, photorealistic, low lamplight.",
};

// ---------------------------------------------------------------------------
// Model literals
// ---------------------------------------------------------------------------

/**
 * `nsfw-api/sdxl-pulid`, copied field-for-field from its seeded registry row
 * (`drizzle/0104_add-adult-and-identity-image-models.sql`) — these scripts have no database,
 * so the row is hand-written exactly as `model.ts` does for the Qwen pair.
 *
 * Two fields are worth stating out loud, because both would otherwise look like omissions and
 * both are what the seed says (and what docs/image-models/sdxl-pulid.md documents):
 *
 * - `outputFormat: null` — this model declares NO output-format input. Replicate rejects
 *   unknown inputs, so sending `output_format: "webp"` would fail the prediction outright.
 *   Its bytes therefore arrive in whatever format the wrapper emits (see {@link imageExtension}).
 * - `supportedAspects: []` with `aspectMode: "aspect_ratio"` — it has no aspect input either.
 *   Shape travels as free `width`/`height` integers, which is exactly what
 *   `withReviewedImageQuality` layers on below, so this arm renders at production's reviewed
 *   832×1216 with `method: "fidelity"` pinned rather than the wrapper's 512×512 default.
 */
function pulidModel(): ImageModel {
  return withReviewedImageQuality({
    id: "eval-pulid",
    // Community model ⇒ the slug carries its version pin; the bare-slug endpoint is
    // official-models-only and 404s for everything else.
    slug: "nsfw-api/sdxl-pulid:83bea633f1fbae0729dcfca1c431b01ae2a9e3e39c25b055fed6da2b916822d5",
    label: "SDXL PuLID",
    canGenerate: true,
    canEdit: true,
    // NOT `image`, and not the schema's first URI-typed input either: `depth_image` comes
    // first in property order and is a ControlNet depth converter. Vesper never sends it.
    referenceField: "reference_image",
    referenceArity: "single",
    referenceTransport: "file",
    maxReferences: 1,
    aspectMode: "aspect_ratio",
    supportedAspects: [],
    outputFormat: null,
    extraInput: {},
    probedVersionId: "83bea633f1fbae0729dcfca1c431b01ae2a9e3e39c25b055fed6da2b916822d5",
    // Both `unknown` in the seed, each for its own reason: the edit-kind vocabulary has no
    // term for a face-embedding adapter, and no trial has measured its likeness — which is
    // half of what this probe is for.
    editKind: "unknown",
    identityPreservation: "unknown",
    // `{}` in the seed, and nothing here reads it: the eval scripts call the provider
    // directly, so no optional control is ever bound. The record shape still requires it.
    advancedCapabilities: emptyImageModelAdvancedCapabilities(),
    operatorWarning:
      "PuLID identity adapter with 283 lifetime Replicate runs and no Vesper trial — likeness is unmeasured. Single reference only, so scene renders never reach the multi-reference rung. Its depth_image ControlNet input is never sent.",
    forPortrait: false,
    forVariant: true,
    forScene: true,
    builtin: true,
    sort: 90,
  });
}

/**
 * `qwen/qwen-image-edit-plus-lora` at its probed pin — the one Qwen edit endpoint that takes
 * a user-supplied LoRA (docs/image-models/qwen-image-edit-plus-lora.md). Registered by admin
 * and off every player surface, so it has no seeded row to copy; the values below are the
 * probe's, which is what that doc records.
 *
 * `withReviewedImageQuality` is applied for the same reason as on the pulid arm — production
 * parity. It is a NO-OP for this slug today (the doc notes this row carries no reviewed
 * overlay, so `go_fast` rides the provider default `true` where 2511's overlay forces
 * `false`); applying it anyway means the arm follows the reviewed policy if one is ever added.
 */
function loraModel(): ImageModel {
  return withReviewedImageQuality({
    id: "eval-qwen-lora",
    slug: "qwen/qwen-image-edit-plus-lora:b37d69a6b94414c96cc4ecb16660b472bb62284f2293d4b65537c09b8500e200",
    label: "Qwen Image Edit Plus LoRA",
    // `required: ["prompt", "image"]` — it cannot run bare.
    canGenerate: false,
    canEdit: true,
    referenceField: "image",
    referenceArity: "array",
    maxReferences: 3,
    referenceTransport: "file",
    aspectMode: "aspect_ratio",
    supportedAspects: ["1:1", "16:9", "9:16", "4:3", "3:4", "match_input_image"],
    outputFormat: "webp",
    extraInput: {
      // The whole point of the arm. Blank would make this its own no-LoRA control, which is
      // what the `qwen` arm already is on the newer checkpoint.
      lora_weights: LORA_WEIGHTS,
      lora_scale: LORA_SCALE,
      // Declared by this schema (default `false`), so the key is legitimate to send; its
      // VALUE is overridden from the deployment's REPLICATE_SAFE_MODE at payload time.
      disable_safety_checker: true,
    },
    probedVersionId: "b37d69a6b94414c96cc4ecb16660b472bb62284f2293d4b65537c09b8500e200",
    editKind: "instruction_edit",
    // A generation behind 2511, which the doc records as the price of LoRA access.
    identityPreservation: "moderate",
    // The `loraWeights`/`loraScale` bindings live here on the real registry row; this probe
    // writes the two fields into `extraInput` directly, so the empty set is honest.
    advancedCapabilities: emptyImageModelAdvancedCapabilities(),
    operatorWarning: null,
    forPortrait: false,
    forVariant: false,
    forScene: false,
    builtin: false,
    sort: 0,
  });
}

// ---------------------------------------------------------------------------
// Arms
// ---------------------------------------------------------------------------

interface Arm {
  id: string;
  /** The question this arm answers — printed above its prompt at run time. */
  question: string;
  prompt: string;
  /** The model as it will actually be sent, for the pre-spend summary. */
  model: ImageModel;
  render: (reference: Buffer) => Promise<ReplicateImageResult>;
  /**
   * The arm this one deliberately shares a prompt with. Set ⇒ the distinctness check asserts
   * EQUALITY with that arm instead of difference — `lora` is only a clean read of the LoRA's
   * contribution while its prompt is the `qwen` arm's, so sameness there is the invariant.
   */
  sharesPromptWith?: string;
  /** True ⇒ this prompt came out of the real pipeline and must carry the staged sentence. */
  pipeline: boolean;
}

/** Order-preserving union — the staging's parts joining whatever the composer's own gate grounded. */
function unionParts(base: readonly ViewerBodyPartId[], extra: readonly ViewerBodyPartId[]): ViewerBodyPartId[] {
  const out = [...base];
  for (const id of extra) if (!out.includes(id)) out.push(id);
  return out;
}

/** `{name}` templates bound to the subject, the way the render layer binds them. */
function bindName(template: string, name: string): string {
  return template.replaceAll("{name}", name);
}

/**
 * The beat's STAGED plan — the twin of orientation-ab's `new` variant, and deliberately built
 * the same way: the staging's own camera, the staging committed onto the plan, and its viewer
 * parts unioned in ungated (`buildSceneRenderPrompt` runs them through `resolveViewerParts`,
 * which is where the coverage/route gate belongs). Every arm here renders THIS plan, so the
 * only variable across arms is the model and the dialect.
 */
function stagedPlan(beat: Beat): { plan: SceneRenderPlan; name: string } {
  const resolved = resolveScenePlan(beat.spec, beat.context);
  const name = resolved.focal?.name;
  if (!name) throw new Error("beat resolved with no focal character — its roster and spec disagree");
  if (!beat.staging) throw new Error("intimate beats must carry a staging entry — this one has none");
  return {
    plan: {
      ...resolved,
      camera: { ...beat.staging.camera },
      staging: beat.staging,
      viewerBody: unionParts(resolved.viewerBody, beat.staging.viewerParts),
    },
    name,
  };
}

/** One prepared reference, stated rather than sniffed — exactly as `model.ts` documents. */
function prepared(reference: Buffer): { bytes: Buffer; mediaType: string; extension: string }[] {
  return [{ bytes: reference, mediaType: "image/webp", extension: "webp" }];
}

function armsFor(beatId: IntimateBeatId, beat: Beat): { arms: Arm[]; name: string } {
  const { plan, name } = stagedPlan(beat);

  // THE BASELINE, byte-identical to orientation-ab's `new` arm: the uncensored reference-edit
  // route with the focal identity-locked to the anchor.
  const editPrompt = buildSceneRenderPrompt(plan, { referenceName: name, allowIntimate: true });
  // The TEXT route. No `referenceName` on purpose: PuLID takes identity from its
  // `reference_image` embedding, and the lock sentence would assert an edit that is not
  // happening — a lie in the prompt, and one that steers the model toward a portrait.
  const textPrompt = buildSceneRenderPrompt(plan, { allowIntimate: true });
  const compactPrompt = COMPACT_PROMPTS[beatId];

  const pulid = pulidModel();
  const arms: Arm[] = [
    {
      id: "qwen",
      question: "baseline — the staged edit prompt on the current eval edit model",
      prompt: editPrompt,
      model: evalEditModel(),
      render: (reference) => evalEdit(editPrompt, [reference]),
      pipeline: true,
    },
    {
      id: "pulid",
      question: "can an adult-trained identity adapter draw the act?",
      prompt: textPrompt,
      model: pulid,
      // `aspect: null` because this model has NO aspect input — shape rides the reviewed
      // width/height in `extraInput`. Sending `aspect_ratio` would be an unknown field.
      render: (reference) =>
        replicateClient().runRegistryImageModel(pulid, { prompt: textPrompt, references: prepared(reference), aspect: null }),
      pipeline: true,
    },
    {
      id: "pulid_compact",
      question: "the same question minus CLIP truncation — a ~60-word SDXL-dialect prompt",
      prompt: compactPrompt,
      model: pulid,
      render: (reference) =>
        replicateClient().runRegistryImageModel(pulid, {
          prompt: compactPrompt,
          references: prepared(reference),
          aspect: null,
        }),
      pipeline: false,
    },
  ];

  if (LORA_WEIGHTS) {
    const lora = loraModel();
    arms.push({
      id: "lora",
      question: "does an anatomy LoRA rescue the Qwen edit path?",
      prompt: editPrompt,
      model: lora,
      render: (reference) =>
        replicateClient().runRegistryImageModel(lora, { prompt: editPrompt, references: prepared(reference), aspect: "3:4" }),
      sharesPromptWith: "qwen",
      pipeline: true,
    });
  }
  return { arms, name };
}

// ---------------------------------------------------------------------------
// The honesty check — refuse to pay for a run that could not answer the question
// ---------------------------------------------------------------------------

/**
 * Four ways this run would prove nothing, each a loud throw rather than a render bill:
 *
 * 1. two arms that are supposed to differ send the SAME prompt — then whatever the pictures
 *    show, they are not evidence about the models;
 * 2. the `lora` arm's prompt has DRIFTED from the `qwen` arm's — the LoRA's contribution
 *    would be confounded with a prompt change, which is the one thing that arm exists to
 *    rule out, so sameness is asserted rather than difference;
 * 3. the staged sentence never reached a pipeline prompt — the registry template is where
 *    every explicit word lives, so a prompt without it is not describing the act at all
 *    (checked NAME-BOUND and verbatim: nothing between the registry and the prompt may
 *    reword a template);
 * 4. a compact prompt outgrew its budget — the arm's whole purpose is to sit inside SDXL's
 *    encoder window, and one that does not is just a second truncated prompt.
 */
function assertProbeIsHonest(beatId: IntimateBeatId, beat: Beat, arms: readonly Arm[], name: string): void {
  const byId = new Map(arms.map((arm) => [arm.id, arm]));

  for (const arm of arms) {
    const twinId = arm.sharesPromptWith;
    if (twinId === undefined) continue;
    const twin = byId.get(twinId);
    if (!twin) throw new Error(`${beatId}/${arm.id} declares a prompt twin "${twinId}" that is not in this run`);
    if (twin.prompt !== arm.prompt) {
      throw new Error(
        `${beatId}: the "${arm.id}" arm must send the "${twinId}" arm's prompt UNCHANGED, or the LoRA's contribution is confounded with a prompt change — they have drifted apart`,
      );
    }
  }

  const independent = arms.filter((arm) => arm.sharesPromptWith === undefined);
  for (let i = 0; i < independent.length; i++) {
    for (let j = i + 1; j < independent.length; j++) {
      const a = independent[i];
      const b = independent[j];
      if (a && b && a.prompt === b.prompt) {
        throw new Error(
          `${beatId}: the "${a.id}" and "${b.id}" arms send an identical prompt — the A/B would render the same words twice and prove nothing about either model`,
        );
      }
    }
  }

  if (!beat.staging) throw new Error(`${beatId} carries no staging entry — this probe grades staged acts only`);
  const staged = bindName(beat.staging.template, name);
  for (const arm of arms) {
    if (!arm.pipeline) continue;
    if (!arm.prompt.includes(staged)) {
      throw new Error(
        `${beatId}/${arm.id}: the staging sentence is missing from the pipeline prompt — expected the registry template verbatim: "${staged}". Either the staging was dropped on this route, or the emitter rewords the template (in which case fix this check, not the registry).`,
      );
    }
  }

  const compact = COMPACT_PROMPTS[beatId];
  const words = compact.trim().split(/\s+/).filter(Boolean).length;
  if (words > COMPACT_WORD_BUDGET) {
    throw new Error(
      `${beatId}: the compact prompt is ${words} words, over the ${COMPACT_WORD_BUDGET}-word budget — past SDXL's encoder window it is a second truncated prompt, not a control`,
    );
  }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

/**
 * The real format of the returned bytes, so a PNG is not filed as `.webp`.
 *
 * `webp` is both the default and the honest one for the Qwen arms (their row sets
 * `output_format`), but sdxl-pulid declares no output-format input at all, so whatever its
 * wrapper emits is what arrives — and a mislabelled file is a nuisance in the one workflow
 * this probe exists for, eyeballing a folder of renders.
 */
function imageExtension(bytes: Buffer): string {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  return "webp";
}

function selectedBeats(): IntimateBeatId[] {
  if (BEAT === "all") return [...INTIMATE_BEATS];
  const match = INTIMATE_BEATS.find((id) => id === BEAT);
  if (!match) throw new Error(`unknown beat "${BEAT}" — have: all, ${INTIMATE_BEATS.join(", ")}`);
  return [match];
}

function buildBeat(id: IntimateBeatId): Beat {
  const build = BEATS.get(id);
  if (!build) throw new Error(`beat "${id}" is gone from orientation-ab.ts — the two probes have drifted`);
  const beat = build();
  if (!beat.allowIntimate) throw new Error(`beat "${id}" is not on the uncensored route — this probe grades intimate acts only`);
  return beat;
}

async function main(): Promise<void> {
  const beats = selectedBeats().map((id) => ({ id, beat: buildBeat(id) }));
  // Every prompt built and every check run BEFORE the first send: a probe that fails its own
  // honesty check on beat 4 after paying for beats 1–3 has wasted the owner's money.
  const planned = beats.map(({ id, beat }) => {
    const { arms, name } = armsFor(id, beat);
    assertProbeIsHonest(id, beat, arms, name);
    if (ARM_FILTER.length > 0) {
      const known = new Set(arms.map((arm) => arm.id));
      for (const wanted of ARM_FILTER) {
        if (!known.has(wanted)) {
          throw new Error(
            `AB_ARMS names "${wanted}", which this run did not build — have: ${[...known].join(", ")}` +
              (wanted === "lora" && !LORA_WEIGHTS ? " (the lora arm needs EVAL_LORA_WEIGHTS or CIVITAI_API_TOKEN)" : ""),
          );
        }
      }
    }
    const rendered = ARM_FILTER.length > 0 ? arms.filter((arm) => ARM_FILTER.includes(arm.id)) : arms;
    return { id, beat, arms, rendered };
  });

  for (const { id, beat, rendered } of planned) {
    console.log(`\n=== ${id} — ${beat.summary} ===`);
    console.log(`Grading:\n${beat.grading.map((line) => `  - ${line}`).join("\n")}`);
    for (const arm of rendered) {
      console.log(`\n--- ${id} / ${arm.id} (${arm.model.slug}) — ${arm.question} ---\n${arm.prompt}\n`);
    }
  }

  if (!LORA_WEIGHTS) {
    console.log(
      "\nlora arm SKIPPED — set EVAL_LORA_WEIGHTS (HuggingFace repo slug or .safetensors URL) or CIVITAI_API_TOKEN (builds the curated Civitai URL) to enable it (EVAL_LORA_SCALE=0–4, default 1).",
    );
  } else {
    // Redacted on purpose: the Civitai form of this URL carries the owner's API key.
    console.log(`\nlora weights: ${describeLoraWeights()} @ scale ${LORA_SCALE}`);
  }

  // The prompts are free and are half of what this probe is for; only the renders cost money.
  if (!hasImageProvider()) {
    console.log("REPLICATE_API_TOKEN not set — prompts printed above, renders skipped.");
    return;
  }

  const total = planned.reduce((sum, entry) => sum + entry.rendered.length, 0) * RUNS_PER_ARM;
  console.log(`\nPAID RUN: ${total} renders (${planned.length} beats × arms × ${RUNS_PER_ARM} runs) → ${OUT}/`);

  const reference = await fs.readFile(ANCHOR);
  for (const { id, rendered } of planned) {
    const dir = path.join(OUT, id);
    await fs.mkdir(dir, { recursive: true });
    for (const arm of rendered) {
      for (let run = 1; run <= RUNS_PER_ARM; run++) {
        const result = await arm.render(reference);
        if (!result.ok || !result.image) {
          console.error(`${id}/${arm.id} run ${run} FAILED: ${result.error ?? "no image"}`);
          continue;
        }
        const file = path.join(dir, `${arm.id}-${run}.${imageExtension(result.image)}`);
        await fs.writeFile(file, result.image);
        console.log(`${id}/${arm.id} run ${run} → ${file}`);
      }
    }
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
