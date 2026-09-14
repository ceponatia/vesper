import type { ImageModelControlBindings } from "../capabilities/image-model-capabilities";
import type { ImageControlDefaults } from "./image-model-profiles";
import { baseImageModelSlug, type ImageModel } from "./image-models";

/**
 * The reviewed quality policy: the settings Vesper has judged a known model must
 * run with, said once, in the vocabulary a TASK PROFILE stores.
 *
 * The registry's raw probe defaults describe what a provider ACCEPTS, not what
 * Vesper wants — a wrapper that optimizes speed where fidelity matters, a hidden
 * negative prompt that suppresses exactly the output this app produces, a
 * 512-square default on a portrait model. Those corrections are reviewed
 * judgments, and this module is where they are stated.
 *
 * They reach a render through ONE owner: the task profile. A profile row carries
 * them as its own `control_defaults` and `provider_overrides` — the seed
 * migrations 0110/0122 wrote them onto the built-in rows, admin creation seeds
 * them onto a new one ({@link withReviewedProfileDefaults}), and from there they
 * are mapped and validated like any other profile setting. There is no
 * slug-keyed rewrite of `extraInput` at the render boundary any more, and that
 * is the point: a reviewed value now travels the same path, through the same
 * probed binding, with the same recorded drop when a version cannot carry it, as
 * every other setting a profile states.
 *
 * What lives here is the reviewed judgment only. Which provider field a control
 * reaches on a version is the PROBE's answer, read from
 * `advancedCapabilities.controls` — never asserted here. `controlFields` records
 * the field each reviewed control is EXPECTED to land on, which is what lets a
 * fixture state the expectation out loud rather than synthesizing a probe that
 * agrees with whatever the table happens to say.
 *
 * There is deliberately no universal negative block. Text, logos, blur,
 * low-resolution media, unusual appendages and absent body parts can all be
 * intentional; contextual negatives belong to individual task profiles.
 *
 * Exact provider slugs are intentional: an operator-added model never receives a
 * guessed field, and a pinned `owner/name:version` is matched on `owner/name`.
 */

/**
 * The normalized controls a reviewed setting can be — a deliberate subset,
 * which keeps a policy from claiming a control (`seed`, `lora`) that the
 * reviewed judgment has nothing to say about.
 *
 * `guidance` is what that headroom was for: SDXL PuLID's reviewed `cfg` is a
 * one-line table edit here rather than a type change, which is exactly the claim
 * this vocabulary was kept wide for. `steps` remains expressible and unused —
 * the sampler corrections that needed it belonged to models the 2026-08-16
 * ruling dropped, and it stays for the same reason `guidance` paid off.
 *
 * A setting the vocabulary HAS a word for must be stated as the control, never
 * as a raw override, and `fastMode` is why the rule is written down. A profile's
 * `providerOverrides` merge LAST in `compileProfileRenderPlan`, over the mapped
 * controls — so a reviewed setting spelled as a raw field outranks the CALLER's
 * own request for the same thing, and a run that explicitly asked for the
 * accelerated path would render unaccelerated with nothing refused. Spelled as a
 * control it merges where a default belongs, beneath the request
 * (`requested?.fastMode ?? defaults.fastMode`).
 */
export type ReviewedImageControlDefaults = Pick<
  ImageControlDefaults,
  "steps" | "guidance" | "negativePrompt" | "fastMode" | "resolution" | "width" | "height"
>;

/** One model's reviewed policy, in the two columns a profile row stores. */
export interface ReviewedImageQualityPolicy {
  /** The reviewed settings a task profile carries as `control_defaults`. */
  controlDefaults: Readonly<ReviewedImageControlDefaults>;
  /**
   * Reviewed settings NO normalized control covers, carried as a profile's
   * `provider_overrides` — the escape hatch, used only where the control
   * vocabulary genuinely has no word for the setting (PuLID's `method` and
   * `face_weight`). A setting that HAS a word belongs in `controlDefaults`
   * instead: overrides merge last, so a raw spelling would outrank the caller's
   * own request for the same thing.
   */
  providerOverrides: Readonly<Record<string, unknown>>;
  /**
   * The provider field each normalized control above is expected to reach on
   * THIS model.
   *
   * It is a STATEMENT OF EXPECTATION, not a transport: nothing reads it to build
   * a payload, because which field a control reaches is the version's own probed
   * binding. It exists so the parity fixture can say "the reviewed 832 must
   * arrive as `width`" in the reviewed table's own words, and so the two defects
   * below can be refused at load.
   *
   * Every control set in `controlDefaults` has an entry here, with ONE exception
   * the load-time check knows about: `resolution: "custom"` is the GATE that
   * makes `width`/`height` a request rather than a leftover
   * (`compileProfileRenderPlan`), not a field anything sends.
   */
  controlFields: Readonly<Partial<Record<keyof ReviewedImageControlDefaults, string>>>;
}

