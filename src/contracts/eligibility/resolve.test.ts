import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DiagnosticCollector } from "../diagnostics";
import { isMinorAge, lifeStageForAge } from "../world/life-stage";
import { adultEligibilityDeclarationSchema, DEFAULT_ADULT_ELIGIBILITY_DECLARATION } from "./declaration";
import {
  ADULT_ELIGIBILITY_CONFLICT_CODE,
  adultEligibilityConflict,
  isNumericMinorAge,
  minorFenceApplies,
  readAdultEligibilityDeclaration,
  resolveAdultEligibility,
} from "./resolve";

describe("adultEligibilityDeclarationSchema (the shared vocabulary)", () => {
  it("defaults and self-heals to unresolved — the no-migration story", () => {
    expect(adultEligibilityDeclarationSchema.parse(undefined)).toBe("unresolved");
    expect(adultEligibilityDeclarationSchema.parse("ADULT")).toBe("unresolved");
    expect(adultEligibilityDeclarationSchema.parse(18)).toBe("unresolved");
    expect(adultEligibilityDeclarationSchema.parse(null)).toBe("unresolved");
    expect(DEFAULT_ADULT_ELIGIBILITY_DECLARATION).toBe("unresolved");
  });

  it("keeps the three authored values verbatim", () => {
    expect(readAdultEligibilityDeclaration("adult")).toBe("adult");
    expect(readAdultEligibilityDeclaration("minor")).toBe("minor");
    expect(readAdultEligibilityDeclaration("unresolved")).toBe("unresolved");
  });
});

describe("resolveAdultEligibility — the law, clause by clause", () => {
  it("clause 1: declared adult with no numeric-minor conflict is eligible", () => {
    expect(resolveAdultEligibility({ adultEligibilityDeclaration: "adult", age: "29" })).toBe("eligible");
    expect(resolveAdultEligibility({ adultEligibilityDeclaration: "adult", age: "" })).toBe("eligible");
    expect(resolveAdultEligibility({ adultEligibilityDeclaration: "adult", age: "ancient" })).toBe("eligible");
    expect(resolveAdultEligibility({ adultEligibilityDeclaration: "adult", age: "312" })).toBe("eligible");
    // The persona case: no age field at all.
    expect(resolveAdultEligibility({ adultEligibilityDeclaration: "adult" })).toBe("eligible");
  });

  it("clause 2: declared minor, or a numeric age below 18, is ineligible", () => {
    expect(resolveAdultEligibility({ adultEligibilityDeclaration: "minor", age: "29" })).toBe("ineligible");
    expect(resolveAdultEligibility({ adultEligibilityDeclaration: "minor" })).toBe("ineligible");
    expect(resolveAdultEligibility({ adultEligibilityDeclaration: "unresolved", age: "15" })).toBe("ineligible");
    expect(resolveAdultEligibility({ age: "8" })).toBe("ineligible");
    expect(resolveAdultEligibility({ age: "17" })).toBe("ineligible");
  });

  it("clause 3: missing, malformed, or declared unresolved is unresolved", () => {
    expect(resolveAdultEligibility({})).toBe("unresolved");
    expect(resolveAdultEligibility({ adultEligibilityDeclaration: undefined, age: "" })).toBe("unresolved");
    expect(resolveAdultEligibility({ adultEligibilityDeclaration: "Adult" })).toBe("unresolved");
    expect(resolveAdultEligibility({ adultEligibilityDeclaration: { value: "adult" } })).toBe("unresolved");
    expect(resolveAdultEligibility({ adultEligibilityDeclaration: "unresolved", age: "ancient" })).toBe("unresolved");
  });

  it("clause 4: a parseable ADULT age without the declaration stays unresolved", () => {
    // The fence this feature exists to replace would have called all of these adult.
    for (const age of ["18", "29", "64", "312", "ancient", "seventeen", ""]) {
      expect(resolveAdultEligibility({ age })).toBe("unresolved");
    }
    expect(isMinorAge("29")).toBe(false); // the old negative fence agrees — and proves nothing
  });

  it("clause 5: apparent age is not an input — a child-reading portrait cannot demote a declared adult", () => {
    // The resolver's signature has no attribute channel, so the only way to express
    // "she reads fifteen" is to not pass it. The declaration alone decides.
    expect(resolveAdultEligibility({ adultEligibilityDeclaration: "adult", age: "29" })).toBe("eligible");
    expect(lifeStageForAge("29")?.minor).toBe(false);
  });

  it("clause 6: a stored contradiction fails closed with a diagnostic", () => {
    const sink = new DiagnosticCollector();
    expect(resolveAdultEligibility({ adultEligibilityDeclaration: "adult", age: "15" }, sink, "characters.profile")).toBe("ineligible");
    expect(sink.items).toHaveLength(1);
    expect(sink.items[0]?.code).toBe(ADULT_ELIGIBILITY_CONFLICT_CODE);
    expect(sink.items[0]?.severity).toBe("error");
    expect(sink.items[0]?.path).toBe("characters.profile");
  });

  it("clause 6: authoring rejects the same pair up front, and only that direction", () => {
    expect(adultEligibilityConflict({ adultEligibilityDeclaration: "adult", age: "15" })).toBe("declared_adult_numeric_minor");
    expect(adultEligibilityConflict({ adultEligibilityDeclaration: "adult", age: "29" })).toBeNull();
    expect(adultEligibilityConflict({ adultEligibilityDeclaration: "adult", age: "ancient" })).toBeNull();
    // Declaring `minor` is the stricter statement; a number never overrules it.
    expect(adultEligibilityConflict({ adultEligibilityDeclaration: "minor", age: "40" })).toBeNull();
    expect(adultEligibilityConflict({ adultEligibilityDeclaration: "unresolved", age: "15" })).toBeNull();
  });
});

