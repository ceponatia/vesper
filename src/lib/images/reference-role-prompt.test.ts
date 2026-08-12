import { describe, expect, it } from "vitest";
import { compileReferenceRolePrompt } from "./reference-role-prompt";

const BASE = "Seated on the balcony rail at dusk, wind in the hair.";

/** The closing clause's tell — asserted by fragment so a copy edit inside the
 * sentence still fails loudly here, where the change is a comparison-identity
 * change, not silently. */
const CONTROL_CLAUSE_FRAGMENT = "never render the control images themselves";

/** The cast clause's tell, asserted the same way and for the same reason. */
const CAST_CLAUSE_FRAGMENT = "never merge, swap, or duplicate them";

describe("compileReferenceRolePrompt", () => {
  it("names a wardrobe reference as clothing to copy onto the subject", () => {
    const compiled = compileReferenceRolePrompt({
      basePrompt: BASE,
      references: [{ role: "identity" }, { role: "outfit" }],
    });
    expect(compiled.startsWith("Image 1: the identity reference")).toBe(true);
    expect(compiled).toContain("Image 2: the wardrobe reference — dress the subject in exactly this clothing.");
    expect(compiled).toContain("take nothing else from it");
    expect(compiled.endsWith(BASE)).toBe(true);
  });

  it("treats an outfit as content, not a control: no closing control clause", () => {
    // The clause exists for structural maps a model might render instead of
    // obey. A wardrobe reference is drawn FROM, so emitting the clause for it
    // would tell the model its outfit image "defines layout only" — a lie that
    // costs the garment.
    const compiled = compileReferenceRolePrompt({
      basePrompt: BASE,
      references: [{ role: "identity" }, { role: "outfit" }],
    });
    expect(compiled).not.toContain(CONTROL_CLAUSE_FRAGMENT);
  });

  it("keeps the closing clause when a structural control rides beside the outfit", () => {
    const compiled = compileReferenceRolePrompt({
      basePrompt: BASE,
      references: [{ role: "identity" }, { role: "pose" }, { role: "outfit" }],
    });
    expect(compiled).toContain("Image 2: a pose skeleton.");
    expect(compiled).toContain("Image 3: the wardrobe reference");
    expect(compiled).toContain(CONTROL_CLAUSE_FRAGMENT);
  });
});

/**
 * The subject field must not have moved a single byte of what this compiler
 * produced before it existed.
 *
 * The compiled text is hashed into comparison identity (`positivePromptHash`), so
 * a stray space or a reworded clause on the subject-LESS path is not a copy edit
 * — it re-fingerprints every controlled experiment already in the archive and
 * makes two arms of a finished comparison look like different configurations. The
 * expected strings below are transcribed from the pre-change compiler rather than
 * derived from it, which is the only way this test can fail when the wording
 * drifts.
 */
describe("compileReferenceRolePrompt — byte identity for subject-less references", () => {
  const IDENTITY_LINE =
    "Image 1: the identity reference — the person this render depicts. Preserve their face, hair, build, and apparent age.";
  const POSE_LINE =
    "Image 2: a pose skeleton. Place the subject in exactly this body position, limb by limb. Do not draw the skeleton.";
  const CONTROL_CLAUSE =
    "The structural reference images above define layout only. Reproduce the structure they describe using the " +
    "subject and setting from the other references; never render the control images themselves.";

  it("compiles a lone identity reference exactly as it always did", () => {
    expect(compileReferenceRolePrompt({ basePrompt: BASE, references: [{ role: "identity" }] })).toBe(
      `${IDENTITY_LINE}\n\n${BASE}`,
    );
  });

  it("compiles the controlled recipe's own send exactly as it always did", () => {
    expect(
      compileReferenceRolePrompt({ basePrompt: BASE, references: [{ role: "identity" }, { role: "pose" }] }),
    ).toBe(`${IDENTITY_LINE}\n${POSE_LINE}\n${CONTROL_CLAUSE}\n\n${BASE}`);
  });

  it("still returns the base prompt untouched when there is nothing to bind", () => {
    expect(compileReferenceRolePrompt({ basePrompt: BASE, references: [] })).toBe(BASE);
  });

  it("emits no cast clause for references that name nobody", () => {
    // The finishing recipe's policy already allows a second identity slot for the
    // pack's face crop, and those are two images of ONE person. Counting
    // references rather than subjects would tell a solo portrait it depicts two
    // people and instruct the model to render them both.
    const compiled = compileReferenceRolePrompt({
      basePrompt: BASE,
      references: [{ role: "before" }, { role: "identity" }, { role: "identity" }],
    });
    expect(compiled).not.toContain(CAST_CLAUSE_FRAGMENT);
    expect(compiled).not.toContain("exactly 2 people");
  });
});

/**
 * The Stage 6 wording: two identity references, each bound to the person it
 * depicts, plus the clause that says how many people there are.
 */
