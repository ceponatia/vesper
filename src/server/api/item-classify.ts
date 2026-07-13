import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import {
  bodyLocationRegistry,
  clothingCategoryById,
  clothingCategoryIds,
  clothingLayerSchema,
  clothingSubtypeById,
  clothingSubtypesByCategory,
  clothingSubtypesForCategory,
  colorFamilyById,
  colorFamilyIds,
  expandCoverage,
  objectSubtypeById,
  objectSubtypeIds,
  subtypedClothingCategoryIds,
  wearerTargetById,
  wearerTargetIds,
  type ItemKind,
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

// The accessory categories carrying a subtype vocabulary — compile-time
// registry constants, safe to inline into the SQL literal.
const SUBTYPED_CATEGORY_LIST = sql.raw(subtypedClothingCategoryIds.map((id) => `'${id}'`).join(", "));

/** An item is a classify candidate when any facet the library uses is absent. */
const MISSING_FACETS_SQL = sql`(
  (kind = 'clothing' and (
    definition->>'category' is null or definition->>'wearer' is null
    or definition->>'layer' is null or definition->'color' is null
    or (definition->>'category' in (${SUBTYPED_CATEGORY_LIST}) and definition->>'subtype' is null)
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

/** The shared facet-vocabulary block (classify backfill + the editor's draft assist). */
function facetVocabularyLines(): string[] {
  return [
    "Facet vocabulary:",
    `- clothing category: ${clothingCategoryIds.join(", ")}`,
    "- clothing layer: 0 underwear · 1 base · 2 mid · 3 outerwear",
    `- wearer (clothing): ${wearerTargetIds.join(", ")} — who the garment is cut for; unisex when not gender-cut`,
    ...[...clothingSubtypesByCategory.entries()].map(
      ([category, list]) => `- ${category} type (clothing classified ${category}): ${list.map((s) => s.id).join(", ")}`,
    ),
    `- object subtype: ${objectSubtypeIds.join(", ")}`,
    `- color family (any kind): ${colorFamilyIds.join(", ")}; also give "shade", the precise hue in a word or two (e.g. "aqua", "olive"), when the exact color is stated or obvious`,
  ];
}

function classifyPrompt(rows: readonly ClassifyRow[]): string {
  const lines = [
    ...facetVocabularyLines(),
    "",
    "Items:",
    ...rows.map((row, i) => {
      const description = row.description.trim();
      return `${i}. [${row.kind}] ${row.name}${description ? ` — ${description}` : ""}`;
    }),
    "",
    "For each item return its index plus the facets that apply: clothing gets category, layer, wearer and color — and when the category is jewelry, headwear or eyewear, also a subtype from that category's type list; objects get subtype and color; containers get color.",
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
    // Accessory type — validated against the (possibly just-merged) category's
    // own vocabulary, so a "nose_ring" can never land on a headwear item.
    const subtype = classified.subtype ? clothingSubtypeById(classified.subtype) : undefined;
    if (
      merged.subtype === undefined &&
      subtype &&
      clothingSubtypesForCategory(merged.category).some((s) => s.id === subtype.id)
    ) {
      merged.subtype = subtype.id;
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

// --- ✦ Draft from description (ux-improvements.plan.md slice 5) --------------

/** What the draft model may propose — every field optional, degrading per-field. */
const draftedItemSchema = z.object({
  category: z.string().optional().catch(undefined),
  subtype: z.string().optional().catch(undefined),
  layer: clothingLayerSchema.optional().catch(undefined),
  wearer: z.string().optional().catch(undefined),
  color: z
    .object({ family: z.string().min(1), shade: z.string().optional().catch(undefined) })
    .optional()
    .catch(undefined),
  opacity: z.enum(["opaque", "sheer"]).optional().catch(undefined),
  /** Explicit covered body-location ids (carve-outs = omitted ids). */
  coverage: z.array(z.string()).optional().catch(undefined),
  sensory: z
    .object({
      appearance: z.string().trim().max(300).optional().catch(undefined),
      scent: z.string().trim().max(300).optional().catch(undefined),
      tactile: z.string().trim().max(300).optional().catch(undefined),
    })
    .optional()
    .catch(undefined),
});
export type DraftedItem = z.infer<typeof draftedItemSchema>;

export interface ItemDraftProposal {
  category?: string;
  subtype?: string;
  layer?: 0 | 1 | 2 | 3;
  wearer?: string;
  color?: { family: string; shade?: string };
  opacity?: "opaque" | "sheer";
  coverage?: string[];
  sensory?: { appearance?: string; scent?: string; tactile?: string };
}

/**
 * Ground a raw model draft against the registries (pure — unit-tested):
 * unknown ids drop per-field, clothing-only facets drop for other kinds, and
 * coverage is exploded to the explicit-id convention (items/coverage.ts) with
 * non-coverage-relevant locations filtered — so "feet minus toes" survives as
 * `top_of_foot, sole, heel` and a bogus location can never reach the form.
 */
export function groundItemDraft(kind: ItemKind, drafted: DraftedItem): ItemDraftProposal {
  const proposal: ItemDraftProposal = {};
  if (kind === "clothing") {
    const category = drafted.category ? clothingCategoryById(drafted.category) : undefined;
    if (category) proposal.category = category.id;
    const subtype = drafted.subtype ? clothingSubtypeById(drafted.subtype) : undefined;
    if (subtype && clothingSubtypesForCategory(proposal.category).some((s) => s.id === subtype.id)) {
      proposal.subtype = subtype.id;
    }
    if (drafted.layer !== undefined) proposal.layer = drafted.layer;
    const wearer = drafted.wearer ? wearerTargetById(drafted.wearer) : undefined;
    if (wearer) proposal.wearer = wearer.id;
    if (drafted.opacity) proposal.opacity = drafted.opacity;
    const known = (drafted.coverage ?? []).flatMap((id) => {
      const normalized = id.trim().toLowerCase();
      return bodyLocationRegistry.byId(normalized) ? [normalized] : [];
    });
    if (known.length > 0) {
      const effective = expandCoverage(known);
      const coverage = bodyLocationRegistry.all
        .filter((loc) => (loc.coverageRelevant ?? true) && effective.has(loc.id))
        .map((loc) => loc.id);
      // Only propose when something survives grounding — an all-intimate (non
      // coverage-relevant) proposal must not read as "covers nothing".
      if (coverage.length > 0) proposal.coverage = coverage;
    }
  }
  if (kind === "object") {
    const subtype = drafted.subtype ? objectSubtypeById(drafted.subtype) : undefined;
    if (subtype) proposal.subtype = subtype.id;
  }
  const family = drafted.color ? colorFamilyById(drafted.color.family) : undefined;
  if (family) proposal.color = { family: family.id, shade: drafted.color?.shade };
  const sensory = {
    appearance: drafted.sensory?.appearance?.trim() || undefined,
    scent: drafted.sensory?.scent?.trim() || undefined,
    tactile: drafted.sensory?.tactile?.trim() || undefined,
  };
  if (sensory.appearance || sensory.scent || sensory.tactile) proposal.sensory = sensory;
  return proposal;
}

const DRAFT_SYSTEM =
  "You are a meticulous inventory librarian for a roleplaying engine. You draft an item's structured record from its name and description, using ONLY the exact vocabulary ids provided for facets. Skip any facet you cannot infer confidently — a missing facet is better than a wrong one. Sensory lines are short, concrete, present-tense prose.";

function draftPrompt(kind: ItemKind, name: string, description: string): string {
  const coverageIds = bodyLocationRegistry.all
    .filter((loc) => loc.coverageRelevant ?? true)
    .map((loc) => loc.id);
  return [
    ...facetVocabularyLines(),
    '- opacity (clothing): "opaque" or "sheer" — sheer only when the fabric reads see-through',
    `- coverage (clothing): body-location ids — ${coverageIds.join(", ")}`,
    "",
    `Item: [${kind}] ${name || "(unnamed)"}${description ? ` — ${description}` : ""}`,
    "",
    "Draft the item's record. Clothing gets category, layer, wearer, color, opacity, coverage — and when the category is jewelry, headwear or eyewear, a subtype from that category's type list. Objects get subtype and color; containers get color.",
    "Coverage lists EVERY covered location id explicitly; a cutout is expressed by omission — a peep-toe sandal covers sole, heel and top_of_foot but NOT toes; a flip-flop covers only sole. A parent id implies all its children, so use explicit children whenever part of a region is bare.",
    "Also write the three sensory lines — appearance (how it reads on the body/in the room), scent, tactile (how it feels) — from the item's nature: concrete and restrained, one short sentence each.",
  ].join("\n");
}

/**
 * The editor's ✦ Draft-from-description (stateless — nothing is written; the
 * client fill-merges into the unsaved form for SaveBar review). Returns null
 * when the model produced nothing usable (the route degrades to an error toast).
 */
export async function draftItemProposal(input: {
  kind: ItemKind;
  name: string;
  description: string;
}): Promise<ItemDraftProposal | null> {
  const { value } = await generateChecked({
    schema: draftedItemSchema,
    system: DRAFT_SYSTEM,
    prompt: draftPrompt(input.kind, input.name, input.description),
    code: "api.items.draft",
  });
  if (!value) return null;
  return groundItemDraft(input.kind, value);
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
