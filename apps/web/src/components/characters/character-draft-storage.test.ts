import { describe, expect, it } from "vitest";
import { z } from "zod";
import { characterDetailSchema } from "@/lib/client/api/library";
import { promoteDraftRecovery, readDraft, writeDraft, type DraftStorage } from "./character-draft-storage";
import { characterCreationStateSchema, creationSaveNavigationHref, emptyCharacterCreation, prepareCreationSave, recoverCreationMismatch, savedCreationHref } from "./character-creation-draft";

function memoryStorage(): DraftStorage {
  const rows = new Map<string, string>();
  return { getItem: (key) => rows.get(key) ?? null, setItem: (key, value) => { rows.set(key, value); }, removeItem: (key) => { rows.delete(key); } };
}

describe("character browser draft persistence", () => {
  it("freezes a create retry payload and lets ordinary Save replace an old destination", () => {
    const first = emptyCharacterCreation();
    first.draft.name = "Iris";
    const requested = prepareCreationSave(first, "chat");
    const retry = prepareCreationSave({ ...requested, draft: { ...requested.draft, name: "Newer edit" } }, null);
    expect(retry.id).toBe(first.id);
    expect(retry.initialSaveDraft?.name).toBe("Iris");
    expect(retry.draft.name).toBe("Newer edit");
    expect(retry.saveDestination).toBeNull();
  });

  it("does not keep a successful first save on the creation draft for an already-applied Forge receipt", () => {
    const state = emptyCharacterCreation();
    state.savedCharacterId = "saved-character";
    state.tab = "portrait";
    state.review.handledIds = ["completed-forge"];
    const saved = { characterId: "saved-character", requestId: state.id, savedSnapshotUnchanged: true, authoredMatchesSaved: true, revisionMatches: true };
    expect(creationSaveNavigationHref(state, [{ id: "completed-forge", status: "completed" }], saved)).toBe("/characters/saved-character?tab=portrait");
    state.tab = "profile";
    state.saveDestination = "portrait";
    expect(creationSaveNavigationHref(state, [], saved)).toBe("/characters/saved-character?tab=portrait");
    state.saveDestination = "chat";
    expect(creationSaveNavigationHref(state, [], saved)).toBe("/characters/saved-character?tab=chat");
    expect(creationSaveNavigationHref(state, [{ id: "unapplied-forge", status: "completed" }], saved)).toBeNull();
    expect(creationSaveNavigationHref(state, [{ id: "pending-forge", status: "pending" }], saved)).toBeNull();
    expect(creationSaveNavigationHref(state, [{ id: "failed-forge", status: "failed" }], saved)).toBeNull();
    expect(creationSaveNavigationHref(state, [], { ...saved, savedSnapshotUnchanged: false })).toBeNull();
    expect(creationSaveNavigationHref(state, [], { ...saved, authoredMatchesSaved: false })).toBeNull();
    expect(creationSaveNavigationHref(state, [], { ...saved, requestId: "new-draft" })).toBeNull();
    expect(creationSaveNavigationHref(state, [], { ...saved, revisionMatches: false })).toBeNull();
  });

  it("binds an idempotency mismatch without changing the retained authored draft", () => {
    const state = emptyCharacterCreation();
    state.draft.name = "Retained Iris";
    state.draft.profile.bio = "Local edit";
    state.initialSaveDraft = structuredClone(state.draft);
    const created = characterDetailSchema.parse({
      id: "saved-iris",
      name: "Original Iris",
      profile: { bio: "Original saved value" },
      updatedAt: "2026-09-07T18:00:00.000Z",
    });
    const current = characterDetailSchema.parse({
      id: "saved-iris",
      name: "Server Iris",
      profile: { bio: "Current saved value" },
      updatedAt: "2026-09-07T19:00:00.000Z",
    });
    const recovered = recoverCreationMismatch(state, created, current);
    expect(recovered.savedCharacterId).toBe("saved-iris");
    expect(recovered.draft.name).toBe("Retained Iris");
    expect(recovered.draft.profile.bio).toBe("Local edit");
    expect(recovered.serverSnapshot?.draft.name).toBe("Original Iris");
    expect(recovered.serverConflict?.snapshot.draft.name).toBe("Server Iris");
    expect(recovered.serverConflict?.reason).toBe("creation_mismatch");
    expect(recovered.serverUpdatedAt).toBe(current.updatedAt);
    expect(recovered.initialSaveDraft).toBeNull();
  });

  it("consumes the exact recovery copy only after shared promotion succeeds", () => {
    const storage = memoryStorage();
    storage.setItem("shared", "old");
    storage.setItem("copy", "selected");
    expect(promoteDraftRecovery(storage, "shared", "old", "copy", "selected")).toEqual({ status: "saved", consumed: true });
    expect(storage.getItem("shared")).toBe("selected");
    expect(storage.getItem("copy")).toBeNull();
  });

  it("retains recovery on a shared conflict and preserves a reused copy key", () => {
    const storage = memoryStorage();
    storage.setItem("shared", "newer");
    storage.setItem("copy", "selected");
    expect(promoteDraftRecovery(storage, "shared", "old", "copy", "selected")).toEqual({ status: "conflict", consumed: false });
    expect(storage.getItem("copy")).toBe("selected");
    storage.setItem("copy", "displaced local edits");
    expect(promoteDraftRecovery(storage, "shared", "newer", "copy", "selected")).toEqual({ status: "saved", consumed: false });
    expect(storage.getItem("copy")).toBe("displaced local edits");
  });

  it.each(["replace", "clear"] as const)("a stale %s never destroys a newer draft", (operation) => {
    const storage = memoryStorage();
    writeDraft(storage, "account-one", null, "first");
    writeDraft(storage, "account-one", "first", "newer");
    expect(writeDraft(storage, "account-one", "first", operation === "clear" ? null : "late-response")).toBe("conflict");
    expect(storage.getItem("account-one")).toBe("newer");
  });

  it("clears only the version saved and keeps other account keys", () => {
    const storage = memoryStorage();
    writeDraft(storage, "account-one", null, "first");
    writeDraft(storage, "account-two", null, "other");
    expect(writeDraft(storage, "account-one", "first", null)).toBe("saved");
    expect(storage.getItem("account-one")).toBeNull();
    expect(storage.getItem("account-two")).toBe("other");
  });

  it("degrades corrupt data and unavailable storage without removing the stored copy", () => {
    expect(readDraft("not json", z.string())).toBeNull();
    expect(readDraft('{"revision":"one","data":false}', z.string())).toBeNull();
    const unavailable = { getItem: () => { throw new Error("unavailable"); }, setItem: () => undefined, removeItem: () => undefined };
    expect(writeDraft(unavailable, "draft", null, "new")).toBe("unavailable");
  });

  it("round-trips original brief, destination, accepted author draft and pending review separately", () => {
    const state = emptyCharacterCreation();
    state.draft.profile.creationBrief = "A human woman in a blue suit";
    state.draft.name = "Iris";
    state.tab = "portrait";
    state.saveDestination = "chat";
    state.savedCharacterId = "saved-character";
    state.materializingDraft = structuredClone(state.draft);
    state.review.pending.push({ id: "pending", label: "Profile rewrite", base: structuredClone(state.draft), proposed: { ...state.draft, name: "Suggested Iris" }, undo: false });
    const raw = JSON.stringify({ revision: "one", data: state });
    const loaded = readDraft(raw, characterCreationStateSchema);
    expect(loaded?.data).toEqual(state);
    expect(loaded && savedCreationHref(loaded.data)).toBe("/characters/saved-character?tab=chat");
    expect(loaded?.data.draft.name).toBe("Iris");
    expect(loaded?.data.review.pending[0]?.proposed.name).toBe("Suggested Iris");
  });
});
