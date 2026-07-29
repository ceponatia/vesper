import { describe, expect, it } from "vitest";
import {
  displayWorldActionLabel,
  displayWorldAlternative,
  worldCastKey,
} from "./chat-world-card-format";

describe("chat world card formatting", () => {
  it("keeps authored action prose and humanizes identifier-like labels", () => {
    expect(displayWorldActionLabel("Take a quiet rest", "rest")).toBe("Take a quiet rest");
    expect(displayWorldActionLabel("prepare_meal", "action-1")).toBe("Prepare meal");
    expect(displayWorldActionLabel("", "prepare_meal")).toBe("Prepare meal");
  });

  it("maps command alternatives to player language and safely humanizes unknown commands", () => {
    expect(displayWorldAlternative("end_engagement")).toBe("End the conversation");
    expect(displayWorldAlternative("move_actor")).toBe("Go somewhere else");
    expect(displayWorldAlternative("attempt_entry")).toBe("Attempt entry");
    expect(displayWorldAlternative("wait a while")).toBe("Wait a while");
  });

  it("uses actor identity when present and keeps duplicate-name fallbacks unique", () => {
    const identified = [
      { actorId: "actor-a", name: "Nora" },
      { actorId: "actor-b", name: "Nora" },
    ];
    expect(worldCastKey(identified, 0)).toBe("actor-a");
    expect(worldCastKey(identified, 1)).toBe("actor-b");

    const legacy = [{ name: "Nora" }, { name: "Sable" }, { name: "Nora" }];
    expect(worldCastKey(legacy, 0)).toBe("Nora\u00000");
    expect(worldCastKey(legacy, 2)).toBe("Nora\u00001");
  });
});
