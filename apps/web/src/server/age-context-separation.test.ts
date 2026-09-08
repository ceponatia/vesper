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
 * Scene-image coverage lives beside the scene lane: `images/character-scene.test.ts`
 * proves the composer context carries neither field, and
 * `images/scene-provenance.test.ts` proves the compiled scene prompt states no
 * apparent age on any rung — scene renders inherit visible age from the identity
 * reference, by the seam's lane policy (`CHARACTER_LANE_APPARENT_AGE`).
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
    const complete = laneProbeProfile();
    const overridden = new Set(profile.attributes.map((attribute) => attribute.id));
    const program = laneProbeAvatarProgram({
      profile: laneProbeProfile({
        age: profile.age,
        attributes: [
          ...complete.attributes.filter((attribute) => !overridden.has(attribute.id)),
          ...profile.attributes,
        ],
      }),
    });
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
    // reintroduce an explicit apparent-age anchor — the retired lane-side sentence
    // under any name, or the image age vocabulary read directly — or an
    // age-bearing look input. Age reaches a picture through the compiled
    // program's adapter alone.
    const ageWords = /\bapparentAgeAnchor\b|\bimageAgeBandPhrases\b|\bimageApparentAgeValue\b/;
    expect(scene).not.toMatch(ageWords);
    expect(scene).not.toMatch(/\bageAnchor\s*:/);
    expect(lookJob).not.toMatch(ageWords);
    expect(lookJob).not.toMatch(/\bageAnchor\s*:/);
    expect(lookRender).not.toMatch(/\bageAnchor\b/);
  });
});
