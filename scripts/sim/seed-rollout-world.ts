import "dotenv/config";
import { seedRolloutTestWorld } from "@/server/engine";

/**
 * R1 (engine.rollout.plan.md): provision (or find) the standing internal test
 * world. Idempotent — an existing world is reported, never duplicated. Run
 * locally (`pnpm sim:seed`) or on Fly (`fly ssh console -a vesper -C "pnpm sim:seed"`).
 */
async function main() {
  const summary = await seedRolloutTestWorld();
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
