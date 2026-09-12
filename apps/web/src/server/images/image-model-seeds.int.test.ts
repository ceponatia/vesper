import { readFile } from "node:fs/promises";
import path from "node:path";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createReplicateClient, DEFAULT_PREDICTION_TIMEOUT_MS, type ProbeResult } from "@vesper/image-replicate";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import { endTestPool, probeIntegrationDb } from "@/server/test-support";
import { db, imageModelProfiles, imageModels } from "../db";
import { imageModelProbeFields } from "./identity-trial-model-versions";
import { loadImageModels } from "./models";

/**
 * What migration 0136 actually put in a migrated database, and what it does
 * beside a row an operator already added.
 *
 * Two jobs, and the first is the one the migration exists for:
 *
 * 1. THE SEEDED VALUES ARE THE PROBE'S. Every probe-owned column on the three
 *    FLUX.2 klein 4B rows is compared against what `probeReplicateModel`
 *    derives from the same captured schema — the PUBLIC seam, driven through a
 *    stubbed fetch, not a private helper re-exported so a second hand-maintained
 *    derivation could agree with itself. A migration literal that disagreed with
 *    the derivation would show up as a phantom version diff on the admin card of
 *    a row nobody touched, or as a control sent to a field the pinned version
 *    does not declare.
 * 2. THE GUARDS PRESERVE OPERATOR CURATION. Re-executing the shipped statements
 *    beside a hand-added row — version-suffixed or bare — must leave that row
 *    exactly as it is and must not add a second row for the same endpoint.
 *
 * `purgeOwnerRows` does NOT reach `image_models`: it is global registry data
 * with no owner column. So the mutation cases below delete and restore BY ID and
 * end with the migrated state back in place, and `test:engine` runs
 * `--no-file-parallelism`, so no other suite observes the gap.
 */

const ready = await probeIntegrationDb("images image-model-seeds.int.test", "image_models");

const MIGRATION_TAG = "0136_flux-2-klein-4b";
const MIGRATION_FILE = `drizzle/${MIGRATION_TAG}.sql`;

