import "dotenv/config";
import { emptyImageModelAdvancedCapabilities, type ImageModel } from "@vesper/image-core";
import { hasReplicate } from "@/server/ai";
import {
  type NegativeBlockTrial,
  type NegativeTrialEndpoint,
  type NegativeTrialProgram,
  reportTrials,
  runTrial,
  type TrialFixture,
} from "./negative-trial-harness";

/**
 * Negative-field canaries for the endpoints whose probes claim a dedicated
 * negative field: Stable Diffusion 3.5 Large, SDXL PuLID, and LikeReality Pony
 * v1 (issue #253).
 *
 * Qwen Image 2512 exposed `negative_prompt` and ignored it — 16/16 canary
 * failures — so no channel is trusted on the wrapper's word. Before any
 * per-block negative trial is bought on an endpoint, this program proves (or
 * refutes) that its field does anything at all: ask for a simple subject, put
 * that subject in the negative field, and see whether the negative removes it.
 * The fixture, arms, and metrics are the qwen instrument's trials A/A2
 * verbatim — only the endpoint changes.
 *
 * ## Trial design per endpoint
 *
 * - **A — production path.** Provider defaults plus the reviewed production
 *   settings (`reviewed-profile-controls.ts`), because the verdict that matters
 *   first is about the configuration production would send. 10 paired seeds.
 * - **A2/A3 — alternate sampling paths.** Escalations, bought only if A fails:
 *   negative conditioning rides classifier-free guidance, so each endpoint gets
 *   a high-guidance trial on its own guidance input, and Pony additionally gets
 *   the wrapper's other negative-channel path (`prepend_preprompt: false`).
 *   Qwen's A2/A3 (go_fast, guidance) are the precedent: vary the path the
 *   mechanism could hide behind, never enumerate every enum. 6 paired seeds.
 * - **D — determinism control.** The same arm rendered twice at one seed, hashes
 *   compared by the harness. Required reading for everything else: the Qwen
 *   compass misreading happened because OFF/ON pairs differ at byte level even
 *   when content is provably unsteered, and only a reproducibility baseline
 *   says whether a byte difference means anything.
 *
 * Reading the verdict: at matched seeds, a WORKING field collapses the ON arm's
 * `red_apple_present` rate against OFF; an INERT field leaves it untouched (the
 * Qwen outcome was 16/16 apples). `blue_mug_preserved` is the collateral check
 * that the field steered rather than destroyed the scene.
 *
 * ## Where the endpoint facts come from
 *
 * Each endpoint literal restates its seeded `image_models` row (migrations 0098
 * and 0104) so the lab renders what production would send without touching the
 * database, and each negative field name is the probed `negative_prompt` string
 * input recorded in `docs/image-models/models/<model>.md` § Inputs — the same
 * binding the probe derives (`stringBinding(properties, "negative_prompt")`,
 * `packages/image-replicate/src/probe.ts`). The negative rides `controlInput`
 * directly (this is a lab), so the empty `advancedCapabilities` on every seeded
 * row gates nothing here.
 *
 * ## Running it
 *
 * ```
 * pnpm tsx scripts/eval/prompt-programs/negative-field-canary.ts                        # free: every endpoint's arms + CSV templates
 * CANARY_ENDPOINT=sd35  pnpm tsx .../negative-field-canary.ts                           # free: one endpoint
 * CANARY_ENDPOINT=sd35  AB_TRIAL=A pnpm tsx .../negative-field-canary.ts --render       # PAID: one trial on one endpoint
 * CANARY_ENDPOINT=sd35  AB_TRIAL=all pnpm tsx .../negative-field-canary.ts --render     # PAID: that endpoint's full program
 * CANARY_ENDPOINT=sd35  pnpm tsx .../negative-field-canary.ts --report                  # rates + deltas + determinism verdict
 * ```
 *
 * Endpoints: `sd35`, `pulid`, `pony`. Render counts per endpoint — A: 20,
 * A2/A3: 12 each, D: 2. Full programs: sd35 34, pulid 34, pony 46. The verdict
 * path that spends least: A + D (22 renders), then A2/A3 only if A shows no
 * steering. Renders are idempotent; output lands under
 * `eval-images/negative-canary/<endpoint>/`.
 */

