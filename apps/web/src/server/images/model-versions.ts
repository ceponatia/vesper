import { eq } from "drizzle-orm";
import sharp from "sharp";
import {
  baseImageModelSlug,
  diffImageModelCapabilities,
  IMAGE_TARGET_ASPECT,
  type ImageCapabilityDiffEntry,
  type ImageModel,
  type ImageModelProfile,
  type ImageModelProfileFindings,
  type ImageReferenceRole,
  type ImageRenderIntent,
  type ImageRenderReference,
  pinnedImageModelVersion,
  validateImageProfileForCandidate,
} from "@vesper/image-core";
import type { ProbeResult } from "@vesper/image-replicate";
import type { DiagnosticSink } from "@/contracts/diagnostics";
import { replicateClient } from "../ai";
import { db, imageModels } from "../db";
import { imageModelReprobeFields } from "./identity-trial-model-versions";
import { loadImageModelProfileById, loadImageModelProfiles } from "./model-profiles";
import { loadImageModel } from "./models";
import { renderImageIntent, type RenderImageIntentResult } from "./render-intent";

/**
 * Version candidate probing, smoke testing, and atomic activation.
 *
 * Production rows follow their slug's floating latest until an admin pins them
 * through this flow; the controlled comparisons refuse an unpinned row. The
 * three operations are deliberately separate admin actions:
 *
 * - {@link probeLatestCandidate} — read-only: what is latest, and what would
 *   activating it change? Mutates NOTHING.
 * - {@link smokeTestCandidate} — one transient render against the candidate
 *   pin. Cost-bearing, explicit, run in no automated gate, persists nothing.
 * - {@link activateCandidateVersion} — re-probe THAT exact version, refuse if
 *   any enabled profile would stop being runnable, then rewrite the row's pin
 *   and probe-owned capability columns in one atomic update.
 *
 * The judgment calls (the diff, the blocking/warning rules) are pure and live
 * in `@vesper/image-core`; the write set is `imageModelReprobeFields`, the
 * single answer to "what does a re-probe own" — reviewed judgments (`editKind`,
 * `identityPreservation`, `operatorWarning`), the owner-set reference cap and
 * transport, the curated `supportedAspects` list, the surface toggles and sort
 * are never touched here.
 */

type SuccessfulProbe = Extract<ProbeResult, { ok: true }>["probe"];

// The `{ profileId, key, label, findings }` wire shape is the package's
// `imageModelProfileFindingsSchema` — one spelling shared with the client,
// like the diff-entry schema. Re-exported so this module stays the server-side
// home of the name.
export type { ImageModelProfileFindings };

/** The one atomic write activation performs. `slug` carries the new pin; the rest is re-probe-owned. */
export type ActivatedImageModelUpdate = ReturnType<typeof imageModelReprobeFields> & {
  slug: string;
  updatedAt: Date;
};

/**
 * The IO seams, injectable so the decision logic tests without a database or a
 * provider — the `ensureIdentityTrialModelVersions` idiom one file over.
 */
export interface ImageModelVersionDependencies {
  loadModel: (id: string) => Promise<ImageModel | null>;
  loadProfiles: (sink?: DiagnosticSink) => Promise<ImageModelProfile[]>;
  /** One row by id — the smoke test needs a single profile, not the registry. */
  loadProfile: (profileId: string) => Promise<ImageModelProfile | null>;
  probe: (slug: string) => Promise<ProbeResult>;
  render: (intent: ImageRenderIntent, sink?: DiagnosticSink) => Promise<RenderImageIntentResult>;
  persist: (modelId: string, update: ActivatedImageModelUpdate) => Promise<void>;
}

const defaultDependencies: ImageModelVersionDependencies = {
  loadModel: loadImageModel,
  loadProfiles: loadImageModelProfiles,
  loadProfile: loadImageModelProfileById,
  probe: (slug) => replicateClient().probeReplicateModel(slug),
  render: renderImageIntent,
  persist: async (modelId, update) => {
    await db().update(imageModels).set(update).where(eq(imageModels.id, modelId));
  },
};

