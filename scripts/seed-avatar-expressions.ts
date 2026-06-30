import "dotenv/config";
import { ilike } from "drizzle-orm";
import { characters, db } from "../src/server/db";
import { coveredExpressionEmotions, SEED_EMOTIONS, seedAvatarExpressions } from "../src/server/images";

/**
 * Backfill a character's avatar **expression frames** (avatar-3d.plan.md §"Slice 3"). This
 * is the dev/ops entry point to the runtime pipeline — it routes through the same idempotent
 * `seedAvatarExpressions` the `avatar_seed` job uses (deduped, negative-cached,
 * Venice-semaphore-bounded), so it is **safe to re-run** and only fills genuinely-missing
 * frames. Seeding now happens automatically at avatar-ready; this covers characters that
 * pre-date the feature.
 *
 *   pnpm tsx scripts/seed-avatar-expressions.ts [namePrefix] [--dry-run] [--limit N]
 *
 * Name-scoped (default "Lysandra" — the dev cast) so it is never an unbounded all-DB run.
 * `--dry-run` prints the per-character missing-frame plan + total edit count without spending.
 */

function flagValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const positional = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const prefix = positional[0] ?? "Lysandra";
  const dryRun = process.argv.includes("--dry-run");
  const limit = Number.parseInt(flagValue("--limit") ?? "", 10);

  let matches = await db()
    .select({ id: characters.id, ownerId: characters.ownerId, name: characters.name, avatarImageId: characters.avatarImageId })
    .from(characters)
    .where(ilike(characters.name, `${prefix}%`));
  matches = matches.filter((c) => c.avatarImageId);
  if (Number.isFinite(limit) && limit > 0) matches = matches.slice(0, limit);

  if (matches.length === 0) {
    console.error(`No character whose name starts with "${prefix}" has a canonical avatar.`);
    process.exit(1);
  }

  if (dryRun) {
    let total = 0;
    for (const c of matches) {
      const covered = await coveredExpressionEmotions(c.id, c.ownerId);
      const missing = SEED_EMOTIONS.filter((e) => !covered.has(e));
      total += missing.length;
      console.log(`  ${c.name.padEnd(24)} ${c.id}  →  ${missing.length} missing: ${missing.join(", ") || "(complete)"}`);
    }
    console.log(`\nDry run: ${total} expression frame(s) would be generated across ${matches.length} character(s). No spend.`);
    process.exit(0);
  }

  console.log(`Seeding expression frames for ${matches.length} character(s) starting with "${prefix}"…`);
  for (const c of matches) {
    const result = await seedAvatarExpressions(c.id, c.ownerId);
    console.log(`  ${c.name.padEnd(24)} → seeded ${result.seeded}, skipped ${result.skipped}, failed ${result.failed}`);
  }
  console.log("Done. Open the character chat or a session — the standing avatar crossfades real expressions as the mood shifts.");
  process.exit(0);
}

void main();
