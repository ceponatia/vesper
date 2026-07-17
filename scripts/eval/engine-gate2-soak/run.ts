import { eq } from "drizzle-orm";
import { db, simWorlds } from "@/server/db";
import { gate2SoakCiProfile, gate2SoakFullProfile, runGate2Soak } from "@/server/engine";

/**
 * E2.6 — the full-scale Gate 2 synthetic-month soak (developer tool; never part
 * of `verify` or CI — CI runs the small profile via `pnpm test:engine-e2-6`).
 *
 * Usage: pnpm eval:engine-gate2-soak [--ci-profile] [--keep]
 *   --ci-profile  run the small CI-sized profile instead of the full one
 *   --keep        leave the synthetic worlds in the database for inspection
 *
 * Needs DATABASE_URL (defaults to the local dev database). The normalized
 * material hash printed at the end is profile-deterministic: two runs of the
 * same profile must print the same value.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const profile = args.includes("--ci-profile") ? gate2SoakCiProfile : gate2SoakFullProfile;
  const keepWorlds = args.includes("--keep");

  const startedAt = performance.now();
  const report = await runGate2Soak(profile);
  const elapsedSeconds = (performance.now() - startedAt) / 1000;

  if (!keepWorlds) {
    for (const worldId of report.worldIds) {
      await db().delete(simWorlds).where(eq(simWorlds.id, worldId));
    }
  }
  await globalThis.__vesperPool?.end();

  console.log(JSON.stringify(report, null, 2));
  const failed = report.proofs.filter((proof) => !proof.pass);
  console.log(
    `\nGate 2 soak: ${report.proofs.length - failed.length}/${report.proofs.length} proof checks passed in ${elapsedSeconds.toFixed(1)}s ` +
      `(material hash ${report.materialHash.singleSkip}${keepWorlds ? "; worlds kept" : ""})`,
  );
  if (failed.length > 0) {
    for (const proof of failed) console.error(`FAILED ${proof.name}: ${proof.detail}`);
    throw new Error(`Gate 2 soak failed ${failed.length} proof check(s)`);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
