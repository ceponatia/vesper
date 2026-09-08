import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import {
  projectCharacterMediaJob,
  type CharacterMediaJob,
  type CharacterMediaJobProjectionInput,
  type CharacterMediaResult,
} from "@/contracts";
import { characterReferenceViews, db, imageIdentityPacks, jobs, JOB_STALE_MS } from "@/server/db";

const CHARACTER_MEDIA_JOB_TYPES = ["avatar", "portrait_variant", "identity_pack", "reference_views"] as const;
const CHARACTER_MEDIA_RECENT_MS = 24 * 60 * 60_000;
export const CHARACTER_MEDIA_JOB_LIMIT = 8;

type CharacterMediaJobRow = Pick<
  typeof jobs.$inferSelect,
  "id" | "type" | "status" | "payload" | "createdAt" | "startedAt" | "finishedAt"
>;

/**
 * The character-facing jobs read.
 *
 * Ownership and character scope are both predicates on the jobs query. The
 * payload remains inside the server and crosses only the pure allowlist
 * projection; provider ids, prompts, arbitrary errors and other internal keys
 * never reach the route.
 */
export async function listCharacterMediaJobs(
  characterId: string,
  ownerId: string,
  now: Date = new Date(),
): Promise<CharacterMediaJob[]> {
  const rows = await db()
    .select({
      id: jobs.id,
      type: jobs.type,
      status: jobs.status,
      payload: jobs.payload,
      createdAt: jobs.createdAt,
      startedAt: jobs.startedAt,
      finishedAt: jobs.finishedAt,
    })
    .from(jobs)
    .where(
      and(
        eq(jobs.ownerId, ownerId),
        inArray(jobs.type, CHARACTER_MEDIA_JOB_TYPES),
        gte(jobs.createdAt, new Date(now.getTime() - CHARACTER_MEDIA_RECENT_MS)),
        sql`${jobs.payload} ->> 'characterId' = ${characterId}`,
      ),
    )
    .orderBy(desc(jobs.createdAt))
    .limit(CHARACTER_MEDIA_JOB_LIMIT);

  const scoped = rows.flatMap((row) => {
    const input = toProjectionInput(row);
    return input === null ? [] : [{ row, input }];
  });
  return Promise.all(
    scoped.map(async ({ row, input }) =>
      projectCharacterMediaJob(input, {
        now,
        staleAfterMs: JOB_STALE_MS,
        results: await resultIdentifiers(row, characterId),
      }),
    ),
  );
}

function toProjectionInput(row: CharacterMediaJobRow): CharacterMediaJobProjectionInput | null {
  if (!CHARACTER_MEDIA_JOB_TYPES.some((type) => type === row.type)) {
    return null;
  }
  return {
    id: row.id,
    type: row.type as CharacterMediaJobProjectionInput["type"],
    status: row.status,
    payload: row.payload,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  };
}

/** Result rows created by this job window, projected to identifiers only. */
async function resultIdentifiers(row: CharacterMediaJobRow, characterId: string): Promise<CharacterMediaResult[]> {
  if (row.type !== "identity_pack" && row.type !== "reference_views") return [];
  const end = row.finishedAt ?? new Date();

  if (row.type === "identity_pack") {
    const packs = await db()
      .select({ id: imageIdentityPacks.id, imageId: imageIdentityPacks.faceCropImageId })
      .from(imageIdentityPacks)
      .where(
        and(
          eq(imageIdentityPacks.characterId, characterId),
          gte(imageIdentityPacks.createdAt, row.createdAt),
          lte(imageIdentityPacks.createdAt, end),
        ),
      )
      .orderBy(desc(imageIdentityPacks.createdAt))
      .limit(1);
    return packs.map((pack) => ({ kind: "identity_pack" as const, id: pack.id, imageId: pack.imageId }));
  }

  const attempts = await db()
    .select({
      id: characterReferenceViews.id,
      imageId: characterReferenceViews.imageId,
    })
    .from(characterReferenceViews)
    .where(
      and(
        eq(characterReferenceViews.characterId, characterId),
        gte(characterReferenceViews.createdAt, row.createdAt),
        lte(characterReferenceViews.createdAt, end),
      ),
    )
    .orderBy(desc(characterReferenceViews.createdAt))
    .limit(32);
  return attempts.map((attempt) => ({
    kind: "reference_view_attempt" as const,
    id: attempt.id,
    imageId: attempt.imageId,
  }));
}
