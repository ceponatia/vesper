import { describe, expect, it } from "vitest";
import { z } from "zod";
import { readDraft, writeDraft, type DraftStorage } from "./character-draft-storage";
import { characterCreationStateSchema, emptyCharacterCreation } from "./character-creation-draft";

function memoryStorage(): DraftStorage {
  const rows = new Map<string, string>();
  return { getItem: (key) => rows.get(key) ?? null, setItem: (key, value) => { rows.set(key, value); }, removeItem: (key) => { rows.delete(key); } };
}

describe("character browser draft persistence", () => {
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
    state.review.pending.push({ id: "pending", label: "Profile rewrite", base: structuredClone(state.draft), proposed: { ...state.draft, name: "Suggested Iris" }, undo: false });
    const raw = JSON.stringify({ revision: "one", data: state });
    const loaded = readDraft(raw, characterCreationStateSchema);
    expect(loaded?.data).toEqual(state);
    expect(loaded?.data.draft.name).toBe("Iris");
    expect(loaded?.data.review.pending[0]?.proposed.name).toBe("Suggested Iris");
  });
});
