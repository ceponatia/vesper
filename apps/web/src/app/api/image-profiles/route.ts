import type { NextRequest } from "next/server";
import { imageProfileTaskSchema } from "@vesper/image-core";
import { jsonError, jsonOk, withUser } from "@/server/api";
import { loadImageModelProfilesForTask } from "@/server/images";

/**
 * The profile list the player-facing pickers read. Ordinary users, not admins:
 * choosing which profile paints your portrait or scene is a normal affordance —
 * only MANAGING profiles is admin-only, under
 * `/api/admin/self/image-models/…/profiles`.
 *
 * `?task=` is required, because "offered" is a fact about one task: the list is
 * `loadImageModelProfilesForTask`'s answer — the profile enabled, the model
 * present and allowed by the task's legacy surface toggle, the pair eligible —
 * which is EXACTLY the candidate set `resolveImageProfileForTask` accepts, so
 * the picker can never show a choice resolution would then decline (the
 * `image_profile.pick_unavailable` window this endpoint closes).
 *
 * The wire shape is a picker OPTION, not the profile row: id, grouping label,
 * and the model's operator warning, which a player sees BEFORE choosing rather
 * than after a refused render. Model internals stay off this surface.
 */
export const GET = withUser(async (_user, req: NextRequest) => {
  const requested = imageProfileTaskSchema.safeParse(new URL(req.url).searchParams.get("task"));
  if (!requested.success) {
    return jsonError("image_profile.unknown_task", "pass ?task=<image profile task>", 400);
  }
  const offered = await loadImageModelProfilesForTask(requested.data);
  return jsonOk({
    profiles: offered.map(({ profile, model }) => ({
      id: profile.id,
      label: profile.label,
      task: profile.task,
      isDefault: profile.isDefault,
      modelId: model.id,
      modelLabel: model.label,
      operatorWarning: model.operatorWarning,
    })),
  });
});
