import { describe, expect, it } from "vitest";
import { DiagnosticCollector } from "../diagnostics";
import { parseOr } from "@/lib/parse";
import {
  chatEnvironmentSchema,
  chatWindLevels,
  CHAT_WIND_FORCE,
  emptyChatEnvironment,
  precipitationActive,
  windForceOf,
} from "./chat-environment";

/**
 * The scene-environment owner (body-attribute-affordances slice 4).
 *
 * The property that matters most is the DIRECTION of the degraded default:
 * anything unparseable must land on indoors/still/dry, because failing the other
 * way would give every unlabelled conversation weather it never had.
 */

describe("the schema's degraded default is the conservative one", () => {
  it("parses an empty value to indoors, still, dry", () => {
    expect(chatEnvironmentSchema.parse({})).toEqual(emptyChatEnvironment());
    expect(emptyChatEnvironment().indoors).toBe(true);
  });

  it("catches an unknown band per FIELD without losing the rest", () => {
    const parsed = chatEnvironmentSchema.parse({
      wind: "hurricane",
      precipitation: "rain",
      indoors: "outside",
      updatedAtMinutes: -4,
    });
    expect(parsed).toEqual({ wind: "none", precipitation: "rain", indoors: true, updatedAtMinutes: 0 });
  });

  it("a rubbish blob degrades to the empty environment WITH the boundary diagnostic", () => {
    const sink = new DiagnosticCollector();
    const healed = parseOr(chatEnvironmentSchema, "storm", emptyChatEnvironment(), sink, "character_chats.environment");
    expect(healed).toEqual(emptyChatEnvironment());
    expect(sink.items.find((d) => d.code === "parse.boundary_failed")?.path).toBe("character_chats.environment");
  });
});

describe("the band maps", () => {
  it("is monotone across the wind vocabulary", () => {
    const forces = chatWindLevels.map((level) => CHAT_WIND_FORCE[level]);
    for (let i = 1; i < forces.length; i++) expect(forces[i]).toBeGreaterThan(forces[i - 1] ?? -1);
  });

  it("indoors is a hard zero whatever the sky is doing", () => {
    const gale = { ...emptyChatEnvironment(), wind: "gusting" as const, precipitation: "downpour" as const };
    expect(windForceOf({ ...gale, indoors: true })).toBe(0);
    expect(precipitationActive({ ...gale, indoors: true })).toBe(false);
    expect(windForceOf({ ...gale, indoors: false })).toBe(CHAT_WIND_FORCE.gusting);
    expect(precipitationActive({ ...gale, indoors: false })).toBe(true);
  });

  it("still air outdoors reads zero force and no active precipitation", () => {
    const clear = { ...emptyChatEnvironment(), indoors: false };
    expect(windForceOf(clear)).toBe(0);
    expect(precipitationActive(clear)).toBe(false);
  });
});
