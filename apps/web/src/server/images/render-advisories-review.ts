import { z } from "zod";
import { parseOr } from "@/lib/parse";
import { imageMeta } from "./asset-storage";

/**
 * The owner's agree/disagree verdict on one stored render advisory (#249) —
 * the pure `images.meta` merge, split out from the route so the merge logic
 * can be pinned by a fixture-only test with no database.
 *
 * Deliberately loose about what an advisory IS: this module matches an entry
 * only by its `code` and otherwise treats it as an opaque bag it copies
 * forward untouched. It does NOT import `renderAdvisorySchema` from
 * `@vesper/image-core` and re-validate every field, because that schema has
 * no `review` key — a strict re-parse on a row that already carries a PRIOR
 * review would silently strip it every time this runs (zod drops unknown
 * keys by default), which would make a second review erase evidence of the
 * first instead of replacing it. Passthrough parsing is what lets an entry
 * round-trip everything it does not understand.
 */

const storedAdvisorySchema = z.object({ code: z.string() }).loose();
const storedAdvisoryListSchema = z.array(storedAdvisorySchema);

export interface RenderAdvisoryReviewRequest {
  code: string;
  verdict: "agree" | "disagree";
  /** Capped by the request schema at the route (≤ 300 chars); not re-checked here. */
  note?: string;
}

export type RenderAdvisoryReviewOutcome =
  | {
      ok: true;
      /** The row's full `meta`, ready to write back — every other key
       * untouched, `advisories` with the matched entry replaced. */
      meta: Record<string, unknown>;
      /** The updated entry alone, for the route's response body. */
      advisory: Record<string, unknown>;
    }
  | { ok: false };

/**
 * Merge one review onto the advisory named by `request.code`.
 *
 * `reviewedAt` is a parameter rather than read from `Date.now()` in here, on
 * the `image-lab-controls.ts` `reviewImageLabControl` precedent: a review's
 * timestamp is stamped from the caller's clock, never accepted from a
 * request body, and keeping this function pure of the wall clock is what
 * makes it a fixture-only test.
 *
 * `{ ok: false }` — matched by the route to a 404 — when `rawMeta` carries no
 * `advisories` array at all, or none of its entries has this code: an unknown
 * code is indistinguishable from "this render never measured that signal",
 * which is the honest answer either way. A second review on an entry that
 * already has one REPLACES it (the spread order below), never averages or
 * stacks reviews.
 */
export function mergeRenderAdvisoryReview(
  rawMeta: unknown,
  request: RenderAdvisoryReviewRequest,
  reviewedAt: string,
): RenderAdvisoryReviewOutcome {
  const meta = imageMeta(rawMeta);
  const advisories = parseOr(storedAdvisoryListSchema, meta.advisories, [], undefined, "images.meta.advisories");
  const index = advisories.findIndex((advisory) => advisory.code === request.code);
  const current = advisories[index];
  if (index === -1 || current === undefined) return { ok: false };

  const updated = {
    ...current,
    review: {
      verdict: request.verdict,
      ...(request.note !== undefined ? { note: request.note } : {}),
      at: reviewedAt,
    },
  };
  const nextAdvisories = advisories.slice();
  nextAdvisories[index] = updated;
  return { ok: true, meta: { ...meta, advisories: nextAdvisories }, advisory: updated };
}