interface KleinEndpoint {
  /** The seeded row id, as the migration writes it. */
  id: string;
  slug: string;
  /** The curated label. Outside `imageModelReprobeFields`, so a re-probe keeps it. */
  label: string;
  versionId: string;
  sort: number;
  /** This version's Input properties, reconstructed from the 2026-09-12 capture. */
  properties: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// The captured schemas, rebuilt through the shared shapes
// ---------------------------------------------------------------------------

/**
 * The three endpoints' Input schemas, from `GET /v1/models/<slug>` on
 * 2026-09-12 (issue #566, evidence state `documented`). Built from shared
 * property constants here rather than transcribed verbatim: the verbatim
 * transcription lives in `packages/image-replicate/src/probe.test.ts`, where the
 * derivation is pinned field by field, and a byte-for-byte second copy in this
 * file would be a clone that drifts silently. What this file needs from the
 * capture is the DERIVED record, so it reconstructs the same schema and reads
 * the derivation back out through the public probe.
 *
 * `x-order` and `title` are omitted throughout: no branch of the derivation
 * reads either, and carrying them would suggest this file is the capture of
 * record when it is not.
 */
const ENUMS = {
  aspect_ratio: [
    "1:1",
    "16:9",
    "9:16",
    "3:2",
    "2:3",
    "4:3",
    "3:4",
    "5:4",
    "4:5",
    "21:9",
    "9:21",
    // The provider SENTINEL, not a ratio. `deriveAspect` drops it.
    "match_input_image",
  ],
  output_format: ["webp", "jpg", "png"],
  output_megapixels: ["0.25", "0.5", "1", "2", "4"],
};

const enumRef = (name: keyof typeof ENUMS) => ({ allOf: [{ $ref: `#/components/schemas/${name}` }] });

const PROMPT = { type: "string", description: "Text prompt for image generation." };
const IMAGES = {
  type: "array",
  items: { type: "string", format: "uri" },
  default: [],
  // The cap lives in this sentence. No klein schema declares `maxItems`.
  description:
    "List of input images for image-to-image generation. Maximum 5 images. Must be jpeg, png, gif, or webp.",
};
const SEED = { type: "integer", nullable: true, description: "Random seed. Set for reproducible generation" };
const ASPECT_RATIO = {
  ...enumRef("aspect_ratio"),
  default: "1:1",
  description:
    "Aspect ratio for the generated image. Use 'match_input_image' to match the aspect ratio of the first input image.",
};
const OUTPUT_FORMAT = { ...enumRef("output_format"), default: "jpg", description: "Format of the output images" };
const OUTPUT_MEGAPIXELS = {
  ...enumRef("output_megapixels"),
  default: "1",
  description: "Resolution of the output image in megapixels",
};
const OUTPUT_QUALITY = {
  type: "integer",
  default: 95,
  maximum: 100,
  minimum: 0,
  description:
    "Quality when saving the output images, from 0 to 100. 100 is best quality, 0 is lowest quality. Not relevant for .png outputs.",
};
const DISABLE_SAFETY_CHECKER = {
  type: "boolean",
  default: false,
  description: "Disable safety checker for generated images.",
};
const GO_FAST = {
  type: "boolean",
  default: false,
  description: "Run faster predictions with additional optimizations.",
};
const GUIDANCE = {
  type: "number",
  default: 4,
  maximum: 10,
  minimum: 1,
  description: "Classifier-free guidance scale. Higher values produce images more closely related to the prompt.",
};
const LORA_WEIGHTS = {
  type: "array",
  items: { type: "string" },
  nullable: true,
  description:
    "LoRA weights as a list of URLs. Supports ComfyUI and native Flux Klein format LoRAs. ComfyUI LoRAs are automatically converted.",
};
const LORA_SCALES = {
  type: "array",
  items: { type: "number" },
  nullable: true,
  description:
    "Scales for each LoRA as a list of floats. Must match the number of lora_weights. Defaults to 1.0 for each if not provided.",
};

/** Shared by all three; each endpoint adds the properties only it declares. */
const COMMON = {
  seed: SEED,
  images: IMAGES,
  prompt: PROMPT,
  aspect_ratio: ASPECT_RATIO,
  output_format: OUTPUT_FORMAT,
  output_quality: OUTPUT_QUALITY,
  output_megapixels: OUTPUT_MEGAPIXELS,
  disable_safety_checker: DISABLE_SAFETY_CHECKER,
};

const KLEIN_ENDPOINTS: readonly KleinEndpoint[] = [
  {
    id: "imgmdlklein4baaaaaaaaaaa",
    slug: "black-forest-labs/flux-2-klein-4b",
    label: "FLUX.2 klein 4B",
    versionId: "8e9c42d77b10a2a41af823ac4500f7545be6ebc4e745830fc3f3de10de200542",
    sort: 101,
    // Distilled: `go_fast`, no `guidance`.
    properties: { ...COMMON, go_fast: GO_FAST },
  },
  {
    id: "imgmdlklein4bbaseaaaaaaa",
    slug: "black-forest-labs/flux-2-klein-4b-base",
    label: "FLUX.2 klein 4B Base",
    versionId: "2289efa5ebba21f5322ba1b73ac92bb6fec9f34bafc08e0c26f465dac6f8b465",
    sort: 102,
    // The only one of the three with a guidance input.
    properties: { ...COMMON, go_fast: GO_FAST, guidance: GUIDANCE },
  },
  {
    id: "imgmdlklein4bbaseloraaaa",
    slug: "black-forest-labs/flux-2-klein-4b-base-lora",
    label: "FLUX.2 klein 4B Base LoRA",
    versionId: "c8ca755d41dd4a19b8fe1f50247bc6b37c73ac5321af8277d97c5e66e803ecdc",
    sort: 103,
    // Neither `go_fast` nor `guidance`; the array-shaped LoRA pair instead.
    properties: { ...COMMON, lora_weights: LORA_WEIGHTS, lora_scales: LORA_SCALES },
  },
];

const SEEDED_IDS = KLEIN_ENDPOINTS.map((endpoint) => endpoint.id);

/**
 * The derivation, through the package's real public entry point. The transport
 * is stubbed at `fetch`, so nothing reaches Replicate and no credential is used
 * beyond the literal below.
 */
async function probeCaptured(endpoint: KleinEndpoint): Promise<ProbeResult> {
  const schemas: Record<string, unknown> = {
    Input: { properties: endpoint.properties, required: ["prompt"] },
    // Carried for fidelity. The probe reads `Input` and nothing else, so the
    // capability record's `output` stays the contract's single-image default.
    Output: { type: "array", items: { type: "string", format: "uri" } },
  };
  for (const [name, values] of Object.entries(ENUMS)) schemas[name] = { enum: values };
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve(
        Response.json({
          name: endpoint.slug.split("/")[1],
          owner: endpoint.slug.split("/")[0],
          is_official: true,
          latest_version: { id: endpoint.versionId, openapi_schema: { components: { schemas } } },
        }),
      ),
    ),
  );
  try {
    return await createReplicateClient({
      apiToken: "seed-test-token",
      safetyCheckerDisabled: true,
      predictionTimeoutMs: DEFAULT_PREDICTION_TIMEOUT_MS,
    }).probeReplicateModel(endpoint.slug);
  } finally {
    vi.unstubAllGlobals();
  }
}

