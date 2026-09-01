import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type { ImageModel } from "@vesper/image-core";
import type { PreparedReferenceBytes } from "@vesper/image-replicate";
import { replicateClient } from "@/server/ai";
import {
  negativeBlockDelta,
  parseManifestProvenance,
  parseNegativeBlockCsv,
  type RenderProvenance,
  type RenderRecord,
  resumedRenderRecord,
  summarizeNegativeBlockRows,
} from "./negative-block-report";

/**
 * The endpoint-neutral core of the negative-prompt trial instrument, extracted
 * from `qwen-2512-negative-blocks.ts` so the same machinery can run one trial
 * design against different endpoints without three copied scripts.
 *
 * What lives here is everything that does not depend on WHICH endpoint is being
 * measured: the trial/arm/fixture contracts, the paired-seed render loop with
 * idempotent files and manifests, contact sheets, scoring templates, the rates
 * and-deltas report, and the determinism comparison. What stays in each script
 * is the endpoint description (the seeded row's shape plus the probe-recorded
 * negative field), the trial definitions, and the CLI.
 *
 * The rules the original harness holds are unchanged and stated there:
 * paired seed sets, one variable per comparison, idempotent renders, scores
 * CSVs never overwritten, `executedVersionId` recorded per render — and on a
 * resumed `--render` run, a skipped render keeps the provenance its prior
 * manifest recorded rather than being rewritten as null.
 *
 * An endpoint may declare a reference SUPPLIER
 * ({@link NegativeTrialEndpoint.references}) for a workflow that cannot run
 * from a bare prompt — an edit-only model such as Qwen Image Edit 2511. The
 * same one-variable rule governs it: the references are resolved once per run
 * and every arm sends exactly those bytes.
 */

export interface TrialArm {
  readonly id: string;
  /**
   * The exact negative this arm sends; null sends the endpoint's OFF state —
   * no field at all, unless the endpoint declares a `baselineNegative` literal
   * (Pony's production OFF state is `""`, because an absent field resurrects
   * the wrapper's own `"nsfw, naked"` default).
   */
  readonly negative: string | null;
  /**
   * Text appended to the positive prompt for this arm.
   *
   * The positive-side transports an endpoint with no working negative field is
   * left with: affirmative replacement, and inline exclusion. Held to a SUFFIX
   * so the baseline prompt is byte-identical across arms and only the added
   * clause varies.
   */
  readonly positiveSuffix?: string;
  /**
   * A wholly different positive, replacing the fixture's.
   *
   * One legitimate use: a `production` control arm carrying the prompt the
   * shipped lane compiles TODAY, so a proposed rewording is measured against
   * what it would replace at matched seeds rather than against a recollection.
   */
  readonly positiveOverride?: string;
}

export interface TrialFixture {
  readonly id: string;
  readonly positive: string;
  readonly aspect: string;
  /** Fixture-specific ON negatives, when the block wording must specialize. */
  readonly negatives?: Readonly<Record<string, string>>;
}

export interface NegativeBlockTrial {
  readonly id: string;
  readonly title: string;
  /** The production block (or distinction) under test. */
  readonly block: string;
  /** The failure this trial induces, in one line. */
  readonly failure: string;
  /**
   * Provider fields held CONSTANT across every arm of this trial — a canary
   * diagnostic varying the sampler configuration, never a per-arm variable.
   */
  readonly providerControls?: Readonly<Record<string, unknown>>;
  readonly seeds: number;
  readonly fixtures: readonly TrialFixture[];
  readonly arms: readonly TrialArm[];
  /** Primary binary metrics, graded per render. */
  readonly metrics: readonly string[];
  /** Collateral checks — the damage a block must not cause. */
  readonly collateral: readonly string[];
  /**
   * A determinism control: every arm sends an IDENTICAL payload, and the
   * question is whether one seed reproduces one image. No scores CSV is
   * written — the harness compares file hashes itself, because "byte-identical
   * or not" needs no human grader. Without this control, an OFF/ON byte
   * difference at one seed cannot be read at all (the Qwen 2512 compass
   * misreading is the precedent).
   */
  readonly determinism?: boolean;
}

