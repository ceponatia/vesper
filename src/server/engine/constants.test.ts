import { describe, expect, it } from "vitest";
import {
  DEFAULT_INTER_AREA_TRAVEL_MINUTES,
  DEFAULT_LINK_TRAVEL_MINUTES,
  EPISODE_WINDOW,
  FACTS_CAP,
  FALLBACK_MINUTES_ADVANCED,
  FUZZY_RESOLVE_MIN,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_STALE_MS,
  MAJOR_TIER_SOFT_CAP,
  MAX_MINUTES_ADVANCED,
  MIN_MINUTES_ADVANCED,
  NARRATIVE_HISTORY_TURNS,
  OPEN_THREADS_IN_CONTEXT,
  THREAD_COOLING_TURNS,
} from "./constants";

// Binding values per docs/turn-engine.md — wave-2 modules build against them.
describe("engine constants", () => {
  it("matches the documented binding values", () => {
    expect(FALLBACK_MINUTES_ADVANCED).toBe(30);
    expect(MIN_MINUTES_ADVANCED).toBe(1);
    expect(MAX_MINUTES_ADVANCED).toBe(480);
    expect(DEFAULT_LINK_TRAVEL_MINUTES).toBe(1);
    expect(DEFAULT_INTER_AREA_TRAVEL_MINUTES).toBe(10);
    expect(MAJOR_TIER_SOFT_CAP).toBe(6);
    expect(NARRATIVE_HISTORY_TURNS).toBe(6);
    expect(EPISODE_WINDOW).toBe(4);
    expect(FACTS_CAP).toBe(8);
    expect(THREAD_COOLING_TURNS).toBe(8);
    expect(OPEN_THREADS_IN_CONTEXT).toBe(3);
    expect(HEARTBEAT_STALE_MS).toBe(60_000);
    expect(HEARTBEAT_INTERVAL_MS).toBe(5_000);
    expect(FUZZY_RESOLVE_MIN).toBe(0.75);
  });
});
