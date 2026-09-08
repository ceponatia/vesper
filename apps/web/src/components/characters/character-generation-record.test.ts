import { describe, expect, it } from "vitest";
import { emptyCharacterDraft } from "@/lib/client/api";
import { emptyCharacterReview } from "./character-proposals";
import { consumeGeneration, createGenerationStorage, finishGeneration, generationKey, matchesGeneration, readGeneration, receiveGenerationReview, type CharacterGeneration } from "./character-generation-record";
import type { DraftStorage } from "./character-draft-storage";

function fixture() {
  const rows = new Map<string, string>();
  const storage: DraftStorage = { getItem: (key) => rows.get(key) ?? null, setItem: (key, raw) => { rows.set(key, raw); }, removeItem: (key) => { rows.delete(key); } };
  const record: CharacterGeneration = { id: "request", ownerId: "owner", target: { kind: "character", id: "iris" }, operation: "fill", scope: "profile", label: "missing Profile details", base: emptyCharacterDraft(), creationStart: null, source: null, status: "pending", result: null, error: null };
  storage.setItem(generationKey(record), JSON.stringify(record));
  return { storage, record };
}

describe("character generation request recovery", () => {
  it("retains a response without a mounted editor and applies it only once on return", () => {
    const { storage, record } = fixture();
    const result = { proposed: { ...record.base, name: "Iris" }, diagnostics: [] };
    expect(finishGeneration(storage, record, { result })).toBe(true);
    const completed = readGeneration(storage.getItem(generationKey(record)))!;
    const received = receiveGenerationReview(emptyCharacterReview(), completed);
    expect(received.pending).toHaveLength(1);
    expect(receiveGenerationReview(received, completed)).toBe(received);
    const rejected = { pending: [], undo: null, handledIds: [record.id] };
    expect(receiveGenerationReview(rejected, completed)).toBe(rejected);
    expect(consumeGeneration(storage, completed, false)).toBe(false);
    expect(readGeneration(storage.getItem(generationKey(record)))?.status).toBe("completed");
    expect(consumeGeneration(storage, completed, true)).toBe(true);
    expect(storage.getItem(generationKey(record))).toBeNull();
  });

  it("keeps owner, character, mode and scope attached to every late response", () => {
    const { storage, record } = fixture();
    expect(matchesGeneration(record, "other-owner", record.target)).toBe(false);
    expect(matchesGeneration(record, record.ownerId, { kind: "character", id: "other" })).toBe(false);
    const modified = { ...record, operation: "redraft" as const, scope: "attributes" as const };
    storage.setItem(generationKey(record), JSON.stringify(modified));
    expect(finishGeneration(storage, record, { result: { proposed: record.base, diagnostics: [] } })).toBe(false);
    expect(readGeneration(storage.getItem(generationKey(record)))).toEqual(modified);
  });

  it("keeps portrait completion bound to the displayed image and saved revision", () => {
    const { storage, record } = fixture();
    const portrait = {
      ...record,
      operation: "portrait" as const,
      scope: null,
      source: { authoringRevision: 7, imageId: "portrait-a" },
    };
    storage.setItem(generationKey(record), JSON.stringify({ ...portrait, source: { authoringRevision: 8, imageId: "portrait-b" } }));
    expect(finishGeneration(storage, portrait, { result: { proposed: portrait.base, diagnostics: [] } })).toBe(false);
    expect(readGeneration(storage.getItem(generationKey(record)))?.source).toEqual({ authoringRevision: 8, imageId: "portrait-b" });
  });

  it("does not recreate a dismissed request or erase a newer stored result", () => {
    const { storage, record } = fixture();
    storage.removeItem(generationKey(record));
    expect(finishGeneration(storage, record, { result: { proposed: record.base, diagnostics: [] } })).toBe(false);
    const completed = { ...record, status: "completed" as const, result: { proposed: record.base, diagnostics: [] } };
    storage.setItem(generationKey(record), JSON.stringify({ ...completed, label: "newer receipt" }));
    expect(consumeGeneration(storage, completed, true)).toBe(false);
  });

  it("does not treat an interrupted request as a completed proposal", () => {
    const { record } = fixture();
    const review = emptyCharacterReview();
    expect(receiveGenerationReview(review, record)).toBe(review);
    expect(matchesGeneration({ ...record, operation: "create" }, record.ownerId, record.target)).toBe(false);
    expect(matchesGeneration({ ...record, operation: "portrait", scope: "profile" }, record.ownerId, record.target)).toBe(false);
  });

  it("retains a late response when storage fails and respects a changed record after recovery", () => {
    const { storage: backing, record } = fixture();
    let available = true;
    const storage = createGenerationStorage({
      getItem: (key) => { if (!available) throw new Error("unavailable"); return backing.getItem(key); },
      setItem: (key, raw) => { if (!available) throw new Error("unavailable"); backing.setItem(key, raw); },
      removeItem: (key) => { if (!available) throw new Error("unavailable"); backing.removeItem(key); },
    });
    const key = generationKey(record);
    storage.getItem(key);
    available = false;
    expect(finishGeneration(storage, record, { result: { proposed: { ...record.base, name: "Iris" }, diagnostics: [] } })).toBe(true);
    const completed = readGeneration(storage.getItem(key))!;
    expect(completed.status).toBe("completed");
    expect(storage.unavailable(key)).toBe(true);
    expect(consumeGeneration(storage, completed, true)).toBe(false);
    available = true;
    expect(readGeneration(storage.getItem(key))?.status).toBe("completed");
    // A different tab explicitly dismissed the request during the outage.
    backing.removeItem(key);
    expect(storage.getItem(key)).toBeNull();
    expect(consumeGeneration(storage, completed, true)).toBe(false);
  });

});