/** This model's enabled profiles, each judged against the candidate's capabilities. */
function profileFindings(
  profiles: readonly ImageModelProfile[],
  modelId: string,
  candidate: SuccessfulProbe,
): ImageModelProfileFindings[] {
  return profiles
    .filter((profile) => profile.imageModelId === modelId && profile.enabled)
    .map((profile) => ({
      profileId: profile.id,
      key: profile.key,
      label: profile.label,
      findings: validateImageProfileForCandidate(profile, candidate),
    }));
}

export type ProbeLatestCandidateResult =
  | {
      ok: true;
      /** The probe verbatim — mechanical capabilities as the candidate declares them. */
      candidate: SuccessfulProbe;
      /** False when the model record names no latest version id — nothing to activate. */
      activatable: boolean;
      /** Whether latest differs from the row's current pin (an unpinned row always differs). */
      latestDiffers: boolean;
      diff: ImageCapabilityDiffEntry[];
      profiles: ImageModelProfileFindings[];
    }
  | { ok: false; code: "not_found" | "probe_failed"; message: string };

/**
 * Probe the model's BARE path — the pin stripped, so a pinned row still asks
 * "what is latest?" rather than re-reading its own pin — and report the
 * candidate, the field diff against the stored capabilities, and every enabled
 * profile's findings. Nothing is written: this is the read the admin card
 * shows before an activation is even offered.
 */
export async function probeLatestCandidate(
  modelId: string,
  sink?: DiagnosticSink,
  dependencies: Partial<ImageModelVersionDependencies> = {},
): Promise<ProbeLatestCandidateResult> {
  const deps: ImageModelVersionDependencies = { ...defaultDependencies, ...dependencies };
  const model = await deps.loadModel(modelId);
  if (!model) return { ok: false, code: "not_found", message: "image model not found" };

  const probed = await deps.probe(baseImageModelSlug(model.slug));
  if (!probed.ok) return { ok: false, code: "probe_failed", message: probed.error };
  const candidate = probed.probe;

  return {
    ok: true,
    candidate,
    activatable: candidate.versionId !== null,
    latestDiffers: candidate.versionId !== null && candidate.versionId !== pinnedImageModelVersion(model),
    diff: diffImageModelCapabilities(model, candidate),
    profiles: profileFindings(await deps.loadProfiles(sink), modelId, candidate),
  };
}

export interface SmokeTestCandidateInput {
  versionId: string;
  profileId: string;
}

export type SmokeTestCandidateResult =
  | {
      ok: true;
      predictionId?: string;
      executedVersionId?: string;
      durationMs: number;
      imageBytes: number;
      width?: number;
      height?: number;
    }
  | {
      ok: false;
      code: "not_found" | "profile_not_found" | "smoke_failed";
      message: string;
      predictionId?: string;
      durationMs?: number;
    };

/** A fixed neutral prompt: no character, no stored asset, nothing worth keeping. */
const SMOKE_TEST_PROMPT =
  "A simple still life: a plain ceramic teapot on a wooden table, soft window light, neutral background.";

/**
 * ONE synthetic neutral reference, generated locally with sharp — a 768×1024
 * flat-gray WebP. It exists so an edit-operation profile (or a model that
 * cannot generate from a prompt alone) exercises the full reference pipeline —
 * preparation, transport, the provider's reference field — without reading a
 * single stored asset: no character portrait, no player image, nothing
 * identifying leaves the machine for a smoke test.
 */
function syntheticNeutralReference(): Promise<Buffer> {
  return sharp({ create: { width: 768, height: 1024, channels: 3, background: { r: 128, g: 128, b: 128 } } })
    .webp()
    .toBuffer();
}

