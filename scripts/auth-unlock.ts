import "dotenv/config";
import { BYPASS_GRANT_MS, credentialSubject, grantCredentialBypass, readCredentialFailures } from "@/server/auth";

/**
 * Operator recovery for the durable credential backoff
 * (docs/auth/sign-in.md §Per account, in Postgres).
 *
 * The backoff cannot tell an account's owner from someone guessing at it, so at
 * the ceiling both are queuing for the same slot and whoever asks first wins.
 * This is the way out when the owner keeps losing that race.
 *
 * It grants a short window in which the account is not refused — rather than
 * deleting the failure row, which an attacker rebuilds in seconds. The count
 * underneath is untouched: an unused grant expires and leaves the account
 * exactly as protected, and a used one ends when the successful sign-in clears
 * the row.
 *
 *   pnpm auth:unlock player@vesper.local
 *   pnpm auth:unlock player@vesper.local --minutes 5
 *
 * Run it where DATABASE_URL points at the database you mean — against Fly, that
 * is `fly ssh console` or a shell with the deployment's URL exported, and the
 * usual caution about which database applies.
 */

interface Args {
  readonly address: string;
  readonly durationMs: number;
}

function usage(message: string): never {
  process.stderr.write(`${message}\n\nUsage: pnpm auth:unlock <email> [--minutes N]\n`);
  process.exit(1);
}

function parseArgs(argv: readonly string[]): Args {
  const positional = argv.filter((arg) => !arg.startsWith("--"));
  const address = positional[0];
  if (address === undefined || address.trim().length === 0) usage("An account address is required.");

  const flagIndex = argv.indexOf("--minutes");
  if (flagIndex === -1) return { address, durationMs: BYPASS_GRANT_MS };

  const raw = argv[flagIndex + 1];
  const minutes = raw === undefined ? Number.NaN : Number(raw);
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 60) {
    usage("--minutes must be a number between 1 and 60; the window is meant to be short.");
  }
  return { address, durationMs: minutes * 60_000 };
}

async function main(): Promise<void> {
  const { address, durationMs } = parseArgs(process.argv.slice(2));
  const subject = credentialSubject(address);

  const before = await readCredentialFailures(subject);
  const until = await grantCredentialBypass(subject, durationMs);

  const state =
    before === null
      ? "no recorded failures — the account was not being throttled"
      : `${before.failures} recorded failure(s), left in place`;
  process.stdout.write(
    `Opened ${address} until ${until.toISOString()} (${Math.round(durationMs / 60_000)} min).\n` +
      `  ${state}.\n` +
      `  Sign in during the window; a successful sign-in clears the record and ends the grant.\n`,
  );
}

await main();
process.exit(0);
