import { and, asc, eq, ne } from "drizzle-orm";
import {
  type ImageModel,
  type ImageModelProfile,
  type ImageModelProfileCreateRequest,
  type ImageModelProfileUpdateRequest,
  imageModelProfileSchema,
  imageProfileCandidates,
  type ImageProfileTask,
  type ResolvedImageProfile,
  resolveImageProfile,
  validateImageProfileConfiguration,
} from "@vesper/image-core";
import { diag, type DiagnosticSink } from "@/contracts/diagnostics";
import { newId } from "@/lib/ids";
import { db, imageModelProfiles } from "../db";
import { loadImageModel, loadImageModels, parseRegistryRows } from "./models";

/**
 * The profile registry's server seam.
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

// ---------------------------------------------------------------------------
// Admin CRUD — the LoRA
// library's idiom: rows parsed at the boundary, cross-row rules judged against
// the MERGED row, refusals returned as typed results the route maps to 400s.
// ---------------------------------------------------------------------------

/**
 * A mutation's result: the row as it now stands, or the typed reason it was
 * refused. `conflict` is separate from `invalid` because it maps to a 409 and a
 * different fix: the request is well-formed, another ROW is in the way.
 */
export type ImageModelProfileMutation =
  | { ok: true; profile: ImageModelProfile }
  | { ok: false; code: "not_found" | "invalid" | "conflict"; message: string };

/** One row by id, or null when it is missing or unreadable (the LoRA rule: a row
 * that cannot parse cannot be edited into shape through a partial merge).
 * Exported for the version service's smoke test, which needs exactly one
 * profile row and should not load and parse the whole registry to find it. */
export async function loadImageModelProfileById(profileId: string): Promise<ImageModelProfile | null> {
  const [row] = await db().select().from(imageModelProfiles).where(eq(imageModelProfiles.id, profileId)).limit(1);
  if (!row) return null;
  const parsed = imageModelProfileSchema.safeParse(row);
  return parsed.success ? parsed.data : null;
}

/**
 * The two pre-checks the database constraints back up, judged here so an
 * operator reads a sentence instead of a raw unique-violation. The constraints
 * remain the backstop for a concurrent write; these exist for the message.
 */
async function profileConflict(profile: ImageModelProfile): Promise<string | null> {
  const [duplicateKey] = await db()
    .select({ id: imageModelProfiles.id })
    .from(imageModelProfiles)
    .where(
      and(
        eq(imageModelProfiles.imageModelId, profile.imageModelId),
        eq(imageModelProfiles.key, profile.key),
        ne(imageModelProfiles.id, profile.id),
      ),
    )
    .limit(1);
  if (duplicateKey) return `this model already has a profile with the key “${profile.key}”`;

  if (profile.isDefault && profile.enabled) {
    const [existingDefault] = await db()
      .select({ id: imageModelProfiles.id, label: imageModelProfiles.label })
      .from(imageModelProfiles)
      .where(
        and(
          eq(imageModelProfiles.task, profile.task),
          eq(imageModelProfiles.isDefault, true),
          eq(imageModelProfiles.enabled, true),
          ne(imageModelProfiles.id, profile.id),
        ),
      )
      .limit(1);
    if (existingDefault) {
      return `“${existingDefault.label}” is already the ${profile.task} default — untick it first (one enabled default per task)`;
    }
  }
  return null;
}

/**
 * Add one profile beneath a model.
 *
 * The would-be row is validated as the render path will read it: eligibility
 * and override keys against the PARENT model (`validateImageProfileConfiguration`
 * — a row every resolution would silently skip is refused at save, with the
 * reason), then the two uniqueness pre-checks. The id is ours to mint, and a
 * row assembled from a request that passed the contract schema cannot fail to
 * parse back.
 */
export async function createImageModelProfile(
  modelId: string,
  request: ImageModelProfileCreateRequest,
): Promise<ImageModelProfileMutation> {
  const model = await loadImageModel(modelId);
  if (!model) return { ok: false, code: "not_found", message: "image model not found" };

  const row: ImageModelProfile = { id: newId(), imageModelId: modelId, builtin: false, ...request };
  const issues = validateImageProfileConfiguration(row, model);
  if (issues.length > 0) {
    return { ok: false, code: "invalid", message: issues.map((issue) => issue.message).join("; ") };
  }
  const conflict = await profileConflict(row);
  if (conflict) return { ok: false, code: "conflict", message: conflict };

  await db().insert(imageModelProfiles).values(row);
  return { ok: true, profile: imageModelProfileSchema.parse(row) };
}

/**
 * Edit one profile.
 *
 * Every rule that spans fields the request did not send — eligibility after an
 * operation or task change, override keys, the duplicate key, the
 * second-default — is re-judged against the MERGED row, because this is the
 * only place that can see the fields the PATCH left alone. Disabling (or
 * un-defaulting) a task's only default is deliberately allowed: resolution
 * degrades to the next candidate by design, and a guard here would make
 * "switch the default to another model" a forbidden two-step.
 *
 * Configuration validation runs ONLY when the merged row is ENABLED. A disabled
 * row is out of every candidate list, so nothing can resolve to it — and gating
 * its edits on validity would make the activation flow's "disable that profile
 * and retry" advice impossible for exactly the rows that need it (a profile
 * whose stored config went invalid under a new version, or a seeded row like
 * 0107's Portrait Quality whose `go_fast` override cannot validate until the
 * model is probed). Enabling, or editing while enabled, validates as before.
 */
export async function updateImageModelProfile(
  modelId: string,
  profileId: string,
  request: ImageModelProfileUpdateRequest,
): Promise<ImageModelProfileMutation> {
  const existing = await loadImageModelProfileById(profileId);
  // A profile reached under the wrong model's URL is the same 404 as a missing
  // one — the collapsed shape every resource route answers with.
  if (!existing || existing.imageModelId !== modelId) {
    return { ok: false, code: "not_found", message: "image model profile not found" };
  }
  if (Object.keys(request).length === 0) return { ok: true, profile: existing };

  const merged: ImageModelProfile = { ...existing, ...request };
  if (merged.enabled) {
    const model = await loadImageModel(merged.imageModelId);
    if (!model) {
      // Unreachable while the FK cascade holds (a deleted model deletes its
      // profiles), kept because an unparseable model row reads the same here.
      return { ok: false, code: "invalid", message: "the profile's model cannot be loaded" };
    }
    const issues = validateImageProfileConfiguration(merged, model);
    if (issues.length > 0) {
      return { ok: false, code: "invalid", message: issues.map((issue) => issue.message).join("; ") };
    }
  }
  const conflict = await profileConflict(merged);
  if (conflict) return { ok: false, code: "conflict", message: conflict };

  await db().update(imageModelProfiles).set(request).where(eq(imageModelProfiles.id, profileId));
  // The merged row IS what the update wrote — `existing` parsed, `request`
  // passed the boundary schema — so a re-read would only repeat the merge.
  return { ok: true, profile: merged };
}

/**
 * Remove one profile. Deleting a task's only default — or the only profile a
 * stored pick names — is deliberately allowed, on the model registry's
 * precedent: stored selections are plain ids, and `resolveImageProfileForTask`
 * degrades an unknown one to the task's default (or reports
 * `image_profile.none_offered`) rather than failing the render.
 */
export async function deleteImageModelProfile(modelId: string, profileId: string): Promise<boolean> {
  const existing = await loadImageModelProfileById(profileId);
  if (!existing || existing.imageModelId !== modelId) return false;
  await db().delete(imageModelProfiles).where(eq(imageModelProfiles.id, profileId));
  return true;
}
