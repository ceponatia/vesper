import { describe, expect, it } from "vitest";
import {
  LEGACY_ENGINE_TEST_PLAYER_ENV,
  requireLegacyUnanchoredEngineTestMode,
} from "./simulation-fixtures";

describe("requireLegacyUnanchoredEngineTestMode", () => {
  it("passes silently when the run opted in", () => {
    expect(() =>
      requireLegacyUnanchoredEngineTestMode("some-store.int.test", {
        NODE_ENV: "test",
        [LEGACY_ENGINE_TEST_PLAYER_ENV]: "1",
      }),
    ).not.toThrow();
  });

  it("fails a flagless run naming the opt-in command and the doc section", () => {
    expect(() => requireLegacyUnanchoredEngineTestMode("space-store.int.test", { NODE_ENV: "test" })).toThrow(
      /\[space-store\.int\.test\][\s\S]*VESPER_ALLOW_LEGACY_ENGINE_TEST_PLAYER=1 is not set[\s\S]*unanchored_player[\s\S]*VESPER_ALLOW_LEGACY_ENGINE_TEST_PLAYER=1 pnpm test:int[\s\S]*docs\/testing\.md/,
    );
  });

  it("blames NODE_ENV, not the flag, when the flag is set outside a test run", () => {
    expect(() =>
      requireLegacyUnanchoredEngineTestMode("space-store.int.test", {
        NODE_ENV: "development",
        [LEGACY_ENGINE_TEST_PLAYER_ENV]: "1",
      }),
    ).toThrow(/is set but NODE_ENV is "development"/);
  });
});
