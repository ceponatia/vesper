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
