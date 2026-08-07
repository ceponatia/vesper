import { eq } from "drizzle-orm";
import type { ImageModel, ImageModelProfile } from "@/contracts";
import { diag, type DiagnosticSink } from "@/contracts/diagnostics";
import { probeReplicateModel } from "../ai";
import { db, imageModels } from "../db";
import { loadImageModelProfiles } from "./model-profiles";
import { loadImageModels } from "./models";
import { pinnedImageModelVersion } from "./render-profile";

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
 * the same mechanical capability fields as the admin model route, and leaves all
 * reviewed/operator fields alone (`maxReferences`, surface choices, edit kind,
 * identity rating, transport, warnings and advanced controls). The trial planner
 * still refuses an unpinnable cell; this removes the manual prerequisite without
 * weakening the evidence contract.
 */

type SuccessfulProbe = Extract<Awaited<ReturnType<typeof probeReplicateModel>>, { ok: true }>["probe"];

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
  probe: typeof probeReplicateModel;
  persist: (modelId: string, probe: SuccessfulProbe) => Promise<void>;
}

/**
 * The capability columns a successful Replicate probe owns. Kept here so trial
 * setup and any future bulk re-probe cannot accidentally overwrite reviewed
 * judgments that the API PATCH route deliberately preserves.
 */
export function imageModelProbeFields(probe: SuccessfulProbe) {
  return {
    canGenerate: probe.canGenerate,
    canEdit: probe.canEdit,
    referenceField: probe.referenceField,
    referenceArity: probe.referenceArity,
    aspectMode: probe.aspectMode,
    supportedAspects: probe.supportedAspects,
    outputFormat: probe.outputFormat,
    extraInput: probe.extraInput,
    probedVersionId: probe.versionId,
  };
}

const defaultDependencies: IdentityTrialVersionDependencies = {
  loadModels: loadImageModels,
  loadProfiles: loadImageModelProfiles,
  probe: probeReplicateModel,
  persist: async (modelId, probe) => {
    await db().update(imageModels).set(imageModelProbeFields(probe)).where(eq(imageModels.id, modelId));
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
