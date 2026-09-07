import { z } from "zod";
import { ambientSchema as ambientBaseSchema } from "@/contracts";

export function arrayOf<T>(item: z.ZodType<T>) {
  return z
    .array(z.unknown())
    .catch([])
    .transform((xs) =>
      xs.flatMap((x) => {
        const parsed = item.safeParse(x);
        return parsed.success ? [parsed.data] : [];
      }),
    );
}

/** Accept a bare array or `{ <key>: [...] }` for any of the given keys. */
export function listOf<T>(item: z.ZodType<T>, ...keys: string[]) {
  return z.preprocess((raw) => {
    if (Array.isArray(raw)) return raw as unknown[];
    if (raw && typeof raw === "object") {
      for (const key of [...keys, "items", "data", "results"]) {
        const candidate = (raw as Record<string, unknown>)[key];
        if (Array.isArray(candidate)) return candidate as unknown[];
      }
    }
    return [];
  }, arrayOf(item));
}

export const idSchema = z.string().min(1);
export const nameSchema = z.string().catch("Untitled");
/** Cross-account share scope; unknown/absent ⇒ private. */
export const visibilitySchema = z.enum(["private", "public"]).catch("private");
export type Visibility = z.infer<typeof visibilitySchema>;
export const textOr = (fallback: string) => z.string().catch(fallback);
export const tagsSchema = arrayOf(z.string());
/** string | null, tolerating absent/garbage values. */
export const optionalId = z
  .string()
  .nullish()
  .catch(null)
  .transform((v) => v ?? null);
export const optionalText = z
  .string()
  .nullish()
  .catch(null)
  .transform((v) => v ?? null);

/** Accept `{ id }` or `{ <entity>: { id } }` from create endpoints. */
export const createdRefSchema = z.preprocess(
  (raw) => {
    if (raw && typeof raw === "object") {
      const obj = raw as Record<string, unknown>;
      if (typeof obj.id === "string") return { id: obj.id };
      for (const key of [
        "session",
        "world",
        "character",
        "location",
        "item",
        "socialCard",
        "persona",
        "draft",
      ]) {
        const inner = obj[key];
        if (
          inner &&
          typeof inner === "object" &&
          typeof (inner as Record<string, unknown>).id === "string"
        ) {
          return { id: (inner as Record<string, unknown>).id };
        }
      }
    }
    return raw;
  },
  z.object({ id: idSchema }),
);

export type CreatedRef = z.infer<typeof createdRefSchema>;

/**
 * Accept the entity bare or wrapped as `{ <key>: {...}, ...siblings }`
 * (e.g. `{ world, locations, cast, … }`). Siblings are MERGED with the entity
 * row (entity keys win), never discarded — the world detail families live
 * beside the row, and dropping them once made every edit-save silently erase
 * the world's map/cast/items (the editor seeded from an empty parse).
 */
export function detailOf<T>(item: z.ZodType<T>, key: string) {
  return z.preprocess((raw) => {
    if (raw && typeof raw === "object") {
      const obj = raw as Record<string, unknown>;
      const inner = obj[key];
      if (typeof obj.id !== "string" && inner && typeof inner === "object") {
        return { ...obj, ...(inner as Record<string, unknown>) };
      }
    }
    return raw;
  }, item);
}

// Canonical shape from contracts; client wraps it in `.catch({})` for resilience.
export const ambientSchema = ambientBaseSchema.catch({});

export type Ambient = z.infer<typeof ambientSchema>;
