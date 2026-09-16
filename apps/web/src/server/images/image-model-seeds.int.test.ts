import { readFile } from "node:fs/promises";
import path from "node:path";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ImageExecutionContext } from "@vesper/image-core";
import { createReplicateClient, DEFAULT_PREDICTION_TIMEOUT_MS, type ProbeResult } from "@vesper/image-replicate";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import { endTestPool, probeIntegrationDb } from "@/server/test-support";
import { db, imageLoras, imageModelProfiles, imageModels } from "../db";
import { imageModelProbeFields } from "./identity-trial-model-versions";
import { type ImageLoraResolution, listImageLoras, loadImageLora, resolveImageLoraForRender } from "./image-loras";
import { loadImageModels } from "./models";

/**
 * What the hand-written image-registry migrations actually put in a migrated
 * database, and what they do beside a row an operator already added.
 *
 * 0136 seeds the three FLUX.2 klein 4B model rows; 0137 seeds the one curated
 * `image_loras` row that names the third of them. They are asserted in one file
 * because the claim that matters spans both: the LoRA row's compatible version
 * id has to be the version the model row is actually pinned to, and nothing but
 * a migrated database can say whether those two hand-written literals agree.
 * 0138 then corrects one column on a row 0133 seeded — the `qwen/qwen-image-2`
 * reference transport — which belongs here for the same reason: whether a
 * catalog UPDATE reached the row it names, left every other row alone, and
 * honoured a deletion is a question only a migrated database answers. 0139
 * seeds the FLUX.1 Kontext Dev row, whose guard has to tell one provider path
 * from a sibling endpoint whose path EXTENDS it — the difference between an
 * equality test and a prefix match, and the difference between a fresh database
 * getting the row and silently not.
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
 *
 * `required`, `enums` and `output` default to the shape the three klein
 * endpoints share; a capture that differs in any of them passes its own,
 * because each one changes what the probe derives. A reference listed in
 * `required` is what makes a row edit-only, and two endpoints' aspect enums are
 * not interchangeable even when they offer the same count of ratios — order and
 * membership both reach the stored column.
 */
async function probeCaptured(endpoint: {
  slug: string;
  versionId: string;
  properties: Record<string, unknown>;
  required?: readonly string[];
  enums?: Record<string, readonly string[]>;
  output?: Record<string, unknown>;
}): Promise<ProbeResult> {
  const enums: Record<string, readonly string[]> = endpoint.enums ?? ENUMS;
  const schemas: Record<string, unknown> = {
    Input: { properties: endpoint.properties, required: [...(endpoint.required ?? ["prompt"])] },
    // Carried for fidelity. The probe reads `Input` and nothing else, so the
    // capability record's `output` stays the contract's single-image default.
    Output: endpoint.output ?? { type: "array", items: { type: "string", format: "uri" } },
  };
  for (const [name, values] of Object.entries(enums)) schemas[name] = { enum: values };
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

/**
 * The statements one migration file ships whose text contains `keyword`, in file
 * order — `INSERT INTO` for a seed, `UPDATE "image_models"` for a catalog
 * correction.
 *
 * Read from the file rather than restated here, which is the whole point: what
 * is under test is the SQL that ships, so a test that re-typed the statement
 * would pass against a migration it does not describe. A returned chunk carries
 * its leading `--` comment block as well; Postgres ignores it, and what ships is
 * what runs.
 */
async function migrationStatements(file: string, keyword: string): Promise<string[]> {
  const sqlText = await readFile(path.join(process.cwd(), file), "utf8");
  return sqlText
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.toUpperCase().includes(keyword.toUpperCase()));
}

/** The INSERT statements one migration file ships, in file order. */
function insertStatements(file: string): Promise<string[]> {
  return migrationStatements(file, "INSERT INTO ");
}