/**
 * One way a reviewed row can contradict itself.
 *
 * - `unmapped_default` — a `controlDefaults` entry other than `resolution` with
 *   no `controlFields` mapping. The profile carries the value and nothing states
 *   which provider field it must arrive on, so the parity suite has no field to
 *   look for: its payload assertions are driven by this mapping, and a control
 *   missing here is a control the fixture never asks about. (The suite's PROBE
 *   is hand-written from the production registry — `PRODUCTION_BINDINGS` in
 *   `reviewed-profile-parity.test.ts` — and cross-checked against these
 *   mappings, which is what makes a missing one visible as a gap rather than as
 *   agreement.)
 * - `field_collision` — a `controlFields` mapping naming a provider field that a
 *   `providerOverrides` entry also claims. `compileProfileRenderPlan` merges a
 *   profile's overrides LAST, over the mapped controls, so the reviewed control's
 *   value would be silently replaced by the reviewed override's — one reviewed
 *   setting quietly cancelling another, in the live render as much as in a
 *   fixture.
 */
export type ReviewedImageQualityPolicyDefect =
  | { kind: "unmapped_default"; control: string }
  | { kind: "field_collision"; control: string; field: string };

/**
 * The ways one policy contradicts itself, or an empty list.
 *
 * Read off the objects' own keys rather than a typed list of control names, so a
 * key the type does not know about is caught rather than skipped — the drift
 * being guarded against is exactly a table edit the types could not object to.
 */
export function reviewedImageQualityPolicyDefects(
  policy: ReviewedImageQualityPolicy,
): ReviewedImageQualityPolicyDefect[] {
  const defects: ReviewedImageQualityPolicyDefect[] = [];
  const mappings = Object.entries(policy.controlFields).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  );
  const mapped = new Set(mappings.map(([control]) => control));
  for (const [control, value] of Object.entries(policy.controlDefaults)) {
    if (control === "resolution" || value === undefined || mapped.has(control)) continue;
    defects.push({ kind: "unmapped_default", control });
  }
  for (const [control, field] of mappings) {
    if (Object.hasOwn(policy.providerOverrides, field)) defects.push({ kind: "field_collision", control, field });
  }
  return defects;
}

/**
 * Definition-time proof, run once at module load and throwing on a violation.
 *
 * A throw rather than a diagnostic because this is a programmer error in a
 * hand-maintained constant (docs/resilience.md: exceptions are for those, and
 * nothing else): no render-time fallback could reconcile a row that cancels its
 * own setting, and the only fix is an edit to this file. Failing the import is
 * what keeps a contradictory row from being discovered as a silently different
 * payload.
 */
function assertReviewedImageQualityTable(table: Readonly<Record<string, ReviewedImageQualityPolicy>>): void {
  for (const [slug, policy] of Object.entries(table)) {
    const defects = reviewedImageQualityPolicyDefects(policy);
    if (defects.length === 0) continue;
    const described = defects.map((defect) =>
      defect.kind === "unmapped_default"
        ? `${defect.control} has a reviewed default but no controlFields mapping`
        : `${defect.control} maps to ${defect.field}, which providerOverrides also claims`,
    );
    throw new Error(`[reviewed-profile-controls] ${slug}: ${described.join("; ")}`);
  }
}

/**
 * The reviewed policy per BASE provider slug (a pinned `owner/name:version` is
 * matched on `owner/name`).
 *
 * Exact slugs are the point: an operator-added model never receives a guessed
 * field.
 *
 * Owner ruling (2026-08-16): the reviewed set is the Qwen family plus the
 * 2026-08-10/11 seeded additions, and every slug here therefore HAS a seeded
 * `image_models` row. Juggernaut XL v9, RealVis Hyper LoRA and Pony Realism v2.3
 * were dropped from it: they are unseeded community checkpoints an admin adds by
 * hand, they remain catalog pages in `docs/image-models/`, and an admin who adds
 * one now gets the wrapper's own defaults with no reviewed correction. That is
 * accepted rather than overlooked.
 *
 * The consequence worth knowing: this table can no longer contain a model that
 * has no row to seed, so a reviewed setting stated here is always reproducible
 * as a task profile's controls.
 */
