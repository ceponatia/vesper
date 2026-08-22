/**
 * The legacy synthetic-player opt-in read by the simulation authorization seam.
 *
 * This lives in the ENGINE (not `src/server/test-support`) because
 * `command-authz.ts` consults it in production code paths: the seam must prove
 * a submitted principal id is NOT a real account before admitting the legacy
 * fixture, and that check cannot depend on a test-only module. Test-support
 * re-exports these for the suites (`@/server/test-support` stays the import
 * surface for tests), which keeps test-support itself free of production
 * consumers — a hard requirement now that its barrel carries vitest-dependent
 * helpers.
 */

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

// CI probe: server-tree touch (PR is closed after validation, never merged)
