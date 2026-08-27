import "dotenv/config";
import fs from "node:fs/promises";
import { eq, isNotNull, sql } from "drizzle-orm";
import { characters, db, images, jobs } from "@/server/db";
import { absoluteImagePath } from "@/server/images";

/**
 * One-off cleanup for the mood-reactive-avatar rollback: delete every
 * generated avatar **expression frame** (portrait_variant rows tagged `meta.avatarExpression`,
 * any status — includes the give-up tombstones) plus their files, and drop any leftover
 * `avatar_seed` job rows (the job type no longer exists, so a queued row would fail on claim).
 * A frame that was promoted to a character's canonical avatar is kept (deleting it would
 * orphan `characters.avatarImageId`).
 *
 *   pnpm tsx scripts/delete-avatar-expression-frames.ts [--dry-run]
 *
 * Safe to re-run; prints what it deleted. Run once against each environment (local, Fly).
 */

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");

  const rows = await db()
    .select({ id: images.id, path: images.path, entityId: images.entityId, meta: images.meta })
    .from(images)
    .where(sql`${images.kind} = 'portrait_variant' and ${images.meta} ->> 'avatarExpression' is not null`);

  // Never delete a frame the user promoted to the canonical avatar.
  const avatarIds = new Set(
    (await db().select({ id: characters.avatarImageId }).from(characters).where(isNotNull(characters.avatarImageId))).map(
      (r) => r.id,
    ),
  );
  const doomed = rows.filter((r) => !avatarIds.has(r.id));
  const kept = rows.length - doomed.length;

  const seedJobs = await db()
    .select({ id: jobs.id, status: jobs.status })
    .from(jobs)
    .where(sql`${jobs.type} = 'avatar_seed'`);

  console.log(`${rows.length} expression frame(s) found; ${doomed.length} to delete, ${kept} kept (promoted to avatar).`);
  console.log(`${seedJobs.length} avatar_seed job row(s) to delete.`);
  if (dryRun) {
    console.log("Dry run — nothing deleted.");
    process.exit(0);
  }

  for (const row of doomed) {
    await db().delete(images).where(eq(images.id, row.id));
    await fs.unlink(absoluteImagePath(row)).catch(() => undefined); // file may already be gone
  }
  if (seedJobs.length > 0) await db().delete(jobs).where(sql`${jobs.type} = 'avatar_seed'`);

  console.log(`Deleted ${doomed.length} frame row(s) (+files) and ${seedJobs.length} job row(s).`);
  process.exit(0);
}

void main();