/**
 * The synthetic references a smoke render of this profile needs: one per role
 * the policy REQUIRES (the planner refuses a missing required role before any
 * spend), or — when nothing is required but the operation cannot run bare —
 * one under the first allowed role, falling back to `identity`. The same gray
 * buffer serves every slot; a generate profile on a generate-capable model
 * sends none, exactly like its lane.
 */
async function smokeTestReferences(profile: ImageModelProfile, model: ImageModel): Promise<ImageRenderReference[]> {
  const required = profile.referencePolicy.requiredRoles;
  const needsOne = profile.operation === "edit" || !model.canGenerate;
  if (required.length === 0 && !needsOne) return [];
  const roles: ImageReferenceRole[] =
    required.length > 0 ? [...required] : [profile.referencePolicy.allowedRoles[0] ?? "identity"];
  const buffer = await syntheticNeutralReference();
  return roles.map((role) => ({ role, buffer, name: "smoke-test synthetic reference" }));
}

/**
 * Run ONE transient render through the production entry point
 * (`renderImageIntent`) with an explicit candidate-version pin. Nothing is
 * persisted — no images row is reserved, and the returned buffer is discarded
 * after measuring. This is a COST-BEARING, explicit admin action: it spends a
 * real prediction against the live provider and therefore runs in no automated
 * gate or test.
 */
export async function smokeTestCandidate(
  modelId: string,
  input: SmokeTestCandidateInput,
  sink?: DiagnosticSink,
  dependencies: Partial<ImageModelVersionDependencies> = {},
): Promise<SmokeTestCandidateResult> {
  const deps: ImageModelVersionDependencies = { ...defaultDependencies, ...dependencies };
  const model = await deps.loadModel(modelId);
  if (!model) return { ok: false, code: "not_found", message: "image model not found" };
  const profile = await deps.loadProfile(input.profileId);
  if (!profile || profile.imageModelId !== modelId) {
    return { ok: false, code: "profile_not_found", message: "image model profile not found" };
  }

  const intent: ImageRenderIntent = {
    profile: { profile, model },
    prompt: SMOKE_TEST_PROMPT,
    references: await smokeTestReferences(profile, model),
    target: { aspectRatio: IMAGE_TARGET_ASPECT },
    versionId: input.versionId,
  };

  const startedAt = Date.now();
  const result = await deps.render(intent, sink);
  const durationMs = Date.now() - startedAt;
  if (!result.ok || !result.image) {
    return {
      ok: false,
      code: "smoke_failed",
      message: result.error ?? "the smoke render returned no image",
      ...(result.predictionId ? { predictionId: result.predictionId } : {}),
      durationMs,
    };
  }

  // Measure, then let the buffer go — a smoke test leaves no images row and no
  // file behind. An unreadable output is still a successful prediction, so the
  // dimensions simply stay unreported rather than failing the test.
  let dimensions: { width?: number; height?: number } = {};
  try {
    const meta = await sharp(result.image).metadata();
    dimensions = {
      ...(meta.width ? { width: meta.width } : {}),
      ...(meta.height ? { height: meta.height } : {}),
    };
  } catch {
    dimensions = {};
  }
  return {
    ok: true,
    ...(result.predictionId ? { predictionId: result.predictionId } : {}),
    ...(result.executedVersionId ? { executedVersionId: result.executedVersionId } : {}),
    durationMs,
    imageBytes: result.image.byteLength,
    ...dimensions,
  };
}

export interface ActivateCandidateVersionInput {
  versionId: string;
}

export type ActivateCandidateVersionResult =
  | { ok: true; model: ImageModel; profiles: ImageModelProfileFindings[] }
  | { ok: false; code: "not_found" | "version_unavailable"; message: string }
  | { ok: false; code: "activation_blocked"; message: string; profiles: ImageModelProfileFindings[] };

