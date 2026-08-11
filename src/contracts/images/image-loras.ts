import { z } from "zod";
import type { ImageInputBinding, ImageModelControlBindings } from "./image-model-capabilities";
import {
  imageControlDefaultsSchema,
  imageProfileTaskSchema,
  imageProfileTasks,
  type ImageLoraSelection,
  type ImageProfileTask,
  type ImageRenderControls,
} from "./image-model-profiles";

/**
 * The curated LoRA library (image-model-capabilities.spec.md §`image_loras`).
 *
 * A LoRA is a weights file the provider fetches by locator and blends into the
 * render at a scale. That makes it unlike every other control in this contract:
 * the value Vesper sends is not a number the version declared a range for, it is
 * a POINTER to somebody else's file, and the same pointer is a style transfer on
 * one model and a validation error on another. So the library is not a bag of
 * strings a profile may name — it is a reviewed row that carries its own
 * compatibility rules, and this module is where those rules are decided.
 *
 * Three properties are load-bearing:
 *
 * 1. **A locator is never guessed and never widened.** `https_url` must parse as
 *    an HTTPS URL and `huggingface_repo` must look like `owner/repo`. Nothing
 *    here accepts a scheme-bearing slug, a three-segment path, or credentials
 *    embedded in a URL — a locator is a public retrieval address, and a private
 *    one is out of scope until there is somewhere outside the database to keep
 *    the secret.
 * 2. **A locator is redacted everywhere it is reported.** Direct URLs may carry
 *    signed query parameters, so {@link redactImageLoraLocator} is what reaches
 *    a diagnostic, never the raw string.
 * 3. **Refusal, never repair.** A scale outside the curated band is refused
 *    rather than clamped, and an unverifiable version is refused rather than
 *    assumed compatible — the same rule the control mapper already keeps, for
 *    the same reason: a render nobody configured, billed under a record that
 *    claims otherwise, is worse than a render that did not happen.
 *
 * Pure, like the rest of `src/contracts`: the row lookup, the diagnostics and
 * the render wiring live in `src/server/images/image-loras.ts`.
 */

/**
 * How the provider is told where the weights are.
 *
 * `huggingface_repo` is the shape the Qwen LoRA endpoints document first
 * ("Pass a Hugging Face repo slug, for example `owner/model`"); `https_url` is
 * the direct `.safetensors`/archive URL the same field also accepts. They are
 * separate members rather than one loose string because the VALIDATION differs,
 * and a single "locator" that is checked one way would let a typo'd slug travel
 * as if it were a URL.
 *
 * `schema.ts` imports this tuple for its `text(..., { enum })` column, so the
 * column and the parser cannot drift.
 */
export const imageLoraLocatorTypes = ["https_url", "huggingface_repo"] as const;
export const imageLoraLocatorTypeSchema = z.enum(imageLoraLocatorTypes);
export type ImageLoraLocatorType = (typeof imageLoraLocatorTypes)[number];

/**
 * The absolute scale band any library row may declare, matching the ceiling the
 * live Qwen LoRA binding publishes (`lora_scale`, minimum 0, maximum 4).
 *
 * A rail on the STORED configuration, not a substitute for the version's own
 * binding: the authoritative range is whatever the active version declared, and
 * a resolved scale is checked against both. A future model with a wider band
 * relaxes this constant and its table check together.
 */
export const IMAGE_LORA_MIN_SCALE = 0;
export const IMAGE_LORA_MAX_SCALE = 4;

/** The most trigger words one row may carry — a prompt addition, not a tag soup. */
export const IMAGE_LORA_MAX_TRIGGER_WORDS = 8;

/**
 * A conservative `owner/repo`: exactly two segments of letters, digits, `_`, `.`
 * and `-`, each starting and ending on an alphanumeric.
 *
 * Deliberately narrower than what Hugging Face itself accepts. The cost of being
 * strict is an operator retyping a legal-but-odd slug; the cost of being loose is
 * that `https://evil/x`, `owner/repo/../..` and `owner/repo?token=…` all pass a
 * "has a slash" check and are then handed to a provider as a retrieval address.
 */
