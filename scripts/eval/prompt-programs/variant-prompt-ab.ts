import "dotenv/config";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  emptyImageModelAdvancedCapabilities,
  imageModelProfileSchema,
  reviewedImageQualityInputs,
  type ImageModel,
  type ImageRenderReference,
  type ResolvedImageProfile,
} from "@vesper/image-core";
import type { PreparedReferenceBytes } from "@vesper/image-replicate";
import type { AttributeValue } from "@/contracts/attributes";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import {
  trialCharacterProfile,
  trialWardrobe,
  FIXTURE_NAME,
  FIXTURE_READ_TOKEN,
  FIXTURE_SUBJECT_ID,
  OUT_BASE,
  REFERENCE_DEFAULT,
} from "./variant-ab-fixture";
import { fnv1aHex } from "@/lib/hash";
import { hasReplicate } from "@/server/ai";
import {
  buildCharacterPromptProgram,
  buildVariantInstruction,
  buildVariantSegments,
  isCharacterPromptCompiled,
  variantChangeOperation,
  type AvatarWardrobeItem,
  type VariantKind,
  type VariantSegmentAssembly,
} from "@/server/images";
import {
  reportTrials,
  runTrial,
  seedsOf,
  type NegativeBlockTrial,
  type NegativeTrialEndpoint,
  type NegativeTrialProgram,
  type TrialFixture,
} from "./negative-trial-harness";

/**
 * THE VARIANT-LANE POSITIVE-PROMPT TRIAL — the paid, manually graded evidence
 * for promoting `variant-standard`'s prompt-program binding from `candidate` to
 * `active` (issue #256).
 *
 * The shadow already answers the structural half: do the two prompts state the
 * same facts, configure the same transport, and keep the same anchors
 * (`shadow-report.ts`). What no comparator can answer is whether the compiled
 * program makes an equally good PICTURE on this endpoint — whether the face
 * still belongs to the same person, whether the requested change happens,
 * whether apparent age holds. That question is answered by looking, so this
 * script renders both prompts at matched seeds and writes a grading sheet.
 *
 * ## The one variable
 *
 * Everything is held constant except the positive prompt: the same seed in each
 * paired comparison, the same reference image bytes in both arms (resolved once
 * per run by the harness and reused for every arm, seed and trial), the same
 * reviewed provider controls, the same 3:4 target, the same pinned provider
 * version. The endpoint sends no negative at all — 2511 exposes no negative
 * input — so that channel is not a hidden second variable either.
 *
 * ## The legacy arm is an OPEN OWNER RULING
 *
 * Issue #256 says this trial runs "against the frozen Stage 0 payload hashes".
 * But the frozen builder those hashes pin — `buildVariantInstruction`, held by
 * `prompt-freeze.test.ts` — HAS NO PRODUCTION CALLER. Production ships
 * `buildVariantSegments(...).prompt`, and that is also the legacy side the
 * shadow measures. The two are different strings, so "the legacy arm" is two
 * different experiments:
 *
 * - `legacy` (DEFAULT) — `buildVariantSegments`, what production actually
 *   sends today. Promoting the binding replaces THIS string, so this is the
 *   comparison a cutover decision is about.
 * - `frozen` — `buildVariantInstruction`, the Stage 0 string. Answers "is the
 *   compiled program better than the payload the freeze recorded", which is a
 *   historical question about a builder nothing calls.
 *
 * Whichever arm runs, {@link writeStage0Anchor} records the FROZEN string, its
 * `fnv1aHex` and its character count for every kind, so a run always states its
 * relationship to the freeze. `prompt-freeze.test.ts` and its hashes are not
 * touched by this script. **The fork is the owner's to close** — it is written
 * up in `scripts/eval/prompt-programs/README.md` and belongs on issue #256.
 *
 * ## Why the fixture is the script's own, and why it has horns
 *
 * The variant lane's one named cutover delta is
 * `VARIANT_SHADOW_DELTA = { removed: [], added: ["horns", "wings", "tail"] }` —
 * the compiled program states species morphology the legacy build never did. A
 * fixture without species features would measure nothing about that delta, so
 * {@link trialCharacterProfile} authors a succubus with spiraled horns,
 * membranous wings and a spaded tail. One fixture, not two: a second character
 * multiplies the spend without asking a new question.
 *
 * The character is declared HERE rather than borrowed from
 * `@/server/test-support`'s lane probe, and the reason is mechanical: that
 * barrel eagerly imports vitest (`route-assertions.ts`, `sim-assertions.ts`,
 * `sim-harness.ts`), so any runnable script importing it dies at load with
 * "Vitest cannot be imported in a CommonJS module using require()". A script
 * also may not deep-import a server module past its barrel (eslint
 * no-restricted-imports zone 4), so there is no narrower spelling either;
 * `scripts/check-route-authz.ts` records the same constraint and resolves it
 * the same way. The consequence is worth stating plainly: **this fixture is the
 * TRIAL's, not the shadow's probe.** The two characters are authored to the
 * same shape and both exercise the species delta, but they are separate
 * literals and a change to one does not move the other — so a number from this
 * trial and a number from `shadow-report.ts` describe two characters, not one.
 *
 * Both arms still describe ONE character: the legacy prompt, the frozen prompt
 * and the compiled program are all built from a single
 * {@link buildVariantSegments} assembly over one realized cut.
 *
 * `nsfw_test` is deliberately NOT among the kinds. That kind runs on the LoRA
 * wrapper slug (`qwen/qwen-image-edit-plus-lora`, `nsfw-lora.ts`), which is a
 * different endpoint with a different binding — evidence gathered there says
 * nothing about `variant-standard` on 2511.
 *
 * ## Running it
 *
 * ```
 * pnpm tsx scripts/eval/prompt-programs/variant-prompt-ab.ts                    # FREE: both prompts per kind, arms, matrix, templates
 * pnpm tsx scripts/eval/prompt-programs/variant-prompt-ab.ts --dry-run          # FREE: the same, said explicitly
 * AB_TRIAL=pose pnpm tsx .../variant-prompt-ab.ts --render                      # PAID: one kind
 * AB_TRIAL=all  pnpm tsx .../variant-prompt-ab.ts --render                      # PAID: the whole matrix
 * pnpm tsx .../variant-prompt-ab.ts --report                                    # per-arm rates from the graded CSVs
 * ```
 *
 * Output lands under the untracked root `eval-images/` (owner ruling
 * 2026-08-28): renders, manifests, contact sheets, the grading sheets, the
 * Stage 0 anchor and the run notes are all local, and none of it enters git —
 * so the VERDICT has to be written up on issue #256 or it does not exist.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The binding's model. Unpinned here on purpose — see {@link trialModel}. */