const OUT_BASE = process.env["AB_OUT"] ?? "eval-images/negative-canary";
const SEED_BASE = Number(process.env["AB_SEED_BASE"] ?? 101);

// ---------------------------------------------------------------------------
// The endpoint-neutral canary pieces — trials A/A2 of the qwen instrument
// ---------------------------------------------------------------------------

const APPLE_MUG: TrialFixture = {
  id: "apple_mug",
  positive: "A studio photograph of a bright red apple beside a blue ceramic mug on a plain white surface.",
  aspect: "1:1",
};

const CANARY_NEGATIVE = "red apple, apple";

function canaryTrial(input: {
  id: string;
  title: string;
  failure: string;
  seeds: number;
  providerControls?: Readonly<Record<string, unknown>>;
}): NegativeBlockTrial {
  return {
    id: input.id,
    title: input.title,
    block: "none — instrumentation",
    failure: input.failure,
    ...(input.providerControls ? { providerControls: input.providerControls } : {}),
    seeds: input.seeds,
    fixtures: [APPLE_MUG],
    arms: [
      { id: "off", negative: null },
      { id: "on", negative: CANARY_NEGATIVE },
    ],
    metrics: ["red_apple_present", "any_apple_present"],
    collateral: ["blue_mug_preserved"],
  };
}