const HUGGINGFACE_REPO_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?\/[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

/**
 * Whether this locator is usable for its declared type.
 *
 * Exported because three callers must agree on the answer: the admin route that
 * refuses a bad save, the evaluator's defensive re-check at render time (a row
 * can predate a tightening of this rule), and the tests. Two spellings of "is
 * this locator sane" is how a row saves cleanly and then fails every render.
 */
export function isValidImageLoraLocator(locatorType: ImageLoraLocatorType, locator: string): boolean {
  switch (locatorType) {
    case "https_url":
      return isPublicHttpsUrl(locator);
    case "huggingface_repo":
      return HUGGINGFACE_REPO_PATTERN.test(locator);
  }
}

/**
 * An HTTPS URL with no embedded credentials.
 *
 * `http:` is refused rather than upgraded — a weights file fetched over plaintext
 * is a file anyone on the path can replace — and a `user:password@` URL is
 * refused because the library is stored in the database and read by the admin UI,
 * which is exactly where a provider credential must not be.
 */
function isPublicHttpsUrl(locator: string): boolean {
  let url: URL;
  try {
    url = new URL(locator);
  } catch {
    return false;
  }
  return url.protocol === "https:" && url.username === "" && url.password === "";
}

/**
 * The locator as it may appear in a log, a diagnostic, or an operator screen:
 * scheme, host and path, with the query string, fragment and any credentials
 * removed (spec §`image_loras`: "logs and diagnostics must record a redacted
 * locator without its query string").
 *
 * A Hugging Face slug has none of those parts and passes through unchanged, as
 * does anything that does not parse as a URL at all — redaction must never be the
 * step that throws.
 */
export function redactImageLoraLocator(locator: string): string {
  let url: URL;
  try {
    url = new URL(locator);
  } catch {
    return locator;
  }
  url.search = "";
  url.hash = "";
  url.username = "";
  url.password = "";
  return url.toString();
}

// The shared field shapes. Spelled once and reused by the stored record and the
// two admin request schemas, because a create request that validated a locator
// more loosely than the row parser would write rows nothing can read back.
const loraLabel = z.string().trim().min(1).max(200);
const loraLocatorText = z.string().trim().min(1).max(1000);
const loraSlugList = z.array(z.string().trim().min(1).max(200)).max(64);
const loraTriggerWords = z.array(z.string().trim().min(1).max(120)).max(IMAGE_LORA_MAX_TRIGGER_WORDS);
const loraTaskList = z.array(imageProfileTaskSchema).max(imageProfileTasks.length);
const loraScale = z.number().min(IMAGE_LORA_MIN_SCALE).max(IMAGE_LORA_MAX_SCALE);
/**
 * A prompt addition, or nothing. Nullable rather than merely optional so an
 * addition can be CLEARED through the admin PATCH, and a blank string normalizes
 * to null — an emptied textarea means "no addition", not "an addition that says
 * nothing" (the `operatorWarning` idiom on the model route).
 */
const loraPromptAddition = z.union([
  z
    .string()
    .trim()
    .max(2000)
    .transform((text) => text || null),
  z.null(),
]);

/**
 * The fields a stored row and a create request share.
 *
 * Every array default is a THUNK for the reason recorded in
 * `image-model-capabilities.ts`: zod hands a default back without cloning it, so
 * a literal `[]` would be one array instance shared by every parsed row, and a
 * caller pushing a trigger word onto one row's list would edit them all.
 */
const imageLoraFields = {
  label: loraLabel,
  locatorType: imageLoraLocatorTypeSchema,
  /** A public retrieval address. Never a token, never a private repository. */
  locator: loraLocatorText,
  /**
   * The model slugs this LoRA was trained against, compared BASE-slug to
   * base-slug (a pinned `owner/name:version` row matches `owner/name`).
   *
   * Empty means NOTHING is compatible, not "anything is". A LoRA is trained
   * against one base model and produces noise on another, so an unfilled list is
   * an unfinished row rather than a wildcard — the opposite reading of
   * `compatibleVersionIds`, and deliberately so.
   */
  compatibleModelSlugs: loraSlugList.default((): string[] => []),
  /**
   * Exact provider versions of a compatible slug. EMPTY means "any version of a
   * compatible slug", because a LoRA usually survives a point release of the
   * model it was trained on; a non-empty list is a reviewer saying it does not,
   * and then a render that cannot name its version is refused rather than tried.
   */
  compatibleVersionIds: loraSlugList.default((): string[] => []),
  defaultScale: loraScale,
  minimumScale: loraScale,
  maximumScale: loraScale,
  /** Words the LoRA was trained to answer to, appended when the prompt lacks them. */
  triggerWords: loraTriggerWords.default((): string[] => []),
  promptPrefix: loraPromptAddition.default(null),
  promptSuffix: loraPromptAddition.default(null),
  /**
   * The profile tasks this LoRA may serve. Empty means none — same fail-closed
   * reading as `compatibleModelSlugs`: an anime style LoRA quietly applying to a
   * character's canonical portrait is the failure this list exists to prevent.
   */
  allowedTasks: loraTaskList.default((): ImageProfileTask[] => []),
  enabled: z.boolean().default(true),
};

/** The curated band plus the value inside it a render defaults to. */
export interface ImageLoraScaleTriple {
  defaultScale: number;
  minimumScale: number;
  maximumScale: number;
}

/** `minimum <= default <= maximum`, the invariant the table also checks. */
export function imageLoraScalesOrdered(scales: ImageLoraScaleTriple): boolean {
  return scales.minimumScale <= scales.defaultScale && scales.defaultScale <= scales.maximumScale;
}

const SCALE_ORDER_MESSAGE = "minimumScale must be at most defaultScale, and defaultScale at most maximumScale";
const LOCATOR_MESSAGE = "the locator does not match its locator type";

/**
 * The two cross-field rules a stored row and a create request share.
 *
 * Written once and applied to both schemas rather than restated: a create path
 * that accepted an unordered triple would write a row whose own parser then drops
 * it, which reads to an operator as "the LoRA I just saved has vanished".
 */
function checkImageLoraInvariants(
  value: ImageLoraScaleTriple & { locatorType: ImageLoraLocatorType; locator: string },
  ctx: z.RefinementCtx,
): void {
  if (!imageLoraScalesOrdered(value)) {
    ctx.addIssue({ code: "custom", path: ["defaultScale"], message: SCALE_ORDER_MESSAGE });
  }
  if (!isValidImageLoraLocator(value.locatorType, value.locator)) {
    ctx.addIssue({ code: "custom", path: ["locator"], message: LOCATOR_MESSAGE });
  }
}

/**
 * One library row on the wire.
 *
 * `createdAt`/`updatedAt` are columns only, deliberately absent here for the
 * reason recorded on `imageModelSchema`: they are storage bookkeeping, and a
 * client that displayed them would start depending on them.
 */
export const imageLoraSchema = z
  .object({
    id: z.string().min(1),
    ...imageLoraFields,
    /** Marks a seeded row for display. Does NOT gate deletion, matching the registry. */
    builtin: z.boolean().default(false),
  })
  .superRefine(checkImageLoraInvariants);
export type ImageLora = z.infer<typeof imageLoraSchema>;

/** Degraded-safe list: a malformed payload parses to `[]` (docs/resilience.md §1). */
export const imageLoraListSchema = z.array(imageLoraSchema).catch((): ImageLora[] => []);

/**
 * What the admin create route accepts. `builtin` is absent on purpose — a row
 * created through the API is by definition not seeded — and `id` is the server's
 * to mint.
 */
export const imageLoraCreateRequestSchema = z.object(imageLoraFields).superRefine(checkImageLoraInvariants);
export type ImageLoraCreateRequest = z.infer<typeof imageLoraCreateRequestSchema>;

/**
 * A partial edit. Every field is optional, so the cross-field invariants can only
 * be judged HERE when the whole triple (or the whole locator pair) arrives
 * together; the service re-checks both against the MERGED row, which is the only
 * place that knows the fields this request did not send.
 */
export const imageLoraUpdateRequestSchema = z
  .object({
    label: loraLabel.optional(),
    locatorType: imageLoraLocatorTypeSchema.optional(),
    locator: loraLocatorText.optional(),
    compatibleModelSlugs: loraSlugList.optional(),
    compatibleVersionIds: loraSlugList.optional(),
    defaultScale: loraScale.optional(),
    minimumScale: loraScale.optional(),
    maximumScale: loraScale.optional(),
    triggerWords: loraTriggerWords.optional(),
    promptPrefix: loraPromptAddition.optional(),
    promptSuffix: loraPromptAddition.optional(),
    allowedTasks: loraTaskList.optional(),
    enabled: z.boolean().optional(),
  })
  .superRefine((request, ctx) => {
    if (
      request.defaultScale !== undefined &&
      request.minimumScale !== undefined &&
      request.maximumScale !== undefined &&
      !imageLoraScalesOrdered({
        defaultScale: request.defaultScale,
        minimumScale: request.minimumScale,
        maximumScale: request.maximumScale,
      })
    ) {
      ctx.addIssue({ code: "custom", path: ["defaultScale"], message: SCALE_ORDER_MESSAGE });
    }
    if (
      request.locatorType !== undefined &&
      request.locator !== undefined &&
      !isValidImageLoraLocator(request.locatorType, request.locator)
    ) {
      ctx.addIssue({ code: "custom", path: ["locator"], message: LOCATOR_MESSAGE });
    }
  });
export type ImageLoraUpdateRequest = z.infer<typeof imageLoraUpdateRequestSchema>;

/**
 * What a render actually needs from the library once the rules have been
 * applied: the locator to send, the scale to send it at, and the prompt additions
 * that come with it.
 *
 * A separate type from {@link ImageLora} because it is a DECISION rather than a
 * row — it exists only after a specific model, version and task agreed to it, so
 * carrying the whole row down the render path would invite a second, weaker
 * check somewhere further in.
 */
export const imageLoraRenderBindingSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  locator: z.string().min(1),
  scale: z.number(),
  promptPrefix: z.string().nullable(),
  promptSuffix: z.string().nullable(),
  triggerWords: z.array(z.string()),
});
export type ImageLoraRenderBinding = z.infer<typeof imageLoraRenderBindingSchema>;