/** The shipped INSERT statements, read from the migration file itself. */
async function seedStatements(): Promise<string[]> {
  const sqlText = await readFile(path.join(process.cwd(), MIGRATION_FILE), "utf8");
  return sqlText
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.toUpperCase().includes("INSERT INTO "));
}

/** Re-run the migration's own statements. Idempotent by construction — that is what is under test. */
async function reapplySeeds(): Promise<void> {
  const statements = await seedStatements();
  // Three, always: a file this suite could not parse must fail before anything
  // is deleted, not after.
  expect(statements, `${MIGRATION_FILE} must carry three INSERT statements`).toHaveLength(3);
  for (const statement of statements) await db().execute(sql.raw(statement));
}

/** Every row whose provider path is this endpoint, version suffix or not. */
async function rowsForEndpoint(slug: string): Promise<{ id: string; slug: string; label: string; maxReferences: number }[]> {
  return db()
    .select({
      id: imageModels.id,
      slug: imageModels.slug,
      label: imageModels.label,
      maxReferences: imageModels.maxReferences,
    })
    .from(imageModels)
    .where(sql`split_part(${imageModels.slug}, ':', 1) = ${slug}`);
}

/**
 * Put the migrated state back: drop whatever a case planted for these three
 * endpoints, then let the shipped statements re-seed them. Deleting by
 * provider path rather than by id is deliberate — a case plants an
 * operator-style row under a DIFFERENT id, and leaving it behind would make the
 * bare-slug guard suppress the re-seed and strand the next case.
 */
async function restoreSeededRows(): Promise<void> {
  // Read and validate the statements BEFORE deleting anything: an unreadable
  // migration file must fail this suite, not strip three registry rows the rest
  // of the run expects to find.
  expect(await seedStatements(), `${MIGRATION_FILE} must carry three INSERT statements`).toHaveLength(3);
  for (const endpoint of KLEIN_ENDPOINTS) {
    await db().delete(imageModels).where(sql`split_part(${imageModels.slug}, ':', 1) = ${endpoint.slug}`);
  }
  await reapplySeeds();
}

