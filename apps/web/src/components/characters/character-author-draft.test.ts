import { describe, expect, it } from "vitest";
import { itemDefinitionSchema } from "@/contracts";
import { characterDraftSchema, emptyCharacterDraft } from "@/lib/client/api";
import { characterSaveSchema, characterSaveConflictSchema } from "@/lib/client/api/library";
import { authorModelConflict, authorRecoveryDisposition, authorRecoveryProposal, rebaseAuthorRecovery, reconcileCharacterSave, type CharacterAuthorSnapshot } from "./character-author-draft";
import { proposalConflicts } from "./character-proposals";

const snapshot = (bio: string, chatModel = "model-a"): CharacterAuthorSnapshot => ({ draft: characterDraftSchema.parse({ name: "Iris", profile: { bio, creationBrief: "Original human concept" } }), chatModel });

describe("saved author recovery", () => {
  it("keeps the saved row and conflict version across the client boundary", () => {
    const character = { id: "iris", name: "Iris", updatedAt: "2026-09-01T12:00:00.123Z", authoringRevision: 7, chatModel: "model-b", profile: { bio: "Saved" } };
    const saved = characterSaveSchema.parse({ character, diagnostics: [] }).character;
    const conflict = characterSaveConflictSchema.parse({ error: { code: "character_conflict", message: "Changed" }, character }).character;
    expect(saved).toEqual(conflict);
    expect(saved.updatedAt).toBe(character.updatedAt);
    expect(saved.authoringRevision).toBe(7);
    expect(saved.name).toBe(character.name);
    expect(saved.chatModel).toBe(character.chatModel);
  });

  it("resumes an unchanged authored baseline despite metadata version updates and recognizes an exact acknowledgment", () => {
    const base = snapshot("Before");
    const authored = snapshot("Browser edit", "model-b");
    const record = { base, authored, serverUpdatedAt: "version-1" };
    expect(authorRecoveryDisposition(base, "version-1", record)).toBe("resume");
    expect(authorRecoveryDisposition(base, "version-2", record)).toBe("resume");
    expect(authorRecoveryDisposition(snapshot("Server edit"), "version-1", record)).toBe("review");
    expect(authorRecoveryDisposition(authored, "version-2", record)).toBe("acknowledged");
  });

  it("rebases recovered edits while preserving independent server changes", () => {
    const base = snapshot("Before");
    const authored = snapshot("Browser edit", "model-b");
    const server = { ...base, draft: { ...base.draft, name: "Iris Vale" } };
    expect(rebaseAuthorRecovery(server, { base, authored, serverUpdatedAt: "v1" })).toEqual({ ...authored, draft: { ...authored.draft, name: "Iris Vale" } });
  });

  it("requires choices for changed server prose and narrator before restoring", () => {
    const record = { base: snapshot("Before"), authored: snapshot("Browser edit", "model-b"), serverUpdatedAt: "v1" };
    const server = snapshot("Server edit", "model-c");
    expect(authorModelConflict(server, record)).toBe(true);
    expect(rebaseAuthorRecovery(server, record)).toBeNull();
    const changes = proposalConflicts(server.draft, authorRecoveryProposal(record));
    const choices = Object.fromEntries(changes.map((change) => [change.key, "current" as const]));
    expect(rebaseAuthorRecovery(server, record, choices)).toBeNull();
    expect(rebaseAuthorRecovery(server, record, choices, "proposed")).toEqual({ ...server, chatModel: "model-b" });
  });
});

describe("materialized character save acknowledgment", () => {
  const coat = itemDefinitionSchema.parse({ name: "Blue coat", kind: "clothing" });
  const scarf = itemDefinitionSchema.parse({ name: "New scarf", kind: "clothing" });
  const sent = characterDraftSchema.parse({ name: "Iris", profile: { creationBrief: "Original brief", bio: "Before", outfits: [{ id: "daily", name: "Daily", items: ["boots"] }] }, suggestedItems: [coat] });
  const saved = characterDraftSchema.parse({ ...sent, profile: { ...sent.profile, outfits: [{ id: "daily", name: "Daily", items: ["boots", "coat-id"] }] }, suggestedItems: [] });

  it("merges actual ids, preserves newer edits, and removes only suggestions sent", () => {
    const latest = characterDraftSchema.parse({ ...sent, name: "Iris Vale", profile: { ...sent.profile, bio: "New biography", outfits: [{ id: "daily", name: "Harbor", items: ["boots", "belt"] }] }, suggestedItems: [coat, scarf] });
    const result = reconcileCharacterSave(latest, sent, saved);
    expect(result.name).toBe("Iris Vale");
    expect(result.profile.bio).toBe("New biography");
    expect(result.profile.outfits).toEqual([{ id: "daily", name: "Harbor", items: ["boots", "belt", "coat-id"] }]);
    expect(result.suggestedItems).toEqual([scarf]);
    const secondSave = { ...result, suggestedItems: [] };
    expect(reconcileCharacterSave(result, result, secondSave)).toEqual(secondSave);
    expect(reconcileCharacterSave(saved, sent, saved)).toEqual(saved);
  });

  it("does not restore discarded in-flight suggestions while retaining other acknowledgments", () => {
    const sentBoth = { ...sent, suggestedItems: [coat, scarf] };
    const returned = { ...saved, profile: { ...saved.profile, outfits: [{ id: "daily", name: "Daily", items: ["boots", "coat-id", "scarf-id"] }] } };
    const latest = { ...sentBoth, suggestedItems: [scarf] };
    const result = reconcileCharacterSave(latest, sentBoth, returned, [{ index: 0, itemId: "coat-id" }, { index: 1, itemId: "scarf-id" }]);
    expect(result.profile.outfits[0]?.items).toEqual(["boots", "scarf-id"]);
    expect(result.suggestedItems).toEqual([]);
  });

  it("keeps changed suggestions and does not resurrect an explicitly deleted preset", () => {
    const edited = { ...coat, description: "Newly tailored" };
    const latest = { ...sent, profile: { ...sent.profile, outfits: [] }, suggestedItems: [edited] };
    const result = reconcileCharacterSave(latest, sent, saved);
    expect(result.suggestedItems).toEqual([edited]);
    expect(result.profile.outfits).toEqual([]);
  });

  it("adds the materialized first outfit and captured brief to a creation draft", () => {
    const initial = { ...emptyCharacterDraft(), suggestedItems: [coat] };
    const request = { ...initial, profile: { ...initial.profile, creationBrief: "Original brief" } };
    const created = characterDraftSchema.parse({ ...request, profile: { ...request.profile, outfits: [{ id: "daily", name: "Daily", items: ["coat-id"] }] }, suggestedItems: [] });
    const latest = { ...initial, name: "New name", suggestedItems: [coat, scarf] };
    const result = reconcileCharacterSave(latest, request, created);
    expect(result.profile.outfits).toEqual(created.profile.outfits);
    expect(result.profile.creationBrief).toBe("Original brief");
    expect(result.name).toBe("New name");
    expect(result.suggestedItems).toEqual([scarf]);
  });
});
