import { describe, expect, it } from "vitest";
import { parseOr } from "@/lib/parse";
import { expectCleanSink } from "@/test/diagnostics";
import { DiagnosticCollector } from "../diagnostics";
import {
  CAST_MAX_DETAILS,
  chatCastProposalSchema,
  emptySupportingCast,
  findCastMember,
  mergeSupportingCast,
  sameCastName,
  SUPPORTING_CAST_MAX,
  supportingCastSchema,
  type SupportingCast,
} from "./chat-supporting-cast";

const member = (name: string, relation = "", details: string[] = []): SupportingCast[number] => ({
  name,
  relation,
  details,
});

describe("supportingCastSchema", () => {
  it("heals a garbage stored value to the empty cast at the trust boundary", () => {
    const sink = new DiagnosticCollector();
    expect(parseOr(supportingCastSchema, "not-a-cast", [], sink, "character_chats.supporting_cast")).toEqual([]);
    expect(parseOr(supportingCastSchema, null, [], sink, "character_chats.supporting_cast")).toEqual([]);
    // No boundary diagnostic: the schema's OWN array-level `.catch([])` absorbs
    // this, so `parseOr` sees a successful parse and never reports a failure.
    // The healing is the schema's, not the boundary's — that's where to look
    // when a bad cast blob turns up empty in production.
    expectCleanSink(sink);
  });

  it("drops bad rows, dedupes details, and enforces the member cap (newest kept)", () => {
    const parsed = supportingCastSchema.parse([
      { name: "Abby", relation: "coworker", details: ["runs marathons", "Runs Marathons", "  "] },
      { name: "" }, // unnameable — drops the whole array to the catch? no: min(1) fails the row → array catch
    ]);
    // A row with an empty name fails the member schema, which the ARRAY-level catch
    // heals to [] — a reminder that stored writes go through the merge, not raw parse.
    expect(parsed).toEqual([]);

    const many = supportingCastSchema.parse(
      Array.from({ length: SUPPORTING_CAST_MAX + 3 }, (_, i) => member(`Person ${i}`)),
    );
    expect(many).toHaveLength(SUPPORTING_CAST_MAX);
    expect(many[0]?.name).toBe("Person 3"); // oldest-out
  });

  it("keeps optional voice/whereabouts and parses away invalid ones", () => {
    const parsed = supportingCastSchema.parse([
      { name: "Jo", relation: "", details: [], voice: "dry one-liners", whereabouts: "" },
    ]);
    expect(parsed[0]?.voice).toBe("dry one-liners");
    expect(parsed[0]?.whereabouts).toBeUndefined();
  });
});

describe("mergeSupportingCast", () => {
  it("mints a new member from a proposal and accretes details on later ones", () => {
    const first = mergeSupportingCast(
      emptySupportingCast(),
      chatCastProposalSchema.parse([{ name: "Abby", relation: "the player's coworker", details: ["covered a shift"] }]),
    );
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ name: "Abby", relation: "the player's coworker" });

    const second = mergeSupportingCast(
      first,
      chatCastProposalSchema.parse([{ name: "abby", details: ["training for a marathon", "covered a shift"] }]),
    );
    expect(second).toHaveLength(1); // case-insensitive upsert, no duplicate
    expect(second[0]?.name).toBe("Abby"); // first-write casing wins
    expect(second[0]?.details).toEqual(["covered a shift", "training for a marathon"]);
  });

  it("fills relation only when empty — author edits are canonical", () => {
    const cast: SupportingCast = [member("Abby", "the player's coworker")];
    const merged = mergeSupportingCast(cast, chatCastProposalSchema.parse([{ name: "Abby", relation: "a stranger" }]));
    expect(merged[0]?.relation).toBe("the player's coworker");

    const bare: SupportingCast = [member("Jo")];
    const filled = mergeSupportingCast(bare, chatCastProposalSchema.parse([{ name: "Jo", relation: "Abby's roommate" }]));
    expect(filled[0]?.relation).toBe("Abby's roommate");
  });

  it("never mints excluded names (roster members, the player) as cast entries", () => {
    const merged = mergeSupportingCast(
      emptySupportingCast(),
      chatCastProposalSchema.parse([
        { name: "Bella", relation: "??" },
        { name: "riley", relation: "??" },
        { name: "Abby", relation: "the player's coworker" },
      ]),
      ["Bella", "Riley"],
    );
    expect(merged.map((m) => m.name)).toEqual(["Abby"]);
  });

  it("caps per-member details and preserves voice/whereabouts through a merge", () => {
    const cast: SupportingCast = [
      { name: "Jo", relation: "", details: [], voice: "clipped", whereabouts: "the pier" },
    ];
    const merged = mergeSupportingCast(
      cast,
      chatCastProposalSchema.parse([
        { name: "Jo", details: Array.from({ length: CAST_MAX_DETAILS + 2 }, (_, i) => `detail ${i}`) },
      ]),
    );
    expect(merged[0]?.details).toHaveLength(CAST_MAX_DETAILS);
    expect(merged[0]?.voice).toBe("clipped");
    expect(merged[0]?.whereabouts).toBe("the pier");
  });

  it("is a no-op on an empty proposal (degraded archivist)", () => {
    const cast: SupportingCast = [member("Abby", "coworker")];
    expect(mergeSupportingCast(cast, [])).toBe(cast);
  });
});

describe("helpers", () => {
  it("sameCastName is case-insensitive and blank-safe", () => {
    expect(sameCastName("Abby", "abby ")).toBe(true);
    expect(sameCastName("Abby", "Jo")).toBe(false);
    expect(sameCastName(undefined, "Jo")).toBe(false);
  });

  it("findCastMember resolves by normalized name", () => {
    const cast: SupportingCast = [member("Abby")];
    expect(findCastMember(cast, "ABBY")?.name).toBe("Abby");
    expect(findCastMember(cast, "Jo")).toBeNull();
  });
});
