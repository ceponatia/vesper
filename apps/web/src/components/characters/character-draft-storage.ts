import { z } from "zod";
import { parseOrNull } from "@/lib/parse";

export interface DraftStorage { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }
export type StoredDraft<T> = { revision: string; savedAt?: number; data: T };
export type StorageResult = "saved" | "conflict" | "unavailable";

/** Compare the exact version read by this editor. A stale completion may neither
 * overwrite nor clear a newer draft. Call under the browser's per-key write lock. */
export function writeDraft(storage: DraftStorage, key: string, expected: string | null, next: string | null): StorageResult {
  try {
    if (storage.getItem(key) !== expected) return "conflict";
    if (next === null) storage.removeItem(key);
    else storage.setItem(key, next);
    return "saved";
  } catch { return "unavailable"; }
}

export function readDraft<T>(raw: string | null, schema: z.ZodType<T>): StoredDraft<T> | null {
  if (raw === null) return null;
  try {
    return parseOrNull(z.object({ revision: z.string(), savedAt: z.number().optional(), data: schema }), JSON.parse(raw));
  } catch { return null; }
}
