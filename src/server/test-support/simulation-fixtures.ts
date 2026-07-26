/**
 * The historical player identity used by the low-level durable-engine suites.
 *
 * Those suites predate account/chat ownership and intentionally exercise domain
 * kernels against directly seeded branches. New authorization-focused tests must
 * create a real user + character-chat anchor instead; see command-authz.int.test.
 */
export const LEGACY_ENGINE_TEST_PLAYER_ID = "principal-1";

/** Environment key used only by the aggregate legacy engine test command. */
export const LEGACY_ENGINE_TEST_PLAYER_ENV = "VESPER_ENGINE_TEST_PLAYER_ID";

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
 * Narrow compatibility seam for the aggregate engine suite.
 *
 * Production and ordinary integration runs remain fail-closed: the exception is
 * active only under Vitest's NODE_ENV=test and only when test:engine explicitly
 * opts into this exact synthetic principal id. The dedicated authorization suite
 * does not set the env key, so it still proves that every ordinary unanchored
 * player is denied before any write.
 */
export function isLegacyUnanchoredEngineTestPlayer(
  principalId: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.NODE_ENV === "test" && env[LEGACY_ENGINE_TEST_PLAYER_ENV] === principalId;
}