/**
 * One endpoint, as the trial scripts describe it: the seeded row's shape plus
 * the facts the probe recorded about its negative channel.
 */
export interface NegativeTrialEndpoint {
  /** Short name used in console output. */
  readonly key: string;
  /**
   * The model literal every render sends — the seeded `image_models` row's
   * shape, restated in the script so the lab renders what production would
   * send without touching the database.
   */
  readonly model: () => ImageModel;
  /**
   * The provider input the negative rides, verbatim from the version's probed
   * schema (`docs/image-models/models/<model>.md` § Inputs). The negative rides
   * `controlInput` directly (this is a lab), so no capability row is consulted.
   */
  readonly negativeField: string;
  /**
   * What an arm's `negative: null` sends: `undefined` omits the field entirely
   * (the production OFF state on most endpoints); a string sends that literal.
   */
  readonly baselineNegative?: string;
  /**
   * Constants sent with every render of every trial — the reviewed production
   * settings (`reviewed-profile-controls.ts`), so the canary measures the
   * configuration production would actually run.
   */
  readonly baseControls?: Readonly<Record<string, unknown>>;
  /**
   * The reference images every render of this endpoint sends, for endpoints
   * whose workflow cannot run without one (Qwen Image Edit 2511 is edit-only;
   * PuLID's workflow refuses bare prompts). Absent — every endpoint that
   * existed before this field — sends no `references` key at all, so those
   * requests are byte-identical to what they were.
   *
   * A SUPPLIER rather than a value, for two reasons this directory has already
   * paid for. It is invoked only on a `--render` run, so a report or another
   * endpoint's run never demands the file (`negative-field-canary.ts`'s
   * `CANARY_FACE` gate); and {@link endpointReferences} resolves it exactly
   * ONCE per run and reuses the result for every arm, seed and trial, so "the
   * reference is held constant" is a property of the harness rather than of a
   * supplier remembering to be pure. A reference that varied between arms would
   * be a second variable in a one-variable comparison.
   */
  readonly references?: () => Promise<readonly PreparedReferenceBytes[]>;
  /**
   * False for models with no aspect input (free width/height integers): the
   * aspect key is omitted and shape travels in `baseControls` instead. Sending
   * `aspect_ratio` to a model whose schema lacks it would be rejected —
   * Replicate refuses unknown inputs.
   */
  readonly sendAspect: boolean;
  /**
   * Extension for rendered files. Cosmetic — sharp sniffs content, not names —
   * but an honest label beats `.webp` on a PNG.
   */
  readonly fileExt: string;
}

/** One script's whole configuration: endpoint, trials, and where output lands. */
export interface NegativeTrialProgram {
  readonly endpoint: NegativeTrialEndpoint;
  readonly outRoot: string;
  readonly seedBase: number;
  readonly trials: readonly NegativeBlockTrial[];
}

/** The positive prompt this arm sends: the fixture's, plus the arm's own clause. */
export function armPositive(fixture: TrialFixture, arm: TrialArm): string {
  const base = arm.positiveOverride ?? fixture.positive;
  return arm.positiveSuffix === undefined ? base : `${base} ${arm.positiveSuffix}`;
}

/** The ON negative for one fixture — per-fixture wording wins over the arm's. */
export function armNegative(fixture: TrialFixture, arm: TrialArm): string | null {
  if (arm.negative === null) return null;
  const negative = fixture.negatives?.[arm.id] ?? arm.negative;
  // An arm may declare "" to mean "every fixture specializes me" (Trial F:
  // "second glove" does not belong in a boot shot). A fixture that then fails
  // to specialize is a definition bug, not a quiet no-negative render.
  if (negative.length === 0) throw new Error(`${fixture.id} does not specialize the ${arm.id} negative`);
  return negative;
}

