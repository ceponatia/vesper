import { z } from "zod";
import { parseAspectValue, type ImageAspectMode, type ImageReferenceArity } from "@/contracts";

/**
 * The save-time capability probe (image-model-registry.spec.md §"Capability
 * probe"). Reads a Replicate model's published input schema and derives what
 * the registry needs to render with it: what its reference input is called,
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

const REPLICATE_BASE = "https://api.replicate.com/v1";
const PROBE_TIMEOUT_MS = 20_000;

/** Field names checked first, in order, so a model with several image-ish inputs resolves deterministically. */
const PREFERRED_REFERENCE_FIELDS = ["image", "image_input", "images"] as const;

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
    // unreadable INPUT SCHEMA is worth failing on (owner report 2026-08-05:
    // `nsfw-api/pony-realism-v2.3` and `nsfw-api/realvis-hyper-lora`).
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
 * hint as to why (owner report 2026-08-05: `lucataco/juggernaut-xl-v9`,
 * `nsfw-api/pony-realism-v2.3` and `nsfw-api/realvis-hyper-lora` all registered
 * cleanly and then 404'd on every render). Community models must go through
 * `POST /predictions` with a version id, which is what a pinned
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
}

export type ProbeResult = { ok: true; probe: ReplicateModelProbe } | { ok: false; error: string };

export async function probeReplicateModel(slug: string): Promise<ProbeResult> {
  const token = process.env.REPLICATE_API_TOKEN;
  if (!token) return { ok: false, error: "REPLICATE_API_TOKEN not configured" };

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
  const url = pinnedVersion
    ? `${REPLICATE_BASE}/models/${modelPath}/versions/${encodeURIComponent(pinnedVersion)}`
    : `${REPLICATE_BASE}/models/${modelPath}`;

  let raw: unknown;
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
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
    },
  };
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
  const names = [
    ...PREFERRED_REFERENCE_FIELDS.filter((name) => name in properties),
    ...Object.keys(properties).filter((name) => !(PREFERRED_REFERENCE_FIELDS as readonly string[]).includes(name)),
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
  // Juggernaut XL v9 defaults `apply_watermark` to TRUE, stamping a provenance
  // mark into every output. Same category as the group-generation pins below: a
  // model default that silently degrades the image, switched off wherever the
  // input exists.
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
