/**
 * The FACE REPAIR admin action switch — experimental, default-off, the same
 * shape as every other flag `docs/README.md`/`constants.ts` documents
 * (`apps/web/src/server/engine/prompts/constants.ts` L106-126): only the
 * literal `"on"` enables it, and anything else — unset, `"false"`, `"true"`, a
 * typo — stays off.
 *
 * OFF is the entire action absent: the route answers the same hidden 404
 * `withOwnerAdmin` gives a caller outside its namespace, and the admin
 * Settings page hides the Face repair section behind one sentence saying so.
 * ON adds exactly the one flagged action issue #246 asks for — an explicit,
 * owner-admin-only repair of one character's face in one selected source
 * image, run over the ordinary Image Generator run path so the attempt is
 * provenance-complete and never a silent substitute for another model's
 * output. No other behavior changes: repair is never an automatic fallback
 * after another render fails, and player-facing promotion is a separate,
 * unimplemented decision.
 */
export function imageFaceRepairEnabled(): boolean {
  return process.env.IMAGE_FACE_REPAIR === "on";
}