describe("isNumericMinorAge (reconciled toward the stricter answer)", () => {
  it("agrees with isMinorAge everywhere isMinorAge says minor", () => {
    for (const age of ["0", "8", "12", "13", "17", "017"]) {
      expect(isMinorAge(age)).toBe(true);
      expect(isNumericMinorAge(age)).toBe(true);
    }
  });

  it("catches the numeric-minor shapes isMinorAge declines to parse", () => {
    // `lifeStageForAge` only matches whitelisted in-range numerals, so these read adult there.
    expect(isMinorAge("17.5")).toBe(false);
    expect(isNumericMinorAge("17.5")).toBe(true);
    expect(isMinorAge("-5")).toBe(false);
    expect(isNumericMinorAge("-5")).toBe(true);
    expect(isNumericMinorAge("17.5 years old")).toBe(true);
  });

  it("recognizes the tightly whitelisted 'years' spellings (owner instruction 2026-07-30)", () => {
    expect(isNumericMinorAge("17 years")).toBe(true);
    expect(isNumericMinorAge("17 years old")).toBe(true);
    expect(isNumericMinorAge("17 Year Old")).toBe(true);
    expect(isNumericMinorAge("18 years")).toBe(false);
    expect(isNumericMinorAge("18 years old")).toBe(false);
  });

  it("never widens: non-numeric and fantasy-scaled ages stay un-minored", () => {
    for (const age of ["", "ancient", "seventeen", "312 years", "312", "500", "18", "18.0", "17 winters", "nearly 17 years"]) {
      expect(isNumericMinorAge(age)).toBe(false);
    }
  });
});

describe("minorFenceApplies (declaration-armed minor-safe prompting)", () => {
  it("arms on an explicit minor declaration, whatever the age field holds", () => {
    expect(minorFenceApplies({ adultEligibilityDeclaration: "minor", age: "29" })).toBe(true);
    expect(minorFenceApplies({ adultEligibilityDeclaration: "minor", age: "" })).toBe(true);
    expect(minorFenceApplies({ adultEligibilityDeclaration: "minor" })).toBe(true);
  });

  it("keeps the existing numeric fence, whitelisted spellings included", () => {
    expect(minorFenceApplies({ age: "15" })).toBe(true);
    expect(minorFenceApplies({ age: "17 years old" })).toBe(true);
    expect(minorFenceApplies({ adultEligibilityDeclaration: "adult", age: "15" })).toBe(true);
  });

  it("stays byte-identical territory for adult and unresolved declarations", () => {
    expect(minorFenceApplies({ adultEligibilityDeclaration: "adult", age: "29" })).toBe(false);
    expect(minorFenceApplies({ adultEligibilityDeclaration: "unresolved", age: "ancient" })).toBe(false);
    expect(minorFenceApplies({})).toBe(false);
  });
});

describe("the resolver is structurally starved of attribute input (clause 5)", () => {
  const sources = ["declaration.ts", "resolve.ts", "contact-adapter.ts", "blocker.ts"].map((name) => ({
    name,
    code: fs
      .readFileSync(path.join(process.cwd(), "src/contracts/eligibility", name), "utf8")
      // Prose may name what the module refuses to read; executable code may not.
      .replace(/\/\*[\s\S]*?\*\//gu, " ")
      .replace(/\/\/.*$/gmu, " "),
  }));

  it("names no attribute or portrait vocabulary in executable code", () => {
    const offences = sources.flatMap(({ name, code }) =>
      [/attribute/iu, /apparent/iu, /portrait/iu, /appearance/iu].filter((p) => p.test(code)).map((p) => `${name}: ${p.source}`),
    );
    expect(offences).toEqual([]);
  });

  it("imports nothing from the attribute registry, the server, or a lane", () => {
    const offences = sources.flatMap(({ name, code }) =>
      [/from\s+["'][^"']*attributes/u, /from\s+["']@\/server/u, /from\s+["']@\/app/u, /from\s+["']@\/components/u]
        .filter((p) => p.test(code))
        .map((p) => `${name}: ${p.source}`),
    );
    expect(offences).toEqual([]);
  });
});