const REVIEWED_IMAGE_QUALITY: Readonly<Record<string, ReviewedImageQualityPolicy>> = {
  "qwen/qwen-image-edit-2511": {
    // This model currently serves only identity-critical variants/scenes. Its
    // provider default optimizes speed on the surface where fidelity matters.
    //
    // Stated as the `fastMode` CONTROL, because the vocabulary has a word for it
    // and the probed row binds that word to `go_fast`. As a raw override it
    // merged last and beat the caller: an Image Generator run that asked this
    // model for the accelerated path — the one surface allowed to ask — compiled
    // `go_fast: true` from the request and then had it replaced by the reviewed
    // `false`, with nothing dropped and nothing refused to show for it. That is
    // the klein 4B defect (#569/#573) reached from the other side.
    controlDefaults: { fastMode: false },
    providerOverrides: {},
    controlFields: { fastMode: "go_fast" },
  },
  "aisha-ai-official/nsfw-flux-dev": {
    // The wrapper defaults to a 1024×1024 square, so every render would be
    // cropped to 3:4 and lose a quarter of the frame. 832×1216 is the portrait
    // bucket this architecture is trained on.
    controlDefaults: { resolution: "custom", width: 832, height: 1216 },
    providerOverrides: {},
    controlFields: { width: "width", height: "height" },
  },
  "aisha-ai-official/likereality-pony-v1": {
    // The wrapper's provider default negative is literally `"nsfw, naked"` — a
    // hidden negative that suppresses the output this app exists to produce and
    // silently contradicts the authored wardrobe and exposure state. The Pony
    // score-tag preamble is separate and stays on (`prepend_preprompt`).
    controlDefaults: { negativePrompt: "", resolution: "custom", width: 832, height: 1216 },
    providerOverrides: {},
    controlFields: { negativePrompt: "negative_prompt", width: "width", height: "height" },
  },
  "nsfw-api/sdxl-pulid": {
    // 512×512 is the wrapper's default: both off-shape and far below the
    // 768×1024 canonical portrait. `method` is pinned because Vesper runs this
    // model for identity preservation and never for style transfer, so a changed
    // provider default must not be able to move it off `fidelity`.
    //
    // The two identity settings, both of which ran on wrapper defaults through
    // every likeness observation this row has: `face_weight` governs how hard the
    // PuLID adapter pulls toward the reference and defaulted to 0.8, and this
    // model is registered FOR identity preservation — there is no reading of that
    // purpose on which Vesper wants the adapter at four-fifths strength. 1.0 is
    // its ceiling, so this arm has no headroom past it. `cfg` defaulted to 3,
    // which the negative-field canary measured as the weak arm on this exact
    // endpoint (2026-08-29: 6/6 coherent renders at 7 against 8/10 with
    // degenerate output at the default). `face_weight` has no normalized control
    // — same reason `method` has none — while `cfg` is precisely what `guidance`
    // is the word for.
    controlDefaults: { guidance: 7, resolution: "custom", width: 832, height: 1216 },
    providerOverrides: { method: "fidelity", face_weight: 1 },
    controlFields: { guidance: "cfg", width: "width", height: "height" },
  },
};

assertReviewedImageQualityTable(REVIEWED_IMAGE_QUALITY);

/** Every base slug the reviewed policy covers, for tests and admin diagnostics. */
export const reviewedImageQualitySlugs: readonly string[] = Object.keys(REVIEWED_IMAGE_QUALITY);

/** The reviewed policy for one BASE slug, or null when the model is unreviewed. */
export function reviewedImageQualityPolicy(baseSlug: string): ReviewedImageQualityPolicy | null {
  return REVIEWED_IMAGE_QUALITY[baseSlug] ?? null;
}

/**
 * The provider fields this policy's NORMALIZED controls are expected to reach.
 *
 * Written out control by control rather than through `Object.values`, which
 * widens a partial record to `any` under this repo's lint rules — and a cast to
 * work around that would be a silent hole in exactly the table the parity
 * fixture is checking. `resolution` is deliberately absent: it is the gate, not
 * a field (see `controlFields`).
 */
export function reviewedImageQualityControlFields(policy: ReviewedImageQualityPolicy): string[] {
  const fields = policy.controlFields;
  return [fields.steps, fields.guidance, fields.negativePrompt, fields.fastMode, fields.width, fields.height].filter(
    (field): field is string => field !== undefined,
  );
}