const BASE_SLUG = "qwen/qwen-image-edit-2511";

/** The profile key the candidate binding is registered under (`packs-qwen-2511.ts`). */
const PROFILE_KEY = "variant-standard";

/**
 * The probed version, from `docs/image-models/models/qwen-image-edit-2511.md`
 * (probed 2026-08-05).
 *
 * A default rather than a required flag, because this endpoint is an official
 * Replicate model whose registry row floats — but a SILENT default would let a
 * run grade whatever the slug resolved to that day, so the pin and its
 * provenance are printed loudly on every run, free or paid, and `--version`
 * overrides it.
 */
const DOCUMENTED_VERSION = "a0670a7f47d5975347c105b6ce71456c4377d511993975988127dee03ca6c729";

const SEED_BASE = Number(process.env["AB_SEED_BASE"] ?? 20_260_831);

/** Paired seeds per kind. `AB_SEEDS` overrides it (the harness reads that env). */
const SEEDS_PER_KIND = 3;

/** The trial's stand-in for `characters.updatedAt` — fixed, so nothing here depends on a clock. */
const TRIAL_REVISION = "trial";

const FIXTURE_ID = "nyx";

/** Vesper's portrait target (`IMAGE_TARGET_ASPECT`, 3/4) spelled as this model's aspect-enum entry. */
const TARGET_ASPECT = "3:4";

/**
 * The grading sheet's columns, and the single place they are stated.
 *
 * Derived into the trial definitions below rather than hand-typed into a CSV
 * header, so the sheet a grader fills in and the dimensions this file's docs
 * describe cannot drift apart (the `sd-identity-matrix.ts` anti-drift rule).
 *
 * One BINARY per column, and each column is a migration risk stated as a
 * question a grader can answer by looking at one picture:
 *
 * - `identity_face_fidelity` — is this still the same person as the reference?
 * - `requested_change_succeeded` — did the asked-for change actually happen?
 * - `apparent_age_preserved` — the owner ruling of 2026-07-29: variant edits
 *   drift older, and the age anchor is the thing that stops it.
 * - `preserved_facts_intact` — hair, eyes, skin, species morphology: are the
 *   character's stated facts still there?
 * - `geometry_framing_ok` — full-figure, facing the camera, nothing cropped or
 *   duplicated.
 * - `no_other_regression` — the catch-all for damage none of the above names.
 *
 * Blank means UNGRADED and must never be read as "no": `--report` counts only
 * filled cells, and a sheet half-filled is a half-graded run, not a failing one.
 */
export const VARIANT_PROMPT_AB_DIMENSIONS = [
  "identity_face_fidelity",
  "requested_change_succeeded",
  "apparent_age_preserved",
  "preserved_facts_intact",
  "geometry_framing_ok",
  "no_other_regression",
] as const;

/**
 * The ordinary variant changes, with the instruction each kind is measured on.
 *
 * Fixed wording, because the instruction is part of the payload and a trial
 * whose prompt text moved between runs would not be resumable. `nsfw_test` is
 * excluded for the reason in the header.
 */