function determinismTrial(): NegativeBlockTrial {
  return {
    id: "D",
    title: "Determinism control — the same arm rendered twice at one seed",
    block: "none — instrumentation",
    failure: "does a held seed reproduce a byte-identical image, so OFF/ON byte differences can be read at all",
    seeds: 1,
    fixtures: [APPLE_MUG],
    arms: [
      { id: "first", negative: null },
      { id: "second", negative: null },
    ],
    metrics: [],
    collateral: [],
    determinism: true,
  };
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

interface CanaryEndpoint {
  readonly endpoint: NegativeTrialEndpoint;
  readonly trials: readonly NegativeBlockTrial[];
}

/**
 * Stable Diffusion 3.5 Large — official model, bare slug (the row tracks
 * `latest_version`). Row verbatim from migration 0098 (reviewed ratings from
 * 0100); probed 2026-08-05 (`docs/image-models/models/stable-diffusion-3-5-large.md`).
 *
 * Negative field: `negative_prompt`. Sampling paths: `cfg` (range 1–10,
 * provider default 5) is the ONLY sampling knob the schema exposes — no
 * accelerated toggle, no sampler enum — so the alternate-path escalation is
 * high guidance alone. Production sends no reviewed controls on this model
 * (prompt + aspect + output_format is the whole payload), so trial A carries no
 * base controls. The fixture's 1:1 is in this model's aspect enum and is sent.
 */
function sd35Model(): ImageModel {
  return {
    id: "trial-sd35-large",
    slug: "stability-ai/stable-diffusion-3.5-large",
    label: "Stable Diffusion 3.5 Large",
    canGenerate: true,
    canEdit: true,
    referenceField: "image",
    referenceArity: "single",
    maxReferences: 1,
    referenceTransport: "file",
    aspectMode: "aspect_ratio",
    supportedAspects: ["16:9", "1:1", "21:9", "2:3", "3:2", "4:5", "5:4", "9:16", "9:21"],
    outputFormat: "webp",
    extraInput: {},
    probedVersionId: null,
    editKind: "img2img",
    identityPreservation: "weak",
    operatorWarning: null,
    advancedCapabilities: emptyImageModelAdvancedCapabilities(),
    forPortrait: true,
    forVariant: false,
    forScene: false,
    builtin: true,
    sort: 50,
  } satisfies ImageModel;
}

/**
 * SDXL PuLID — community model, version-pinned in the slug. Row verbatim from
 * migration 0104; probed 2026-08-11 (`docs/image-models/models/sdxl-pulid.md`).
 *
 * Negative field: `negative_prompt` (provider default `""`, so an absent field
 * IS the clean OFF state). The canary runs bare-prompt — `prompt` is the only
 * required input, and no reference means no PuLID face adapter in the loop;
 * `reference_image` and `depth_image` are never sent. Base controls are the
 * reviewed production settings: 832×1216 and `method: "fidelity"` pinned
 * (`reviewed-profile-controls.ts`). Sampling paths: `cfg` default 3 is LOW —
 * negative conditioning rides classifier-free guidance, so a working field can
 * look weak there; A3 raises it. The `sampler_name`/`scheduler` enums (euler,
 * euler_ancestral, heun, dpmpp_2s_ancestral, uni_pc × beta, normal) are not
 * bought blind — no sampler classically gates negative conditioning. Seed note:
 * this wrapper treats seed 0 as random; the seed base never sends 0.
 */
function pulidModel(): ImageModel {
  return {
    id: "trial-sdxl-pulid",
    slug: "nsfw-api/sdxl-pulid:83bea633f1fbae0729dcfca1c431b01ae2a9e3e39c25b055fed6da2b916822d5",
    label: "SDXL PuLID",
    canGenerate: true,
    canEdit: true,
    referenceField: "reference_image",
    referenceArity: "single",
    maxReferences: 1,
    referenceTransport: "file",
    aspectMode: "aspect_ratio",
    supportedAspects: [],
    outputFormat: null,
    extraInput: {},
    probedVersionId: "83bea633f1fbae0729dcfca1c431b01ae2a9e3e39c25b055fed6da2b916822d5",
    editKind: "unknown",
    identityPreservation: "unknown",
    operatorWarning: null,
    advancedCapabilities: emptyImageModelAdvancedCapabilities(),
    forPortrait: false,
    forVariant: true,
    forScene: true,
    builtin: true,
    sort: 90,
  } satisfies ImageModel;
}

/**
 * LikeReality Pony v1 — community model, version-pinned in the slug. Row
 * verbatim from migration 0104; probed 2026-08-11
 * (`docs/image-models/models/likereality-pony-v1.md`).
 *
 * Negative field: `negative_prompt`, and this endpoint's OFF state is special:
 * the provider DEFAULT is literally `"nsfw, naked"`, so omitting the field
 * would run the OFF arm under a different negative rather than none. The
 * baseline is therefore the explicit `""` production sends
 * (`reviewed-profile-controls.ts`), which also carries the 832×1216 shape. Two
 * alternate paths matter here: `prepend_preprompt` (default true, held on trial
 * A because production keeps it) composes the wrapper's own score-tag negative
 * preamble around the field on BOTH arms alike, and A2 turns it off to test the
 * raw field; `cfg_scale` (default 7) gets the high-guidance escalation in A3.
 * The 21-value `scheduler` enum is not enumerated, for the same reason as
 * PuLID's samplers. Seed note: -1 means random; explicit seeds are always sent.
 */
function ponyModel(): ImageModel {
  return {
    id: "trial-likereality-pony",
    slug: "aisha-ai-official/likereality-pony-v1:f777e1c330555044053ad5089fbcee89804e3df2419c1e09d9bbc80a399b01a2",
    label: "LikeReality Pony v1",
    canGenerate: true,
    canEdit: false,
    referenceField: "image",
    referenceArity: "array",
    maxReferences: 0,
    referenceTransport: "file",
    aspectMode: "aspect_ratio",
    supportedAspects: [],
    outputFormat: null,
    extraInput: {},
    probedVersionId: "f777e1c330555044053ad5089fbcee89804e3df2419c1e09d9bbc80a399b01a2",
    editKind: "none",
    identityPreservation: "unknown",
    operatorWarning: null,
    advancedCapabilities: emptyImageModelAdvancedCapabilities(),
    forPortrait: true,
    forVariant: false,
    forScene: false,
    builtin: true,
    sort: 80,
  } satisfies ImageModel;
}

const ENDPOINTS: Readonly<Record<string, CanaryEndpoint>> = {
  sd35: {
    endpoint: {
      key: "sd35",
      model: sd35Model,
      negativeField: "negative_prompt",
      sendAspect: true,
      fileExt: "webp",
    },
    trials: [
      canaryTrial({
        id: "A",
        title: "Transport canary — production path (provider defaults, cfg 5)",
        failure: "does changing negative_prompt measurably steer content at all",
        seeds: 10,
      }),
      canaryTrial({
        id: "A3",
        title: "Transport canary — high guidance",
        failure: "does negative conditioning appear only at high guidance",
        seeds: 6,
        providerControls: { cfg: 9 },
      }),
      determinismTrial(),
    ],
  },
  pulid: {
    endpoint: {
      key: "pulid",
      model: pulidModel,
      negativeField: "negative_prompt",
      baseControls: { width: 832, height: 1216, method: "fidelity" },
      sendAspect: false,
      fileExt: "png",
    },
    trials: [
      canaryTrial({
        id: "A",
        title: "Transport canary — production path (defaults: euler_ancestral, cfg 3, steps 30)",
        failure: "does changing negative_prompt measurably steer content at all",
        seeds: 10,
      }),
      canaryTrial({
        id: "A3",
        title: "Transport canary — high guidance",
        failure: "is the negative applied but drowned at the default cfg 3",
        seeds: 6,
        providerControls: { cfg: 7 },
      }),
      determinismTrial(),
    ],
  },
  pony: {
    endpoint: {
      key: "pony",
      model: ponyModel,
      negativeField: "negative_prompt",
      // Production's OFF state: the field sent EMPTY, clearing the wrapper's
      // "nsfw, naked" default. An absent field would be a different negative.
      baselineNegative: "",
      baseControls: { width: 832, height: 1216 },
      sendAspect: false,
      fileExt: "png",
    },
    trials: [
      canaryTrial({
        id: "A",
        title: "Transport canary — production path (defaults: Euler a, cfg_scale 7, preamble on)",
        failure: "does changing negative_prompt measurably steer content at all",
        seeds: 10,
      }),
      canaryTrial({
        id: "A2",
        title: "Transport canary — score-tag preamble off",
        failure: "does the raw field work when the wrapper's own negative preamble is not composed around it",
        seeds: 6,
        providerControls: { prepend_preprompt: false },
      }),
      canaryTrial({
        id: "A3",
        title: "Transport canary — high guidance",
        failure: "does negative conditioning appear only above the default cfg_scale 7",
        seeds: 6,
        providerControls: { cfg_scale: 10 },
      }),
      determinismTrial(),
    ],
  },
};

function programOf(key: string, entry: CanaryEndpoint): NegativeTrialProgram {
  return {
    endpoint: entry.endpoint,
    outRoot: `${OUT_BASE}/${key}`,
    seedBase: SEED_BASE,
    trials: entry.trials,
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const endpointKeys = Object.keys(ENDPOINTS);
  const wantedEndpoint = process.env["CANARY_ENDPOINT"];
  if (wantedEndpoint !== undefined && !endpointKeys.includes(wantedEndpoint)) {
    throw new Error(`no endpoint named ${wantedEndpoint} — choose one of ${endpointKeys.join(", ")}`);
  }
  const selectedEndpoints = endpointKeys.filter((key) => wantedEndpoint === undefined || key === wantedEndpoint);

  if (process.argv.includes("--report")) {
    for (const key of selectedEndpoints) {
      const entry = ENDPOINTS[key];
      if (entry === undefined) continue;
      console.log(`\n##### Endpoint ${key} — ${entry.endpoint.model().slug}`);
      await reportTrials(programOf(key, entry));
    }
    return;
  }

  const shouldRender = process.argv.includes("--render");
  const wantedTrial = process.env["AB_TRIAL"];
  if (shouldRender && !hasReplicate()) throw new Error("REPLICATE_API_TOKEN is not set — --render has nothing to send to");
  if (shouldRender && wantedEndpoint === undefined) {
    throw new Error(`--render needs CANARY_ENDPOINT=<${endpointKeys.join("|")}> — one endpoint's spend at a time, chosen deliberately`);
  }
  if (shouldRender && wantedTrial === undefined) {
    throw new Error("--render needs AB_TRIAL=<id> or AB_TRIAL=all — run A (20 renders) and D (2) first; A2/A3 are escalations for a failed A");
  }

  for (const key of selectedEndpoints) {
    const entry = ENDPOINTS[key];
    if (entry === undefined) continue;
    const selected = entry.trials.filter((trial) => wantedTrial === undefined || wantedTrial === "all" || trial.id === wantedTrial);
    if (selected.length === 0) throw new Error(`endpoint ${key} has no trial named ${wantedTrial ?? ""}`);
    console.log(`\n##### Endpoint ${key} — ${entry.endpoint.model().slug}`);
    const program = programOf(key, entry);
    for (const trial of selected) await runTrial(program, trial, shouldRender);
  }
  if (!shouldRender) {
    console.log("\nNothing was sent. Re-run with CANARY_ENDPOINT=<endpoint> AB_TRIAL=<id> --render to spend.");
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
