import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import {
  clothingCategoryById,
  clothingCategoryIds,
  clothingLayerSchema,
  colorFamilyById,
  colorFamilyIds,
  objectSubtypeById,
  objectSubtypeIds,
  wearerTargetById,
  wearerTargetIds,
} from "@/contracts";
import { log } from "@/server/log";
import { parseOr } from "@/lib/parse";
import { generateChecked } from "@/server/ai";
import { db, items } from "@/server/db";
import { errorText } from "./respond";
import { itemExtrasSchema, type ItemExtras } from "./schemas";

/**
 * Classify-items backfill (library-ux.plan.md §5): fill the facet fields the
 * library organizes by (clothing category/layer/wearer/color, object
 * subtype/color) on items that lack them, inferred from name + description by
 * a cheap model. **Only absent fields are ever written** — a present value is
 * authored data and never overwritten, so the pass is safe to re-run.
 */

const CLASSIFY_CHUNK = 20;

/** An item is a classify candidate when any facet the library uses is absent. */
const MISSING_FACETS_SQL = sql`(
  (kind = 'clothing' and (
    definition->>'category' is null or definition->>'wearer' is null
    or definition->>'layer' is null or definition->'color' is null
  ))
  or (kind = 'object' and (definition->>'subtype' is null or definition->'color' is null))
  or (kind = 'container' and definition->'color' is null)
)`;

/** Owner's item ids still missing facets, optionally scoped to `ids`. */
export async function missingFacetItemIds(ownerId: string, ids?: readonly string[]): Promise<string[]> {
  const conditions = [eq(items.ownerId, ownerId), MISSING_FACETS_SQL];
  if (ids !== undefined) {
    if (ids.length === 0) return [];
    conditions.push(inArray(items.id, [...ids]));
  }
  const rows = await db()
    .select({ id: items.id })
    .from(items)
    .where(and(...conditions));
  return rows.map((r) => r.id);
}

const classifiedItemSchema = z.object({
  index: z.number().int(),
  category: z.string().optional().catch(undefined),
  subtype: z.string().optional().catch(undefined),
  layer: clothingLayerSchema.optional().catch(undefined),
  wearer: z.string().optional().catch(undefined),
  color: z
    .object({ family: z.string().min(1), shade: z.string().optional().catch(undefined) })
    .optional()
    .catch(undefined),
});

const classifySectionSchema = z.object({ items: z.array(classifiedItemSchema).default([]) });

const CLASSIFY_SYSTEM =
  "You are a meticulous inventory librarian for a roleplaying engine. You classify item records with structured facets, using ONLY the exact vocabulary ids provided. Skip any facet you cannot infer confidently from the item's name and description — a missing facet is better than a wrong one.";

interface ClassifyRow {
  id: string;
  kind: "clothing" | "object" | "container";
  name: string;
  description: string;
  definition: unknown;
}

function classifyPrompt(rows: readonly ClassifyRow[]): string {
  const lines = [
    "Facet vocabulary:",
    `- clothing category: ${clothingCategoryIds.join(", ")}`,
    "- clothing layer: 0 underwear · 1 base · 2 mid · 3 outerwear",
    `- wearer (clothing): ${wearerTargetIds.join(", ")} — who the garment is cut for; unisex when not gender-cut`,
    `- object subtype: ${objectSubtypeIds.join(", ")}`,
    `- color family (any kind): ${colorFamilyIds.join(", ")}; also give "shade", the precise hue in a word or two (e.g. "aqua", "olive"), when the exact color is stated or obvious`,
    "",
    "Items:",
    ...rows.map((row, i) => {
      const description = row.description.trim();
      return `${i}. [${row.kind}] ${row.name}${description ? ` — ${description}` : ""}`;
    }),
    "",
    "For each item return its index plus the facets that apply: clothing gets category, layer, wearer and color; objects get subtype and color; containers get color.",
  ];
  return lines.join("\n");
}

/** Merge grounded classifications into the stored extras — absent fields only. */
export function mergeClassifiedExtras(extras: ItemExtras, kind: ClassifyRow["kind"], classified: z.infer<typeof classifiedItemSchema>): { merged: ItemExtras; changed: boolean } {
  const merged = { ...extras };
  let changed = false;
  if (kind === "clothing") {
    const category = classified.category ? clothingCategoryById(classified.category) : undefined;
    if (merged.category === undefined && category) {
      merged.category = category.id;
      changed = true;
    }
    const wearer = classified.wearer ? wearerTargetById(classified.wearer) : undefined;
    if (merged.wearer === undefined && wearer) {
      merged.wearer = wearer.id;
      changed = true;
    }
    if (merged.layer === undefined && classified.layer !== undefined) {
      merged.layer = classified.layer;
      changed = true;
    }
  }
  if (kind === "object") {
    const subtype = classified.subtype ? objectSubtypeById(classified.subtype) : undefined;
    if (merged.subtype === undefined && subtype) {
      merged.subtype = subtype.id;
      changed = true;
    }
  }
  const family = classified.color ? colorFamilyById(classified.color.family) : undefined;
  if (merged.color === undefined && family) {
    merged.color = { family: family.id, shade: classified.color?.shade };
    changed = true;
  }
  return { merged, changed };
}

/**
 * The background classify pass over the given item ids: chunks of
 * CLASSIFY_CHUNK per model call, each chunk independent — a failed chunk is
 * logged and skipped, never fails the job (docs/resilience.md §1).
 */
export async function runItemClassify(ownerId: string, ids: readonly string[]): Promise<{ updated: number; failedChunks: number }> {
  let updated = 0;
  let failedChunks = 0;
  for (let offset = 0; offset < ids.length; offset += CLASSIFY_CHUNK) {
    const chunkIds = ids.slice(offset, offset + CLASSIFY_CHUNK);
    try {
      const rows = await db()
        .select({
          id: items.id,
          kind: items.kind,
          name: items.name,
          description: items.description,
          definition: items.definition,
        })
        .from(items)
        .where(and(eq(items.ownerId, ownerId), inArray(items.id, [...chunkIds])));
      if (rows.length === 0) continue;

      const { value } = await generateChecked({
        schema: classifySectionSchema,
        system: CLASSIFY_SYSTEM,
        prompt: classifyPrompt(rows),
        code: "api.items.classify",
      });
      if (!value) {
        failedChunks += 1;
        continue;
      }

      for (const classified of value.items) {
        const row = rows[classified.index];
        if (!row) continue;
        const extras = parseOr(itemExtrasSchema, row.definition, itemExtrasSchema.parse({}), undefined, "items.definition");
        const { merged, changed } = mergeClassifiedExtras(extras, row.kind, classified);
        if (!changed) continue;
        await db().update(items).set({ definition: merged }).where(eq(items.id, row.id));
        updated += 1;
      }
    } catch (err) {
      failedChunks += 1;
      log.warn("api.items", "classify chunk failed", { ownerId, offset, error: errorText(err) });
    }
  }
  return { updated, failedChunks };
}
