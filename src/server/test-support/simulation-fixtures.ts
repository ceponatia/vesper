/**
 * The historical player identity used by the low-level durable-engine suites.
 *
 * Those suites predate account/chat ownership and intentionally exercise domain
 * kernels against directly seeded branches. New authorization-focused tests must
 * create a real user + character-chat anchor instead; see command-authz.int.test.
 */
export const LEGACY_ENGINE_TEST_PLAYER_ID = "principal-1";

/** Environment key used only by the aggregate legacy engine test command. */
export const LEGACY_ENGINE_TEST_PLAYER_ENV = "VESPER_ALLOW_LEGACY_ENGINE_TEST_PLAYER";

export interface LegacyEngineTestPlayerPrincipal {
  kind: "player";
  principalId: typeof LEGACY_ENGINE_TEST_PLAYER_ID;
  controlledActorIds: string[];
}

/**
 * Shared legacy principal builder for new/updated low-level engine fixtures.
 * Keeping this in one module prevents another spread of hand-written principal
 * ids and makes a future fixture migration mechanical.
 */
export function legacyEngineTestPlayerPrincipal(controlledActorIds: string[]): LegacyEngineTestPlayerPrincipal {
  return {
    kind: "player",
    principalId: LEGACY_ENGINE_TEST_PLAYER_ID,
    controlledActorIds,
  };
}

/**
 * Whether the aggregate engine run has opted into legacy synthetic principals.
 *
 * This is intentionally only a mode check. The authorization seam separately
 * proves that the submitted id is NOT a real account before admitting it, so an
 * opted-in test run still cannot make an unanchored branch writable by a seeded
 * user. Production and ordinary integration runs never enable this mode.
 */
export function legacyUnanchoredEngineTestMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === "test" && env[LEGACY_ENGINE_TEST_PLAYER_ENV] === "1";
}

/**
 * Collection-time guard for the suites that submit the legacy fixture against
 * directly-seeded (unanchored) branches. Without the opt-in,
 * `authorizeSimulationCommand` refuses every player command as
 * `unanchored_player`, which a plain local `pnpm test:int` surfaces as ~120
 * opaque domain failures ("expected the transfer to be accepted, got
 * rejected") — so fail the file at collection naming the actual cause instead.
 * Call it only after the DB probe succeeds (an unreachable database keeps its
 * self-skip behavior), and never from the authorization suites
 * (command-authz.int.test), whose denial coverage must not depend on the flag.
 */
export function requireLegacyUnanchoredEngineTestMode(suite: string, env: NodeJS.ProcessEnv = process.env): void {
  if (legacyUnanchoredEngineTestMode(env)) return;
  const cause =
    env[LEGACY_ENGINE_TEST_PLAYER_ENV] === "1"
      ? `${LEGACY_ENGINE_TEST_PLAYER_ENV}=1 is set but NODE_ENV is ${JSON.stringify(env.NODE_ENV)} — the legacy mode also requires NODE_ENV=test (vitest's default)`
      : `${LEGACY_ENGINE_TEST_PLAYER_ENV}=1 is not set`;
  throw new Error(
    `[${suite}] ${cause}. This suite submits the legacy synthetic player fixture ` +
      `("${LEGACY_ENGINE_TEST_PLAYER_ID}") against directly-seeded unanchored branches, so without the opt-in ` +
      `the simulation authorization seam refuses every player command as "unanchored_player" and the run reports ` +
      `dozens of misleading domain failures instead of this message. Re-run as ` +
      `\`${LEGACY_ENGINE_TEST_PLAYER_ENV}=1 pnpm test:int\` (CI already exports the flag for \`pnpm test:engine\`). ` +
      `Details: docs/testing.md §"Running the whole integration suite locally".`,
  );
}
