import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { attr, laneProbeAvatarProgram, laneProbeProfile, makeProfile } from "@/server/test-support";
import { buildCanonBlock, buildCharacterChatSystemPrompt } from "@/server/engine";

/**
 * Age has two intentionally different owners:
 *
 * - `profile.age` is chronological/story truth and belongs to narrative models.
 * - `identity.apparent_age` is a visual authoring field and belongs to portrait generation.
 *
 * Scene-image coverage lives in `images/character-scene.test.ts`: scene renders get
 * neither field and inherit visible age from the portrait reference.
 */
describe("age context separation", () => {
  const profile = makeProfile({
    age: "25",
    attributes: [
      attr("identity.gender", "female", "base"),
      // Deliberately contradictory-looking values: this is the regression case.
      attr("identity.apparent_age", "forties", "base"),
      attr("hair.color", "black", "base"),
    ],
  });

  it("character chat gives narrators chronological age and withholds apparent age", () => {
    const prompt = buildCharacterChatSystemPrompt({ name: "Mira", profile });
    expect(prompt).toContain("You are 25 years old");
    expect(prompt).toContain("a young adult");
    expect(prompt).not.toContain("forties");
    expect(prompt).not.toContain("Apparent age");
  });

  it("successor narration gives narrators chronological age and withholds apparent age", () => {
    const prompt = buildCanonBlock({
      primaryName: "Mira",
      playerName: "Brian",
      profile,
      player: undefined,
      minor: false,
    });
    expect(prompt).toContain("Mira is 25 years old");
    expect(prompt).toContain("a young adult");
    expect(prompt).not.toContain("forties");
    expect(prompt).not.toContain("Apparent age");
  });

  it("portrait generation gets apparent age and never chronological age", () => {
    // The compiled avatar program is the portrait's only prompt path; the age
    // it states is the sheet's apparent-age band through the image vocabulary
    // (`imageAgeBandPhrases`), never the chronological field. Over the lane
    // probe's species, because the program states a person only once the
    // standalone digest projects a subject for them.
    const program = laneProbeAvatarProgram({ profile: laneProbeProfile({ age: profile.age, attributes: profile.attributes }) });
    if (program.kind !== "compiled") throw new Error(`the avatar program did not compile: ${program.kind}`);
    expect(program.prompt).toContain("forties");
    expect(program.prompt).not.toContain("25 years old");
    expect(program.prompt).not.toMatch(/\bchronological\b/i);
  });

  it("keeps production scene-image assembly disconnected from both age fields", () => {
    const scene = readFileSync(new URL("./images/character-scene.ts", import.meta.url), "utf8");
    const lookJob = readFileSync(new URL("./engine/chat-reference-images.ts", import.meta.url), "utf8");
    const lookRender = readFileSync(new URL("./images/chat-look.ts", import.meta.url), "utf8");

    // These are source-boundary tripwires: a future scene change must not quietly
    // reintroduce the old explicit apparent-age anchor or an age-bearing look input.
    expect(scene).not.toMatch(/\bapparentAgeAnchor\b/);
    expect(scene).not.toMatch(/\bageAnchor\s*:/);
    expect(lookJob).not.toMatch(/\bapparentAgeAnchor\b/);
    expect(lookJob).not.toMatch(/\bageAnchor\s*:/);
    expect(lookRender).not.toMatch(/\bageAnchor\b/);
  });
});
