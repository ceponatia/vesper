import { describe, expect, it } from "vitest";
import { circadianCurveV1, METER_FIXED_POINT_ONE } from "@vesper/simulation-core/contracts/bodies";
import { initialMeters } from "@/contracts/meters/registry";
import { makeProfile } from "@/server/test-support";
import { chatMeterReads, seedChatScenario, seedChatState, type ChatState } from "./chat-state";
import { chatVisualStateShadowInput } from "./chat-visual-state-cut";

/**
 * #300: `chatVisualStateShadowInput` feeds the image lane's meters through the
 * ONE derived-read path (`chatMeterReads`), the same one the narrator and the
 * status strip read — never the raw stored reserve — so an image states
 * "exhausted" exactly when the rest of the surface does (energy read against
 * the character's own sleep pressure). Regression this kills: reverting the
 * `meters` field to `cut.state.meters` compiles clean (both are
 * `Record<string, number>`) and would silently make images show a rested
 * character at 4am, with no other test noticing.
 */
describe("chatVisualStateShadowInput — meters through the derived-read path", () => {
  it("reads energy against sleep pressure, not the raw stored reserve", () => {
    const profile = makeProfile();
    /** Chat minute of `hour:minute` on calendar day `day` (default anchor: day 0, 8:00am = minute 0). */
    const at = (day: number, hour: number, minute = 0): number => day * 1_440 + hour * 60 + minute - 8 * 60;
    const bedtimeReserve = circadianCurveV1.bedtimeFixedPoint / METER_FIXED_POINT_ONE;
    const clockMinutes = at(1, 4); // kept up long past a normal bedtime
    const scenario = { ...seedChatScenario(profile), clockMinutes };
    const state: ChatState = {
      ...seedChatState(profile),
      meters: { ...initialMeters(), energy: bedtimeReserve },
      lastSleepEndedAtMinutes: at(0, 7),
    };

    const shadow = chatVisualStateShadowInput({
      characterId: "chr-1",
      memoryGroupId: "chr-1",
      cutId: "cut-1",
      cut: { profile, state, scenario, owner: "player-1" },
    });

    const expectedReads = chatMeterReads(state, scenario, profile);
    expect(shadow.meters.energy).toBe(expectedReads.energy);
    expect(shadow.meters.energy).toBeLessThan(state.meters.energy as number);
  });
});
