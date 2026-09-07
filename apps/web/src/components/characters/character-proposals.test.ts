import { describe, expect, it } from "vitest";
import { characterDraftSchema, emptyCharacterDraft } from "@/lib/client/api";
import { applyCharacterProposal, describeProposalValue, proposalChanges, proposalConflicts, reconcileMaterializedUndo, type CharacterProposal } from "./character-proposals";
import { isPristineCharacterDraft, withCreationBrief } from "./character-creation-draft";

const proposal = (base: CharacterProposal["base"], proposed: CharacterProposal["proposed"]): CharacterProposal => ({ id: "generation", label: "Profile rewrite", base, proposed, undo: false });

describe("character proposal review", () => {
  it("applies only proposed differences and preserves edits made during generation", () => {
    const base = characterDraftSchema.parse({ name: "Iris", profile: { bio: "Original", attributes: [{ id: "hair.color", value: "auburn", source: "manual" }] } });
    const incoming = characterDraftSchema.parse({ ...base, profile: { ...base.profile, bio: "Suggested", attributes: [...base.profile.attributes, { id: "eyes.color", value: "green", source: "creation" }] } });
    const current = characterDraftSchema.parse({ ...base, name: "Iris Vale", profile: { ...base.profile, attributes: [...base.profile.attributes, { id: "hair.length", value: "long", source: "manual" }] } });
    const original = structuredClone(current);
    const result = applyCharacterProposal(current, proposal(base, incoming));
    expect(result.unresolved).toEqual([]);
    expect(result.draft.name).toBe("Iris Vale");
    expect(result.draft.profile.bio).toBe("Suggested");
    expect(result.draft.profile.attributes.map((row) => row.id)).toEqual(["hair.color", "hair.length", "eyes.color"]);
    expect(current).toEqual(original);
  });

  it("requires explicit conflict resolution and can keep the author's changed value", () => {
    const base = characterDraftSchema.parse({ profile: { bio: "Original", voice: "Old voice" } });
    const generated = characterDraftSchema.parse({ profile: { bio: "Suggested", voice: "Warm" } });
    const current = { ...base, profile: { ...base.profile, bio: "My newer description" } };
    const pending = proposal(base, generated);
    const conflict = proposalConflicts(current, pending).find((row) => row.label === "bio");
    expect(conflict).toBeDefined();
    expect(applyCharacterProposal(current, pending).draft).toBe(current);
    const result = applyCharacterProposal(current, pending, { [conflict?.key ?? "missing"]: "current" });
    expect(result.draft.profile.bio).toBe("My newer description");
    expect(result.draft.profile.voice).toBe("Warm");
  });

  it("undo restores accepted differences while preserving later independent edits", () => {
    const base = characterDraftSchema.parse({ name: "Iris", profile: { bio: "Original" } });
    const incoming = { ...base, profile: { ...base.profile, bio: "Suggested" } };
    const accepted = applyCharacterProposal(base, proposal(base, incoming));
    expect(accepted.undo).not.toBeNull();
    if (!accepted.undo) return;
    const later = { ...accepted.draft, name: "Iris Vale" };
    const undone = applyCharacterProposal(later, accepted.undo);
    expect(undone.draft.name).toBe("Iris Vale");
    expect(undone.draft.profile.bio).toBe("Original");
    const conflicting = { ...later, profile: { ...later.profile, bio: "Edited after acceptance" } };
    expect(applyCharacterProposal(conflicting, accepted.undo).unresolved).toHaveLength(1);
  });

  it("can restore a deleted attribute after an explicit conflicting choice", () => {
    const base = characterDraftSchema.parse({ profile: { attributes: [{ id: "eyes.color", value: "brown", source: "manual" }] } });
    const incoming = characterDraftSchema.parse({ profile: { attributes: [{ id: "eyes.color", value: "green", source: "creation" }] } });
    const current = emptyCharacterDraft();
    const pending = proposal(base, incoming);
    const changes = proposalChanges(pending);
    const result = applyCharacterProposal(current, pending, Object.fromEntries(changes.map((change) => [change.key, "proposed" as const])));
    expect(result.draft.profile.attributes[0]?.value).toBe("green");
  });

  it("never replaces the creation brief or asks for provenance-only approvals", () => {
    const base = characterDraftSchema.parse({ profile: { creationBrief: "Original human concept", attributes: [{ id: "eyes.color", value: "brown", source: "manual" }] } });
    const incoming = characterDraftSchema.parse({ profile: { creationBrief: "Replacement concept", attributes: [{ id: "eyes.color", value: "brown", source: "creation" }] } });
    const pending = proposal(base, incoming);
    expect(proposalChanges(pending)).toEqual([]);
    expect(applyCharacterProposal(base, pending).draft).toEqual(base);
  });

  it("shows a note-only change while suppressing source metadata", () => {
    const base = characterDraftSchema.parse({ profile: { attributes: [{ id: "eyes.color", value: "brown", source: "manual", note: "Warm brown" }] } });
    const incoming = characterDraftSchema.parse({ profile: { attributes: [{ id: "eyes.color", value: "brown", source: "creation", note: "Gold flecks" }] } });
    const changes = proposalChanges(proposal(base, incoming));
    expect(changes).toHaveLength(1);
    expect(describeProposalValue(changes[0]?.before)).toBe("brown · Note: Warm brown");
    expect(describeProposalValue(changes[0]?.after)).toBe("brown · Note: Gold flecks");
  });

  it("includes materialized outfit item ids in undo without accepting pending proposals", () => {
    const base = emptyCharacterDraft();
    const incoming = characterDraftSchema.parse({ suggestedItems: [{ name: "Blue coat", kind: "clothing" }] });
    const accepted = applyCharacterProposal(base, proposal(base, incoming));
    const pending = proposal(base, { ...base, name: "Another suggestion" });
    const savedProfile = { ...incoming.profile, outfits: [{ id: "everyday", name: "Everyday", items: ["new-coat"] }] };
    const review = reconcileMaterializedUndo({ pending: [pending], undo: accepted.undo }, incoming, savedProfile);
    expect(review.pending).toEqual([pending]);
    expect(review.undo).not.toBeNull();
    if (!review.undo) return;
    const undone = applyCharacterProposal({ ...incoming, profile: savedProfile, suggestedItems: [] }, review.undo);
    expect(undone.unresolved).toEqual([]);
    expect(undone.draft.profile.outfits).toEqual([]);
  });
});

