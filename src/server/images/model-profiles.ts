import { asc } from "drizzle-orm";
import {
  type ImageModel,
  type ImageModelProfile,
  imageModelProfileSchema,
  imageProfileCandidates,
  type ImageProfileTask,
  type ResolvedImageProfile,
  resolveImageProfile,
} from "@vesper/image-core";
import { diag, type DiagnosticSink } from "@/contracts/diagnostics";
import { db, imageModelProfiles } from "../db";
import { loadImageModels, parseRegistryRows } from "./models";

/**
 * The profile registry's server seam (image-model-capabilities.spec.md
 * §`image_model_profiles`, §"Profile resolution").
 *
 * `./models` answers "which model may a surface use". This module answers the
 * narrower question the render path actually has: "which model AND which
 * configuration of it should this job run with" — a profile joined to its model,
 * with the ineligible combinations already removed.
 *
 * EVERY render lane resolves here. The portrait, variant, scene, item, location,
 * chat-look and chat-place lanes each call `resolveImageProfileForTask` for their
 * own task and hand the result to `renderImageIntent`; the fixed
 * identity-reference trial resolves its cells' profiles by id through the same
 * registry. Model-level resolution no longer exists — `resolveSurfaceModel` was
 * deleted when the lanes moved over (capabilities slice 2), because two resolvers
 * answering "which model runs this job" is how a picker and a render come to
 * disagree.
 *
 * The migration was payload-neutral by construction: each of the 17 seeded
 * profiles describes exactly what its lane already did, so swapping the resolver
 * changed which ROW the answer came from, not what the provider received.
 *
 * The eligibility and ordering rules live in the pure contract
 * (`imageProfileCandidates`, `resolveImageProfile`) and are deliberately NOT
 * re-derived here: this module only supplies the two collections and turns a failed
 * resolution into a diagnostic.
 */

/** Every profile row, sort-ordered. One unparseable row is dropped, not the list. */
export async function loadImageModelProfiles(sink?: DiagnosticSink): Promise<ImageModelProfile[]> {
  const rows = await db().select().from(imageModelProfiles).orderBy(asc(imageModelProfiles.sort));
  return parseRegistryRows(
    rows,
    imageModelProfileSchema,
    {
      code: "image_profile.row_invalid",
      message: "an image_model_profiles row failed to parse and was skipped",
      path: "image_model_profiles",
    },
    sink,
  );
}

/**
 * Both collections a profile question needs, loaded together.
 *
 * A profile is meaningless without its model — eligibility is a fact about the
 * pair — so every entry point below needs both, and loading them in one place is
 * what keeps a caller from resolving against a stale half. Concurrent because the
 * two selects are independent and the render path pays this on every image.
 *
 * The sink is threaded through BOTH loads: a dropped profile row and a dropped
 * model row are equally capable of silently shrinking the offered set, and only the
 * loader knows which row it was.
 */
async function loadProfileRegistry(
  sink?: DiagnosticSink,
): Promise<{ profiles: ImageModelProfile[]; models: ImageModel[] }> {
  const [models, profiles] = await Promise.all([loadImageModels(sink), loadImageModelProfiles(sink)]);
  return { profiles, models };
}

/**
 * Every profile a task may actually be offered, joined to its model and in sort
 * order — what a picker lists.
 *
 * Disabled profiles, profiles whose model row is gone or unparseable, models the
 * task's legacy surface toggle excludes, and pairs `profileEligibility` refuses are
 * all already absent. Computing the offered set through the same helper the
 * resolver uses is what stops a picker from showing a choice resolution would then
 * decline.
 */
export async function loadImageModelProfilesForTask(
  task: ImageProfileTask,
  sink?: DiagnosticSink,
): Promise<ResolvedImageProfile[]> {
  const { profiles, models } = await loadProfileRegistry(sink);
  return imageProfileCandidates(profiles, models, task);
}

/**
 * Whether the resolver actually honored `stored`, or substituted something else.
 *
 * This mirrors steps 1–2 of `resolveImageProfile`: a stored value is honored when
 * it names the resolved profile, OR the resolved model by id or slug. The second
 * half matters because most stored picks are legacy `sceneModel`/`portraitModel`
 * MODEL keys (owner ruling 5 — existing chats are not migrated), and those resolve
 * to a profile whose id will never equal the stored string. Comparing profile ids
 * alone would warn `pick_unavailable` on every legacy chat that is working
 * perfectly, which is how a real diagnostic becomes noise nobody reads.
 */
function storedWasHonored(stored: string, resolved: ResolvedImageProfile): boolean {
  return stored === resolved.profile.id || stored === resolved.model.id || stored === resolved.model.slug;
}

/**
 * Resolve a stored pick to the profile and model a task should run with — the
 * entry point every render lane calls before it reserves an image row.
 *
 * `stored` is loose by design (a profile id, a model id, a model slug, or a dead
 * value from before any of this existed). A pick that has gone invalid — deleted
 * model, disabled profile, a model just re-rated `weak` for an identity-critical
 * task — degrades to the task's default with a warning rather than failing the
 * render, exactly as the model registry does.
 *
 * Null is the only hard failure, and it means the database offers this task no
 * runnable profile at all: an operator deleted the row, or cleared every surface
 * toggle it depended on. That is an `error`, not a `warn`, because the caller has
 * nothing left to render with.
 */
export async function resolveImageProfileForTask(
  task: ImageProfileTask,
  stored: string | null | undefined,
  sink?: DiagnosticSink,
): Promise<ResolvedImageProfile | null> {
  const { profiles, models } = await loadProfileRegistry(sink);
  const resolved = resolveImageProfile(profiles, models, task, stored);
  if (!resolved) {
    sink?.push(
      diag("error", "image_profile.none_offered", "no image model profile is offered for this task", {
        path: "image_model_profiles",
        context: { task },
      }),
    );
    return null;
  }
  if (stored && !storedWasHonored(stored, resolved)) {
    sink?.push(
      diag("warn", "image_profile.pick_unavailable", "the stored image profile is not offered here; using the default", {
        path: "image_model_profiles",
        context: { task, stored, used: resolved.profile.id, model: resolved.model.slug },
      }),
    );
  }
  return resolved;
}
