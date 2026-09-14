import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { renderAdvisoryCodes } from "@vesper/image-core";
import { db, images } from "@/server/db";
import { jsonOk, withOwnerAdmin } from "@/server/api";
import { imageMeta } from "@/server/images";
import { parseOrNull } from "@/lib/parse";

/**
 * GET /api/admin/self/image-advisories/summary — the comparison record issue
 * #249 asks for: per advisory code, how many of the owner's renders were
 * annotated, how many the owner agreed or disagreed with, and how many are
 * still unreviewed, plus the 20 most recently reviewed rows. This table is
 * what the owner reads to write a verdict for each signal — annotate, reject,
 * or propose a narrowly defined promotion check — never a computed threshold
 * that writes the verdict for them.
 *
 * Every known code is seeded at zero so a signal nobody has triggered yet
 * (or one deferred without shipping, like face-count) still has a row.
 */

const storedAdvisorySchema = z
  .object({
    code: z.string(),
    review: z
      .object({
        verdict: z.enum(["agree", "disagree"]),
        note: z.string().optional(),
        at: z.string().optional(),
      })
      .optional(),
  })
  .loose();

interface CodeCounts {
  annotated: number;
  agreed: number;
  disagreed: number;
  unreviewed: number;
}

function emptyCounts(): CodeCounts {
  return { annotated: 0, agreed: 0, disagreed: 0, unreviewed: 0 };
}

interface ReviewedRow {
  imageId: string;
  code: string;
  verdict: "agree" | "disagree";
  note: string | null;
  reviewedAt: string | null;
}

export const GET = withOwnerAdmin(async (user) => {
  // Pre-filtered to rows that carry an `advisories` key at all — every other
  // row (the overwhelming majority: nothing was measured, or nothing crossed
  // a threshold) never needed to be pulled into the process just to be
  // skipped in a loop.
  const rows = await db()
    .select({ id: images.id, meta: images.meta })
    .from(images)
    .where(and(eq(images.ownerId, user.id), sql`${images.meta} -> 'advisories' is not null`));

  const counts = new Map<string, CodeCounts>(renderAdvisoryCodes.map((code) => [code, emptyCounts()]));
  const bump = (code: string, key: keyof CodeCounts) => {
    const entry = counts.get(code) ?? emptyCounts();
    entry[key] += 1;
    counts.set(code, entry);
  };

  const reviewed: ReviewedRow[] = [];
  for (const row of rows) {
    const meta = imageMeta(row.meta);
    // Parsed PER ENTRY, not as one array: a single malformed advisory (an
    // older or newer deploy's shape this route does not recognize) costs
    // that one entry, never the whole row's evidence.
    const rawAdvisories = Array.isArray(meta.advisories) ? meta.advisories : [];
    const advisories = rawAdvisories.flatMap((raw) => {
      const parsed = parseOrNull(storedAdvisorySchema, raw, undefined, "images.meta.advisories");
      return parsed ? [parsed] : [];
    });
    for (const advisory of advisories) {
      bump(advisory.code, "annotated");
      if (!advisory.review) {
        bump(advisory.code, "unreviewed");
        continue;
      }
      bump(advisory.code, advisory.review.verdict === "agree" ? "agreed" : "disagreed");
      reviewed.push({
        imageId: row.id,
        code: advisory.code,
        verdict: advisory.review.verdict,
        note: advisory.review.note ?? null,
        reviewedAt: advisory.review.at ?? null,
      });
    }
  }

  // Most-recently-reviewed first. `at` is an ISO timestamp, so string order is
  // chronological order; an entry missing it (a hand-edited or pre-timestamp
  // row) sorts last rather than crowding out ones that do carry one.
  reviewed.sort((a, b) => (b.reviewedAt ?? "").localeCompare(a.reviewedAt ?? ""));

  return jsonOk({
    codes: Array.from(counts.entries()).map(([code, counted]) => ({ code, ...counted })),
    reviewed: reviewed.slice(0, 20),
  });
});