/**
 * The LoRA's OWN rules refuse this render: the model, the version, the task or
 * the requested scale is outside what the library row says it is for. An operator
 * fixes it by choosing a different LoRA, or by editing this one's rules.
 */
export const IMAGE_LORA_INCOMPATIBLE = "image_lora.incompatible" as const;

/**
 * The configuration cannot reach the provider at all: the row is switched off or
 * unreadable, the active version exposes no LoRA inputs, the resolved scale is
 * outside the provider's own declared range, or nothing can say which version
 * will run while the row demands a specific one. An operator fixes it by changing
 * the MODEL or the row's enabled/locator state, not by choosing another task.
 */
export const IMAGE_LORA_UNREACHABLE = "image_lora.unreachable_configuration" as const;

export type ImageLoraRefusalCode = typeof IMAGE_LORA_INCOMPATIBLE | typeof IMAGE_LORA_UNREACHABLE;

/** A resolved binding, or the typed reason this LoRA will not be sent. */
export type ImageLoraEvaluation =
  | { ok: true; binding: ImageLoraRenderBinding }
  | { ok: false; code: ImageLoraRefusalCode; message: string };

export interface EvaluateImageLoraForRenderInput {
  lora: ImageLora;
  /** The model row's slug, pinned or bare — compared base-slug to base-slug. */
  modelSlug: string;
  /** The version this render will execute, or null when nothing can say. */
  versionId: string | null;
  task: ImageProfileTask;
  /** The per-render scale; absent takes the row's `defaultScale`. */
  requestedScale?: number;
  /** The ACTIVE version's probed bindings — the only source of field names. */
  bindings: ImageModelControlBindings;
}