describe("original creation brief", () => {
  it("distinguishes the first blank Forge preview from existing author edits", () => {
    const blank = withCreationBrief(emptyCharacterDraft(), "A harbor master");
    expect(isPristineCharacterDraft(blank)).toBe(true);
    expect(isPristineCharacterDraft({ ...blank, name: "Iris" })).toBe(false);
    expect(isPristineCharacterDraft({ ...blank, profile: { ...blank.profile, bio: "Manual eyes and outfit facts" } })).toBe(false);
  });
  it("captures the manual concept before its bio can be rewritten", () => {
    const manual = characterDraftSchema.parse({ name: "Iris", profile: { bio: "Green eyes and a blue suit", attributes: [{ id: "hair.color", value: "auburn", source: "manual" }] } });
    const captured = withCreationBrief(manual);
    expect(captured.profile.creationBrief).toContain("Green eyes and a blue suit");
    expect(captured.profile.creationBrief).toContain("auburn");
    const revised = { ...captured, profile: { ...captured.profile, bio: "A harbor master" } };
    expect(withCreationBrief(revised, "A later prompt").profile.creationBrief).toBe(captured.profile.creationBrief);
  });

  it("retains the original Forge prompt verbatim across revisions", () => {
    const draft = withCreationBrief(emptyCharacterDraft(), "Human woman, auburn hair, green eyes, blue suit");
    expect(draft.profile.creationBrief).toBe("Human woman, auburn hair, green eyes, blue suit");
    expect(withCreationBrief(draft, "Another prompt")).toBe(draft);
    expect(characterDraftSchema.parse(draft).profile.creationBrief).toBe(draft.profile.creationBrief);
  });
});