/** What the negative field will actually carry for this arm, or undefined for "no field". */
function sentNegative(endpoint: NegativeTrialEndpoint, negative: string | null): string | undefined {
  return negative ?? endpoint.baselineNegative;
}

function describeNegative(endpoint: NegativeTrialEndpoint, negative: string | null): string {
  const sent = sentNegative(endpoint, negative);
  if (sent === undefined) return "(no negative field)";
  if (sent.length === 0) return '"" (field sent empty)';
  return sent;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * One endpoint's references, resolved once per process and reused everywhere.
 *
 * Keyed on the endpoint object rather than its `key` so two programs over the
 * same endpoint description cannot collide, and weak so nothing is retained
 * past the run. The cache IS the constancy guarantee described on
 * {@link NegativeTrialEndpoint.references}.
 */
const RESOLVED_ENDPOINT_REFERENCES = new WeakMap<NegativeTrialEndpoint, readonly PreparedReferenceBytes[]>();

async function endpointReferences(
  endpoint: NegativeTrialEndpoint,
): Promise<readonly PreparedReferenceBytes[] | undefined> {
  if (endpoint.references === undefined) return undefined;
  const cached = RESOLVED_ENDPOINT_REFERENCES.get(endpoint);
  if (cached !== undefined) return cached;
  const resolved = await endpoint.references();
  RESOLVED_ENDPOINT_REFERENCES.set(endpoint, resolved);
  return resolved;
}

async function renderOne(
  endpoint: NegativeTrialEndpoint,
  positive: string,
  negative: string | null,
  aspect: string,
  seed: number,
  providerControls?: Readonly<Record<string, unknown>>,
  references?: readonly PreparedReferenceBytes[],
): Promise<{ image: Buffer; executedVersionId: string | null; predictionId: string | null } | null> {
  const sent = sentNegative(endpoint, negative);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await replicateClient().runRegistryImageModel(endpoint.model(), {
      prompt: positive,
      // Copied rather than passed through: the request type owns a mutable
      // array, and the resolved set is shared by every render of the run.
      ...(references === undefined ? {} : { references: [...references] }),
      aspect: endpoint.sendAspect ? aspect : null,
      // controlInput merges LAST over the model literal's extraInput, and inside
      // it the layers are: seed, the endpoint's reviewed production constants,
      // the trial's sampling-path variation, then the arm's negative — so a
      // trial's cfg/sampler override applies to BOTH arms alike.
      controlInput: {
        seed,
        ...(endpoint.baseControls ?? {}),
        ...providerControls,
        ...(sent === undefined ? {} : { [endpoint.negativeField]: sent }),
      },
    });
    if (result.ok && result.image) {
      return {
        image: result.image,
        executedVersionId: result.executedVersionId ?? null,
        predictionId: result.predictionId ?? null,
      };
    }
    console.log(`    retryable failure (${result.error ?? "no image"})`);
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  return null;
}

async function fileExists(file: string): Promise<boolean> {
  return fs.access(file).then(
    () => true,
    () => false,
  );
}

async function readIfExists(file: string): Promise<string | null> {
  return fs.readFile(file, "utf8").catch(() => null);
}

// ---------------------------------------------------------------------------
// Contact sheets — one grid per fixture × arm, so grading reads one image
// ---------------------------------------------------------------------------

const PANEL_WIDTH = 380;
const LABEL_HEIGHT = 26;
const SHEET_COLUMNS = 4;

async function contactSheet(files: readonly { file: string; label: string }[], out: string): Promise<void> {
  const panels: Buffer[] = [];
  let panelHeight = 0;
  for (const entry of files) {
    const resized = await sharp(await fs.readFile(entry.file)).resize(PANEL_WIDTH).png().toBuffer();
    const meta = await sharp(resized).metadata();
    panelHeight = Math.max(panelHeight, meta.height ?? PANEL_WIDTH);
    const labeled = await sharp({
      create: { width: PANEL_WIDTH, height: (meta.height ?? PANEL_WIDTH) + LABEL_HEIGHT, channels: 3, background: "#101010" },
    })
      .composite([
        {
          input: Buffer.from(
            `<svg width="${PANEL_WIDTH}" height="${LABEL_HEIGHT}"><text x="8" y="19" font-family="sans-serif" font-size="16" fill="#ffffff">${entry.label}</text></svg>`,
          ),
          top: 0,
          left: 0,
        },
        { input: resized, top: LABEL_HEIGHT, left: 0 },
      ])
      .png()
      .toBuffer();
    panels.push(labeled);
  }
  const rows = Math.ceil(panels.length / SHEET_COLUMNS);
  const cellHeight = panelHeight + LABEL_HEIGHT;
  await sharp({
    create: { width: PANEL_WIDTH * SHEET_COLUMNS, height: cellHeight * rows, channels: 3, background: "#101010" },
  })
    .composite(panels.map((panel, index) => ({ input: panel, top: Math.floor(index / SHEET_COLUMNS) * cellHeight, left: (index % SHEET_COLUMNS) * PANEL_WIDTH })))
    .webp({ quality: 82 })
    .toFile(out);
}

// ---------------------------------------------------------------------------
// Trial execution
// ---------------------------------------------------------------------------

export function seedsOf(program: NegativeTrialProgram, trial: NegativeBlockTrial): number[] {
  const count = Number(process.env["AB_SEEDS"] ?? trial.seeds);
  return Array.from({ length: count }, (_, index) => program.seedBase + index);
}

async function writeScoresTemplate(
  outRoot: string,
  trial: NegativeBlockTrial,
  records: readonly RenderRecord[],
): Promise<string> {
  const file = path.join(outRoot, `scores-${trial.id}.csv`);
  if (await fileExists(file)) {
    console.log(`  scores template exists, not overwritten: ${file}`);
    return file;
  }
  const columns = ["trial", "fixture", "arm", "seed", "file", ...trial.metrics, ...trial.collateral, "notes"];
  const rows = records.map((record) =>
    [trial.id, record.fixture, record.arm, String(record.seed), record.file, ...trial.metrics.map(() => ""), ...trial.collateral.map(() => ""), ""].join(","),
  );
  await fs.writeFile(file, `${columns.join(",")}\n${rows.join("\n")}\n`);
  return file;
}

function trialFile(program: NegativeTrialProgram, trial: NegativeBlockTrial, fixture: string, arm: string, seed: number): string {
  return path.join(program.outRoot, trial.id, `${fixture}-${arm}-s${seed}.${program.endpoint.fileExt}`);
}

/**
 * Compare hashes for a determinism trial: every arm of a determinism trial sent
 * the same payload, so at each fixture × seed the rendered files either match
 * byte for byte or the endpoint does not reproduce at a held seed. Returns the
 * hashes so a render run can record them in the manifest.
 */
async function compareDeterminism(
  program: NegativeTrialProgram,
  trial: NegativeBlockTrial,
  seeds: readonly number[],
): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  for (const fixture of trial.fixtures) {
    for (const seed of seeds) {
      const digests: { arm: string; hash: string }[] = [];
      let missing = false;
      for (const arm of trial.arms) {
        const file = trialFile(program, trial, fixture.id, arm.id, seed);
        if (!(await fileExists(file))) {
          missing = true;
          continue;
        }
        const hash = createHash("sha256").update(await fs.readFile(file)).digest("hex");
        hashes[file] = hash;
        digests.push({ arm: arm.id, hash });
      }
      for (const digest of digests) console.log(`    ${fixture.id} s${seed} ${digest.arm.padEnd(8)} sha256 ${digest.hash.slice(0, 16)}…`);
      if (missing || digests.length < trial.arms.length) {
        console.log(`    ${fixture.id} s${seed}: determinism not comparable yet — render the trial first`);
        continue;
      }
      const identical = digests.every((digest) => digest.hash === digests[0]?.hash);
      console.log(
        identical
          ? `    ${fixture.id} s${seed}: IDENTICAL — the seed pins sampling, so OFF/ON byte differences are meaningful`
          : `    ${fixture.id} s${seed}: DIFFERS — the endpoint does not reproduce at a held seed; byte-level OFF/ON differences say nothing`,
      );
    }
  }
  return hashes;
}