/**
 * Whether this LoRA may be sent on this render, and with what.
 *
 * The order of the gates is the order an operator wants the answer in, cheapest
 * and most specific first: the row's own switch, then what it was trained for,
 * then what the version can express. Splitting the answer across two codes is the
 * point — "this LoRA is not for this job" and "this model has no LoRA input" send
 * an operator to two different screens, and one merged `lora_refused` would send
 * them to neither.
 *
 * Pure: it decides, it does not read a row or push a diagnostic. The server seam
 * (`resolveImageLoraForRender`) loads the row and reports the refusal.
 */
export function evaluateImageLoraForRender(input: EvaluateImageLoraForRenderInput): ImageLoraEvaluation {
  const { lora, task, bindings } = input;
  if (!lora.enabled) {
    return unreachable(`LoRA ${lora.label} is switched off in the library`);
  }

  const slug = baseSlug(input.modelSlug);
  if (!lora.compatibleModelSlugs.some((compatible) => baseSlug(compatible) === slug)) {
    return incompatible(`LoRA ${lora.label} is not compatible with ${slug}`);
  }

  if (lora.compatibleVersionIds.length > 0) {
    // A row naming exact versions is a reviewer saying this LoRA does NOT survive
    // a version change, so a render that cannot state its version is unverifiable
    // rather than merely unlisted — a different answer, and a different fix.
    if (input.versionId === null) {
      return unreachable(`LoRA ${lora.label} lists compatible versions, and this render cannot say which version runs`);
    }
    if (!lora.compatibleVersionIds.includes(input.versionId)) {
      return incompatible(`LoRA ${lora.label} is not compatible with version ${input.versionId}`);
    }
  }

  if (!lora.allowedTasks.includes(task)) {
    return incompatible(`LoRA ${lora.label} is not allowed for ${task} renders`);
  }

  // Refused, never clamped: sending 1.0 where 2.5 was asked for renders something
  // nobody configured under a record that claims 2.5 was requested.
  const scale = input.requestedScale ?? lora.defaultScale;
  if (!Number.isFinite(scale) || scale < lora.minimumScale || scale > lora.maximumScale) {
    return incompatible(
      `scale ${String(scale)} is outside LoRA ${lora.label}'s curated range ${String(lora.minimumScale)}–${String(lora.maximumScale)}`,
    );
  }

  const weightsBinding = bindings.loraWeights;
  const scaleBinding = bindings.loraScale;
  if (!weightsBinding || !scaleBinding) {
    // Both or neither: a locator with no scale field runs at the model's own
    // default strength, which is a different render from the one recorded.
    return unreachable(`${slug} exposes no LoRA weights and scale inputs, so ${lora.label} cannot be sent`);
  }
  if (!withinBindingRange(scaleBinding, scale)) {
    return unreachable(
      `scale ${String(scale)} is outside the range ${slug} declares for ${scaleBinding.field}`,
    );
  }

  // Defensive: the row parsed under today's rules, but a row written before this
  // check tightened would otherwise hand an unusable address to the provider.
  if (!isValidImageLoraLocator(lora.locatorType, lora.locator)) {
    return unreachable(
      `LoRA ${lora.label} has an unusable ${lora.locatorType} locator (${redactImageLoraLocator(lora.locator)})`,
    );
  }

  return {
    ok: true,
    binding: {
      id: lora.id,
      label: lora.label,
      locator: lora.locator,
      scale,
      promptPrefix: lora.promptPrefix,
      promptSuffix: lora.promptSuffix,
      triggerWords: [...lora.triggerWords],
    },
  };
}