/** True when the migrated state is already in place, untouched. */
async function seededRowsIntact(): Promise<boolean> {
  const rows = await db().select({ id: imageModels.id }).from(imageModels).where(inArray(imageModels.id, SEEDED_IDS));
  return rows.length === SEEDED_IDS.length;
}

beforeAll(async () => {
  if (!ready) return;
  // The ordinary path touches nothing: `pnpm db:migrate` already wrote these
  // rows and this suite asserts what the MIGRATION produced, so re-seeding a
  // healthy database would replace the very rows under test with rows this file
  // inserted. Restoring runs only when a previous run died mid-case and left an
  // operator fixture behind.
  if (!(await seededRowsIntact())) await restoreSeededRows();
});

afterAll(async () => {
  // The net. The guard cases below restore as they go, so this normally finds
  // the migrated state intact and does nothing; it exists so a case that fails
  // midway cannot leave the rows missing for the suites that follow in
  // `test:engine` — `image-generator.int.test.ts` reads them.
  if (ready && !(await seededRowsIntact())) await restoreSeededRows();
  await endTestPool();
});

// ---------------------------------------------------------------------------
// A fresh migrated database
// ---------------------------------------------------------------------------

describe.skipIf(!ready)("migration 0136 — FLUX.2 klein 4B seeds", () => {
  it("seeds one row per endpoint, and every row parses through parseRegistryRows", async () => {
    const sink = new DiagnosticCollector();
    const models = await loadImageModels(sink);
    const seeded = models.filter((model) => SEEDED_IDS.includes(model.id));

    expect(seeded.map((model) => model.id).sort()).toEqual([...SEEDED_IDS].sort());
    // `loadImageModels` drops an unparseable row with a diagnostic rather than
    // throwing, so "three came back" and "none was skipped" are two assertions.
    expect(sink.items.filter((item) => item.code === "image_model.row_invalid")).toEqual([]);

    for (const endpoint of KLEIN_ENDPOINTS) {
      const model = seeded.find((candidate) => candidate.id === endpoint.id);
      expect(model, `${endpoint.slug} must be seeded`).toBeDefined();
      // The BARE slug: these are official models, and the bare-slug prediction
      // endpoint is official-models-only. The pin lives in its own column.
      expect(model?.slug).toBe(endpoint.slug);
      expect(model?.slug).not.toContain(":");
      expect(model?.label).toBe(endpoint.label);
      expect(model?.sort).toBe(endpoint.sort);
    }
  });

  it("carries no surface flag and no reviewed rating, so no production surface changes", async () => {
    const models = await loadImageModels();
    const seeded = models.filter((model) => SEEDED_IDS.includes(model.id));
    expect(seeded).toHaveLength(3);

    for (const model of seeded) {
      // The player-facing pickers offer PROFILES, and this migration writes
      // none; these three flags are the remaining legacy surface toggles.
      expect(model.forPortrait).toBe(false);
      expect(model.forVariant).toBe(false);
      expect(model.forScene).toBe(false);
      expect(model.builtin).toBe(true);
      // Reviewed, never probed. `unknown` is a statement about Vesper's
      // evidence — no trial has graded these — and is the permissive default.
      expect(model.editKind).toBe("unknown");
      expect(model.identityPreservation).toBe("unknown");
      expect(model.referenceTransport).toBe("file");
      // The warning an operator actually sees, and it must not imply a run happened.
      expect(model.operatorWarning).toContain("Untried in Vesper");
      expect(model.operatorWarning).toContain("no production surface");
    }
  });

  it("seeds no image_model_profiles row for any of the three", async () => {
    // No profile means no player-facing picker can reach these rows at all:
    // the production pickers offer profiles, and the Image Generator is the
    // one surface that runs a registered row without one.
    const profiles = await db()
      .select({ id: imageModelProfiles.id })
      .from(imageModelProfiles)
      .where(inArray(imageModelProfiles.imageModelId, SEEDED_IDS));
    expect(profiles).toEqual([]);
  });

  // The checklist item this suite exists for.
  it.each(KLEIN_ENDPOINTS.map((endpoint) => ({ endpoint, name: endpoint.slug })))(
    "seeds $name with exactly the columns probeReplicateModel derives for its pinned version",
    async ({ endpoint }) => {
      const result = await probeCaptured(endpoint);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.probe.versionId).toBe(endpoint.versionId);

      const models = await loadImageModels();
      const model = models.find((candidate) => candidate.id === endpoint.id);
      expect(model).toBeDefined();
      if (!model) return;

      // `imageModelProbeFields` is the CREATE write set the admin add path uses
      // — every probe-owned column and nothing reviewed or curated. Comparing
      // the whole set at once is the point: a column the migration typed by hand
      // would otherwise only be caught if someone thought to assert it.
      const derived = imageModelProbeFields(result.probe);
      expect({
        canGenerate: model.canGenerate,
        canEdit: model.canEdit,
        referenceField: model.referenceField,
        referenceArity: model.referenceArity,
        aspectMode: model.aspectMode,
        supportedAspects: model.supportedAspects,
        outputFormat: model.outputFormat,
        extraInput: model.extraInput,
        advancedCapabilities: model.advancedCapabilities,
        probedVersionId: model.probedVersionId,
      }).toEqual(derived);

      // `maxReferences` is NOT in that write set — it is a curated column a
      // re-probe may never rewrite — so the seeded value is checked against the
      // probe's own starting figure separately. Five, from "Maximum 5 images".
      expect(model.maxReferences).toBe(result.probe.maxReferences);
      expect(model.maxReferences).toBe(5);

      // Called out individually because each is a way the row could look right
      // and render wrong.
      expect(model.supportedAspects).not.toContain("match_input_image");
      expect(model.supportedAspects).toContain("3:4");
      expect(model.outputFormat).toBe("webp");
      expect(model.extraInput).toMatchObject({ disable_safety_checker: true, output_quality: 95 });
      expect(model.advancedCapabilities.output).toEqual({ arity: "single", supportsMultiple: false });
    },
  );

  it("gives each endpoint only the controls its own version declares", async () => {
    const models = await loadImageModels();
    const bySlug = new Map(models.map((model) => [model.slug, model]));
    const controls = (slug: string) => bySlug.get(slug)?.advancedCapabilities.controls;

    const distilled = controls("black-forest-labs/flux-2-klein-4b");
    const base = controls("black-forest-labs/flux-2-klein-4b-base");
    const lora = controls("black-forest-labs/flux-2-klein-4b-base-lora");

    // Seed everywhere; fast mode on the two that declare `go_fast`; guidance on
    // `-base` alone; the array LoRA pair on `-base-lora` alone. Sending a
    // control to a field the pinned version does not declare is a provider
    // rejection at spend time, so these absences are load-bearing.
    expect(distilled?.seed).toEqual({ field: "seed", type: "integer" });
    expect(base?.seed).toEqual({ field: "seed", type: "integer" });
    expect(lora?.seed).toEqual({ field: "seed", type: "integer" });

    expect(distilled?.fastMode).toEqual({ field: "go_fast", type: "boolean" });
    expect(base?.fastMode).toEqual({ field: "go_fast", type: "boolean" });
    expect(lora?.fastMode).toBeUndefined();

    expect(base?.guidance).toEqual({ field: "guidance", type: "number", minimum: 1, maximum: 10 });
    expect(distilled?.guidance).toBeUndefined();
    expect(lora?.guidance).toBeUndefined();

    expect(lora?.loraWeights).toEqual({ field: "lora_weights", type: "string", arity: "array" });
    expect(lora?.loraScale).toEqual({ field: "lora_scales", type: "number", arity: "array" });
    expect(distilled?.loraWeights).toBeUndefined();
    expect(base?.loraWeights).toBeUndefined();

    // `output_megapixels` is a STRING enum with no tier members, so it is a raw
    // Advanced input rather than a resolution-tier control on any of the three.
    for (const control of [distilled, base, lora]) expect(control?.resolutionTier).toBeUndefined();
  });

  it("registers no 9B sibling", async () => {
    const models = await loadImageModels();
    // The 9B endpoints are published under a non-commercial licence (#564) and
    // are deliberately outside this migration.
    expect(models.filter((model) => model.slug.includes("klein-9b"))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The upgrade path
// ---------------------------------------------------------------------------

describe.skipIf(!ready)("migration 0136 — history and upgrade", () => {
  it("follows 0135 in the journal, as a data migration with no schema snapshot", async () => {
    const journal = JSON.parse(
      await readFile(path.join(process.cwd(), "drizzle", "meta", "_journal.json"), "utf8"),
    ) as { entries: { idx: number; tag: string; when: number }[] };

    const entry = journal.entries.find((candidate) => candidate.tag === MIGRATION_TAG);
    expect(entry).toBeDefined();
    expect(entry?.idx).toBe(136);

    const previous = journal.entries.find((candidate) => candidate.idx === 135);
    expect(previous?.tag).toBe("0135_fal-qwen-image-3");
    // The migrator applies in `when` order, so an entry timestamped before its
    // predecessor would run 0136 against a database 0135 had not reached.
    expect(entry?.when).toBeGreaterThan(previous?.when ?? 0);
    // Indices are unique and contiguous at the head: a duplicate 136 from a
    // concurrent branch is exactly the merge accident this catches.
    expect(journal.entries.filter((candidate) => candidate.idx === 136)).toHaveLength(1);
    expect(Math.max(...journal.entries.map((candidate) => candidate.idx))).toBe(136);
  });

  it("carries no drizzle snapshot, because it changes no schema", async () => {
    // Data migrations 0132–0135 ship none either; a snapshot here would claim a
    // `schema.ts` change this file does not make.
    const missing = await readFile(path.join(process.cwd(), "drizzle", "meta", "0136_snapshot.json"), "utf8").then(
      () => false,
      () => true,
    );
    expect(missing).toBe(true);
  });

  it("leaves the three rows present after the harness's full migrate", async () => {
    // This database was migrated from the baseline through 0136 by the ordinary
    // `pnpm db:migrate`, so the rows existing here IS the upgrade result — there
    // is no fresh-versus-upgraded distinction to draw from inside the suite.
    const rows = await db().select({ id: imageModels.id }).from(imageModels).where(inArray(imageModels.id, SEEDED_IDS));
    expect(rows.map((row) => row.id).sort()).toEqual([...SEEDED_IDS].sort());
  });
});

// ---------------------------------------------------------------------------
// The two guards, beside a row an operator already added
// ---------------------------------------------------------------------------

describe.skipIf(!ready)("migration 0136 — guards over an existing row", () => {
  const endpoint = KLEIN_ENDPOINTS[0] as KleinEndpoint;
  const OPERATOR_ID = "imgmdlklein4boperatoraaa";

  afterAll(async () => {
    if (!ready) return;
    await db().delete(imageModels).where(eq(imageModels.id, OPERATOR_ID));
    await restoreSeededRows();
  });

  it("does not duplicate an endpoint an operator added under a version-suffixed slug", async () => {
    // The admin add path auto-pins, so a hand-added official row can be stored
    // as `owner/name:<version>`. That slug is not EQUAL to the bare one, so the
    // unique index would not catch it — only the `split_part` guard can, and
    // without it every picker would list this endpoint twice.
    await db().delete(imageModels).where(inArray(imageModels.id, SEEDED_IDS));
    await db()
      .insert(imageModels)
      .values({
        id: OPERATOR_ID,
        slug: `${endpoint.slug}:${endpoint.versionId}`,
        label: "Operator's klein 4B",
        canGenerate: true,
        canEdit: true,
        referenceField: "images",
        referenceArity: "array",
        maxReferences: 2,
        probedVersionId: endpoint.versionId,
      });

    await reapplySeeds();

    const rows = await rowsForEndpoint(endpoint.slug);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(OPERATOR_ID);
    // Untouched, not merely un-duplicated: the guard is `WHERE NOT EXISTS`, so
    // the statement inserts nothing at all rather than merging anything in.
    expect(rows[0]?.label).toBe("Operator's klein 4B");
    expect(rows[0]?.maxReferences).toBe(2);
    // The two siblings are NOT suppressed by it: the guard compares provider
    // paths for EQUALITY, so `…-4b` does not match `…-4b-base`.
    for (const sibling of KLEIN_ENDPOINTS.slice(1)) {
      const siblingRows = await rowsForEndpoint(sibling.slug);
      expect(siblingRows, `${sibling.slug} must still be seeded`).toHaveLength(1);
      expect(siblingRows[0]?.id).toBe(sibling.id);
    }

    await db().delete(imageModels).where(eq(imageModels.id, OPERATOR_ID));
    await restoreSeededRows();
  });

  it("preserves an operator's curation on an existing BARE row rather than overwriting it", async () => {
    // The second guard's case: same slug, so `ON CONFLICT ("slug") DO NOTHING`
    // would cover it even if `WHERE NOT EXISTS` did not. Both must be no-ops —
    // a migration that re-asserted its own values here would silently undo a
    // reference cap or a label an operator corrected by hand.
    await db().delete(imageModels).where(inArray(imageModels.id, SEEDED_IDS));
    await db()
      .insert(imageModels)
      .values({
        id: OPERATOR_ID,
        slug: endpoint.slug,
        label: "klein 4B (operator-tuned)",
        canGenerate: true,
        canEdit: true,
        referenceField: "images",
        referenceArity: "array",
        // Deliberately NOT the seeded 5: a curated cap an operator lowered.
        maxReferences: 3,
        probedVersionId: endpoint.versionId,
      });

    await reapplySeeds();

    const rows = await rowsForEndpoint(endpoint.slug);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(OPERATOR_ID);
    expect(rows[0]?.label).toBe("klein 4B (operator-tuned)");
    expect(rows[0]?.maxReferences).toBe(3);
    // And the seeded id is genuinely absent — the no-op did not write it under
    // a second row that the endpoint query above happened not to surface.
    const [seededRow] = await db().select({ id: imageModels.id }).from(imageModels).where(eq(imageModels.id, endpoint.id));
    expect(seededRow).toBeUndefined();

    await db().delete(imageModels).where(eq(imageModels.id, OPERATOR_ID));
    await restoreSeededRows();
  });

  it("re-running the shipped statements against the migrated state changes nothing", async () => {
    // Idempotence stated directly: a deploy that replays this file — or a
    // second migrator run — must not rewrite a row it already wrote. Timestamps
    // are left out of the comparison because an UPDATE is exactly what would
    // move them, and this asserts no write happened at all through the values.
    const snapshot = async () =>
      (
        await db()
          .select({
            id: imageModels.id,
            slug: imageModels.slug,
            label: imageModels.label,
            maxReferences: imageModels.maxReferences,
            supportedAspects: imageModels.supportedAspects,
            outputFormat: imageModels.outputFormat,
            extraInput: imageModels.extraInput,
            probedVersionId: imageModels.probedVersionId,
            advancedCapabilities: imageModels.advancedCapabilities,
            operatorWarning: imageModels.operatorWarning,
            sort: imageModels.sort,
          })
          .from(imageModels)
          .where(inArray(imageModels.id, SEEDED_IDS))
      ).sort((a, b) => (a.id < b.id ? -1 : 1));

    const before = await snapshot();
    expect(before).toHaveLength(3);
    await reapplySeeds();
    expect(await snapshot()).toEqual(before);
  });
});
