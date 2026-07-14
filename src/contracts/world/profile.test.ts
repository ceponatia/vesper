import { describe, expect, it } from "vitest";
import {
  characterProfileSchema,
  describeScheduleWindow,
  emptyVoiceAnchors,
  formatScheduleMinute,
  formatScheduleRhythm,
  hasVoiceAnchors,
  matchScheduleDayPart,
  SCHEDULE_DAY_PARTS,
  scheduleDayPartById,
  VOICE_PET_PHRASES_MAX,
  voiceAnchorsSchema,
  type ScheduleEntry,
} from "./profile";

const entry = (over: Partial<ScheduleEntry> = {}): ScheduleEntry => ({
  startMinute: 360,
  endMinute: 720,
  locationName: "the Dockside Café",
  activity: "waiting tables",
  ...over,
});

describe("schedule day parts (chat-initiative.plan.md slice 4)", () => {
  it("round-trips: every day part matches its own window", () => {
    for (const part of SCHEDULE_DAY_PARTS) {
      expect(scheduleDayPartById(part.id)).toBe(part);
      expect(matchScheduleDayPart({ startMinute: part.startMinute, endMinute: part.endMinute })).toBe(part.id);
    }
    expect(matchScheduleDayPart({ startMinute: 400, endMinute: 720 })).toBeNull();
    expect(scheduleDayPartById("brunch")).toBeUndefined();
  });

  it("formats minutes as a 12-hour clock face", () => {
    expect(formatScheduleMinute(0)).toBe("12am");
    expect(formatScheduleMinute(360)).toBe("6am");
    expect(formatScheduleMinute(750)).toBe("12:30pm");
    expect(formatScheduleMinute(1439)).toBe("11:59pm");
  });

  it("describes preset windows by name, custom ones by clock, with the day mask appended", () => {
    expect(describeScheduleWindow(entry())).toBe("mornings");
    expect(describeScheduleWindow(entry({ startMinute: 570, endMinute: 840 }))).toBe("9:30am–2pm");
    expect(describeScheduleWindow(entry({ days: [1, 3, 5] }))).toBe("mornings (Mon/Wed/Fri)");
  });

  it("renders the compact rhythm line the initiative cue consumes", () => {
    const rhythm = formatScheduleRhythm([
      entry(),
      entry({ startMinute: 1080, endMinute: 1380, activity: "sketching", locationName: "the pier" }),
    ]);
    expect(rhythm).toBe("mornings: waiting tables at the Dockside Café; evenings: sketching at the pier");
    expect(formatScheduleRhythm([])).toBe("");
  });
});

describe("voiceAnchors (character-fidelity slice 7)", () => {
  it("trims, drops blanks, and caps the lists", () => {
    const parsed = voiceAnchorsSchema.parse({
      petPhrases: ["  no promises  ", "", "  ", ...Array.from({ length: 10 }, (_, i) => `p${i}`)],
      cadence: "  clipped and dry  ",
      neverSays: ["babe", ""],
    });
    expect(parsed.petPhrases).toContain("no promises");
    expect(parsed.petPhrases.length).toBeLessThanOrEqual(VOICE_PET_PHRASES_MAX);
    expect(parsed.petPhrases).not.toContain("");
    expect(parsed.cadence).toBe("clipped and dry");
    expect(parsed.neverSays).toEqual(["babe"]);
  });

  it("degrades a malformed value to empty anchors rather than throwing", () => {
    expect(voiceAnchorsSchema.parse("not an object")).toEqual(emptyVoiceAnchors());
    expect(voiceAnchorsSchema.parse(undefined)).toEqual(emptyVoiceAnchors());
    expect(voiceAnchorsSchema.parse({ petPhrases: "oops", cadence: 5, neverSays: null })).toEqual(emptyVoiceAnchors());
  });

  it("old rows parse unchanged: no voiceAnchors key ⇒ empty ⇒ hasVoiceAnchors false", () => {
    const profile = characterProfileSchema.parse({ bio: "x" });
    expect(profile.voiceAnchors).toEqual(emptyVoiceAnchors());
    expect(hasVoiceAnchors(profile.voiceAnchors)).toBe(false);
  });

  it("hasVoiceAnchors is true when any field carries content", () => {
    expect(hasVoiceAnchors({ petPhrases: ["hey"], cadence: "", neverSays: [] })).toBe(true);
    expect(hasVoiceAnchors({ petPhrases: [], cadence: "clipped", neverSays: [] })).toBe(true);
    expect(hasVoiceAnchors(emptyVoiceAnchors())).toBe(false);
  });
});

describe("profile.schedule boundary (element-wise catch)", () => {
  it("drops a bad row alone instead of failing the profile parse", () => {
    const parsed = characterProfileSchema.parse({
      schedule: [
        { startMinute: 360, endMinute: 720, locationName: "the quay", activity: "inspection" },
        { startMinute: 360, endMinute: 720, locationName: "", activity: "" }, // a blank editor row
        "not even an object",
      ],
    });
    expect(parsed.schedule).toEqual([
      { startMinute: 360, endMinute: 720, locationName: "the quay", activity: "inspection" },
    ]);
  });
});
