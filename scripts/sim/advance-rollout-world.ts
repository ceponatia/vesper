import "dotenv/config";
import { advanceRolloutWorld } from "@/server/engine";

/**
 * R1 (engine.rollout.plan.md): advance the rollout test world's story clock,
 * looping the bounded drain until it converges. Usage:
 *
 *   pnpm sim:advance -- --days 3
 *   pnpm sim:advance -- --to 500000
 *
 * Runs locally or on Fly over SSH exactly like sim:seed.
 */
async function main() {
  const args = process.argv.slice(2);
  const read = (flag: string): number | undefined => {
    const index = args.indexOf(flag);
    if (index === -1) return undefined;
    const value = Number(args[index + 1]);
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${flag} needs a positive number`);
    return value;
  };
  const days = read("--days");
  const to = read("--to");
  if (days === undefined && to === undefined) {
    throw new Error("Pass --days N or --to <storySecond>");
  }
  const result = await advanceRolloutWorld({
    ...(days === undefined ? {} : { days }),
    ...(to === undefined ? {} : { toStorySecond: to }),
  });
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
