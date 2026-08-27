import { z } from "zod";
import {
  type ImageAdditionalImageInput,
  type ImageAspectMode,
  type ImageInputBinding,
  type ImageModelAdvancedCapabilities,
  imageModelAdvancedCapabilitiesSchema,
  type ImageModelControlBindings,
  type ImageProviderInputDescriptor,
  type ImageReferenceArity,
  type ImageReferenceRole,
  type ImageUriBinding,
  parseAspectValue,
} from "@vesper/image-core";
import { PROBE_TIMEOUT_MS } from "./config";
import { NOT_CONFIGURED_ERROR, type ReplicateHttp } from "./http";

/**
 * The save-time capability probe. Reads a Replicate model's published input
 * schema and derives what the registry needs to render with it: what its
 * reference input is called,
 * whether that input is one URI or a list, whether it is required, and how to
 * ask it for a 3:4 image.
 *
 * This is the one place in the image path that FAILS rather than degrades. A
 * half-known row would move the failure to render time, where it costs a
 * player-visible image instead of a form error — so an unreadable schema is a
 * rejected save (docs/resilience.md: degraded defaults are for turns, not for
 * configuration a human is actively writing).
 *
 * The schema parsing itself is still defensive: Replicate's OpenAPI blob is
 * third-party data, so everything is optional and unknown shapes fall through
 * to a conservative default rather than throwing.
 */

/**
 * Field names checked first, in order, so a model with several image-ish inputs
 * resolves deterministically. The last two are identity inputs on adapter
 * pipelines (InstantID, PuLID), which name their face input rather than calling
 * it `image`.
 */
const PREFERRED_REFERENCE_FIELDS = ["image", "image_input", "images", "reference_image", "face_image"] as const;

/**
 * The dedicated-input field names this probe recognizes, each mapped to the
 * structural role Vesper feeds it. Alias discovery happens once, here — the
 * render path and the Generator never pattern-match a provider field name, and
 * an unknown URI field is NEVER classified heuristically: no alias, no entry.
 */
const DEDICATED_IMAGE_INPUT_ALIASES: Record<string, ImageReferenceRole> = {
  depth_image: "depth",
  pose_image: "pose",
  mask: "mask",
  mask_image: "mask",
  control_image: "control",
  edge_image: "edge",
  canny_image: "edge",
};

/**
 * Names checked LAST, after the ordinary fallback scan — derived from the alias
 * table's keys so the "known control input" and "deprioritized reference
 * candidate" lists cannot drift apart.
 *
 * These are CONTROL inputs — a depth map, a pose skeleton, a mask — and they are
 * URI-typed exactly like an identity reference, so the fallback cannot tell them
 * apart. `nsfw-api/sdxl-pulid` is why this exists: it declares `depth_image`
 * before `reference_image`, so plain property order resolved its reference field
 * to the ControlNet depth input, and every render would have handed a
 * character's portrait to a depth converter — a silhouette-shaped stranger
 * rather than that person, with nothing in the payload looking wrong.
 *
 * Deprioritized rather than excluded: a model whose ONLY image input is a
 * control image is still better described as editing from that input than as
 * unable to edit at all, and the admin page can correct the stored field. When a
 * control-alias field IS the resolved reference field, the numbered-reference
 * path owns it and it never doubles as a dedicated input.
 */
const DEPRIORITIZED_REFERENCE_FIELDS: readonly string[] = Object.keys(DEDICATED_IMAGE_INPUT_ALIASES);

// Every string here is `nullish` for the same reason as the model record below:
// a null is Replicate saying "no value", and a rejected property parse would
// silently cost a reference field (the model would look like it cannot edit)
// rather than raising anything.
const propertySchema = z
  .object({
    type: z.string().nullish(),
    format: z.string().nullish(),
    description: z.string().nullish(),
    default: z.unknown().optional(),
    maxItems: z.number().nullish(),
    /** The declared numeric range, when a schema states one rather than only prosing it. */
    minimum: z.number().nullish(),
    maximum: z.number().nullish(),
    /** Inline enum members. Replicate usually routes enums through `allOf` + `$ref`
     * instead, so both spellings are read ({@link strictEnumValues}). */
    enum: z.array(z.unknown()).nullish(),
    items: z.object({ type: z.string().nullish(), format: z.string().nullish() }).nullish(),
    allOf: z.array(z.object({ $ref: z.string().nullish() })).nullish(),
  });

