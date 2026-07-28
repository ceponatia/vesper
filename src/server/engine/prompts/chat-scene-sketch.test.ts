import { describe, expect, it } from "vitest";
import { expectFenced } from "@/server/test-support";
import { buildChatSceneSketchPrompt, CHAT_SCENE_SKETCH_SYSTEM } from "./chat-scene-sketch";

describe("CHAT_SCENE_SKETCH_SYSTEM", () => {
  it("asks for one JSON sketch object, place-only and grounded in the established details", () => {
    expect(CHAT_SCENE_SKETCH_SYSTEM).toContain('{ "sketch"');
    expect(CHAT_SCENE_SKETCH_SYSTEM).toMatch(/Describe the PLACE only/);
    expect(CHAT_SCENE_SKETCH_SYSTEM).toMatch(/Never people, never events/);
    expect(CHAT_SCENE_SKETCH_SYSTEM).toMatch(/MUST appear in the sketch/);
    expect(CHAT_SCENE_SKETCH_SYSTEM).toMatch(/contradict nothing/);
  });
});

describe("buildChatSceneSketchPrompt", () => {
  it("renders the place, details, connections, time of day, and fences the authored/derived text", () => {
    const prompt = buildChatSceneSketchPrompt({
      placeName: "the kitchen",
      details: ["blue-tiled counter", "kettle on the stove"],
      connections: ["living room through the doorway"],
      timeOfDay: "early evening",
      premise: "A quiet week at Mara's coastal cottage.",
      characterName: "Mara",
      recentNarration: ["Mara led you into the kitchen, flicking on the small lamp over the stove."],
    });
    expect(prompt).toContain("Place to sketch: the kitchen");
    expect(prompt).toContain("Time of day: early evening");
    expect(prompt).toContain("- blue-tiled counter");
    expect(prompt).toContain("- living room through the doorway");
    // Authored premise and prior narration are untrusted — both ride inside fences.
    // Matched by SHAPE, so rotating the fence nonce (a security action) is not a test break.
    expectFenced(prompt, "scenario");
    expectFenced(prompt, "recent narration");
    expect(prompt).toContain("flicking on the small lamp");
  });

  it("stays coherent with no details, no premise, and no narration (a just-minted stub place)", () => {
    const prompt = buildChatSceneSketchPrompt({
      placeName: "the porch",
      details: [],
      connections: [],
      characterName: "Mara",
      recentNarration: [],
    });
    expect(prompt).toContain("Place to sketch: the porch");
    expect(prompt).toContain("(none yet — invent modest, tone-appropriate furnishings)");
    expect(prompt).not.toContain("Time of day:");
    expect(prompt).not.toContain("Connections");
  });
});
