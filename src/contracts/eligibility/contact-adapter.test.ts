import { describe, expect, it } from "vitest";
import { affordanceSubjectId } from "../affordances/core";
import { DiagnosticCollector } from "../diagnostics";
import { emptyPersonaProfile, personaProfileSchema } from "../players/persona-profile";
import { characterProfileSchema, emptyCharacterProfile } from "../world/profile";
import { ADULT_ELIGIBILITY_CONFLICT_CODE } from "./resolve";
import { adultEligibilityParticipant, contactParticipantEligibility } from "./contact-adapter";

const mara = affordanceSubjectId("char_mara");
const player = affordanceSubjectId("persona_brian");

const participant = (id: typeof mara, adultEligibilityDeclaration: string, age?: string) => ({
  id,
  adultEligibilityDeclaration,
  ...(age === undefined ? {} : { age }),
});

describe("contactParticipantEligibility (the slice-3 seam)", () => {
  it("is eligible only when EVERY participant is", () => {
    const read = contactParticipantEligibility([participant(mara, "adult", "29"), participant(player, "adult")]);
    expect(read.status).toBe("eligible");
    expect(read.participantIds).toEqual([mara, player]);
  });

  it("sinks the whole set when ANY participant is ineligible", () => {
    const read = contactParticipantEligibility([participant(mara, "adult", "29"), participant(player, "minor")]);
    expect(read.status).toBe("ineligible");
  });

  it("is unresolved when a participant is undeclared — the fail-closed default", () => {
    const read = contactParticipantEligibility([participant(mara, "adult", "29"), { id: player }]);
    expect(read.status).toBe("unresolved");
  });

  it("is unresolved with no participants at all, and says so in evidence", () => {
    const read = contactParticipantEligibility([]);
    expect(read.status).toBe("unresolved");
    expect(read.participantIds).toEqual([]);
    expect(read.evidence).toEqual([{ kind: "adapter", ref: "adult_eligibility", detail: "no_participants" }]);
  });

  it("never answers not_required — that is the action kind's business, not the adapter's", () => {
    for (const declaration of ["adult", "minor", "unresolved", "nonsense"]) {
      expect(contactParticipantEligibility([participant(mara, declaration)]).status).not.toBe("not_required");
    }
  });

  it("records one adapter evidence entry per participant, carrying its verdict", () => {
    const read = contactParticipantEligibility([participant(mara, "adult", "29"), participant(player, "minor")]);
    expect(read.evidence).toEqual([
      { kind: "adapter", ref: "adult_eligibility:char_mara", detail: "eligible" },
      { kind: "adapter", ref: "adult_eligibility:persona_brian", detail: "ineligible" },
    ]);
  });

  it("threads the clause-6 diagnostic out of a corrupted stored row", () => {
    const sink = new DiagnosticCollector();
    const read = contactParticipantEligibility([participant(mara, "adult", "15")], sink, "characters.profile");
    expect(read.status).toBe("ineligible");
    expect(sink.items[0]?.code).toBe(ADULT_ELIGIBILITY_CONFLICT_CODE);
  });
});

describe("adultEligibilityParticipant (profiles → the seam)", () => {
  it("reads a character profile's declaration and age", () => {
    const profile = characterProfileSchema.parse({ adultEligibilityDeclaration: "adult", age: "29" });
    expect(adultEligibilityParticipant(mara, profile)).toEqual({
      id: mara,
      adultEligibilityDeclaration: "adult",
      age: "29",
    });
  });

  it("reads a persona profile, which carries no age at all", () => {
    const profile = personaProfileSchema.parse({ adultEligibilityDeclaration: "adult" });
    expect(adultEligibilityParticipant(player, profile)).toEqual({
      id: player,
      adultEligibilityDeclaration: "adult",
    });
  });

  it("leaves a fresh character and a fresh persona unresolved — today's behavior, unchanged", () => {
    const read = contactParticipantEligibility([
      adultEligibilityParticipant(mara, emptyCharacterProfile()),
      adultEligibilityParticipant(player, emptyPersonaProfile()),
    ]);
    expect(read.status).toBe("unresolved");
  });
});