const TRIAL_KINDS: readonly { readonly kind: VariantKind; readonly instruction: string }[] = [
  { kind: "pose", instruction: "sitting on the workshop stool, leaning forward on one elbow" },
  { kind: "outfit", instruction: "a heavy linen apron over a plain work shirt" },
  { kind: "expression", instruction: "a slow, amused half-smile" },
  { kind: "setting", instruction: "a rain-streaked glassworks at dusk, kilns banked low" },
];

/** A mistake in how the script was CALLED — printed without a stack trace. */
class UsageError extends Error {}

// ---------------------------------------------------------------------------
// The fixture — owned by this script, for the reason in the header
// ---------------------------------------------------------------------------

/**
 * The variant lane's PRODUCTION assembly over this fixture — the exact call
 * `generateVariant` makes, minus the database around it.
 *
 * ONE assembly per kind feeds all three prompts: its `.prompt` is the legacy
 * arm, its `.visual.ageAnchor` is what the frozen builder is handed, and its
 * `.visual` realized cut is what the compiled program compiles from. That is
 * what keeps the arms describing one character rather than three.
 */
function trialVariantSegments(kind: VariantKind, instruction: string): VariantSegmentAssembly {
  return buildVariantSegments({
    characterId: FIXTURE_SUBJECT_ID,
    name: FIXTURE_NAME,
    profile: trialCharacterProfile(),
    kind,
    instruction,
    wardrobe: trialWardrobe(),
    readToken: FIXTURE_READ_TOKEN,
  });
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

/**
 * A `--flag value` pair, or null when the flag is ABSENT.
 *
 * A flag that is present but carries no usable value exits rather than reading
 * as absent — the two are opposite intentions and this script spends money on
 * the difference. `--render --version "$UNSET"` would buy the whole matrix at
 * the documented pin while its operator believed a different version was under
 * test; `--render --reference "$UNSET"` would grade every arm against whatever
 * portrait happens to sit at the default path; and `--legacy-arm "$UNSET"`
 * would render the default arm into the directory named for the other one.
 */
function flagValue(flag: string): string | null {
  const at = process.argv.indexOf(flag);
  if (at < 0) return null;
  const next = process.argv[at + 1];
  if (next === undefined || next.startsWith("--") || next.trim().length === 0) {
    console.error(`${flag} was given without a value. Pass one, or omit the flag entirely.`);
    process.exit(1);
  }
  return next;
}

/** Which legacy string the trial measures the compiled program against — the open ruling. */
const LEGACY_SOURCES = ["legacy", "frozen"] as const;
type LegacySource = (typeof LEGACY_SOURCES)[number];

interface Args {
  readonly legacySource: LegacySource;
  readonly versionId: string;
  readonly versionIsDefault: boolean;
  readonly referencePath: string;
  readonly outRoot: string;
  readonly render: boolean;
  readonly report: boolean;
  readonly dryRun: boolean;
}

function readArgs(): Args {
  const rawSource = flagValue("--legacy-arm");
  const legacySource = LEGACY_SOURCES.find((known) => known === rawSource);
  if (rawSource !== null && legacySource === undefined) {
    throw new UsageError(`--legacy-arm must be one of ${LEGACY_SOURCES.join(", ")}: ${rawSource}`);
  }
  const source = legacySource ?? "legacy";
  const version = flagValue("--version");
  const outRoot = flagValue("--out") ?? `${OUT_BASE}/${source}`;
  return {
    legacySource: source,
    versionId: version ?? DOCUMENTED_VERSION,
    versionIsDefault: version === null,
    // Any clear synthetic front-facing portrait works; keep the same file
    // across every arm and every run of one comparison.
    referencePath: flagValue("--reference") ?? REFERENCE_DEFAULT,
    outRoot,
    render: process.argv.includes("--render"),
    report: process.argv.includes("--report"),
    dryRun: process.argv.includes("--dry-run"),
  };
}

// ---------------------------------------------------------------------------
// The endpoint, restated from the seeded rows
// ---------------------------------------------------------------------------

/**
 * The reviewed production controls for this slug, DERIVED from the reviewed
 * table rather than restated.
 *
 * `go_fast: false` is the whole of it (owner quality ruling: 2511 serves
 * identity-critical lanes and the provider default optimizes speed where
 * fidelity matters). Production applies it through `withReviewedImageQuality`
 * inside `renderWithModel`; this lab calls the transport directly, so the same
 * values ride `baseControls` and land in every manifest. A trial that skipped
 * them would grade a configuration production does not run.
 */
function reviewedControls(): Readonly<Record<string, unknown>> {
  const controls = reviewedImageQualityInputs[BASE_SLUG];
  if (controls === undefined || Object.keys(controls).length === 0) {
    throw new UsageError(
      `the reviewed quality policy for ${BASE_SLUG} is empty — production sends reviewed provider controls on this ` +
        "model, so a trial without them would grade a configuration production does not run",
    );
  }
  return controls;
}

/**
 * The 2511 row as migration 0098 seeds it, stated locally.
 *
 * Local rather than read from `image_models`, for the reason
 * `entity-negative-ab.ts` records: activating or re-probing the production row
 * would repin the version for every profile that resolves to it, and the
 * evidence has to come before anything about production moves. Reading the row
 * is not this script's business either way.
 *
 * TWO SLUGS, one row. The RENDER side pins the probed version in the slug,
 * because a controlled comparison cannot run against a floating
 * `latest_version`. The COMPILE side must see the BASE slug: prompt bindings
 * are registered on `qwen/qwen-image-edit-2511` (`packs-qwen-2511.ts`), and a
 * pinned slug would resolve no binding and turn every compiled arm into an
 * `unbound` result.
 *
 * `advancedCapabilities` is empty here, which is a stated LIMITATION rather
 * than a claim: the deployed row carries a probed record (migration 0119), and
 * if that record ever declares a measured prompt budget, production's compiled
 * prompt would be fitted to it and this trial's would not. It declares no
 * negative field either way — 2511 has none — so the negative channel is
 * genuinely absent in both.
 */
function trialModel(options: { readonly versionId: string | null }): ImageModel {
  return {
    id: "trial-qwen-edit-2511",
    slug: options.versionId === null ? BASE_SLUG : `${BASE_SLUG}:${options.versionId}`,
    label: "Qwen Image Edit 2511",
    canGenerate: false,
    canEdit: true,
    referenceField: "image",
    referenceArity: "array",
    maxReferences: 3,
    referenceTransport: "file",
    aspectMode: "aspect_ratio",
    // Migration 0098's menu verbatim; 3:4 is Vesper's portrait target and is in it.
    supportedAspects: ["1:1", "16:9", "9:16", "4:3", "3:4"],
    outputFormat: "webp",
    extraInput: { output_quality: 95, go_fast: true, disable_safety_checker: true },
    probedVersionId: options.versionId,
    // The reviewed capability, from docs/image-models/models/qwen-image-edit-2511.md.
    editKind: "instruction_edit",
    identityPreservation: "strong",
    operatorWarning: null,
    advancedCapabilities: emptyImageModelAdvancedCapabilities(),
    forPortrait: false,
    forVariant: true,
    forScene: true,
    builtin: true,
    sort: 20,
  } satisfies ImageModel;
}

/**
 * The `variant-standard` profile row from migration 0100, parsed through the
 * registry's own schema so the defaults this trial runs under are the exact
 * defaults a database read applies — never a hand-written approximation of them.
 */
function trialProfile(model: ImageModel): ResolvedImageProfile {
  const profile = imageModelProfileSchema.parse({
    id: "imgprf2511variantaaaaaaa",
    imageModelId: model.id,
    key: PROFILE_KEY,
    label: "Variant Standard",
    task: "variant",
    operation: "edit",
    promptStrategy: "instruction_edit",
    referencePolicy: { allowedRoles: ["identity", "style"], requiredRoles: ["identity"], roleOrder: ["identity", "style"] },
    controlDefaults: {},
    providerOverrides: {},
    timeoutMs: null,
    enabled: true,
    isDefault: true,
    builtin: true,
    sort: 21,
  });
  return { profile, model };
}

// ---------------------------------------------------------------------------
// The reference
// ---------------------------------------------------------------------------

const REFERENCE_MEDIA_TYPES: Readonly<Record<string, string>> = {
  ".webp": "image/webp",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};

interface TrialReference {
  readonly bytes: Buffer;
  readonly mediaType: string;
  readonly extension: string;
  readonly provenance: string;
  /** True when this is the free run's stand-in rather than a real portrait. */
  readonly placeholder: boolean;
}

/**
 * The identity anchor every arm sends.
 *
 * On a `--render` run the real file is REQUIRED: 2511 is edit-only and cannot
 * render from a bare prompt, so a missing reference must fail here — free, and
 * before the first prediction — rather than as a matrix of provider errors.
 *
 * On a free run a one-pixel stand-in is used when no file is present. That is
 * sound for what a free run produces: the compiled program plans references by
 * ROLE, ORDER and COUNT, never by their bytes, so the prompt text this run
 * prints is the prompt text a paid run sends.
 */
async function loadReference(reference: string, required: boolean): Promise<TrialReference> {
  const extension = path.extname(reference).toLowerCase();
  const mediaType = REFERENCE_MEDIA_TYPES[extension];
  const bytes = await fs.readFile(reference).catch(() => null);
  if (bytes === null || mediaType === undefined) {
    if (required) {
      throw new UsageError(
        `--render needs a reference image at ${reference} (or --reference <path>): Qwen Image Edit 2511 is edit-only ` +
          `and refuses a bare prompt. Any clear synthetic front-facing portrait works (${Object.keys(REFERENCE_MEDIA_TYPES).join(", ")}); ` +
          "keep the same file across every arm of one comparison.",
      );
    }
    return {
      bytes: Buffer.from([0]),
      mediaType: "image/webp",
      extension: "webp",
      provenance: `(placeholder — nothing readable at ${reference}; reference BYTES never reach the prompt, only role and order do)`,
      placeholder: true,
    };
  }
  return {
    bytes,
    mediaType,
    extension: extension.replace(".", ""),
    provenance: `${path.resolve(reference)} (${String(bytes.length)} bytes, sha256 ${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}…)`,
    placeholder: false,
  };
}

/** What the compiled program plans over — the lane's identity reference, pre-planning. */
function programReferences(reference: TrialReference): ImageRenderReference[] {
  return [
    {
      role: "identity",
      required: true,
      buffer: reference.bytes,
      name: `${FIXTURE_NAME} identity anchor`,
      subject: FIXTURE_NAME,
    },
  ];
}

function preparedReferences(reference: TrialReference): PreparedReferenceBytes[] {
  return [{ bytes: reference.bytes, mediaType: reference.mediaType, extension: reference.extension, role: "identity" }];
}

// ---------------------------------------------------------------------------
// The three prompts
// ---------------------------------------------------------------------------

interface PromptRecord {
  readonly text: string;
  readonly hash: string;
  readonly chars: number;
}

function promptRecord(text: string): PromptRecord {
  return { text, hash: fnv1aHex(text), chars: text.length };
}

/** One kind's three prompts, all built from ONE segment assembly over one cut. */
interface KindPrompts {
  readonly kind: VariantKind;
  readonly instruction: string;
  /** `buildVariantSegments` — what production ships today, and the shadow's legacy side. */
  readonly legacy: PromptRecord;
  /** `buildVariantInstruction` — the Stage 0 frozen builder, with no production caller. */
  readonly frozen: PromptRecord;
  readonly compiled: PromptRecord;
  /** The FINAL send order the compiled program planned. */
  readonly sentReferenceRoles: readonly string[];
}

function buildKindPrompts(
  entry: { readonly kind: VariantKind; readonly instruction: string },
  profile: ResolvedImageProfile,
  references: readonly ImageRenderReference[],
  sink: DiagnosticCollector,
): KindPrompts {
  const assembly = trialVariantSegments(entry.kind, entry.instruction);
  const visual = assembly.visual;

  const result = buildCharacterPromptProgram({
    lane: "variant",
    task: "variant",
    profile,
    bindingProfileKey: PROFILE_KEY,
    // `shadow`, not `active`: the variant binding is still registered as a
    // CANDIDATE (`packs-qwen-2511.ts` — an active row would overload the
    // staged-rollout state model), and this trial is the evidence FOR promoting
    // it. `active` would resolve null and every compiled arm would be unbound.
    resolver: "shadow",
    cut: {
      subjectId: FIXTURE_SUBJECT_ID,
      name: FIXTURE_NAME,
      digest: visual.digest,
      attributes: visual.resolved,
      exposure: visual.exposure,
      realizedBody: visual.realizedBody,
    },
    read: {
      kind: "standalone_character",
      characters: [{ characterId: FIXTURE_SUBJECT_ID, revision: TRIAL_REVISION }],
      extraRevisions: [],
    },
    references,
    operation: variantChangeOperation(entry.kind, entry.instruction),
    // The trial MEASURES a degraded assembly rather than refusing over it: a
    // missing anchor is a grading observation, not a reason to buy nothing.
    refuseOnMissingRequired: false,
    sink,
  });

  if (!isCharacterPromptCompiled(result)) {
    throw new UsageError(
      result.kind === "unbound"
        ? `${entry.kind}: no prompt binding for ${result.modelSlug} / ${result.task} / ${result.profileKey ?? "(no profile key)"} — ` +
            "the shadow resolver should see the candidate row; check that packs-qwen-2511.ts is still registering it"
        : `${entry.kind}: the prompt program refused to compile (${result.code}) — ${result.refusal}`,
    );
  }
  if (result.negativePrompt !== null && result.negativePrompt.length > 0) {
    throw new UsageError(
      `${entry.kind}: the compiled program produced a negative prompt, and this endpoint has no negative input — ` +
        "the two arms would differ in two places, so the comparison would measure neither",
    );
  }

  return {
    kind: entry.kind,
    instruction: entry.instruction,
    legacy: promptRecord(assembly.prompt),
    frozen: promptRecord(
      buildVariantInstruction(entry.kind, entry.instruction, { ageAnchor: visual.ageAnchor }),
    ),
    compiled: promptRecord(result.prompt),
    sentReferenceRoles: result.sentReferences.map((planned) => planned.role),
  };
}

/**
 * The compiled program's planned send order must be the reference list this
 * endpoint actually sends, or the arms differ in a second place.
 *
 * Checked rather than assumed: the trial sends one identity reference, and a
 * program that planned a different set (a dropped required role, an added
 * style slot) would mean the compiled arm was graded on a payload the legacy
 * arm never had.
 */
function assertReferencePlanMatches(prompts: readonly KindPrompts[], sent: readonly PreparedReferenceBytes[]): void {
  const expected = sent.map((entry) => entry.role ?? "reference").join(", ");
  for (const entry of prompts) {
    const planned = entry.sentReferenceRoles.join(", ");
    if (planned !== expected) {
      throw new UsageError(
        `${entry.kind}: the compiled program plans references [${planned}] but this endpoint sends [${expected}] — ` +
          "the arms would not be comparable, so nothing was rendered",
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Trials
// ---------------------------------------------------------------------------

function armPromptFor(entry: KindPrompts, source: LegacySource): PromptRecord {
  return source === "frozen" ? entry.frozen : entry.legacy;
}

function kindTrial(entry: KindPrompts, source: LegacySource): NegativeBlockTrial {
  const legacy = armPromptFor(entry, source);
  const fixture: TrialFixture = {
    id: FIXTURE_ID,
    // The fixture's positive IS the legacy arm; the compiled arm overrides it.
    positive: legacy.text,
    aspect: TARGET_ASPECT,
  };
  return {
    id: entry.kind,
    title: `Variant ${entry.kind} — ${source} variant prompt vs compiled prompt program`,
    // `block` is what the harness prints and records in every manifest, so the
    // Stage 0 anchor rides here as well as in stage0-anchor.json: a manifest
    // that did not state its relationship to the freeze would be evidence
    // nobody could place later.
    block: `positive prompt (${source} vs compiled); Stage 0 frozen anchor fnv1a ${entry.frozen.hash}, ${String(entry.frozen.chars)} chars`,
    failure:
      "does the compiled program hold identity, the requested change, apparent age and the character's stated facts as well as the prompt it would replace",
    seeds: SEEDS_PER_KIND,
    fixtures: [fixture],
    arms: [
      { id: source, negative: null },
      { id: "compiled", negative: null, positiveOverride: entry.compiled.text },
    ],
    metrics: [...VARIANT_PROMPT_AB_DIMENSIONS],
    collateral: [],
  };
}

/**
 * The determinism control, on the compiled arm's own payload.
 *
 * Determinism has NEVER been measured on 2511. Without it, a legacy/compiled
 * difference at one seed cannot be read at byte level at all — the Qwen 2512
 * compass misreading is the precedent — and a grader comparing two visibly
 * different images has no way to know how much of the difference the sampler
 * owns. Two identical payloads at one seed, hashes compared by the harness.
 */
function determinismTrial(entry: KindPrompts): NegativeBlockTrial {
  return {
    id: "D",
    title: "Determinism control — the compiled arm rendered twice at one seed",
    block: "none — instrumentation",
    failure: "does a held seed reproduce a byte-identical image on 2511, so an arm-to-arm difference can be read at all",
    seeds: 1,
    fixtures: [{ id: FIXTURE_ID, positive: entry.compiled.text, aspect: TARGET_ASPECT }],
    arms: [
      { id: "first", negative: null },
      { id: "second", negative: null },
    ],
    metrics: [],
    collateral: [],
    determinism: true,
  };
}

function buildProgram(args: Args, prompts: readonly KindPrompts[], reference: TrialReference): NegativeTrialProgram {
  const first = prompts[0];
  if (first === undefined) throw new UsageError("no variant kinds are defined — nothing to compare");
  const endpoint: NegativeTrialEndpoint = {
    key: "qwen-edit-2511",
    model: () => trialModel({ versionId: args.versionId }),
    // 2511 exposes NO negative input, and no arm here sends one: every arm
    // declares `negative: null` and the endpoint declares no `baselineNegative`,
    // so `renderOne` writes no negative key at all. The empty name is
    // deliberate — if an arm ever did send a negative, Replicate would reject
    // the unknown input loudly instead of this trial quietly inventing a field
    // the endpoint does not have.
    negativeField: "",
    baseControls: reviewedControls(),
    sendAspect: true,
    fileExt: "webp",
    references: () => Promise.resolve(preparedReferences(reference)),
  };
  return {
    endpoint,
    outRoot: args.outRoot,
    seedBase: SEED_BASE,
    trials: [...prompts.map((entry) => kindTrial(entry, args.legacySource)), determinismTrial(first)],
  };
}

// ---------------------------------------------------------------------------
// Output the run leaves behind
// ---------------------------------------------------------------------------

/**
 * The Stage 0 anchor, written on every run whichever legacy arm ran.
 *
 * `frozen` is the anchor: the string `buildVariantInstruction` produces for this
 * fixture and this instruction, with its `fnv1aHex` and character count. It is
 * NOT the same measurement as `prompt-freeze.test.ts`'s pins, which are taken
 * over that suite's own frozen fixture and remain the canonical Stage 0 record;
 * this file is the same builder measured on this trial's character, so a reader
 * can place the run against the freeze without either file editing the other.
 *
 * Derived, so it is rewritten every run — unlike the grading sheet and the run
 * notes, which carry human work and are never overwritten.
 */
async function writeStage0Anchor(outRoot: string, args: Args, prompts: readonly KindPrompts[], reference: TrialReference): Promise<string> {
  const file = path.join(outRoot, "stage0-anchor.json");
  await fs.mkdir(outRoot, { recursive: true });
  await fs.writeFile(
    file,
    JSON.stringify(
      {
        slug: BASE_SLUG,
        versionId: args.versionId,
        profileKey: PROFILE_KEY,
        legacyArmRun: args.legacySource,
        fixture: { id: FIXTURE_ID, subjectId: FIXTURE_SUBJECT_ID, name: FIXTURE_NAME },
        reference: reference.provenance,
        stage0Anchor: {
          builder: "buildVariantInstruction (server/images/prompts-variant.ts)",
          note:
            "The Stage 0 frozen builder, pinned by prompt-freeze.test.ts and with no production caller. " +
            "Recorded on every run so a graded comparison always states its relationship to the freeze. " +
            "The hashes below are over THIS trial's fixture, not the freeze suite's; neither file re-pins the other.",
        },
        kinds: prompts.map((entry) => ({
          kind: entry.kind,
          instruction: entry.instruction,
          frozen: entry.frozen,
          legacy: entry.legacy,
          compiled: entry.compiled,
          sentReferenceRoles: entry.sentReferenceRoles,
        })),
      },
      null,
      2,
    ),
  );
  return file;
}

async function fileExists(file: string): Promise<boolean> {
  return fs.access(file).then(
    () => true,
    () => false,
  );
}

/** The run-notes skeleton — written once and never overwritten, because the verdict goes in it. */
async function writeRunNotes(outRoot: string, args: Args, program: NegativeTrialProgram, reference: TrialReference): Promise<string> {
  const file = path.join(outRoot, "README.md");
  if (await fileExists(file)) return file;
  const today = new Date().toISOString().slice(0, 10);
  const renders = program.trials.map((trial) => ({ trial, count: renderCount(program, trial) }));
  const body = `# Variant prompt A/B — ${args.legacySource} vs compiled

Status: set up ${today} — ungraded.

The paid, manually graded half of the \`variant-standard\` cutover evidence
(issue #256): the legacy variant prompt against the compiled prompt program, at
matched seeds, on pinned Qwen Image Edit 2511. Rendered by
\`scripts/eval/prompt-programs/variant-prompt-ab.ts\`.

- **Model:** \`${BASE_SLUG}\`, version \`${args.versionId}\`${args.versionIsDefault ? " (the documented probed pin — no --version was passed)" : " (--version)"}
- **Profile:** \`${PROFILE_KEY}\`, resolver \`shadow\` (the binding is still a candidate; this run is the evidence for promoting it)
- **Provider controls:** \`${JSON.stringify(program.endpoint.baseControls ?? {})}\` — the reviewed production settings
- **Reference:** ${reference.provenance} — TO BE FILLED: which portrait this is and why that one
- **Fixture:** this trial's own character (\`${FIXTURE_NAME}\`, \`${FIXTURE_SUBJECT_ID}\`) — a succubus, so the named cutover delta (horns, wings, tail) is live. It is NOT the shadow's lane probe: a runnable script cannot import \`@/server/test-support\` (that barrel loads vitest), so the two are separate literals authored to the same shape.
- **Legacy arm:** \`${args.legacySource}\` — ${args.legacySource === "legacy" ? "`buildVariantSegments`, what production ships today" : "`buildVariantInstruction`, the Stage 0 frozen string with no production caller"}

Everything in this folder is **local only** (owner ruling 2026-08-28): the
images, the manifests, \`stage0-anchor.json\`, and every \`scores-*.csv\` live in
the untracked \`eval-images/\` root and none of it enters git. **The verdict
therefore has to be written up on issue #256** — nothing here survives the
machine.

## The trials

${renders.map(({ trial, count }) => `- \`${trial.id}\` — ${trial.title} (${String(count)} renders)`).join("\n")}

## How to grade

Open one fixture's contact sheets side by side, arm against arm at the same
seed, then move to the next kind. Fill one binary per column in
\`scores-<kind>.csv\`:

${VARIANT_PROMPT_AB_DIMENSIONS.map((dimension) => `- \`${dimension}\``).join("\n")}

A blank cell means **ungraded** and is never read as "no". \`--report\` counts
only filled cells, so a half-filled sheet is a half-graded run.

Read trial \`D\` first. Determinism has never been measured on this endpoint: if
one seed does not reproduce one image, then some of every arm-to-arm difference
belongs to the sampler and not to the prompt, and the grading has to be read
that much more conservatively.

## The open owner ruling

Issue #256 asks for the comparison "against the frozen Stage 0 payload hashes",
but the frozen builder has no production caller. This run measured the
\`${args.legacySource}\` arm; \`stage0-anchor.json\` records the frozen string, its
hash and its length for every kind either way. Which arm the promotion decision
is actually about is the owner's call.

## Verdict

TO BE FILLED — promote \`variant-standard\`'s binding to \`active\`, or not, and
why. Per issue #256 this has to be recorded on the issue: this file is not in git.
`;
  await fs.mkdir(outRoot, { recursive: true });
  await fs.writeFile(file, body);
  return file;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function renderCount(program: NegativeTrialProgram, trial: NegativeBlockTrial): number {
  return seedsOf(program, trial).length * trial.arms.length * trial.fixtures.length;
}

function printPrompts(args: Args, prompts: readonly KindPrompts[], reference: TrialReference): void {
  console.log(`\n##### Variant prompt A/B — ${args.legacySource} vs compiled, on ${BASE_SLUG}`);
  console.log(`  VERSION   ${args.versionId}${args.versionIsDefault ? "  (the documented probed pin from docs/image-models/models/qwen-image-edit-2511.md — pass --version to override)" : "  (--version)"}`);
  console.log(`  PROFILE   ${PROFILE_KEY}, resolver shadow (the binding is a candidate; this run is the evidence for promoting it)`);
  console.log(`  CONTROLS  ${JSON.stringify(reviewedControls())}  (reviewed production settings)`);
  console.log(`  REFERENCE ${reference.provenance}`);
  if (reference.placeholder) {
    console.log(
      "  NOTE      no reference file was readable, so this free run planned over a one-pixel stand-in. The compiled " +
        "program plans references by role, order and count and never by their bytes, so the prompts below are the " +
        "prompts a paid run sends.",
    );
  }
  for (const entry of prompts) {
    console.log(`\n=== ${entry.kind} — "${entry.instruction}"`);
    console.log(`  LEGACY   (${String(entry.legacy.chars)} chars, fnv1a ${entry.legacy.hash})  ${entry.legacy.text}`);
    console.log(`  FROZEN   (${String(entry.frozen.chars)} chars, fnv1a ${entry.frozen.hash})  ${entry.frozen.text}`);
    console.log(`  COMPILED (${String(entry.compiled.chars)} chars, fnv1a ${entry.compiled.hash})  ${entry.compiled.text}`);
    console.log(`  REFERENCES SENT  ${entry.sentReferenceRoles.join(", ") || "(none)"}`);
  }
}

async function main(): Promise<void> {
  const args = readArgs();
  if (args.render && args.dryRun) {
    throw new UsageError("--dry-run and --render are opposite instructions; pass one");
  }

  const model = trialModel({ versionId: null });
  const profile = trialProfile(model);
  const reference = await loadReference(args.referencePath, args.render);
  const sink = new DiagnosticCollector();
  const prompts = TRIAL_KINDS.map((entry) => buildKindPrompts(entry, profile, programReferences(reference), sink));
  const program = buildProgram(args, prompts, reference);
  // Free, and therefore checked on every run: a compiled arm that planned a
  // different reference set from the one this endpoint sends would be graded on
  // a payload the legacy arm never had.
  assertReferencePlanMatches(prompts, preparedReferences(reference));

  if (args.report) {
    console.log(
      [
        "How to read this trial:",
        "  1. Trial D first — if a held seed does not reproduce one image, part of every",
        "     arm-to-arm difference belongs to the sampler, not to the prompt.",
        "  2. Each dimension is a binary per render; a BLANK cell is ungraded, never a no.",
        "  3. No Δ column: the harness computes deltas against an arm named `off`, and",
        "     these arms are named for the prompt each one sends.",
      ].join("\n"),
    );
    await reportTrials(program);
    return;
  }

  printPrompts(args, prompts, reference);
  for (const diagnostic of sink.items) console.log(`  DIAG ${diagnostic.severity} ${diagnostic.code}: ${diagnostic.message}`);

  const total = program.trials.reduce((count, trial) => count + renderCount(program, trial), 0);
  if (args.render) {
    if (!hasReplicate()) throw new UsageError("REPLICATE_API_TOKEN is not set — --render has nothing to send to");
    if (process.env["AB_TRIAL"] === undefined) {
      throw new UsageError(
        `--render needs AB_TRIAL=<${program.trials.map((trial) => trial.id).join("|")}> or AB_TRIAL=all — ` +
          `the full matrix is ${String(total)} renders (${program.trials.map((trial) => `${trial.id} ${String(renderCount(program, trial))}`).join(", ")}). ` +
          "One scope at a time, chosen deliberately.",
      );
    }
  }

  const wanted = process.env["AB_TRIAL"];
  const selected = program.trials.filter((trial) => wanted === undefined || wanted === "all" || trial.id === wanted);
  if (selected.length === 0) throw new UsageError(`no trial named ${wanted ?? ""} — have ${program.trials.map((trial) => trial.id).join(", ")}`);

  for (const trial of selected) await runTrial(program, trial, args.render);

  const anchor = await writeStage0Anchor(args.outRoot, args, prompts, reference);
  const notes = await writeRunNotes(args.outRoot, args, program, reference);
  console.log(`\n  stage 0 anchor ${anchor}`);
  console.log(`  run notes      ${notes}`);
  if (!args.render) {
    console.log(`\nNothing was sent. The full matrix is ${String(total)} renders; re-run with AB_TRIAL=<id|all> --render to spend.`);
  }
}

void main().catch((error: unknown) => {
  if (error instanceof UsageError) console.error(error.message);
  else console.error(error);
  process.exitCode = 1;
});