const openapiSchema = z.object({
  components: z
    .object({
      schemas: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
});

/** `GET /models/{owner}/{name}/versions/{id}` — the schema sits at the top level. */
const versionResponseSchema = z.object({
  id: z.string().optional(),
  openapi_schema: openapiSchema.nullable().optional(),
});

const modelResponseSchema = z
  .object({
    // `nullish`, not `optional`: Replicate sends `"description": null` for a
    // model whose page has no blurb, and an absent field and a null one must
    // both be tolerated. Requiring a string here rejected the whole record and
    // refused the save — the opposite of this module's rule that only an
    // unreadable INPUT SCHEMA is worth failing on (owner report 2026-08-05, two
    // community checkpoints with no blurb).
    name: z.string().nullish(),
    owner: z.string().nullish(),
    description: z.string().nullish(),
    /** Replicate's own marker for a first-party/partner model. See `isOfficial`. */
    is_official: z.boolean().nullish(),
    latest_version: z
      .object({
        id: z.string().optional(),
        openapi_schema: z
          .object({
            components: z
              .object({
                schemas: z.record(z.string(), z.unknown()).optional(),
              })
              .optional(),
          })
          .optional(),
      })
      .nullable()
      .optional(),
  });

/**
 * Whether Replicate lists this model as official, which decides HOW it can be
 * run — not merely how it is labelled.
 *
 * `POST /models/{owner}/{name}/predictions`, the endpoint a bare slug uses, is
 * **official models only**. A community model posted there returns 404 with no
 * hint as to why (owner report 2026-08-05: three community checkpoints
 * registered cleanly and then 404'd on every render). Community models must go
 * through `POST /predictions` with a version id, which is what a pinned
 * `owner/name:version` slug does.
 *
 * Defaults to FALSE when the field is missing. The asymmetry is deliberate:
 * running a pinned version works for official models too (verified), so a wrong
 * "community" guess costs only the ability to track latest, while a wrong
 * "official" guess costs every render on that model.
 */
export interface ReplicateModelProbe {
  slug: string;
  /** False ⇒ the model can only be run by version id, so its row must be pinned. */
  isOfficial: boolean;
  label: string;
  versionId: string | null;
  canGenerate: boolean;
  canEdit: boolean;
  referenceField: string;
  referenceArity: ImageReferenceArity;
  maxReferences: number;
  aspectMode: ImageAspectMode;
  /** Every shape the model offers, verbatim; selection happens per render. */
  supportedAspects: string[];
  outputFormat: string | null;
  /** Constants worth pinning, derived from the schema (e.g. a safety toggle that exists). */
  extraInput: Record<string, unknown>;
  /**
   * The optional input bindings this ONE version declares, as the capability
   * contract names them ({@link deriveAdvancedCapabilities}). A slot left absent
   * means "this version exposes no field for that control", and the mapper
   * drops it with a reason — so a row probed before a given alias existed keeps
   * sending exactly what it sends today until somebody re-probes it.
   */
  advancedCapabilities: ImageModelAdvancedCapabilities;
}

export type ProbeResult = { ok: true; probe: ReplicateModelProbe } | { ok: false; error: string };

export async function probeReplicateModel(http: ReplicateHttp, slug: string): Promise<ProbeResult> {
  // The SAME configured client rendering uses. Probing used to read the token
  // independently, which meant a process could probe with one credential and
  // render with another.
  if (!http.configured) return { ok: false, error: NOT_CONFIGURED_ERROR };

  const [path, pinnedVersion, ...rest] = slug.split(":");
  const parts = path?.split("/") ?? [];
  const [owner, name] = parts;
  if (!owner || !name || parts.length !== 2 || rest.length > 0) {
    return { ok: false, error: `"${slug}" is not a Replicate model path — expected owner/name` };
  }

  // A PINNED slug must be probed at its OWN version, not at `latest_version`.
  // Rendering posts the pinned version id, so probing latest would store
  // capability columns describing a different schema — the exact drift pinning
  // exists to prevent, and it would surface as every render failing on invalid
  // inputs while the save looked fine.
  const modelPath = `${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  const probePath = pinnedVersion
    ? `/models/${modelPath}/versions/${encodeURIComponent(pinnedVersion)}`
    : `/models/${modelPath}`;

  let raw: unknown;
  try {
    const response = await http.apiFetch(probePath, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (response.status === 404) {
      return {
        ok: false,
        error: pinnedVersion
          ? `Replicate has no version ${pinnedVersion} of ${owner}/${name}`
          : `Replicate has no model called ${owner}/${name}`,
      };
    }
    if (!response.ok) return { ok: false, error: `Replicate returned ${response.status} for ${slug}` };
    raw = await response.json();
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  // The two endpoints nest the schema differently: a model record carries it
  // under `latest_version`, a version record carries it at the top level.
  let schemas: Record<string, unknown>;
  let versionId: string | null;
  // A version record carries no `is_official`, but an already-pinned slug runs
  // through the version endpoint regardless, so the distinction cannot bite.
  let isOfficial = true;
  if (pinnedVersion) {
    const parsed = versionResponseSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: `Replicate returned an unreadable version record for ${slug}` };
    schemas = parsed.data.openapi_schema?.components?.schemas ?? {};
    versionId = pinnedVersion;
  } else {
    const parsed = modelResponseSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: `Replicate returned an unreadable model record for ${slug}` };
    schemas = parsed.data.latest_version?.openapi_schema?.components?.schemas ?? {};
    versionId = parsed.data.latest_version?.id ?? null;
    isOfficial = parsed.data.is_official === true;
  }
  const input = schemas.Input;
  const inputShape = z
    .object({
      required: z.array(z.string()).optional(),
      properties: z.record(z.string(), z.unknown()).optional(),
    })
    .safeParse(input);
  if (!inputShape.success || !inputShape.data.properties) {
    return { ok: false, error: `${slug} publishes no input schema — it may not be an image model` };
  }

  const properties = inputShape.data.properties;
  const required = inputShape.data.required ?? [];
  if (!("prompt" in properties)) {
    return { ok: false, error: `${slug} has no "prompt" input — Vesper can only run text-prompted image models` };
  }

  const reference = findReferenceField(properties);
  const aspect = deriveAspect(properties, schemas);
  // Derived AFTER the reference field resolves: the dedicated-input and
  // descriptor derivations must know which URI field the numbered-reference
  // path owns, and which field the chosen aspect mode reserves.
  const advancedCapabilities = deriveAdvancedCapabilities(
    properties,
    schemas,
    required,
    reference?.field ?? null,
    aspect.mode === "size" ? "size" : "aspect_ratio",
  );

  return {
    ok: true,
    probe: {
      slug,
      isOfficial,
      label: defaultLabel(name),
      versionId,
      canEdit: reference !== null,
      // A model whose reference input is REQUIRED cannot make an image from a
      // prompt alone — this is what keeps qwen-image-edit-2511 out of the
      // new-portrait picker without anyone hand-flagging it.
      canGenerate: reference === null || !required.includes(reference.field),
      referenceField: reference?.field ?? "image",
      referenceArity: reference?.arity ?? "array",
      maxReferences: reference ? referenceCap(reference) : 0,
      aspectMode: aspect.mode,
      supportedAspects: aspect.supported,
      outputFormat: deriveOutputFormat(properties, schemas),
      extraInput: deriveExtraInput(properties),
      advancedCapabilities,
    },
  };
}

/**
 * The optional-input bindings this version declares, resolved from the KNOWN
 * ALIAS LIST — alias discovery happens once, here, so the render-time mapper
 * never pattern-matches a field name.
 *
 * The style is uniformly conservative: a binding is derived only when the
 * schema declares a field of the expected primitive type under a known name,
 * absent stays absent, and nothing is invented. A field sent to a name the
 * active version does not declare is a provider rejection at spend time, which
 * is why the result is recorded with the version it was read from
 * (`probedVersionId`, written in the same update).
 *
 * The DECLARED numeric type is preserved rather than flattened to `number`:
 * `bindingAccepts` refuses a fractional value on an integer binding, and calling
 * an integer field a number would send `0.8` to a provider that rejects it.
 *
 * `resolutionTier` derives from a `size` input even though `size` is the aspect
 * key on size-mode models — the collision is real, and it is handled where the
 * payload is built (`filterReservedInputFields` refuses the mapped value with a
 * `reserved` drop), not special-cased here: a probe that guessed the aspect
 * mode's consequences would encode a second copy of the reserved-field rule.
 *
 * `knownInputFields` is every property name of the Input schema, sorted. It is
 * the allowlist `providerOverrides` validation reads, and an empty list fails
 * CLOSED — so populating it here is what makes overrides usable at all on a
 * probed row, while unprobed rows keep rejecting everything.
 *
 * `additionalImageInputs` and `providerInputs` are derived here too, both
 * sorted by field name — a re-probe of an unchanged schema must produce an
 * identical record however the provider orders its properties, so version
 * diffs stay empty. `referenceField` is the resolved primary reference (null
 * when the model has none) and `aspectField` the input the detected aspect
 * mode owns; both arrive from the caller because the reservations they imply
 * are decided by `findReferenceField`/`deriveAspect`, not re-guessed here.
 */
function deriveAdvancedCapabilities(
  properties: Record<string, unknown>,
  schemas: Record<string, unknown>,
  required: readonly string[],
  referenceField: string | null,
  aspectField: string,
): ImageModelAdvancedCapabilities {
  const controls: ImageModelControlBindings = {};

  const assign = (slot: keyof ImageModelControlBindings, binding: ImageInputBinding | null): void => {
    if (binding) controls[slot] = binding;
  };

  assign("seed", numericBinding(properties, "seed"));
  assign("negativePrompt", stringBinding(properties, "negative_prompt"));
  // Three spellings of the SAME quantity — how hard the sampler is pushed toward
  // the prompt. `true_cfg_scale` is deliberately NOT a fourth: on CFG-distilled
  // checkpoints (Qwen among them) `guidance_scale` is the embedded guidance,
  // usually pinned near 1.0 and near-meaningless to raise, while
  // `true_cfg_scale` is real classifier-free guidance and runs an order of
  // magnitude higher. Folding both into one slot would make two different knobs
  // answer to one name, and nothing in a run record would say which one moved.
  // A registered model that publishes `true_cfg_scale` deserves its own slot and
  // its own reviewed decision rather than a guess made here in advance.
  assign(
    "guidance",
    numericBinding(properties, "guidance") ??
      numericBinding(properties, "guidance_scale") ??
      numericBinding(properties, "cfg"),
  );
  assign("steps", numericBinding(properties, "num_inference_steps"));
  assign("editStrength", numericBinding(properties, "strength") ?? numericBinding(properties, "prompt_strength"));
  assign("outputCount", numericBinding(properties, "num_outputs") ?? numericBinding(properties, "max_images"));
  assign("thinkingMode", booleanBinding(properties, "thinking_mode"));
  // Exactly one alias. `go_fast` is the Replicate wrapper convention for the
  // accelerated sampling path, and inventing `fast_mode`/`lightning` beside it
  // would bind a field no schema here declares — a provider rejection at spend
  // time, which is the failure the alias list exists to prevent.
  assign("fastMode", booleanBinding(properties, "go_fast"));
  assign("sequentialMode", enumOrStringBinding(properties, schemas, "sequential_image_generation"));
  assign("coherentSet", booleanBinding(properties, "image_set_mode"));

  // A `size` input is a resolution-tier control only when its enum actually
  // offers a tier ("1K", "2K" …). Wan's enum mixes tiers with pixel pairs and
  // still counts; a size that is a free string, or an enum of shapes alone,
  // does not — there is no tier to ask for.
  const sizeValues = strictEnumValues(properties.size, schemas);
  if (sizeValues && sizeValues.some((value) => /^\d+K$/i.test(value))) {
    controls.resolutionTier = { field: "size", type: "enum", enumValues: sizeValues };
  }

  const width = numericBinding(properties, "width");
  if (width?.type === "integer") controls.customWidth = width;
  const height = numericBinding(properties, "height");
  if (height?.type === "integer") controls.customHeight = height;

  assign("loraWeights", stringBinding(properties, "lora_weights"));
  assign("loraScale", numericBinding(properties, "lora_scale"));

  const additionalImageInputs = deriveAdditionalImageInputs(properties, required, referenceField);

  return imageModelAdvancedCapabilitiesSchema.parse({
    controls,
    additionalImageInputs,
    knownInputFields: Object.keys(properties).sort(),
    providerInputs: deriveProviderInputs(properties, schemas, {
      required,
      referenceField,
      aspectField,
      controls,
      additionalImageInputs,
    }),
  });
}

/**
 * The dedicated image inputs this version declares: only fields the alias
 * table names, only when URI-typed, and never the primary reference field —
 * that one belongs to the numbered-reference path, and double-booking it would
 * offer the same provider input under two transports. Sorted by field name so
 * a re-probe of the same schema is byte-identical.
 *
 * One binding per role: when a schema declares two aliases for the same role
 * (`mask` beside `mask_image`), the planner and every form select only the
 * FIRST binding for a role, so recording both would leave a later required
 * alias permanently unfillable — every run refused with nothing to fill it
 * with. A required alias outranks an optional one for exactly that reason;
 * ties fall to field-name order, which the pre-sorted alias walk provides.
 */
function deriveAdditionalImageInputs(
  properties: Record<string, unknown>,
  required: readonly string[],
  referenceField: string | null,
): ImageAdditionalImageInput[] {
  const aliases = Object.entries(DEDICATED_IMAGE_INPUT_ALIASES).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const byRole = new Map<string, ImageAdditionalImageInput>();
  for (const [field, roleHint] of aliases) {
    if (field === referenceField || !(field in properties)) continue;
    const parsed = referenceArityOf(properties[field]);
    if (!parsed) continue;
    const binding: ImageUriBinding = {
      field,
      arity: parsed.arity,
      required: required.includes(field),
      ...(parsed.maxItems == null ? {} : { maxItems: parsed.maxItems }),
    };
    const existing = byRole.get(roleHint);
    if (existing === undefined || (binding.required && !existing.binding.required)) {
      byRole.set(roleHint, { roleHint, binding });
    }
  }
  return [...byRole.values()].sort((a, b) =>
    a.binding.field < b.binding.field ? -1 : a.binding.field > b.binding.field ? 1 : 0,
  );
}

/**
 * One descriptor per declared property, sorted by field name — metadata for
 * the Image Generator's advanced-input form, not a second control system.
 * `reserved` marks every field the render path already owns: the prompt, the
 * primary reference, the aspect key the detected mode writes, the version pin,
 * the safety toggle, every control-bound field, every dedicated image input,
 * and every `extraInput` pin. The style stays conservative — a shape the
 * property schema cannot read is recorded as `unknown` rather than guessed at.
 */
function deriveProviderInputs(
  properties: Record<string, unknown>,
  schemas: Record<string, unknown>,
  context: {
    required: readonly string[];
    referenceField: string | null;
    aspectField: string;
    controls: ImageModelControlBindings;
    additionalImageInputs: readonly ImageAdditionalImageInput[];
  },
): ImageProviderInputDescriptor[] {
  const reserved = new Set<string>([
    "prompt",
    context.aspectField,
    "version",
    "disable_safety_checker",
    // A generate-only model stores the fallback name "image" as its reference
    // field, and the runtime reserved list reserves it unconditionally — a
    // declared non-URI `image` property must not read as an editable input the
    // render path would then refuse.
    context.referenceField ?? "image",
    ...Object.values(context.controls).flatMap((binding) => (binding ? [binding.field] : [])),
    ...context.additionalImageInputs.map((input) => input.binding.field),
    // Every URI-typed alias-table field stays reserved even when per-role
    // dedup left it out of `additionalImageInputs` — it is still a structural
    // image input, and the raw bag must never be the path that writes one.
    ...Object.keys(DEDICATED_IMAGE_INPUT_ALIASES).filter(
      (field) => field in properties && referenceArityOf(properties[field]) !== null,
    ),
    ...Object.keys(deriveExtraInput(properties)),
  ]);
  return Object.keys(properties)
    .sort()
    .map((field) =>
      describeProviderInput(field, properties[field], schemas, {
        required: context.required.includes(field),
        reserved: reserved.has(field),
      }),
    );
}

/** The descriptor for one declared property, optional facts carried only when the schema states them. */
function describeProviderInput(
  field: string,
  property: unknown,
  schemas: Record<string, unknown>,
  flags: { required: boolean; reserved: boolean },
): ImageProviderInputDescriptor {
  const parsed = propertySchema.safeParse(property);
  if (!parsed.success) return { field, type: "unknown", required: flags.required, reserved: flags.reserved };
  const p = parsed.data;
  const enumValues = descriptiveEnumValues(property, schemas);
  const description = p.description?.trim().slice(0, 500);
  return {
    field,
    type: providerInputTypeOf(p, property, enumValues),
    required: flags.required,
    ...(p.default === undefined ? {} : { default: p.default }),
    ...(enumValues.length === 0 ? {} : { enumValues }),
    ...(p.minimum == null ? {} : { minimum: p.minimum }),
    ...(p.maximum == null ? {} : { maximum: p.maximum }),
    ...(description ? { description } : {}),
    reserved: flags.reserved,
  };
}

/**
 * The descriptor vocabulary is broader than the binding one: `uri` for anything
 * `referenceArityOf` recognizes (single URI or a list of them), `array` for a
 * non-URI list, `enum` whenever members resolve, and `unknown` for a shape the
 * probe cannot read — descriptors DESCRIBE the schema, so an odd field is
 * reported rather than omitted.
 */
function providerInputTypeOf(
  p: z.infer<typeof propertySchema>,
  property: unknown,
  enumValues: readonly string[],
): ImageProviderInputDescriptor["type"] {
  if (referenceArityOf(property) !== null) return "uri";
  if (enumValues.length > 0) return "enum";
  if (p.type === "array") return "array";
  if (p.type === "string" || p.type === "integer" || p.type === "number" || p.type === "boolean") return p.type;
  return "unknown";
}

/**
 * The property's enum members, FILTERED to strings — inline `enum` first, the
 * `allOf` `$ref` spelling otherwise. Descriptive on purpose, unlike
 * {@link strictEnumValues}: a descriptor is form metadata, so showing the
 * string-expressible subset of a mixed enum beats hiding the field, while a
 * control binding must describe the whole accepted set or nothing.
 */
function descriptiveEnumValues(property: unknown, schemas: Record<string, unknown>): string[] {
  const parsed = propertySchema.safeParse(property);
  if (!parsed.success) return [];
  const inline = (parsed.data.enum ?? []).filter((value): value is string => typeof value === "string");
  return inline.length > 0 ? inline : enumValuesFor(property, schemas);
}

/** The declared integer/number binding for one field, range carried over verbatim. */
function numericBinding(properties: Record<string, unknown>, field: string): ImageInputBinding | null {
  const parsed = propertySchema.safeParse(properties[field]);
  if (!parsed.success) return null;
  const p = parsed.data;
  if (p.type !== "number" && p.type !== "integer") return null;
  const binding: ImageInputBinding = { field, type: p.type };
  // Absent means "the provider declared no bound", never "unbounded" — so a
  // missing key is left off rather than written as a made-up range.
  if (p.minimum != null) binding.minimum = p.minimum;
  if (p.maximum != null) binding.maximum = p.maximum;
  return binding;
}

function stringBinding(properties: Record<string, unknown>, field: string): ImageInputBinding | null {
  const parsed = propertySchema.safeParse(properties[field]);
  return parsed.success && parsed.data.type === "string" ? { field, type: "string" } : null;
}

function booleanBinding(properties: Record<string, unknown>, field: string): ImageInputBinding | null {
  const parsed = propertySchema.safeParse(properties[field]);
  return parsed.success && parsed.data.type === "boolean" ? { field, type: "boolean" } : null;
}

/**
 * An enum binding when the field's members resolve, a string binding when the
 * field is a plain string, absent otherwise. An `enum` binding always carries
 * its values: `bindingAccepts` fails a value-less enum closed, so recording one
 * would be recording a control nothing can ever send.
 */
function enumOrStringBinding(
  properties: Record<string, unknown>,
  schemas: Record<string, unknown>,
  field: string,
): ImageInputBinding | null {
  const values = strictEnumValues(properties[field], schemas);
  if (values) return { field, type: "enum", enumValues: values };
  return stringBinding(properties, field);
}

/**
 * The property's enum members — inline `enum` or the `allOf` `$ref` Replicate
 * favours — but only when EVERY member is a string. A partially-string enum is
 * skipped whole rather than filtered: filtering would record an enum whose
 * accepted set differs from the provider's, and a value judged valid here could
 * still be rejected at spend time.
 *
 * Distinct from {@link enumValuesFor}, which FILTERS to strings on purpose —
 * aspect derivation wants the shape-expressing subset of a mixed enum, while a
 * control binding must describe the whole input or nothing.
 */
function strictEnumValues(property: unknown, schemas: Record<string, unknown>): string[] | null {
  const parsed = propertySchema.safeParse(property);
  if (!parsed.success) return null;
  let values: unknown[] | null = parsed.data.enum ?? null;
  if (!values) {
    const ref = parsed.data.allOf?.[0]?.$ref;
    if (!ref) return null;
    const referenced = schemas[ref.split("/").pop() ?? ""];
    const enumShape = z.object({ enum: z.array(z.unknown()).optional() }).safeParse(referenced);
    values = enumShape.success ? (enumShape.data.enum ?? null) : null;
  }
  if (!values || values.length === 0) return null;
  return values.every((value): value is string => typeof value === "string") ? values : null;
}

interface ReferenceField {
  field: string;
  arity: ImageReferenceArity;
  description: string;
  maxItems?: number;
}

/** A property is a reference input when it is a URI string, or an array of them. */
function referenceArityOf(value: unknown): { arity: ImageReferenceArity; description: string; maxItems?: number } | null {
  const parsed = propertySchema.safeParse(value);
  if (!parsed.success) return null;
  const p = parsed.data;
  const description = p.description ?? "";
  if (p.type === "string" && p.format === "uri") return { arity: "single", description };
  if (p.type === "array" && p.items?.type === "string" && p.items.format === "uri") {
    return { arity: "array", description, ...(p.maxItems == null ? {} : { maxItems: p.maxItems }) };
  }
  return null;
}

function findReferenceField(properties: Record<string, unknown>): ReferenceField | null {
  const preferred: readonly string[] = PREFERRED_REFERENCE_FIELDS;
  const deprioritized: readonly string[] = DEPRIORITIZED_REFERENCE_FIELDS;
  const names = [
    ...PREFERRED_REFERENCE_FIELDS.filter((name) => name in properties),
    ...Object.keys(properties).filter((name) => !preferred.includes(name) && !deprioritized.includes(name)),
    ...DEPRIORITIZED_REFERENCE_FIELDS.filter((name) => name in properties),
  ];
  for (const field of names) {
    const match = referenceArityOf(properties[field]);
    if (match) return { field, ...match };
  }
  return null;
}

/**
 * How many references the model takes. `maxItems` is honoured when present, but
 * no model in the seeded set declares it — the caps live in prose ("List of
 * 1-14 images", "up to 9 images"), so those two phrasings are read here. The
 * result is a starting value the admin page can correct, never a guarantee.
 */
function referenceCap(reference: ReferenceField): number {
  if (reference.arity === "single") return 1;
  if (reference.maxItems && reference.maxItems > 0) return Math.min(reference.maxItems, 64);
  const range = /(\d+)\s*[-–]\s*(\d+)\s+images/i.exec(reference.description);
  if (range?.[2]) return clampCap(Number(range[2]));
  const upTo = /up to (\d+)\s+images/i.exec(reference.description);
  if (upTo?.[1]) return clampCap(Number(upTo[1]));
  return 3;
}

function clampCap(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.min(Math.trunc(value), 64) : 3;
}

function enumValuesFor(
  property: unknown,
  schemas: Record<string, unknown>,
): string[] {
  const parsed = propertySchema.safeParse(property);
  if (!parsed.success) return [];
  const ref = parsed.data.allOf?.[0]?.$ref;
  if (!ref) return [];
  const referenced = schemas[ref.split("/").pop() ?? ""];
  const enumShape = z.object({ enum: z.array(z.unknown()).optional() }).safeParse(referenced);
  return (enumShape.success ? (enumShape.data.enum ?? []) : []).filter((v): v is string => typeof v === "string");
}

/**
 * Derive how this model is told what shape to produce, and every shape it
 * offers. Shape SELECTION happens later, per render, in `chooseAspect` — the
 * probe's job is only to record the menu.
 *
 * `aspect_ratio` wins when the model has one. Otherwise a `size` enum is used
 * (Wan 2.7 has no aspect input at all), filtered to entries that actually
 * express a shape: its enum mixes `2K`-style tiers with `1536*2048` pixel
 * pairs, and a tier says nothing about proportions.
 */
function deriveAspect(
  properties: Record<string, unknown>,
  schemas: Record<string, unknown>,
): { mode: ImageAspectMode; supported: string[] } {
  const ratios = enumValuesFor(properties.aspect_ratio, schemas).filter((value) => parseAspectValue(value) !== null);
  if (ratios.length > 0) return { mode: "aspect_ratio", supported: ratios };

  const sizes = enumValuesFor(properties.size, schemas).filter((value) => parseAspectValue(value) !== null);
  if (sizes.length > 0) return { mode: "size", supported: sizes };

  return { mode: "aspect_ratio", supported: [] };
}

function deriveOutputFormat(properties: Record<string, unknown>, schemas: Record<string, unknown>): string | null {
  const formats = enumValuesFor(properties.output_format, schemas);
  if (formats.length === 0) return null;
  return formats.includes("webp") ? "webp" : (formats[0] ?? null);
}

/**
 * Constants worth pinning at save time. Only keys the model actually declares
 * are included — Replicate rejects unknown inputs, so this is the mechanism
 * that keeps `disable_safety_checker` off the models that lack it.
 */
function deriveExtraInput(properties: Record<string, unknown>): Record<string, unknown> {
  const extra: Record<string, unknown> = {};
  if ("disable_safety_checker" in properties) extra.disable_safety_checker = true;
  if ("output_quality" in properties) extra.output_quality = 95;
  if ("go_fast" in properties) extra.go_fast = true;
  // SDXL-family community wrappers commonly default `apply_watermark` to TRUE,
  // stamping a provenance mark into every output. Same category as the
  // group-generation pins below: a model default that silently degrades the
  // image, switched off wherever the input exists.
  if ("apply_watermark" in properties) extra.apply_watermark = false;
  // Group/sequential generation defaults differ per model and would return an
  // image SET rather than one image; pin them off wherever they exist.
  if ("max_images" in properties) extra.max_images = 1;
  if ("num_outputs" in properties) extra.num_outputs = 1;
  if ("sequential_image_generation" in properties) extra.sequential_image_generation = "disabled";
  if ("image_set_mode" in properties) extra.image_set_mode = false;
  return extra;
}

function defaultLabel(name: string): string {
  return name
    .split(/[-_]/)
    .filter(Boolean)
    .map((word) => (/^\d/.test(word) ? word : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(" ");
}