/** 0136's shipped INSERT statements. */
function seedStatements(): Promise<string[]> {
  return insertStatements(MIGRATION_FILE);
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
  // The same net for 0137's row: the retune case below leaves the band changed
  // if it dies partway, and the next run would then assert against it.
  if (ready && !(await seededLoraIntact())) await restoreSeededLora();
  // And for the row 0133 seeds and 0138 corrects: the guard cases below delete
  // it outright, and a suite that follows would otherwise find the endpoint
  // missing from the registry entirely.
  //
  // Note what this net restores: the POST-0138 state, replayed from the shipped
  // files. On CI that is harmless — the workflow migrates a fresh database from
  // zero for every run and tears it down after. Against a long-lived local
  // database that never had 0138 applied, a first run fails correctly and this
  // net then writes `data_url`, so a second run would pass on state this file
  // created rather than state the migration produced. Re-run `pnpm db:migrate`
  // rather than trusting a green second run on a database of unknown vintage.
  //
  // There is deliberately no matching `beforeAll` restore for this row, unlike
  // the klein block above: a restore that ran BEFORE the assertions would mask
  // the un-migrated case outright, which is the one case worth failing on. The
  // cost is that a run killed between `restoreQwenImage2Row`'s DELETE and its
  // re-INSERT leaves the next run reporting a missing row instead of healing.
  if (ready && !(await qwenImage2Intact())) await restoreQwenImage2Row();
  // And for the row 0139 seeds: its guard cases delete it outright, and
  // `image-generator.int.test.ts` reads the registry after this file runs.
  if (ready && !(await kontextIntact())) await restoreKontextRow();
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
    // A duplicate 136 from a concurrent branch is exactly the merge accident this
    // catches. Which index sits at the HEAD is asserted by the newest migration's
    // own suite instead, so this case does not have to be edited every time a
    // later migration lands.
    expect(journal.entries.filter((candidate) => candidate.idx === 136)).toHaveLength(1);
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

// ---------------------------------------------------------------------------
// Migration 0137 — the curated klein 4B RefControl depth LoRA row
// ---------------------------------------------------------------------------

const LORA_MIGRATION_TAG = "0137_klein-4b-refcontrol-depth-lora";
const LORA_MIGRATION_FILE = `drizzle/${LORA_MIGRATION_TAG}.sql`;
const DEPTH_LORA_ID = "imglorklein4brefdepthaaa";

/** The third 0136 endpoint — the only one of the three that accepts LoRA weights. */
const KLEIN_BASE_LORA = KLEIN_ENDPOINTS[2] as KleinEndpoint;

/**
 * Every field 0137 writes, as the library reader hands it back.
 *
 * `compatibleModelSlugs` and `compatibleVersionIds` are built from the 0136
 * endpoint constant rather than retyped, because agreeing with the model row is
 * the property under test: a version id that drifted from the one the model row
 * pins would refuse every render, and two independent transcriptions of the same
 * 64-character hex string is exactly how that happens.
 *
 * `maximumScale` is written as `1` because that is the JavaScript number a
 * `double precision` 1.0 reads back as — the column is float8 precisely so a
 * stored 0.9 does not return 0.8999999761581421.
 */
const DEPTH_LORA_ROW = {
  id: DEPTH_LORA_ID,
  label: "FLUX.2 klein 4B RefControl depth (pilot)",
  locatorType: "https_url",
  locator:
    "https://snarebox-pub.s3.us-east-2.amazonaws.com/lora/flux2_klein_4b_refcontrol_depth-65ec4c71.safetensors",
  compatibleModelSlugs: [KLEIN_BASE_LORA.slug],
  compatibleVersionIds: [KLEIN_BASE_LORA.versionId],
  defaultScale: 0.9,
  minimumScale: 0.8,
  maximumScale: 1,
  triggerWords: ["refcontrol"],
  promptPrefix: null,
  promptSuffix: null,
  allowedTasks: [],
  enabled: true,
  builtin: true,
};

/** Re-run 0137's own statement. Idempotent by construction — that is what is under test. */
async function reapplyLoraSeed(): Promise<void> {
  const statements = await insertStatements(LORA_MIGRATION_FILE);
  // One, always: a file this suite could not parse must fail before anything is
  // deleted, not after.
  expect(statements, `${LORA_MIGRATION_FILE} must carry exactly one INSERT statement`).toHaveLength(1);
  for (const statement of statements) await db().execute(sql.raw(statement));
}

/**
 * Put the seeded row back exactly as the migration writes it.
 *
 * By deleting and re-running the shipped statement rather than by UPDATEing the
 * values back: restoring from literals typed in this file would restore whatever
 * this file believes, which is the one thing a test of the migration must not
 * assume.
 */
async function restoreSeededLora(): Promise<void> {
  expect(
    await insertStatements(LORA_MIGRATION_FILE),
    `${LORA_MIGRATION_FILE} must carry exactly one INSERT statement`,
  ).toHaveLength(1);
  await db().delete(imageLoras).where(eq(imageLoras.id, DEPTH_LORA_ID));
  await reapplyLoraSeed();
}

/** True when the row is present with the band the migration wrote. */
async function seededLoraIntact(): Promise<boolean> {
  const lora = await loadImageLora(DEPTH_LORA_ID);
  if (!lora) return false;
  return (
    lora.minimumScale === DEPTH_LORA_ROW.minimumScale &&
    lora.defaultScale === DEPTH_LORA_ROW.defaultScale &&
    lora.maximumScale === DEPTH_LORA_ROW.maximumScale
  );
}

/**
 * Resolve the seeded row against the seeded model row, through the server seam a
 * render actually calls.
 *
 * `resolveImageLoraForRender` rather than the pure evaluator on purpose. The pure
 * decision table is already pinned in `packages/image-core/src/loras/image-loras.test.ts`
 * against a synthetic locator and hand-written bindings, and it would answer the
 * same way whatever the migration wrote. What is unproven until a migrated
 * database exists is whether the two SEEDED ROWS agree: whether the version id in
 * this row's compatibility list is the one the model row pins, and whether that
 * model row's probed bindings really expose the array-shaped pair this endpoint
 * needs.
 */
async function resolveDepthLora(execution: ImageExecutionContext, scale?: number): Promise<ImageLoraResolution> {
  const models = await loadImageModels();
  const model = models.find((candidate) => candidate.slug === KLEIN_BASE_LORA.slug);
  if (!model) throw new Error(`${KLEIN_BASE_LORA.slug} must be seeded by ${MIGRATION_TAG}`);
  return resolveImageLoraForRender(
    { id: DEPTH_LORA_ID, ...(scale === undefined ? {} : { scale }) },
    // The version the render would execute is the row's own pin, which is what
    // the Image Generator sends for a bare-slug official model.
    { model, versionId: model.probedVersionId, execution },
  );
}

describe.skipIf(!ready)("migration 0137 — the klein 4B RefControl depth LoRA row", () => {
  it("seeds exactly the documented row, and it parses through the library reader", async () => {
    const sink = new DiagnosticCollector();
    const loras = await listImageLoras(sink);
    const seeded = loras.find((lora) => lora.id === DEPTH_LORA_ID);

    expect(seeded, "0137 must seed the RefControl depth row").toBeDefined();
    // `listImageLoras` DROPS an unparseable row with a diagnostic rather than
    // throwing, so "it came back" and "nothing was skipped" are two assertions.
    expect(sink.items.filter((item) => item.code === "image_lora.row_invalid")).toEqual([]);
    // The whole row at once: a column the migration typed by hand would otherwise
    // only be caught if someone thought to assert that particular one.
    expect(seeded).toEqual(DEPTH_LORA_ROW);
  });

  it("names only the -base-lora endpoint, and pins the version its curation was tied to", async () => {
    const lora = await loadImageLora(DEPTH_LORA_ID);
    expect(lora?.compatibleModelSlugs).toEqual([KLEIN_BASE_LORA.slug]);
    // Neither sibling, under any spelling. The two other klein 4B rows declare no
    // LoRA pair at all, and a resembling name is not compatibility.
    for (const sibling of KLEIN_ENDPOINTS.slice(0, 2)) {
      expect(lora?.compatibleModelSlugs).not.toContain(sibling.slug);
    }
    // Non-empty on purpose, unlike the intimate-scene row 0108 seeds: it means
    // "these weights do not survive a version change", so a version move is an
    // explicit re-curation rather than something this migration pre-authorized.
    expect(lora?.compatibleVersionIds).toEqual([KLEIN_BASE_LORA.versionId]);

    // And that pinned id is the version the model row actually runs — the one
    // cross-row fact neither migration can state about itself.
    const models = await loadImageModels();
    const model = models.find((candidate) => candidate.slug === KLEIN_BASE_LORA.slug);
    expect(model?.probedVersionId).toBe(KLEIN_BASE_LORA.versionId);
  });

  it("resolves on the generator bench at its default scale, against the seeded model row", async () => {
    const resolved = await resolveDepthLora({ kind: "generator_bench" });

    expect(resolved).toEqual({
      ok: true,
      binding: {
        id: DEPTH_LORA_ID,
        label: DEPTH_LORA_ROW.label,
        // The stored locator reaches the provider verbatim: an `https_url` needs
        // no completion, and nothing is appended to it at send time.
        locator: DEPTH_LORA_ROW.locator,
        scale: 0.9,
        promptPrefix: null,
        promptSuffix: null,
        triggerWords: ["refcontrol"],
      },
    });
  });

  it("is Generator-only: the same row is refused for a production task and for the Lab", async () => {
    // Empty `allowedTasks` is read fail-closed, and `generator_bench` skips task
    // curation because it serves no lane. Both halves are asserted here because
    // the row's whole eligibility claim is the difference between them.
    expect(await resolveDepthLora({ kind: "production", task: "scene" })).toMatchObject({
      ok: false,
      code: "image_lora.incompatible",
    });
    expect(await resolveDepthLora({ kind: "production", task: "portrait" })).toMatchObject({
      ok: false,
      code: "image_lora.incompatible",
    });
    // The Lab reproduces production and is judged by production's rules, so the
    // row does not become eligible there either.
    expect(await resolveDepthLora({ kind: "image_lab", task: "scene" })).toMatchObject({
      ok: false,
      code: "image_lora.incompatible",
    });
  });

  it("refuses a scale outside the seeded 0.8–1.0 pilot band rather than clamping it", async () => {
    for (const scale of [0.7, 1.1]) {
      expect(await resolveDepthLora({ kind: "generator_bench" }, scale)).toMatchObject({
        ok: false,
        code: "image_lora.incompatible",
      });
    }
    // The edges themselves are inside the band, which is what makes #569's
    // three-arm comparison runnable at all.
    for (const scale of [0.8, 1]) {
      expect(await resolveDepthLora({ kind: "generator_bench" }, scale)).toMatchObject({ ok: true });
    }
  });

  it("follows 0136 in the journal, as a data migration with no schema snapshot", async () => {
    const journal = JSON.parse(
      await readFile(path.join(process.cwd(), "drizzle", "meta", "_journal.json"), "utf8"),
    ) as { entries: { idx: number; tag: string; when: number }[] };

    const entry = journal.entries.find((candidate) => candidate.tag === LORA_MIGRATION_TAG);
    expect(entry).toBeDefined();
    expect(entry?.idx).toBe(137);

    const previous = journal.entries.find((candidate) => candidate.idx === 136);
    expect(previous?.tag).toBe(MIGRATION_TAG);
    // The migrator applies in `when` order, so an entry timestamped before its
    // predecessor would seed this row against a database 0136 had not reached —
    // and the model row it names would not exist yet.
    expect(entry?.when).toBeGreaterThan(previous?.when ?? 0);
    // A duplicate 137 from a concurrent branch is the merge accident this
    // catches. Which index sits at the HEAD is asserted by the newest
    // migration's own suite instead, so this case does not have to be edited
    // every time a later migration lands.
    expect(journal.entries.filter((candidate) => candidate.idx === 137)).toHaveLength(1);

    // Data migrations 0132–0136 ship no snapshot either; one here would claim a
    // `schema.ts` change this file does not make.
    const missing = await readFile(path.join(process.cwd(), "drizzle", "meta", "0137_snapshot.json"), "utf8").then(
      () => false,
      () => true,
    );
    expect(missing).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 0137 beside an admin who has since edited the row
// ---------------------------------------------------------------------------

describe.skipIf(!ready)("migration 0137 — the guard over an admin's curation", () => {
  afterAll(async () => {
    if (!ready) return;
    await restoreSeededLora();
  });

  it("re-executing the shipped statement changes nothing, timestamps included", async () => {
    // Idempotence stated directly. `updated_at` is INSIDE the comparison here,
    // unlike the model-row case above: `ON CONFLICT DO NOTHING` performs no write
    // at all, so even the bookkeeping column must be untouched, and a statement
    // that had quietly become an upsert would move it.
    const snapshot = () => db().select().from(imageLoras).where(eq(imageLoras.id, DEPTH_LORA_ID));

    const before = await snapshot();
    expect(before).toHaveLength(1);
    await reapplyLoraSeed();
    expect(await snapshot()).toEqual(before);
  });

  it("leaves an admin's retuned band alone instead of re-asserting the seeded one", async () => {
    // Seeded rows are ordinary rows: an admin may retune this band, and the
    // retuned value is the one every later render is judged against. A migration
    // that re-asserted its own numbers here would silently undo that.
    await db()
      .update(imageLoras)
      .set({ minimumScale: 0.5, defaultScale: 0.6 })
      .where(eq(imageLoras.id, DEPTH_LORA_ID));

    await reapplyLoraSeed();

    const retuned = await loadImageLora(DEPTH_LORA_ID);
    expect(retuned?.minimumScale).toBe(0.5);
    expect(retuned?.defaultScale).toBe(0.6);
    expect(retuned?.maximumScale).toBe(1);
    // A second row was not written under the same curation either — the conflict
    // target is the primary key, so there is exactly one row to find.
    const rows = await db().select({ id: imageLoras.id }).from(imageLoras).where(eq(imageLoras.id, DEPTH_LORA_ID));
    expect(rows).toHaveLength(1);

    await restoreSeededLora();
    expect(await loadImageLora(DEPTH_LORA_ID)).toEqual(DEPTH_LORA_ROW);
  });
});

// ---------------------------------------------------------------------------
// Migration 0138 — the Qwen Image 2 reference transport
// ---------------------------------------------------------------------------

const TRANSPORT_MIGRATION_TAG = "0138_qwen-image-2-data-url-transport";
const TRANSPORT_MIGRATION_FILE = `drizzle/${TRANSPORT_MIGRATION_TAG}.sql`;
const QWEN_IMAGE_2_SEED_FILE = "drizzle/0133_qwen-image-2.sql";

/**
 * The row 0133 seeded and 0138 corrects.
 *
 * `qwen/qwen-image-2` rejects Replicate's own uploaded-file URLs — it validates
 * the file extension of what reaches the model container, and an upload arrives
 * there without one — so every reference-bearing render on the `file` transport
 * fails with `ValueError: Invalid image format ''` while prompt-only generation
 * works. The transport is the ONLY column that separates a dead edit path from a
 * working one, and no probe can discover it: `reference_transport` is owner-set
 * and outside every probe write set, so nothing but a migration converges it.
 */
const QWEN_IMAGE_2 = {
  id: "imgmdlqwenimage2aaaaaaaa",
  slug: "qwen/qwen-image-2",
  versionId: "266e594fa007032292c211586354fe193d7aa4e675a1eeb0aef0c6a424468ddd",
} as const;

/**
 * The registered Qwen rows that render from the SAME uploaded-file URLs without
 * complaint. This is a per-wrapper validation quirk of one endpoint rather than a
 * Replicate-wide or Qwen-wide fact, and a migration that blurred it — a
 * `LIKE 'qwen/qwen-image-2%'`, a prefix match — would move both of these onto
 * inlined bytes as well, paying a larger request body on every render to fix a
 * failure neither has.
 */
const FILE_TRANSPORT_SIBLINGS = ["qwen/qwen-image-edit-2511", "qwen/qwen-image-2512"] as const;

/** 0138's shipped statement. It is an UPDATE, so it ships no INSERT at all. */
function transportStatements(): Promise<string[]> {
  return migrationStatements(TRANSPORT_MIGRATION_FILE, 'UPDATE "image_models"');
}

/** Re-run 0138's own statement. Idempotent by construction — that is what is under test. */
async function reapplyTransportFix(): Promise<void> {
  const statements = await transportStatements();
  expect(statements, `${TRANSPORT_MIGRATION_FILE} must carry exactly one image_models UPDATE`).toHaveLength(1);
  for (const statement of statements) await db().execute(sql.raw(statement));
}

/** The stored transport for this endpoint's provider path, however its slug is spelled. */
async function transportFor(slug: string): Promise<string | undefined> {
  const [row] = await db()
    .select({ transport: imageModels.referenceTransport })
    .from(imageModels)
    .where(sql`split_part(${imageModels.slug}, ':', 1) = ${slug}`);
  return row?.transport;
}

/**
 * Put the migrated state back by replaying BOTH shipped statements in order:
 * 0133 inserts the row at `file`, 0138 corrects it. Restoring from literals typed
 * here would restore whatever this file believes, and the composition is itself
 * the deploy path — 0138 has no row to correct unless 0133 ran first.
 *
 * Deleting by provider path rather than by id is what makes the re-seed possible
 * at all: 0133's guard is `WHERE NOT EXISTS` on that path, so an operator-style
 * row left behind under a different id would suppress it.
 */
async function restoreQwenImage2Row(): Promise<void> {
  // Read and validate both files BEFORE deleting: an unreadable migration must
  // fail the suite, not strip a registry row the rest of the run expects to find.
  const seed = await insertStatements(QWEN_IMAGE_2_SEED_FILE);
  expect(seed, `${QWEN_IMAGE_2_SEED_FILE} must carry exactly one INSERT statement`).toHaveLength(1);
  expect(await transportStatements(), `${TRANSPORT_MIGRATION_FILE} must carry one UPDATE`).toHaveLength(1);
  await db().delete(imageModels).where(sql`split_part(${imageModels.slug}, ':', 1) = ${QWEN_IMAGE_2.slug}`);
  for (const statement of seed) await db().execute(sql.raw(statement));
  await reapplyTransportFix();
}

/** True when the migrated state is already in place: the row exists, corrected. */
async function qwenImage2Intact(): Promise<boolean> {
  const [row] = await db()
    .select({ transport: imageModels.referenceTransport })
    .from(imageModels)
    .where(eq(imageModels.id, QWEN_IMAGE_2.id));
  return row?.transport === "data_url";
}

describe.skipIf(!ready)("migration 0138 — the Qwen Image 2 reference transport", () => {
  it("leaves the seeded row on the inlined data: transport", async () => {
    const sink = new DiagnosticCollector();
    const models = await loadImageModels(sink);
    const model = models.find((candidate) => candidate.id === QWEN_IMAGE_2.id);

    expect(model, `${QWEN_IMAGE_2.slug} must be seeded by 0133`).toBeDefined();
    // `loadImageModels` DROPS an unparseable row with a diagnostic rather than
    // throwing, so "it came back" and "nothing was skipped" are two assertions.
    expect(sink.items.filter((item) => item.code === "image_model.row_invalid")).toEqual([]);
    // The checklist item this suite exists for: a row that regressed to `file`
    // renders `ValueError: Invalid image format ''` on every reference-bearing
    // run, and nothing in a schema, a probe or a typecheck would say so.
    expect(model?.referenceTransport).toBe("data_url");
  });

  it("changes nothing else about the row 0133 seeded", async () => {
    const models = await loadImageModels();
    const model = models.find((candidate) => candidate.id === QWEN_IMAGE_2.id);
    expect(model).toBeDefined();
    if (!model) return;

    // Making an endpoint REACHABLE is not grading it. A migration that quietly
    // took the opportunity to flip a surface flag or write a rating would put an
    // untried endpoint in a player-facing picker, which is the failure this
    // asserts against rather than the transport itself.
    expect({
      slug: model.slug,
      canGenerate: model.canGenerate,
      canEdit: model.canEdit,
      referenceField: model.referenceField,
      referenceArity: model.referenceArity,
      maxReferences: model.maxReferences,
      aspectMode: model.aspectMode,
      outputFormat: model.outputFormat,
      extraInput: model.extraInput,
      probedVersionId: model.probedVersionId,
      editKind: model.editKind,
      identityPreservation: model.identityPreservation,
      forPortrait: model.forPortrait,
      forVariant: model.forVariant,
      forScene: model.forScene,
      builtin: model.builtin,
      sort: model.sort,
    }).toEqual({
      slug: QWEN_IMAGE_2.slug,
      canGenerate: true,
      canEdit: true,
      referenceField: "image",
      // A single URI string, not 2511's array: the field NAME matching is a
      // coincidence of provider naming, not a shared shape.
      referenceArity: "single",
      maxReferences: 1,
      aspectMode: "aspect_ratio",
      outputFormat: null,
      extraInput: {},
      probedVersionId: QWEN_IMAGE_2.versionId,
      editKind: "unknown",
      identityPreservation: "unknown",
      forPortrait: false,
      forVariant: false,
      forScene: false,
      builtin: true,
      sort: 100,
    });

    // And still no profile row, so no production picker can reach it either.
    const profiles = await db()
      .select({ id: imageModelProfiles.id })
      .from(imageModelProfiles)
      .where(eq(imageModelProfiles.imageModelId, QWEN_IMAGE_2.id));
    expect(profiles).toEqual([]);
  });

  it("moves no sibling that works on the uploaded-file transport", async () => {
    const models = await loadImageModels();
    for (const slug of FILE_TRANSPORT_SIBLINGS) {
      const sibling = models.find((candidate) => candidate.slug === slug);
      expect(sibling, `${slug} must still be registered`).toBeDefined();
      expect(sibling?.referenceTransport, `${slug} runs fine on uploaded files`).toBe("file");
    }
  });

  it("follows 0137 in the journal, as a data migration with no schema snapshot", async () => {
    const journal = JSON.parse(
      await readFile(path.join(process.cwd(), "drizzle", "meta", "_journal.json"), "utf8"),
    ) as { entries: { idx: number; tag: string; when: number }[] };

    const entry = journal.entries.find((candidate) => candidate.tag === TRANSPORT_MIGRATION_TAG);
    expect(entry).toBeDefined();
    expect(entry?.idx).toBe(138);

    const previous = journal.entries.find((candidate) => candidate.idx === 137);
    expect(previous?.tag).toBe(LORA_MIGRATION_TAG);
    // The migrator applies in `when` order, so an entry timestamped before its
    // predecessor would run this correction against a database that had not
    // reached 0137 — and, further back, not reached the row it corrects.
    expect(entry?.when).toBeGreaterThan(previous?.when ?? 0);
    expect(journal.entries.filter((candidate) => candidate.idx === 138)).toHaveLength(1);

    // Data migrations 0132–0137 ship no snapshot either; one here would claim a
    // `schema.ts` change this file does not make.
    const missing = await readFile(path.join(process.cwd(), "drizzle", "meta", "0138_snapshot.json"), "utf8").then(
      () => false,
      () => true,
    );
    expect(missing).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 0138's predicate, beside an operator's own row
// ---------------------------------------------------------------------------

describe.skipIf(!ready)("migration 0138 — the predicate", () => {
  const OPERATOR_ID = "imgmdlqwen2operatoraaaaa";

  afterAll(async () => {
    if (!ready) return;
    await db().delete(imageModels).where(eq(imageModels.id, OPERATOR_ID));
    await restoreQwenImage2Row();
  });

  it("re-executing the shipped statement changes nothing, timestamps included", async () => {
    // `updated_at` is INSIDE the comparison, and that is the point of matching
    // the known prior value `file`: replayed against its own result the
    // statement matches no row, so even the bookkeeping column is untouched. A
    // predicate that named only the slug would rewrite the row on every replay
    // and make the admin card claim the model had just been changed.
    const snapshot = () => db().select().from(imageModels).where(eq(imageModels.id, QWEN_IMAGE_2.id));

    const before = await snapshot();
    expect(before).toHaveLength(1);
    await reapplyTransportFix();
    expect(await snapshot()).toEqual(before);
  });

  it("corrects an endpoint an operator added under a version-suffixed slug", async () => {
    // The admin add path auto-pins, so a hand-added official row can be stored
    // as `owner/name:<version>` — and it arrives with the same broken default
    // transport, because the add path writes `file` for every new row. Only a
    // provider-path predicate reaches it; an id-equality one would leave that
    // operator's edit path dead after a deploy that claimed to fix it.
    await db().delete(imageModels).where(eq(imageModels.id, QWEN_IMAGE_2.id));
    await db()
      .insert(imageModels)
      .values({
        id: OPERATOR_ID,
        slug: `${QWEN_IMAGE_2.slug}:${QWEN_IMAGE_2.versionId}`,
        label: "Operator's Qwen Image 2",
        canGenerate: true,
        canEdit: true,
        referenceField: "image",
        referenceArity: "single",
        referenceTransport: "file",
        maxReferences: 1,
        probedVersionId: QWEN_IMAGE_2.versionId,
      });

    await reapplyTransportFix();

    expect(await transportFor(QWEN_IMAGE_2.slug)).toBe("data_url");
    // The predicate compares provider paths for EQUALITY, so the sibling that
    // merely starts with the same characters is not swept along.
    for (const slug of FILE_TRANSPORT_SIBLINGS) {
      expect(await transportFor(slug), `${slug} must keep the uploaded-file transport`).toBe("file");
    }

    await db().delete(imageModels).where(eq(imageModels.id, OPERATOR_ID));
    await restoreQwenImage2Row();
  });

  it("resurrects nothing an owner deleted", async () => {
    // Seeded rows are ordinary rows: an owner may remove this endpoint from the
    // registry, and a correction to a row that no longer exists must stay a
    // no-op rather than reintroducing it. An UPDATE gets that for free, which is
    // exactly why the fix is one and not a re-seed.
    await db().delete(imageModels).where(sql`split_part(${imageModels.slug}, ':', 1) = ${QWEN_IMAGE_2.slug}`);

    await reapplyTransportFix();

    expect(await transportFor(QWEN_IMAGE_2.slug)).toBeUndefined();

    await restoreQwenImage2Row();
    expect(await qwenImage2Intact()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Migration 0139 — the FLUX.1 Kontext Dev seed
// ---------------------------------------------------------------------------

const KONTEXT_MIGRATION_TAG = "0139_flux-kontext-dev";
const KONTEXT_MIGRATION_FILE = `drizzle/${KONTEXT_MIGRATION_TAG}.sql`;

/**
 * The row 0139 seeds. `black-forest-labs/flux-kontext-dev` is the OPEN-WEIGHT
 * Kontext, and the only one of its family Vesper registers: its reference input
 * is one required URI named `input_image`, which makes the row edit-only, and it
 * declares no LoRA pair and no accelerated path.
 */
const KONTEXT_DEV = {
  id: "imgmdlfluxkontextdevaaaa",
  slug: "black-forest-labs/flux-kontext-dev",
  /** Curated. Outside `imageModelReprobeFields`, so a re-probe keeps it. */
  label: "FLUX.1 Kontext Dev",
  versionId: "85723d503c17da3f9fd9cecfb9987a8bf60ef747fd8f68a25d7636f88260eb59",
  sort: 104,
} as const;

/**
 * Provider paths this migration must NOT reach. The first three are Kontext
 * endpoints with different schemas — the LoRA arm declares `lora_weights`,
 * `lora_strength` and `megapixels`, and the two hosted BFL arms expose a
 * `safety_tolerance` dial instead of a safety-checker switch — and the fourth is
 * a different model entirely. A prefix match in either guard would fold them
 * together; the guard compares provider paths for EQUALITY.
 */
const KONTEXT_NEIGHBOURS = [
  "black-forest-labs/flux-kontext-dev-lora",
  "black-forest-labs/flux-kontext-pro",
  "black-forest-labs/flux-kontext-max",
] as const;

/**
 * This version's Input schema, from `GET /v1/models/black-forest-labs/flux-kontext-dev`
 * on 2026-09-13 (evidence state `documented`). Rebuilt through the shared
 * shapes rather than transcribed verbatim, for the same reason the klein
 * fixtures above are: the verbatim transcription lives in
 * `packages/image-replicate/src/probe.test.ts`, and a byte-for-byte second copy
 * here would be a clone that drifts silently.
 *
 * The enum is this endpoint's OWN, not the klein one: both offer eleven ratios
 * plus the `match_input_image` sentinel, and they list them in different orders,
 * which reaches `supported_aspects` verbatim.
 */
const KONTEXT_ENUMS: Record<string, readonly string[]> = {
  aspect_ratio: ["1:1", "16:9", "21:9", "3:2", "2:3", "4:5", "5:4", "3:4", "4:3", "9:16", "9:21", "match_input_image"],
  output_format: ["webp", "jpg", "png"],
};

const KONTEXT_PROPERTIES: Record<string, unknown> = {
  seed: {
    type: "integer",
    // Prose only: the schema declares no bounds, so the binding carries none.
    description: "Random seed for reproducible generation. Leave blank for random.",
  },
  prompt: {
    type: "string",
    description:
      "Text description of what you want to generate, or the instruction on how to edit the given image.",
  },
  guidance: { type: "number", default: 2.5, maximum: 10, minimum: 0, description: "Guidance scale for generation" },
  input_image: {
    type: "string",
    format: "uri",
    description: "Image to use as reference. Must be jpeg, png, gif, or webp.",
  },
  aspect_ratio: {
    ...enumRef("aspect_ratio"),
    // The provider's own default is the SENTINEL, not a ratio.
    default: "match_input_image",
    description:
      "Aspect ratio of the generated image. Use 'match_input_image' to match the aspect ratio of the input image.",
  },
  output_format: { ...enumRef("output_format"), default: "webp", description: "Output image format" },
  output_quality: {
    type: "integer",
    // 80 here, while the row pins 95. The two disagreeing is correct.
    default: 80,
    maximum: 100,
    minimum: 0,
    description:
      "Quality when saving the output images, from 0 to 100. 100 is best quality, 0 is lowest quality. Not relevant for .png outputs",
  },
  num_inference_steps: {
    type: "integer",
    default: 30,
    maximum: 50,
    minimum: 4,
    description: "Number of inference steps",
  },
  disable_safety_checker: { type: "boolean", default: false, description: "Disable NSFW safety checker" },
};

/** The derivation for this endpoint, through the same public probe seam. */
function probeCapturedKontext(): Promise<ProbeResult> {
  return probeCaptured({
    slug: KONTEXT_DEV.slug,
    versionId: KONTEXT_DEV.versionId,
    properties: KONTEXT_PROPERTIES,
    // BOTH required — this is the fact that makes the row edit-only.
    required: ["prompt", "input_image"],
    enums: KONTEXT_ENUMS,
    // A bare URI string, like Qwen Image 2's and unlike the klein arrays.
    output: { type: "string", format: "uri" },
  });
}

/** 0139's shipped INSERT statement. */
function kontextSeedStatements(): Promise<string[]> {
  return insertStatements(KONTEXT_MIGRATION_FILE);
}

/** Re-run 0139's own statement. Idempotent by construction — that is what is under test. */
async function reapplyKontextSeed(): Promise<void> {
  const statements = await kontextSeedStatements();
  expect(statements, `${KONTEXT_MIGRATION_FILE} must carry exactly one INSERT statement`).toHaveLength(1);
  for (const statement of statements) await db().execute(sql.raw(statement));
}

/**
 * Put the migrated state back. Deleting by provider path rather than by id is
 * what makes the re-seed possible at all: 0139's guard is `WHERE NOT EXISTS` on
 * that path, so an operator-style row left behind under a different id would
 * suppress it.
 */
async function restoreKontextRow(): Promise<void> {
  // Read and validate the statement BEFORE deleting anything: an unreadable
  // migration file must fail this suite, not strip a registry row the rest of
  // the run expects to find.
  expect(await kontextSeedStatements(), `${KONTEXT_MIGRATION_FILE} must carry one INSERT`).toHaveLength(1);
  await db().delete(imageModels).where(sql`split_part(${imageModels.slug}, ':', 1) = ${KONTEXT_DEV.slug}`);
  await reapplyKontextSeed();
}

/** True when the migrated state is already in place, untouched. */
async function kontextIntact(): Promise<boolean> {
  const [row] = await db().select({ id: imageModels.id }).from(imageModels).where(eq(imageModels.id, KONTEXT_DEV.id));
  return row !== undefined;
}

describe.skipIf(!ready)("migration 0139 — the FLUX.1 Kontext Dev seed", () => {
  it("seeds one row, and it parses through parseRegistryRows", async () => {
    const sink = new DiagnosticCollector();
    const models = await loadImageModels(sink);
    const model = models.find((candidate) => candidate.id === KONTEXT_DEV.id);

    expect(model, `${KONTEXT_DEV.slug} must be seeded`).toBeDefined();
    // `loadImageModels` DROPS an unparseable row with a diagnostic rather than
    // throwing, so "it came back" and "nothing was skipped" are two assertions.
    expect(sink.items.filter((item) => item.code === "image_model.row_invalid")).toEqual([]);
    // The BARE slug: this is an official model, and the bare-slug prediction
    // endpoint is official-models-only. The pin lives in its own column.
    expect(model?.slug).toBe(KONTEXT_DEV.slug);
    expect(model?.slug).not.toContain(":");
    expect(model?.label).toBe(KONTEXT_DEV.label);
    expect(model?.sort).toBe(KONTEXT_DEV.sort);
    // Exactly one row for this provider path, however a slug is spelled.
    expect(await rowsForEndpoint(KONTEXT_DEV.slug)).toHaveLength(1);
  });

  // The checklist item this block exists for.
  it("seeds the row with exactly the columns probeReplicateModel derives for its pinned version", async () => {
    const result = await probeCapturedKontext();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.probe.versionId).toBe(KONTEXT_DEV.versionId);

    const models = await loadImageModels();
    const model = models.find((candidate) => candidate.id === KONTEXT_DEV.id);
    expect(model).toBeDefined();
    if (!model) return;

    // `imageModelProbeFields` is the CREATE write set the admin add path uses —
    // every probe-owned column and nothing reviewed or curated. Comparing the
    // whole set at once is the point: a column the migration typed by hand would
    // otherwise only be caught if someone thought to assert it.
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
    // probe's own starting figure separately. One, because the schema declares a
    // single URI string rather than a list.
    expect(model.maxReferences).toBe(result.probe.maxReferences);
    expect(model.maxReferences).toBe(1);

    // Called out individually because each is a way the row could look right and
    // render wrong.
    expect(model.canGenerate).toBe(false);
    expect(model.referenceField).toBe("input_image");
    expect(model.referenceArity).toBe("single");
    expect(model.supportedAspects).not.toContain("match_input_image");
    expect(model.supportedAspects).toContain("3:4");
    expect(model.outputFormat).toBe("webp");
    expect(model.extraInput).toEqual({ disable_safety_checker: true, output_quality: 95 });
    expect(model.advancedCapabilities.output).toEqual({ arity: "single", supportsMultiple: false });
    // The controls this version declares, and the two it does not: sending a
    // control to a field the pinned version does not own is a provider rejection
    // at spend time, so these absences are load-bearing.
    expect(model.advancedCapabilities.controls.guidance).toEqual({
      field: "guidance",
      type: "number",
      minimum: 0,
      maximum: 10,
    });
    expect(model.advancedCapabilities.controls.steps).toEqual({
      field: "num_inference_steps",
      type: "integer",
      minimum: 4,
      maximum: 50,
    });
    expect(model.advancedCapabilities.controls.fastMode).toBeUndefined();
    expect(model.advancedCapabilities.controls.loraWeights).toBeUndefined();
    // `output_format` is the one input the Generator's Advanced section offers;
    // everything else this version declares is written by the render path,
    // control-bound or pinned.
    const open = model.advancedCapabilities.providerInputs.filter((input) => !input.reserved);
    expect(open.map((input) => input.field)).toEqual(["output_format"]);
  });

  it("carries no surface flag and no reviewed rating, so no production surface changes", async () => {
    const models = await loadImageModels();
    const model = models.find((candidate) => candidate.id === KONTEXT_DEV.id);
    expect(model).toBeDefined();
    if (!model) return;

    // The player-facing pickers offer PROFILES, and this migration writes none;
    // these three flags are the remaining legacy surface toggles.
    expect(model.forPortrait).toBe(false);
    expect(model.forVariant).toBe(false);
    expect(model.forScene).toBe(false);
    expect(model.builtin).toBe(true);
    // Reviewed, never probed. `unknown` is a statement about Vesper's evidence —
    // no trial has graded this endpoint — and is the permissive default.
    expect(model.editKind).toBe("unknown");
    expect(model.identityPreservation).toBe("unknown");
    // The default, and whether this wrapper accepts Replicate's uploaded-file
    // URLs is unknown until a run. If it rejects them the way Qwen Image 2 does,
    // the fix is this owner-set column, never a probe change.
    expect(model.referenceTransport).toBe("file");
    // The warning an operator actually sees, and it must not imply a run happened.
    expect(model.operatorWarning).toContain("Untried in Vesper");
    expect(model.operatorWarning).toContain("no production surface");
    expect(model.operatorWarning).toContain("edit-only");
    expect(model.operatorWarning).toContain("non-commercial licence");
  });

  it("seeds no image_model_profiles row", async () => {
    // No profile means no player-facing picker can reach the row at all: the
    // production pickers offer profiles, and the Image Generator is the one
    // surface that runs a registered row without one.
    const profiles = await db()
      .select({ id: imageModelProfiles.id })
      .from(imageModelProfiles)
      .where(eq(imageModelProfiles.imageModelId, KONTEXT_DEV.id));
    expect(profiles).toEqual([]);
  });

  it("registers no Kontext sibling", async () => {
    const models = await loadImageModels();
    // Three different schemas behind three near-identical names. This migration
    // seeds one endpoint and implies nothing about the others.
    for (const slug of KONTEXT_NEIGHBOURS) {
      expect(
        models.filter((model) => model.slug.split(":")[0] === slug),
        `${slug} must not be registered`,
      ).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// 0139's history, and its guards beside a row an operator already added
// ---------------------------------------------------------------------------

describe.skipIf(!ready)("migration 0139 — history and upgrade", () => {
  it("follows 0138 in the journal, as a data migration with no schema snapshot", async () => {
    const journal = JSON.parse(
      await readFile(path.join(process.cwd(), "drizzle", "meta", "_journal.json"), "utf8"),
    ) as { entries: { idx: number; tag: string; when: number }[] };

    const entry = journal.entries.find((candidate) => candidate.tag === KONTEXT_MIGRATION_TAG);
    expect(entry).toBeDefined();
    expect(entry?.idx).toBe(139);

    const previous = journal.entries.find((candidate) => candidate.idx === 138);
    expect(previous?.tag).toBe(TRANSPORT_MIGRATION_TAG);
    // The migrator applies in `when` order, so an entry timestamped before its
    // predecessor would run this seed against a database 0138 had not reached.
    expect(entry?.when).toBeGreaterThan(previous?.when ?? 0);
    expect(journal.entries.filter((candidate) => candidate.idx === 139)).toHaveLength(1);
    // The HEAD assertion lives with the newest migration — 0145's history
    // suite below — so this historical 0139 check remains valid as rows accrue.

    // Data migrations 0132–0138 ship no snapshot either; one here would claim a
    // `schema.ts` change this file does not make.
    const missing = await readFile(path.join(process.cwd(), "drizzle", "meta", "0139_snapshot.json"), "utf8").then(
      () => false,
      () => true,
    );
    expect(missing).toBe(true);
  });

  it("leaves the row present after the harness's full migrate", async () => {
    // This database was migrated from the baseline through 0139 by the ordinary
    // `pnpm db:migrate`, so the row existing here IS the upgrade result — there
    // is no fresh-versus-upgraded distinction to draw from inside the suite.
    const rows = await db().select({ id: imageModels.id }).from(imageModels).where(eq(imageModels.id, KONTEXT_DEV.id));
    expect(rows.map((row) => row.id)).toEqual([KONTEXT_DEV.id]);
  });
});

describe.skipIf(!ready)("migration 0139 — guards over an existing row", () => {
  const OPERATOR_ID = "imgmdlkontextoperatoraaa";
  const NEIGHBOUR_IDS = ["imgmdlkontextloraaaaaaaa", "imgmdlkontextproaaaaaaaa"];

  afterAll(async () => {
    if (!ready) return;
    await db()
      .delete(imageModels)
      .where(inArray(imageModels.id, [OPERATOR_ID, ...NEIGHBOUR_IDS]));
    await restoreKontextRow();
  });

  it("does not duplicate an endpoint an operator added under a version-suffixed slug", async () => {
    // The admin add path auto-pins, so a hand-added official row can be stored
    // as `owner/name:<version>`. That slug is not EQUAL to the bare one, so the
    // unique index would not catch it — only the `split_part` guard can, and
    // without it every picker would list this endpoint twice.
    await db().delete(imageModels).where(eq(imageModels.id, KONTEXT_DEV.id));
    await db()
      .insert(imageModels)
      .values({
        id: OPERATOR_ID,
        slug: `${KONTEXT_DEV.slug}:${KONTEXT_DEV.versionId}`,
        label: "Operator's Kontext Dev",
        canGenerate: false,
        canEdit: true,
        referenceField: "input_image",
        referenceArity: "single",
        maxReferences: 1,
        probedVersionId: KONTEXT_DEV.versionId,
      });

    await reapplyKontextSeed();

    const rows = await rowsForEndpoint(KONTEXT_DEV.slug);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(OPERATOR_ID);
    // Untouched, not merely un-duplicated: the guard is `WHERE NOT EXISTS`, so
    // the statement inserts nothing at all rather than merging anything in.
    expect(rows[0]?.label).toBe("Operator's Kontext Dev");

    await db().delete(imageModels).where(eq(imageModels.id, OPERATOR_ID));
    await restoreKontextRow();
  });

  it("preserves an operator's curation on an existing BARE row rather than overwriting it", async () => {
    // The second guard's case: same slug, so `ON CONFLICT ("slug") DO NOTHING`
    // would cover it even if `WHERE NOT EXISTS` did not. Both must be no-ops — a
    // migration that re-asserted its own values here would silently undo a
    // reference cap or a label an operator corrected by hand.
    await db().delete(imageModels).where(eq(imageModels.id, KONTEXT_DEV.id));
    await db()
      .insert(imageModels)
      .values({
        id: OPERATOR_ID,
        slug: KONTEXT_DEV.slug,
        label: "Kontext Dev (operator-tuned)",
        // Deliberately NOT the seeded values: an operator who decided this row
        // may generate, and raised its cap, keeps both.
        canGenerate: true,
        canEdit: true,
        referenceField: "input_image",
        referenceArity: "single",
        maxReferences: 3,
        probedVersionId: KONTEXT_DEV.versionId,
      });

    await reapplyKontextSeed();

    const rows = await rowsForEndpoint(KONTEXT_DEV.slug);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(OPERATOR_ID);
    expect(rows[0]?.label).toBe("Kontext Dev (operator-tuned)");
    expect(rows[0]?.maxReferences).toBe(3);
    // And the seeded id is genuinely absent — the no-op did not write it under a
    // second row that the endpoint query above happened not to surface.
    const [seededRow] = await db()
      .select({ id: imageModels.id })
      .from(imageModels)
      .where(eq(imageModels.id, KONTEXT_DEV.id));
    expect(seededRow).toBeUndefined();

    await db().delete(imageModels).where(eq(imageModels.id, OPERATOR_ID));
    await restoreKontextRow();
  });

  it("is not suppressed by a neighbouring endpoint an operator added", async () => {
    // The guard compares provider paths for EQUALITY, and this is the case that
    // separates equality from a prefix match:
    // `black-forest-labs/flux-kontext-dev-lora` EXTENDS the seeded path, so a
    // `LIKE 'black-forest-labs/flux-kontext-dev%'` would read that operator's row
    // as "already present" and skip the seed outright — leaving a fresh database
    // without the row this file exists to write, and no error to say so. It is a
    // different endpoint: it declares a LoRA pair and a `megapixels` input this
    // version does not.
    await db().delete(imageModels).where(eq(imageModels.id, KONTEXT_DEV.id));
    await db()
      .insert(imageModels)
      .values([
        {
          id: NEIGHBOUR_IDS[0] as string,
          slug: "black-forest-labs/flux-kontext-dev-lora",
          label: "Operator's Kontext Dev LoRA",
          canGenerate: false,
          canEdit: true,
          referenceField: "input_image",
          referenceArity: "single",
          maxReferences: 1,
        },
        {
          id: NEIGHBOUR_IDS[1] as string,
          slug: "black-forest-labs/flux-kontext-pro",
          label: "Operator's Kontext Pro",
          canGenerate: false,
          canEdit: true,
          referenceField: "input_image",
          referenceArity: "single",
          maxReferences: 1,
        },
      ]);

    await reapplyKontextSeed();

    const rows = await rowsForEndpoint(KONTEXT_DEV.slug);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(KONTEXT_DEV.id);
    // And both planted neighbours are still there, untouched — the seed is an
    // INSERT with no UPDATE anywhere in the file, so nothing could have reached
    // them.
    const neighbours = await db()
      .select({ id: imageModels.id, label: imageModels.label })
      .from(imageModels)
      .where(inArray(imageModels.id, NEIGHBOUR_IDS));
    expect(neighbours.map((row) => row.label).sort()).toEqual([
      "Operator's Kontext Dev LoRA",
      "Operator's Kontext Pro",
    ]);

    await db().delete(imageModels).where(inArray(imageModels.id, NEIGHBOUR_IDS));
    await restoreKontextRow();
  });

  it("re-running the shipped statement against the migrated state changes nothing", async () => {
    // Idempotence stated directly: a deploy that replays this file — or a second
    // migrator run — must not rewrite a row it already wrote. `updated_at` is
    // inside the comparison, because a guard that let the INSERT fire would move
    // it even if every value it wrote happened to match.
    const snapshot = () => db().select().from(imageModels).where(eq(imageModels.id, KONTEXT_DEV.id));

    const before = await snapshot();
    expect(before).toHaveLength(1);
    await reapplyKontextSeed();
    expect(await snapshot()).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// Migration 0140 — Qwen Image Edit 2511's reviewed speed ruling, as a control
// ---------------------------------------------------------------------------

const FAST_MODE_MIGRATION_TAG = "0140_qwen-2511-fast-mode-control";
const FAST_MODE_MIGRATION_FILE = `drizzle/${FAST_MODE_MIGRATION_TAG}.sql`;

/** The provider path 0140's predicate names, and 0100 seeded three profiles under. */
const QWEN_EDIT_2511_SLUG = "qwen/qwen-image-edit-2511";
const QWEN_EDIT_2511_MODEL_ID = "imgmdlqwenedit2511aaaaaa";

/** The three rows 0100 seeded beneath it, which 0110 gave the raw `go_fast` override. */
const QWEN_EDIT_2511_PROFILE_IDS = [
  "imgprf2511chatlookaaaaaa",
  "imgprf2511sceneaaaaaaaaa",
  "imgprf2511variantaaaaaaa",
] as const;

/** 0140's shipped statement. It is an UPDATE, so it ships no INSERT at all. */
function fastModeStatements(): Promise<string[]> {
  return migrationStatements(FAST_MODE_MIGRATION_FILE, 'UPDATE "image_model_profiles"');
}

/** Re-run 0140's own statement. Idempotent by its two guards — that is what is under test. */
async function reapplyFastModeMove(): Promise<void> {
  const statements = await fastModeStatements();
  expect(statements, `${FAST_MODE_MIGRATION_FILE} must carry exactly one image_model_profiles UPDATE`).toHaveLength(1);
  for (const statement of statements) await db().execute(sql.raw(statement));
}

/** The two configuration columns of named profile rows, in id order. */
async function profileConfigurations(
  ids: readonly string[],
): Promise<{ id: string; controlDefaults: unknown; providerOverrides: unknown }[]> {
  const rows = await db()
    .select({
      id: imageModelProfiles.id,
      controlDefaults: imageModelProfiles.controlDefaults,
      providerOverrides: imageModelProfiles.providerOverrides,
    })
    .from(imageModelProfiles)
    .where(inArray(imageModelProfiles.id, [...ids]));
  return rows.sort((left, right) => left.id.localeCompare(right.id));
}

/**
 * 0140 moves a reviewed setting between the two columns a profile stores it in:
 * out of `provider_overrides`, which merge LAST over the mapped controls and so
 * outrank the caller's own request for the same thing, and into the normalized
 * `fastMode` control the vocabulary now has for it (issue #244).
 *
 * The defect a migrated database is the only witness to: the reviewed table in
 * `packages/image-core` and the seeded rows saying two different things. The
 * table's own suites prove the table; only this one can say the rows followed.
 */
describe.skipIf(!ready)("migration 0140 — the Qwen 2511 fast-mode control", () => {
  it("carries the reviewed ruling as the fastMode control on every row 0110 wrote the override onto", async () => {
    const rows = await profileConfigurations(QWEN_EDIT_2511_PROFILE_IDS);
    expect(rows.map((row) => row.id)).toEqual([...QWEN_EDIT_2511_PROFILE_IDS]);
    for (const row of rows) {
      // `fastMode: false` maps through 2511's probed `go_fast` binding to the
      // same value the override sent — the payload does not move, the
      // precedence does.
      expect(row.controlDefaults, row.id).toMatchObject({ fastMode: false });
      expect(row.providerOverrides, row.id).not.toHaveProperty("go_fast");
    }
  });

  it("follows 0139 in the journal, as a data migration with no schema snapshot", async () => {
    const journal = JSON.parse(
      await readFile(path.join(process.cwd(), "drizzle", "meta", "_journal.json"), "utf8"),
    ) as { entries: { idx: number; tag: string; when: number }[] };

    const entry = journal.entries.find((candidate) => candidate.tag === FAST_MODE_MIGRATION_TAG);
    expect(entry).toBeDefined();
    expect(entry?.idx).toBe(140);

    const previous = journal.entries.find((candidate) => candidate.idx === 139);
    expect(previous?.tag).toBe(KONTEXT_MIGRATION_TAG);
    // The migrator applies in `when` order, so an entry timestamped before its
    // predecessor would run this UPDATE against a database 0139 had not reached.
    expect(entry?.when).toBeGreaterThan(previous?.when ?? 0);
    expect(journal.entries.filter((candidate) => candidate.idx === 140)).toHaveLength(1);

    // Data migrations 0132–0139 ship no snapshot either; one here would claim a
    // `schema.ts` change this file does not make.
    const missing = await readFile(path.join(process.cwd(), "drizzle", "meta", "0140_snapshot.json"), "utf8").then(
      () => false,
      () => true,
    );
    expect(missing).toBe(true);
  });

  it("re-running the shipped statement against the migrated state changes nothing", async () => {
    // Idempotence stated directly, and it is the `NOT (control_defaults ?
    // 'fastMode')` guard doing it: a replayed deploy must not re-write rows it
    // already moved. `updated_at` is inside the comparison, because a statement
    // that matched again would move it even though every value it wrote matches.
    const snapshot = async () =>
      (await db().select().from(imageModelProfiles).where(inArray(imageModelProfiles.id, [...QWEN_EDIT_2511_PROFILE_IDS])))
        .sort((left, right) => left.id.localeCompare(right.id));

    const before = await snapshot();
    expect(before).toHaveLength(QWEN_EDIT_2511_PROFILE_IDS.length);
    await reapplyFastModeMove();
    expect(await snapshot()).toEqual(before);
  });
});

describe.skipIf(!ready)("migration 0140 — the predicate", () => {
  const OPERATOR_PROFILE_ID = "imgprf2511operatorbenchz";

  afterAll(async () => {
    if (!ready) return;
    await db().delete(imageModelProfiles).where(eq(imageModelProfiles.id, OPERATOR_PROFILE_ID));
  });

  it("leaves an operator's deliberate go_fast: true override exactly as it stands", async () => {
    // The value guard (`provider_overrides -> 'go_fast' = 'false'`) is the half
    // that separates the reviewed ruling from an operator's own decision. An
    // UPDATE matching on the KEY alone would silently convert a bench row that
    // exists to run this model accelerated into one that cannot.
    await db().delete(imageModelProfiles).where(eq(imageModelProfiles.id, OPERATOR_PROFILE_ID));
    await db()
      .insert(imageModelProfiles)
      .values({
        id: OPERATOR_PROFILE_ID,
        imageModelId: QWEN_EDIT_2511_MODEL_ID,
        key: "operator-accelerated",
        label: "Operator's Accelerated Bench",
        task: "item",
        operation: "edit",
        promptStrategy: "instruction_edit",
        providerOverrides: { go_fast: true },
      });

    await reapplyFastModeMove();

    const [row] = await profileConfigurations([OPERATOR_PROFILE_ID]);
    expect(row?.providerOverrides).toEqual({ go_fast: true });
    expect(row?.controlDefaults).toEqual({});
  });

  it("names the 2511 provider path by split_part, so a version-suffixed row is not missed", async () => {
    // The predicate the whole statement hangs on, read back from the shipped
    // file rather than restated: a slug equality test would skip an operator's
    // auto-pinned `owner/name:<version>` row, and its reviewed ruling would stay
    // in the column that outranks the caller.
    const [statement] = await fastModeStatements();
    expect(statement).toBeDefined();
    expect(statement).toContain(`split_part(m."slug", ':', 1) = '${QWEN_EDIT_2511_SLUG}'`);
  });
});

// ---------------------------------------------------------------------------
// 0141 — the community rows' capability backfill
// ---------------------------------------------------------------------------

const COMMUNITY_MIGRATION_TAG = "0141_community-model-capability-backfill";
const COMMUNITY_MIGRATION_FILE = `drizzle/${COMMUNITY_MIGRATION_TAG}.sql`;
const CIVITAI_MIGRATION_TAG = "0145_civitai-flux2-klein-4b-lora";

/**
 * The three rows 0104 seeds with `advanced_capabilities` at its column default,
 * and the reviewed setting each one's bindings have to carry.
 *
 * These are the models whose reviewed corrections have no other route since #244
 * removed the transitional overlay: the profile maps them through the bindings
 * below or they do not ship at all, and on a fresh database only this migration
 * puts the bindings there.
 */
const COMMUNITY_CAPABILITY_ROWS = [
  {
    id: "imgmdlnsfwfluxdevaaaaaaa",
    label: "NSFW FLUX Dev",
    controls: ["seed", "customWidth", "customHeight"],
    // The reviewed 832x1216 pair, which this endpoint's only shape input is.
    reviewedFields: ["width", "height"],
  },
  {
    id: "imgmdllikerealityponyaaa",
    label: "LikeReality Pony v1",
    controls: ["seed", "negativePrompt", "customWidth", "customHeight"],
    // `negative_prompt` is the one that clears the wrapper's "nsfw, naked".
    reviewedFields: ["negative_prompt", "width", "height"],
  },
  {
    id: "imgmdlsdxlpulidaaaaaaaaa",
    label: "SDXL PuLID",
    controls: ["seed", "negativePrompt", "guidance", "customWidth", "customHeight"],
    // `cfg` carries the reviewed guidance of 7; `method`/`face_weight` are raw
    // overrides, which fail closed unless `known_input_fields` lists them.
    reviewedFields: ["cfg", "width", "height", "method", "face_weight"],
  },
] as const;

/** 0141's shipped UPDATE statements. */
function communityBackfillStatements(): Promise<string[]> {
  return migrationStatements(COMMUNITY_MIGRATION_FILE, 'UPDATE "image_models"');
}

/** Re-run 0141's own statements. Idempotent by construction — that is what is under test. */
async function reapplyCommunityBackfill(): Promise<void> {
  const statements = await communityBackfillStatements();
  expect(statements, `${COMMUNITY_MIGRATION_FILE} must carry three UPDATE statements`).toHaveLength(3);
  for (const statement of statements) await db().execute(sql.raw(statement));
}

describe.skipIf(!ready)("migration 0141 — history", () => {
  it("is a single ordered journal entry, as a data migration with no schema snapshot", async () => {
    const journal = JSON.parse(
      await readFile(path.join(process.cwd(), "drizzle", "meta", "_journal.json"), "utf8"),
    ) as { entries: { idx: number; tag: string; when: number }[] };

    const entry = journal.entries.find((candidate) => candidate.tag === COMMUNITY_MIGRATION_TAG);
    expect(entry).toBeDefined();
    expect(entry?.idx).toBe(141);
    expect(journal.entries.filter((candidate) => candidate.idx === 141)).toHaveLength(1);
    // The HEAD assertion lives with the newest migration — 0145's history
    // suite below owns it now.

    // The migrator applies in `when` order, so this file must be timestamped
    // after everything it expects to have run — asserted against the whole
    // history rather than one predecessor, because which index sits immediately
    // before it is a merge outcome and not a property of this migration. The
    // HEAD assertion belongs to whichever suite owns the newest migration.
    const earlier = journal.entries.filter((candidate) => candidate.idx < 141).map((candidate) => candidate.when);
    expect(Math.max(...earlier)).toBeLessThan(entry?.when ?? 0);

    // Data only: a snapshot here would claim a `schema.ts` change this file does
    // not make.
    const missing = await readFile(path.join(process.cwd(), "drizzle", "meta", "0141_snapshot.json"), "utf8").then(
      () => false,
      () => true,
    );
    expect(missing).toBe(true);
  });
});

/**
 * 0145 remains an ordered historical entry. The current journal-head assertion
 * belongs to the newest data migration below, so adding another migration does
 * not rewrite this migration's own history.
 */
describe.skipIf(!ready)("migration 0145 — history", () => {
  it("is a unique ordered data migration with no schema snapshot", async () => {
    const journal = JSON.parse(
      await readFile(path.join(process.cwd(), "drizzle", "meta", "_journal.json"), "utf8"),
    ) as { entries: { idx: number; tag: string; when: number }[] };

    const entry = journal.entries.find((candidate) => candidate.tag === CIVITAI_MIGRATION_TAG);
    expect(entry).toBeDefined();
    expect(entry?.idx).toBe(145);
    expect(journal.entries.filter((candidate) => candidate.idx === 145)).toHaveLength(1);
    const earlier = journal.entries.filter((candidate) => candidate.idx < 145).map((candidate) => candidate.when);
    expect(Math.max(...earlier)).toBeLessThan(entry?.when ?? 0);

    // 0145 seeds registry rows only; a snapshot would claim a schema change.
    const missing = await readFile(path.join(process.cwd(), "drizzle", "meta", "0145_snapshot.json"), "utf8").then(
      () => false,
      () => true,
    );
    expect(missing).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Migration 0146 — Civitai FLUX.2 Klein v2 transport contract
// ---------------------------------------------------------------------------

const CIVITAI_V2_MIGRATION_TAG = "0146_civitai-klein-v2";
const CIVITAI_V2_MIGRATION_FILE = `drizzle/${CIVITAI_V2_MIGRATION_TAG}.sql`;
const CIVITAI_V2_MODEL_ID = "imgmdlcivklein4baaaaaaa";
const CIVITAI_V2_LORA_ID = "imglorklein4bnsfwfemale";
const CIVITAI_V2_SLUG = "civitai/flux-2-klein-4b";

function civitaiV2Statements(): Promise<string[]> {
  return migrationStatements(CIVITAI_V2_MIGRATION_FILE, "UPDATE ");
}

describe.skipIf(!ready)("migration 0146 — Civitai Klein v2", () => {
  it("moves the bench row to the documented 4b selector with two data-url edit references", async () => {
    const sink = new DiagnosticCollector();
    const model = (await loadImageModels(sink)).find((candidate) => candidate.id === CIVITAI_V2_MODEL_ID);

    expect(model).toBeDefined();
    expect(sink.items.filter((item) => item.code === "image_model.row_invalid")).toEqual([]);
    expect(model).toMatchObject({
      slug: CIVITAI_V2_SLUG,
      label: "FLUX.2 Klein 4B (Civitai v2)",
      canGenerate: true,
      canEdit: true,
      referenceField: "images",
      referenceArity: "array",
      referenceTransport: "data_url",
      maxReferences: 2,
      probedVersionId: "4b",
      forPortrait: false,
      forVariant: false,
      forScene: false,
    });
    expect(model?.advancedCapabilities.controls).toMatchObject({
      seed: { field: "seed", type: "integer" },
      loraWeights: { field: "civitai_lora_version", type: "string" },
      loraScale: { field: "civitai_lora_strength", type: "number" },
    });
    expect(model?.advancedCapabilities.controls.negativePrompt).toBeUndefined();
  });

  it("retunes the curated LoRA to the v2 selector only after the model row moved", async () => {
    const lora = await loadImageLora(CIVITAI_V2_LORA_ID);
    expect(lora).toMatchObject({
      compatibleModelSlugs: [CIVITAI_V2_SLUG],
      compatibleVersionIds: ["4b"],
    });
  });

  it("does not rewrite an already-migrated row or LoRA on replay", async () => {
    const statements = await civitaiV2Statements();
    expect(statements, `${CIVITAI_V2_MIGRATION_FILE} must carry the model and LoRA updates`).toHaveLength(2);
    const modelBefore = await db().select().from(imageModels).where(eq(imageModels.id, CIVITAI_V2_MODEL_ID));
    const loraBefore = await db().select().from(imageLoras).where(eq(imageLoras.id, CIVITAI_V2_LORA_ID));

    for (const statement of statements) await db().execute(sql.raw(statement));

    expect(await db().select().from(imageModels).where(eq(imageModels.id, CIVITAI_V2_MODEL_ID))).toEqual(modelBefore);
    expect(await db().select().from(imageLoras).where(eq(imageLoras.id, CIVITAI_V2_LORA_ID))).toEqual(loraBefore);
  });

  it("is the unique journal head after 0145 and carries no schema snapshot", async () => {
    const journal = JSON.parse(
      await readFile(path.join(process.cwd(), "drizzle", "meta", "_journal.json"), "utf8"),
    ) as { entries: { idx: number; tag: string; when: number }[] };
    const entry = journal.entries.find((candidate) => candidate.tag === CIVITAI_V2_MIGRATION_TAG);
    const previous = journal.entries.find((candidate) => candidate.idx === 145);

    expect(entry?.idx).toBe(146);
    expect(previous?.tag).toBe(CIVITAI_MIGRATION_TAG);
    expect(entry?.when).toBeGreaterThan(previous?.when ?? 0);
    expect(journal.entries.filter((candidate) => candidate.idx === 146)).toHaveLength(1);
    expect(Math.max(...journal.entries.map((candidate) => candidate.idx))).toBe(146);
    const missing = await readFile(path.join(process.cwd(), "drizzle", "meta", "0146_snapshot.json"), "utf8").then(
      () => false,
      () => true,
    );
    expect(missing).toBe(true);
  });
});

describe.skipIf(!ready)("migration 0141 — the capability record on a migrated database", () => {
  it.each(COMMUNITY_CAPABILITY_ROWS.map((row) => [row.label, row] as const))(
    "gives %s the bindings its reviewed settings map through",
    async (_label, expected) => {
      const [row] = await db()
        .select({ caps: imageModels.advancedCapabilities })
        .from(imageModels)
        .where(eq(imageModels.id, expected.id));
      expect(row).toBeDefined();
      // The control NAMES are what the mapper resolves a reviewed setting
      // through; an empty record here is the state that made every one of them a
      // silent `no_binding` drop.
      expect(row?.caps).toMatchObject({
        controls: Object.fromEntries(expected.controls.map((control) => [control, expect.any(Object) as unknown])),
      });
      for (const field of expected.reviewedFields) {
        expect(row?.caps).toMatchObject({ knownInputFields: expect.arrayContaining([field]) as unknown });
      }
    },
  );

  it("leaves a row an operator has already probed exactly as they probed it", async () => {
    // The guard that matters on an upgraded database: `controls` present means a
    // real probe has answered this question with better evidence than a
    // hand-written file has, and re-running must not talk over it.
    const probed = {
      controls: { seed: { field: "seed", type: "integer" } },
      additionalImageInputs: [],
      output: { arity: "single", supportsMultiple: false },
      knownInputFields: ["prompt", "seed"],
      providerInputs: [],
    };
    const target = COMMUNITY_CAPABILITY_ROWS[2];
    expect(target).toBeDefined();
    if (!target) return;
    const record = JSON.stringify(probed);
    await db().execute(
      sql`UPDATE "image_models" SET "advanced_capabilities" = ${record}::jsonb WHERE "id" = ${target.id}`,
    );

    await reapplyCommunityBackfill();

    const [row] = await db()
      .select({ caps: imageModels.advancedCapabilities })
      .from(imageModels)
      .where(eq(imageModels.id, target.id));
    expect(row?.caps).toEqual(probed);

    // Back to the migrated state: clearing the record is what a fresh database
    // looks like before this file runs, so re-running it restores the row.
    await db().execute(sql`UPDATE "image_models" SET "advanced_capabilities" = '{}'::jsonb WHERE "id" = ${target.id}`);
    await reapplyCommunityBackfill();
    const [restored] = await db()
      .select({ caps: imageModels.advancedCapabilities })
      .from(imageModels)
      .where(eq(imageModels.id, target.id));
    expect(restored?.caps).toMatchObject({ controls: { guidance: { field: "cfg" } } });
  });
});