/**
 * The reviewed policy as the two jsonb columns a task profile row stores.
 *
 * The shape the seed migrations write, the shape admin creation seeds, and the
 * shape the parity fixture compiles — so "what the profile carries" has one
 * definition rather than one in SQL and another in a test that agrees with it
 * until somebody edits one.
 */
export function reviewedImageProfileControls(baseSlug: string): {
  controlDefaults: Readonly<ReviewedImageControlDefaults>;
  providerOverrides: Readonly<Record<string, unknown>>;
} | null {
  const policy = reviewedImageQualityPolicy(baseSlug);
  if (!policy) return null;
  return { controlDefaults: policy.controlDefaults, providerOverrides: policy.providerOverrides };
}

/** The two configuration columns {@link withReviewedProfileDefaults} merges. */
export interface ReviewedProfileConfiguration {
  controlDefaults: ImageControlDefaults;
  providerOverrides: Record<string, unknown>;
}

/**
 * One configuration's own settings with this model's reviewed defaults beneath
 * them — the seam every profile-shaped configuration built in CODE passes
 * through.
 *
 * Three callers build such a configuration against a model instead of reading a
 * seeded row: admin profile creation, the Image Generator's synthetic bench
 * profile, and the image lab's recipe profiles. Each of them would otherwise
 * render a reviewed model with none of its reviewed settings — a bench whose
 * evidence is about a configuration production never runs.
 *
 * The CONFIGURATION wins on a key collision, which is the same direction
 * migration 0110 wrote (`reviewed || existing`) and the same direction the render
 * path already resolves in: a profile's own stated control outranks a default it
 * did not state. Seeding is therefore only ever additive — it can supply a
 * reviewed setting nobody mentioned, never overwrite one somebody chose.
 *
 * Returns the two columns rather than the whole configuration so the caller
 * spreads them into its own concrete type: `{ ...request, ...withReviewedProfileDefaults(model, request) }`.
 */
export function withReviewedProfileDefaults(
  model: ImageModel,
  configuration: ReviewedProfileConfiguration,
): ReviewedProfileConfiguration {
  const { controlDefaults, providerOverrides } = configuration;
  const reviewed = reviewedImageProfileControls(baseImageModelSlug(model.slug));
  if (!reviewed) return { controlDefaults, providerOverrides };
  return {
    controlDefaults: withReviewedControlDefaults(reviewed.controlDefaults, controlDefaults),
    // Raw keys, so an ordinary spread says it: the configuration's own value for
    // a key the reviewed policy also names is the one that stands.
    providerOverrides: { ...reviewed.providerOverrides, ...providerOverrides },
  };
}

/**
 * The control merge, written member by member for `compileProfileRenderPlan`'s
 * own reason: a key present with an explicit `undefined` and a key absent are
 * the SAME request to the control mapper, so a plain `{ ...reviewed,
 * ...configured }` spread would let the first silently erase a reviewed value —
 * and a reviewed setting that vanishes without a drop record is precisely the
 * failure this module exists to prevent.
 *
 * The test is `=== undefined` and never falsiness: the Pony ruling's reviewed
 * negative IS the empty string, and reading `""` as "unset" would restore the
 * wrapper's hidden `"nsfw, naked"` — the exact default the ruling removed.
 */
function withReviewedControlDefaults(
  reviewed: Readonly<ReviewedImageControlDefaults>,
  configured: ImageControlDefaults,
): ImageControlDefaults {
  const merged: ImageControlDefaults = { ...configured };
  if (merged.steps === undefined && reviewed.steps !== undefined) merged.steps = reviewed.steps;
  if (merged.guidance === undefined && reviewed.guidance !== undefined) merged.guidance = reviewed.guidance;
  if (merged.negativePrompt === undefined && reviewed.negativePrompt !== undefined) {
    merged.negativePrompt = reviewed.negativePrompt;
  }
  // `=== undefined` earns its keep twice over here: the reviewed value IS
  // `false`, and so is a caller's "do not accelerate", so falsiness on either
  // side of this test would collapse a real request into the default.
  if (merged.fastMode === undefined && reviewed.fastMode !== undefined) merged.fastMode = reviewed.fastMode;
  if (merged.resolution === undefined && reviewed.resolution !== undefined) merged.resolution = reviewed.resolution;
  if (merged.width === undefined && reviewed.width !== undefined) merged.width = reviewed.width;
  if (merged.height === undefined && reviewed.height !== undefined) merged.height = reviewed.height;
  return merged;
}

