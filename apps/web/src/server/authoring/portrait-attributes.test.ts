import { describe, expect, it } from "vitest";
import { DiagnosticCollector, attributeRegistry, visualExtractionImageRegionSchema } from "@/contracts";
import { portraitFieldEvidenceSchema, type PortraitFieldEvidence } from "@/lib/portrait-extraction";
import { attr, draftWith } from "@/server/test-support";
import { emptyCharacterDraft } from "./drafts";
import {
  derivePortraitAttributes,
  mergePortraitReadings,
  portraitAttributeDefinitions,
  portraitAuthoringFingerprint,
  portraitObservationCanPropose,
} from "./portrait-attributes";

const hash = "a".repeat(64);
const region = visualExtractionImageRegionSchema.parse({ left: 1_000, top: 1_000, width: 4_000, height: 4_000 });
function field(overrides: Partial<PortraitFieldEvidence> = {}): PortraitFieldEvidence {
  return portraitFieldEvidenceSchema.parse({
    id: "eyes.color",
    value: "green",
    confidence: 9_000,
    visibility: "clear",
    evidence: "Both irises are visible in even light.",
    evidenceRegion: region,
    defaultSelected: true,
    ...overrides,
  });
}

describe("portrait evidence classification", () => {
  it("excludes non-pixel identity fields and requires direct teeth visibility", () => {
    const definitions = portraitAttributeDefinitions(emptyCharacterDraft());
    expect(definitions.map((definition) => definition.id)).not.toContain("identity.heritage");
    expect(definitions.map((definition) => definition.id)).not.toContain("identity.gender");
    expect(definitions.map((definition) => definition.id)).not.toContain("identity.natal_sex");
    const teeth = attributeRegistry.byId("teeth.shape");
    expect(portraitObservationCanPropose(teeth, "occluded", region)).toBe(false);
    expect(portraitObservationCanPropose(teeth, "clear", null)).toBe(false);
    expect(portraitObservationCanPropose(teeth, "clear", region)).toBe(true);
  });

  it("distinguishes evidence-bearing proposals, supported matches, and failed reads", () => {
    const draft = draftWith((value) => { value.profile.attributes = [attr("hair.color", "black", "manual")]; });
    const proposal = mergePortraitReadings(draft, [field()], new DiagnosticCollector());
    expect(proposal.outcome).toBe("proposals");
    expect(proposal.filled).toEqual([attr("eyes.color", "green")]);

    const match = mergePortraitReadings(draft, [field({ id: "hair.color", value: "black" })]);
    expect(match.outcome).toBe("supported_match");

    const unsupported = mergePortraitReadings(draft, [field({ id: "hair.color", value: "black", visibility: "uncertain", confidence: 3_000, defaultSelected: false })]);
    expect(unsupported.outcome).toBe("read_failed");
  });

  it("fingerprints appearance inputs without staling on biography edits", () => {
    const draft = emptyCharacterDraft();
    const changedBio = { ...draft, profile: { ...draft.profile, bio: "Unrelated biography edit" } };
    const changedEyes = { ...draft, profile: { ...draft.profile, attributes: [attr("eyes.color", "blue")] } };
    expect(portraitAuthoringFingerprint(changedBio)).toBe(portraitAuthoringFingerprint(draft));
    expect(portraitAuthoringFingerprint(changedEyes)).not.toBe(portraitAuthoringFingerprint(draft));
  });

  it("distinguishes inherited species features from an explicit empty override", () => {
    const inherited = emptyCharacterDraft();
    inherited.profile.speciesId = "succubus";
    const withoutFeatures = structuredClone(inherited);
    withoutFeatures.profile.bodyFeatures = [];

    expect(portraitAuthoringFingerprint(withoutFeatures)).not.toBe(portraitAuthoringFingerprint(inherited));
  });
});

describe("derivePortraitAttributes (keyless demo mode)", () => {
  it("returns a typed retryable read failure instead of a no-change result", async () => {
    const sink = new DiagnosticCollector();
    const draft = draftWith((value) => { value.profile.attributes = [attr("hair.color", "black", "manual")]; });
    const result = await derivePortraitAttributes({
      draft,
      image: { data: new Uint8Array([1, 2, 3]), mediaType: "image/webp" },
      source: { imageId: "portrait", contentHash: hash, authoringRevision: 4, authoringFingerprint: hash },
      sink,
    });
    expect(result.evidence.outcome).toBe("read_failed");
    expect(result.evidence.readFailure).toBe("provider_or_parse");
    expect(result.draft).toEqual(draft);
    expect(sink.items.some((item) => item.code === "forge.character.portrait.degraded")).toBe(true);
  });
});
