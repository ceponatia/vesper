import { describe, expect, it } from "vitest";
import { LEGACY_ENGINE_TEST_PLAYER_ENV, legacyUnanchoredEngineTestMode } from "./legacy-test-mode";

/**
 * The legacy synthetic-player capability needs BOTH conditions: the test runtime
 * and the exact opt-in value `"1"`. A production or development process carrying
 * the flag, a truthy-looking spelling, or the test runtime alone must leave the
 * authorization seam's unanchored-branch exception closed.
 */

interface ModeCase {
  name: string;
  env: NodeJS.ProcessEnv;
  expected: boolean;
}

// Next's global types declare `NODE_ENV` as always present; a real process
// environment can still lack it, which is exactly the case pinned here.
const EMPTY_ENV = {} as NodeJS.ProcessEnv;

const CASES: readonly ModeCase[] = [
  {
    name: "the test runtime with the flag set to 1",
    env: { NODE_ENV: "test", [LEGACY_ENGINE_TEST_PLAYER_ENV]: "1" },
    expected: true,
  },
  {
    name: "a production process carrying the flag",
    env: { NODE_ENV: "production", [LEGACY_ENGINE_TEST_PLAYER_ENV]: "1" },
    expected: false,
  },
  {
    name: "a development process carrying the flag",
    env: { NODE_ENV: "development", [LEGACY_ENGINE_TEST_PLAYER_ENV]: "1" },
    expected: false,
  },
  {
    name: 'the test runtime with the flag spelled "true"',
    env: { NODE_ENV: "test", [LEGACY_ENGINE_TEST_PLAYER_ENV]: "true" },
    expected: false,
  },
  { name: "the test runtime without the flag", env: { NODE_ENV: "test" }, expected: false },
  { name: "an empty environment", env: EMPTY_ENV, expected: false },
];

describe("legacyUnanchoredEngineTestMode", () => {
  it.each(CASES)("is $expected for $name", ({ env, expected }) => {
    expect(legacyUnanchoredEngineTestMode(env)).toBe(expected);
  });
});
