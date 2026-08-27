import { describe, expect, it } from "vitest";
import {
  AFFINITY_DELTA_CLAMP,
  EPISODE_WINDOW,
  HEARTBEAT_INTERVAL_MS,
  MAX_JOB_ATTEMPTS,
  NARRATIVE_TEMPERATURE,
} from "./constants";

// Binding values — the chat pipeline + job runner build against them.
describe("engine constants", () => {
  it("matches the documented binding values", () => {
    expect(NARRATIVE_TEMPERATURE).toBe(0.85);
    expect(AFFINITY_DELTA_CLAMP).toBe(5);
    expect(EPISODE_WINDOW).toBe(4);
    expect(HEARTBEAT_INTERVAL_MS).toBe(5_000);
    expect(MAX_JOB_ATTEMPTS).toBe(3);
  });
});