export async function runTrial(program: NegativeTrialProgram, trial: NegativeBlockTrial, shouldRender: boolean): Promise<void> {
  const { endpoint, outRoot } = program;
  const seeds = seedsOf(program, trial);
  console.log(`\n=== Trial ${trial.id} — ${trial.title}`);
  console.log(`    endpoint: ${endpoint.key} (${endpoint.model().slug})`);
  console.log(`    block: ${trial.block}`);
  console.log(`    failure: ${trial.failure}`);
  console.log(`    seeds: ${seeds.join(", ")}`);
  if (endpoint.baseControls) console.log(`    base controls: ${JSON.stringify(endpoint.baseControls)}`);
  if (trial.providerControls) console.log(`    trial controls: ${JSON.stringify(trial.providerControls)}`);

  // A resumed --render run rewrites the manifest, so the provenance its prior
  // version recorded for already-rendered (skipped) files has to be read back
  // first — otherwise a resume silently replaces every skipped render's
  // executedVersionId/predictionId with nulls, and a mid-trial provider
  // re-point becomes invisible.
  const manifestFile = path.join(outRoot, trial.id, "manifest.json");
  const priorProvenance: ReadonlyMap<string, RenderProvenance> = shouldRender
    ? parseManifestProvenance(await readIfExists(manifestFile))
    : new Map();

  // Resolved before the loop and only on a paid run: a supplier that cannot
  // find its file must fail here, once, rather than mid-matrix with renders
  // already bought — and a free run must never demand it at all.
  const references = shouldRender ? await endpointReferences(endpoint) : undefined;
  if (references !== undefined) {
    console.log(`    references: ${String(references.length)} (${references.map((entry) => entry.role ?? "reference").join(", ")}), held constant across every arm`);
  }

  const records: RenderRecord[] = [];
  for (const fixture of trial.fixtures) {
    console.log(`  fixture ${fixture.id} (${endpoint.sendAspect ? fixture.aspect : "shape from controls"})`);
    console.log(`    POSITIVE ${fixture.positive}`);
    for (const arm of trial.arms) {
      const negative = armNegative(fixture, arm);
      console.log(`    ${arm.id.toUpperCase().padEnd(12)} +${arm.positiveSuffix ?? " (bare positive)"}`);
      console.log(`    ${"".padEnd(12)} neg: ${describeNegative(endpoint, negative)}`);
    }

    for (const seed of seeds) {
      for (const arm of trial.arms) {
        const negative = armNegative(fixture, arm);
        const file = trialFile(program, trial, fixture.id, arm.id, seed);
        const base = { file, seed, arm: arm.id, fixture: fixture.id };
        if (!shouldRender) {
          records.push({ ...base, executedVersionId: null, predictionId: null });
          continue;
        }
        if (await fileExists(file)) {
          // Idempotent skip: the image stands, so its record must carry the
          // provenance the prior manifest recorded, never a fresh null pair.
          records.push(resumedRenderRecord(base, priorProvenance));
          continue;
        }
        await fs.mkdir(path.dirname(file), { recursive: true });
        const rendered = await renderOne(
          endpoint,
          armPositive(fixture, arm),
          negative,
          fixture.aspect,
          seed,
          trial.providerControls,
          references,
        );
        if (rendered === null) {
          console.log(`    FAILED   ${file}`);
          continue;
        }
        await fs.writeFile(file, rendered.image);
        records.push({ ...base, executedVersionId: rendered.executedVersionId, predictionId: rendered.predictionId });
        console.log(`    rendered ${file}${rendered.executedVersionId === null ? "" : ` (${rendered.executedVersionId.slice(0, 12)})`}`);
      }
    }

    if (shouldRender) {
      for (const arm of trial.arms) {
        const armFiles: { file: string; label: string }[] = [];
        for (const seed of seeds) {
          const file = trialFile(program, trial, fixture.id, arm.id, seed);
          if (await fileExists(file)) armFiles.push({ file, label: `${fixture.id} ${arm.id} s${seed}` });
        }
        if (armFiles.length === 0) continue;
        const sheet = path.join(outRoot, trial.id, `sheet-${fixture.id}-${arm.id}.webp`);
        await contactSheet(armFiles, sheet);
        console.log(`    sheet    ${sheet}`);
      }
    }
  }

  await fs.mkdir(outRoot, { recursive: true });
  // A determinism trial grades itself by hash; a scores CSV would be an empty
  // template with nothing for a human to answer.
  const scores = trial.determinism === true ? null : await writeScoresTemplate(outRoot, trial, records);
  const hashes = trial.determinism === true ? await compareDeterminism(program, trial, seeds) : null;
  if (shouldRender) {
    await fs.mkdir(path.dirname(manifestFile), { recursive: true });
    await fs.writeFile(
      manifestFile,
      JSON.stringify(
        {
          trial: trial.id,
          slug: endpoint.model().slug,
          block: trial.block,
          seeds,
          fixtures: trial.fixtures.map((f) => f.id),
          records,
          ...(endpoint.baseControls ? { baseControls: endpoint.baseControls } : {}),
          ...(trial.providerControls ? { providerControls: trial.providerControls } : {}),
          ...(hashes && Object.keys(hashes).length > 0 ? { hashes } : {}),
        },
        null,
        2,
      ),
    );
    console.log(`  manifest ${manifestFile}`);
  }
  if (scores !== null) console.log(`  scores   ${scores}`);
}