function incompatible(message: string): ImageLoraEvaluation {
  return { ok: false, code: IMAGE_LORA_INCOMPATIBLE, message };
}

function unreachable(message: string): ImageLoraEvaluation {
  return { ok: false, code: IMAGE_LORA_UNREACHABLE, message };
}

/**
 * A slug without its `:version` pin.
 *
 * The one-line duplicate of `baseImageModelSlug` in
 * `src/server/images/quality-presets.ts`, restated here because `src/contracts`
 * may not import from `src/server` and this comparison must be made where the
 * rule is decided. Keep the two spellings identical.
 */
function baseSlug(slug: string): string {
  return slug.split(":", 1)[0] ?? slug;
}

/** Whether a value sits inside the bounds a binding actually declared. */
function withinBindingRange(binding: ImageInputBinding, value: number): boolean {
  if (binding.minimum !== undefined && value < binding.minimum) return false;
  if (binding.maximum !== undefined && value > binding.maximum) return false;
  return true;
}

/**
 * Weave a LoRA's prompt additions around a compiled prompt.
 *
 * Called ONCE, in the profile compile step, after the prompt strategy has run and
 * before model-dialect preparation — which is what makes the additions part of
 * the text that is hashed and sent rather than something bolted on at the
 * transport, where nothing would record it.
 *
 * A trigger word already present in the assembled text is NOT repeated: a LoRA
 * whose trigger is "watercolor" applied to a prompt about watercolor would
 * otherwise end with the word twice, which reads to the model as emphasis nobody
 * asked for. Matching is case-insensitive and substring-based, because "Watercolor
 * painting of…" already contains the trigger for every purpose the model has.
 *
 * Returns the prompt UNCHANGED when there is no binding or the binding carries no
 * additions, so a LoRA that only supplies weights leaves the prompt byte-identical.
 */
