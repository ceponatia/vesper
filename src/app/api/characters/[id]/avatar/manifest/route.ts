import { jsonOk, withUser } from "@/server/api";
import { loadAvatarManifest } from "@/server/images";

type Params = { id: string };

/**
 * The character's **avatar asset manifest** (avatar-3d.spec §4) — the standing companion
 * panel fetches this once to map cue emotion/pose labels to image frames. Owner-scoped;
 * an unknown/unowned character degrades to an empty manifest (no 404 — the panel just
 * renders the base portrait, or nothing). Static-ish: changes only when frames are
 * generated, so it rides its own request, not the per-poll state snapshot.
 */
export const GET = withUser<Params>(async (user, _req, ctx) => {
  const { id } = await ctx.params;
  return jsonOk(await loadAvatarManifest(id, user.id));
});