// ---------------------------------------------------------------------------
// Report — per-arm rates and OFF→ON deltas from the graded CSVs
// ---------------------------------------------------------------------------

export async function reportTrials(program: NegativeTrialProgram): Promise<void> {
  for (const trial of program.trials) {
    if (trial.determinism === true) {
      console.log(`\n=== Trial ${trial.id} — ${trial.title}`);
      await compareDeterminism(program, trial, seedsOf(program, trial));
      continue;
    }
    const file = path.join(program.outRoot, `scores-${trial.id}.csv`);
    if (!(await fileExists(file))) continue;
    const rows = parseNegativeBlockCsv(await fs.readFile(file, "utf8"));
    const graded = rows.filter((row) => Object.values(row.values).some((value) => value.length > 0));
    if (graded.length === 0) continue;
    const summaries = summarizeNegativeBlockRows(rows);
    console.log(`\n=== Trial ${trial.id} — ${trial.title}`);
    for (const fixture of trial.fixtures) {
      for (const metric of [...trial.metrics, ...trial.collateral]) {
        const line: string[] = [];
        for (const arm of trial.arms) {
          const cell = summaries.find((s) => s.fixture === fixture.id && s.arm === arm.id);
          const m = cell?.metrics.find((entry) => entry.metric === metric);
          if (m === undefined || m.n === 0) continue;
          line.push(`${arm.id} ${m.rate === null ? `mean ${m.mean?.toFixed(1) ?? "—"}` : `${m.yes}/${m.n} (${Math.round(m.rate * 100)}%)`}`);
        }
        if (line.length === 0) continue;
        const deltas = trial.arms
          .filter((arm) => arm.id !== "off")
          .map((arm) => {
            const delta = negativeBlockDelta(summaries, { trial: trial.id, fixture: fixture.id, metric, offArm: "off", onArm: arm.id });
            return delta === null ? null : `Δ${arm.id} ${(delta.delta * 100).toFixed(0)}pp`;
          })
          .filter((entry): entry is string => entry !== null);
        console.log(`  ${fixture.id}.${metric.padEnd(28)} ${line.join("  ")}${deltas.length > 0 ? `  ${deltas.join("  ")}` : ""}`);
      }
    }
  }
}