export function applyImageLoraPromptAdditions(
  prompt: string,
  binding: ImageLoraRenderBinding | undefined | null,
): string {
  if (!binding) return prompt;
  const prefix = binding.promptPrefix?.trim() ?? "";
  const suffix = binding.promptSuffix?.trim() ?? "";
  const triggers = binding.triggerWords.map((word) => word.trim()).filter((word) => word.length > 0);
  if (prefix.length === 0 && suffix.length === 0 && triggers.length === 0) return prompt;

  const assembled = [prefix, prompt, suffix].filter((block) => block.trim().length > 0).join("\n\n");
  const haystack = assembled.toLowerCase();
  const missing: string[] = [];
  for (const word of triggers) {
    const needle = word.toLowerCase();
    if (haystack.includes(needle)) continue;
    // Deduplicated as we go: two spellings of the same trigger in one row would
    // otherwise both land, since neither is in the text when the list is scanned.
    if (missing.some((already) => already.toLowerCase() === needle)) continue;
    missing.push(word);
  }
  return missing.length === 0 ? assembled : `${assembled}\n\n${missing.join(", ")}`;
}

/**
 * THE rule for which LoRA a render is asking for: the request's own selection,
 * falling back to the profile's stored default.
 *
 * One function because two callers need the same answer and must not derive it
 * separately — `renderImageIntent`, which resolves a selection nobody resolved for
 * it, and the image lab's recipe runner, which resolves before it plans. The
 * merge itself mirrors `compileProfileRenderPlan`'s per-member
 * `requested ?? defaults`, and a second spelling of it would let the LoRA that is
 * RESOLVED differ from the LoRA that is MAPPED.
 *
 * `controlDefaults` is `unknown` because its callers hold a jsonb column or a
 * parsed row indifferently; an unreadable blob yields no selection rather than
 * throwing (docs/resilience.md §1). `parseOr` itself lives in `src/lib` and takes
 * a diagnostic sink, neither of which belongs in this pure module — the caller
 * that has a sink already reports the row it read.
 */
export function effectiveImageLoraSelection(
  controlDefaults: unknown,
  controls: ImageRenderControls | undefined,
): ImageLoraSelection | undefined {
  if (controls?.lora) return controls.lora;
  const parsed = imageControlDefaultsSchema.safeParse(controlDefaults);
  return parsed.success ? parsed.data.lora : undefined;
}