describe("compileReferenceRolePrompt — named subjects", () => {
  const cast = [
    { role: "identity" as const, subject: "Sabrina" },
    { role: "identity" as const, subject: "Lysandra" },
  ];

  it("binds each identity reference to its own named subject", () => {
    const compiled = compileReferenceRolePrompt({ basePrompt: BASE, references: cast });
    expect(compiled).toContain(
      "Image 1: the identity reference for Sabrina — one of the people this render depicts. " +
        "Preserve Sabrina's face, hair, build, and apparent age exactly as shown in this image.",
    );
    expect(compiled).toContain(
      "Image 2: the identity reference for Lysandra — one of the people this render depicts. " +
        "Preserve Lysandra's face, hair, build, and apparent age exactly as shown in this image.",
    );
    // The named line REPLACES the unnamed one rather than joining it: two
    // sentences describing the same slot would leave the model to pick.
    expect(compiled).not.toContain("the person this render depicts");
    expect(compiled.endsWith(BASE)).toBe(true);
  });

  it("states the cast size and names both people", () => {
    const compiled = compileReferenceRolePrompt({ basePrompt: BASE, references: cast });
    expect(compiled).toContain(
      "This render depicts exactly 2 people: Sabrina and Lysandra. Render each person exactly once, " +
        "matched to their own identity reference; never merge, swap, or duplicate them.",
    );
  });

  it("names one subject without claiming a crowd", () => {
    // One named identity is an ordinary single-character render that happens to
    // know whose face it is. A cast clause there would announce a second person
    // the send does not contain.
    const compiled = compileReferenceRolePrompt({
      basePrompt: BASE,
      references: [{ role: "identity", subject: "Sabrina" }],
    });
    expect(compiled).toContain("Image 1: the identity reference for Sabrina");
    expect(compiled).not.toContain(CAST_CLAUSE_FRAGMENT);
  });

  it("counts PEOPLE, not references, when one subject arrives twice", () => {
    const compiled = compileReferenceRolePrompt({
      basePrompt: BASE,
      references: [
        { role: "identity", subject: "Sabrina" },
        { role: "identity", subject: "Sabrina" },
      ],
    });
    expect(compiled).not.toContain(CAST_CLAUSE_FRAGMENT);
  });

  it("puts the cast clause before the control clause", () => {
    // The cast clause belongs beside the identity lines it summarizes; the
    // control clause is a prohibition and reads last, where a model is least
    // likely to weigh it against the descriptive lines above.
    const compiled = compileReferenceRolePrompt({
      basePrompt: BASE,
      references: [...cast, { role: "pose" }],
    });
    expect(compiled).toContain("Image 3: a pose skeleton.");
    expect(compiled).toContain(CAST_CLAUSE_FRAGMENT);
    expect(compiled).toContain(CONTROL_CLAUSE_FRAGMENT);
    expect(compiled.indexOf(CAST_CLAUSE_FRAGMENT)).toBeLessThan(compiled.indexOf(CONTROL_CLAUSE_FRAGMENT));
    // Both clauses sit above the admin's own prompt, which stays last.
    expect(compiled.indexOf(CONTROL_CLAUSE_FRAGMENT)).toBeLessThan(compiled.indexOf(BASE));
  });

  it("names the cast in SEND order, so the clause matches the numbered lines", () => {
    const compiled = compileReferenceRolePrompt({
      basePrompt: BASE,
      references: [
        { role: "identity", subject: "Lysandra" },
        { role: "identity", subject: "Sabrina" },
      ],
    });
    expect(compiled).toContain("Image 1: the identity reference for Lysandra");
    expect(compiled).toContain("exactly 2 people: Lysandra and Sabrina");
  });

  it("uses an Oxford comma from three subjects up", () => {
    // Headroom rather than a live case: the recipe caps identity at two on
    // today's model. The joiner is shared, so it is asserted where it lives.
    const compiled = compileReferenceRolePrompt({
      basePrompt: BASE,
      references: [
        { role: "identity", subject: "Sabrina" },
        { role: "identity", subject: "Lysandra" },
        { role: "identity", subject: "Wren" },
      ],
    });
    expect(compiled).toContain("exactly 3 people: Sabrina, Lysandra, and Wren");
  });

  it("ignores a subject on a role that does not depict a person", () => {
    // Identity is the only role a render sends twice, so it is the only role
    // whose slots need telling apart by name. A named location would assert a
    // distinction the payload does not make.
    const compiled = compileReferenceRolePrompt({
      basePrompt: BASE,
      references: [{ role: "identity" }, { role: "location", subject: "Sabrina" }],
    });
    expect(compiled).toContain("Image 2: the location reference — the place this render is set.");
    expect(compiled).not.toContain("location reference for Sabrina");
    expect(compiled).not.toContain(CAST_CLAUSE_FRAGMENT);
  });
});
