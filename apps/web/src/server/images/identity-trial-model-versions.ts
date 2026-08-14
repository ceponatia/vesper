import { eq } from "drizzle-orm";
import { type ImageModel, type ImageModelProfile, pinnedImageModelVersion } from "@vesper/image-core";
import type { ProbeResult } from "@vesper/image-replicate";
import { diag, type DiagnosticSink } from "@/contracts/diagnostics";
import { replicateClient } from "../ai";
import { db, imageModels } from "../db";
import { loadImageModelProfiles } from "./model-profiles";
import { loadImageModels } from "./models";

/**
 * Identity-trial setup for provider versions.
 *
 * A controlled trial must pin the exact Replicate version used by every cell,
 * but the six built-in model rows predate `probedVersionId` and therefore ship
 * as floating bare slugs. Requiring an admin to leave the trial page and
 * manually re-probe every possible model is an operational trap, not a useful
 * review step: the selected profile ids already tell us exactly which model rows
 * the proposed run needs.
 *
 * This module performs that bounded setup immediately before planning. It probes
 * only the distinct selected models that still have no trustworthy pin, writes
 * the same mechanical capability fields as the admin re-probe route, and leaves
 * all reviewed/operator fields alone (`maxReferences`, the curated
 * `supportedAspects`, surface choices, edit kind, identity rating, transport,
 * warnings and advanced controls). The trial planner still refuses an
 * unpinnable cell; this removes the manual prerequisite without weakening the
 * evidence contract.
 */

type SuccessfulProbe = Extract<ProbeResult, { ok: true }>["probe"];

export interface IdentityTrialVersionProbeFailure {
  modelId: string;
  slug: string;
  error: string;
}

export interface IdentityTrialVersionPreparation {
  /** Models actually sent to Replicate's schema endpoint. */
  probedModelIds: string[];
  /** A failure is returned to the planning route before it creates a useless run. */
  failures: IdentityTrialVersionProbeFailure[];
}

export interface IdentityTrialVersionDependencies {
  loadModels: (sink?: DiagnosticSink) => Promise<ImageModel[]>;
  loadProfiles: (sink?: DiagnosticSink) => Promise<ImageModelProfile[]>;
  probe: (slug: string) => Promise<ProbeResult>;
  persist: (modelId: string, probe: SuccessfulProbe) => Promise<void>;
}

/**
 * The capability columns a re-probe of an EXISTING row may rewrite. Kept here so
 * trial setup, candidate activation and the admin re-probe cannot accidentally
 * overwrite reviewed judgments that the API PATCH route deliberately preserves —
 * and so "what a re-probe writes" has exactly one answer.
 *
 * `supportedAspects` is deliberately ABSENT: the stored list is owner-curated,
 * not probe-owned. Migration 0098 prunes Wan's list by hand (the 4096*… sizes
 * are text-to-image-only, and seeding them "would silently break every edit"),
 * and `chooseAspect`'s largest-exact rule means a probe clobbering the curation
 * would quietly re-add exactly the entries every edit render then picks. The
 * owner updates the list through the PATCH route when a diff shows the schema
 * moved.
 *
 * `advancedCapabilities` is written with `probedVersionId` rather than beside it:
 * the bindings describe ONE version's input schema, so a record that kept the
 * bindings while the version moved would have the render path sending a control
 * to a field that no longer exists.
 */
export function imageModelReprobeFields(probe: SuccessfulProbe) {
  return {
    canGenerate: probe.canGenerate,
    canEdit: probe.canEdit,
    referenceField: probe.referenceField,
    referenceArity: probe.referenceArity,
    aspectMode: probe.aspectMode,
    outputFormat: probe.outputFormat,
    extraInput: probe.extraInput,
    advancedCapabilities: probe.advancedCapabilities,
    probedVersionId: probe.versionId,
  };
}

/**
 * The CREATE write set: everything a re-probe owns PLUS `supportedAspects`. A
 * brand-new row has no curation to protect, and the probe's verbatim menu is
 * the only honest starting value — curation begins the first time the owner
 * edits it, and from then on only {@link imageModelReprobeFields} runs.
 */
export function imageModelProbeFields(probe: SuccessfulProbe) {
  return {
    ...imageModelReprobeFields(probe),
    supportedAspects: probe.supportedAspects,
  };
}

const defaultDependencies: IdentityTrialVersionDependencies = {
  loadModels: loadImageModels,
  loadProfiles: loadImageModelProfiles,
  probe: (slug) => replicateClient().probeReplicateModel(slug),
  persist: async (modelId, probe) => {
    await db().update(imageModels).set(imageModelReprobeFields(probe)).where(eq(imageModels.id, modelId));
  },
};

/** The distinct selected models whose exact provider version is still unknown. */
export function identityTrialModelsNeedingProbe(
  profileIds: readonly string[],
  profiles: readonly ImageModelProfile[],
  models: readonly ImageModel[],
): ImageModel[] {
  const requested = new Set(profileIds);
  const modelIds = new Set(
    profiles.filter((profile) => requested.has(profile.id)).map((profile) => profile.imageModelId),
  );
  return models.filter((model) => modelIds.has(model.id) && pinnedImageModelVersion(model) === null);
}

/**
 * Ensure every resolvable selected profile has a pinned provider version before
 * the fixed identity trial plans cells. Unknown profile ids are deliberately
 * ignored here and remain the planner's own typed refusal.
 */
export async function ensureIdentityTrialModelVersions(
  profileIds: readonly string[],
  sink?: DiagnosticSink,
  dependencies: Partial<IdentityTrialVersionDependencies> = {},
): Promise<IdentityTrialVersionPreparation> {
  const deps: IdentityTrialVersionDependencies = { ...defaultDependencies, ...dependencies };
  const [models, profiles] = await Promise.all([deps.loadModels(sink), deps.loadProfiles(sink)]);
  const targets = identityTrialModelsNeedingProbe(profileIds, profiles, models);
  const probedModelIds: string[] = [];
  const failures: IdentityTrialVersionProbeFailure[] = [];

  // Sequential on purpose. Trial creation is bounded to six profiles and this is
  // an admin action; serial probes avoid a burst against Replicate and make a
  // partial failure's operator message deterministic.
  for (const model of targets) {
    const result = await deps.probe(model.slug);
    if (!result.ok || !result.probe.versionId) {
      const error = result.ok ? `${model.slug} publishes no version id` : result.error;
      failures.push({ modelId: model.id, slug: model.slug, error });
      sink?.push(
        diag("warn", "identity_pack_trial.version_probe_failed", error, {
          path: "image_models",
          context: { modelId: model.id, slug: model.slug },
        }),
      );
      continue;
    }
    await deps.persist(model.id, result.probe);
    probedModelIds.push(model.id);
  }

  return { probedModelIds, failures };
}