/**
 * Probe the EXACT candidate version, defensively across the two endpoints
 * Replicate offers:
 *
 * 1. the pinned-slug probe (`/models/{path}/versions/{id}`) — authoritative
 *    when it resolves;
 * 2. when it does not AND the bare model record's `latest_version.id` IS the
 *    candidate, that record's schema — verified to exist for official models,
 *    which expose no versions list (their per-version endpoint is NOT verified,
 *    see `REPLICATE_VERSION_UNDISCLOSED` in `@vesper/image-core`), yet still
 *    accept an explicit version pin at prediction time.
 *
 * Neither resolving means the candidate cannot be described, so it must not be
 * activated: capabilities stored without a schema read would be fabricated.
 */
async function probeExactCandidate(
  deps: ImageModelVersionDependencies,
  basePath: string,
  versionId: string,
): Promise<{ ok: true; probe: SuccessfulProbe } | { ok: false; message: string }> {
  const pinned = await deps.probe(`${basePath}:${versionId}`);
  if (pinned.ok) return { ok: true, probe: pinned.probe };
  const bare = await deps.probe(basePath);
  if (bare.ok && bare.probe.versionId === versionId) return { ok: true, probe: bare.probe };
  const bareDetail = bare.ok
    ? `the model record's latest version is ${bare.probe.versionId ?? "undisclosed"}, not ${versionId}`
    : bare.error;
  return { ok: false, message: `cannot probe version ${versionId}: ${pinned.error} — and ${bareDetail}` };
}

/**
 * Pin the row to one probed candidate version, atomically.
 *
 * Order of refusals: unknown row, then a candidate that cannot be probed at
 * its exact version, then any BLOCKING finding on any enabled profile — the
 * admin disables or repairs that profile and retries. On success ONE update
 * writes the new pin (`path:versionId`, any previous pin stripped), the
 * re-probe-owned capability columns including `probedVersionId` and the
 * version-specific `advancedCapabilities`, and `updatedAt`. Warnings do not
 * refuse; they come back beside the updated row so the card can show what
 * degraded.
 */
export async function activateCandidateVersion(
  modelId: string,
  input: ActivateCandidateVersionInput,
  sink?: DiagnosticSink,
  dependencies: Partial<ImageModelVersionDependencies> = {},
): Promise<ActivateCandidateVersionResult> {
  const deps: ImageModelVersionDependencies = { ...defaultDependencies, ...dependencies };
  const model = await deps.loadModel(modelId);
  if (!model) return { ok: false, code: "not_found", message: "image model not found" };

  const basePath = baseImageModelSlug(model.slug);
  const probed = await probeExactCandidate(deps, basePath, input.versionId);
  if (!probed.ok) return { ok: false, code: "version_unavailable", message: probed.message };

  const profiles = profileFindings(await deps.loadProfiles(sink), modelId, probed.probe);
  const blocked = profiles.filter((entry) => entry.findings.some((finding) => finding.level === "blocking"));
  if (blocked.length > 0) {
    const names = blocked
      .map((entry) => {
        const codes = entry.findings
          .filter((finding) => finding.level === "blocking")
          .map((finding) => finding.code)
          .join(", ");
        return `${entry.label} (${codes})`;
      })
      .join("; ");
    return {
      ok: false,
      code: "activation_blocked",
      message: `activating ${input.versionId} would break enabled profiles: ${names} — disable or repair them and retry`,
      profiles,
    };
  }

  const probeFields = imageModelReprobeFields(probed.probe);
  const update: ActivatedImageModelUpdate = {
    slug: `${basePath}:${input.versionId}`,
    ...probeFields,
    updatedAt: new Date(),
  };
  await deps.persist(modelId, update);
  // Re-read the row so the caller gets exactly what is stored; the local merge
  // only covers a row that somehow failed to parse back.
  const reloaded = await deps.loadModel(modelId);
  return { ok: true, model: reloaded ?? { ...model, slug: update.slug, ...probeFields }, profiles };
}