/**
 * The provider fields this model's reviewed settings occupy on THIS version — a
 * raw provider key that would land on one of them undoes a reviewed correction.
 *
 * Read off the version's OWN probed bindings rather than the table's
 * `controlFields`, because the probe is what decides where a control lands; a
 * production gate answering from a slug-keyed table would be the transitional
 * overlay wearing a different name. A reviewed control the version declares no
 * binding for occupies no field at all, and is correctly absent here: it is
 * dropped at compile with a recorded reason, and nothing can collide with a
 * value that was never sent.
 *
 * `resolution` contributes nothing for the same reason it maps to no field: it
 * is the gate that makes the width/height pair a request.
 */
export function reviewedImageProfilePinnedFields(model: ImageModel): string[] {
  const reviewed = reviewedImageProfileControls(baseImageModelSlug(model.slug));
  if (!reviewed) return [];
  const defaults = reviewed.controlDefaults;
  const bindings = model.advancedCapabilities.controls;
  const fields = new Set<string>(Object.keys(reviewed.providerOverrides));
  const mapped = [
    defaults.steps === undefined ? undefined : bindings.steps?.field,
    defaults.guidance === undefined ? undefined : bindings.guidance?.field,
    defaults.negativePrompt === undefined ? undefined : bindings.negativePrompt?.field,
    defaults.fastMode === undefined ? undefined : bindings.fastMode?.field,
    defaults.width === undefined ? undefined : bindings.customWidth?.field,
    defaults.height === undefined ? undefined : bindings.customHeight?.field,
  ];
  for (const field of mapped) {
    if (field !== undefined) fields.add(field);
  }
  return [...fields];
}

/**
 * The reviewed controls a configuration states that ONE version cannot carry.
 *
 * Asked at both moments a version and a profile are judged together: saving a
 * profile ({@link import("./image-model-profile-admin").validateImageProfileConfiguration})
 * and promoting a probed candidate (`validateImageProfileForCandidate`). One
 * implementation rather than two lists, because the two answers must never
 * disagree about the same row — a save refusing what an activation waves
 * through is how a reviewed correction goes missing between them.
 *
 * Scoped twice over, and both narrowings are the point. Only a REVIEWED model is
 * asked — an operator's own profile may say whatever the control vocabulary can
 * say, and a control the version drops is an ordinary recorded drop there. And
 * only the controls that model's reviewed policy actually names are checked, so
 * a curated profile's own `steps` on the same row is nobody's business here.
 *
 * `resolution` is never among them: it sends no field at all, it is the GATE
 * that makes a width/height pair a request, and it is dropped with a reason on
 * every version that binds no tier — including all four reviewed models today.
 *
 * Written member by member over the reviewed vocabulary rather than looping a
 * name map, for the reason the reviewed table itself is: a control added to that
 * vocabulary must be a compile error here, not a setting this check silently
 * stops covering.
 */
export function reviewedUnboundControls(
  slug: string,
  bindings: ImageModelControlBindings,
  stated: ImageControlDefaults,
): string[] {
  const reviewed = reviewedImageProfileControls(baseImageModelSlug(slug))?.controlDefaults;
  if (!reviewed) return [];
  const checks: { control: string; carried: boolean; bound: boolean }[] = [
    { control: "steps", carried: carries(stated.steps, reviewed.steps), bound: bindings.steps !== undefined },
    {
      control: "guidance",
      carried: carries(stated.guidance, reviewed.guidance),
      bound: bindings.guidance !== undefined,
    },
    {
      control: "negativePrompt",
      carried: carries(stated.negativePrompt, reviewed.negativePrompt),
      bound: bindings.negativePrompt !== undefined,
    },
    {
      control: "fastMode",
      carried: carries(stated.fastMode, reviewed.fastMode),
      bound: bindings.fastMode !== undefined,
    },
    { control: "width", carried: carries(stated.width, reviewed.width), bound: bindings.customWidth !== undefined },
    { control: "height", carried: carries(stated.height, reviewed.height), bound: bindings.customHeight !== undefined },
  ];
  return checks.filter((check) => check.carried && !check.bound).map((check) => check.control);
}

/**
 * Whether a row states a control the reviewed policy also names.
 *
 * `!== undefined` on both sides and never falsiness: the reviewed values include
 * `fastMode: false` and the Pony ruling's empty `negativePrompt`, and either
 * would read as "not carried" under a truthiness test — skipping the check on
 * exactly the two settings whose whole purpose is to contradict a provider
 * default.
 */
function carries(stated: unknown, reviewed: unknown): boolean {
  return stated !== undefined && reviewed !== undefined;
}
