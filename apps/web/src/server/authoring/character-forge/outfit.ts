import { z } from "zod";
import { bodyLocationRegistry, clothingCategories, clothingCategoryById, colorFamilyById, colorFamilyIds, clothingLayerSchema, diag, itemDefinitionSchema, wearerTargetById, wearerTargets, type DiagnosticSink, type ItemDefinition } from "@/contracts";
import { parseOrNull } from "@/lib/parse";
import { generateChecked } from "@/server/ai";
import { CANDIDATE_LIMIT, findItemsByName, listClothingCandidates, type ClothingCandidate, type LibraryLookup } from "../library";
import { FORGE_LEG_OPTIONS, type CharacterForgeContext, type CharacterSectionPatch } from "./types";
import { demoCharacterOutfitSection } from "./demo";
import { normalizeEnumToken } from "./normalization";

const outfitItemSchema = z.object({
  name: z.string().min(1),
  /** Reuse an existing wardrobe item by its candidate id instead of defining a new garment. */
  reuseId: z.string().optional().catch(undefined),
  description: z.string().default(""),
  /** Coverage template id (contracts/items/clothing-categories.ts); anchors coverage + layer. */
  category: z.string().optional().catch(undefined),
  /** Wearer-target id (contracts/items/wearer.ts): who the garment is cut for. */
  wearer: z.string().optional().catch(undefined),
  /** Primary color: family id (contracts/items/colors.ts) + optional free-text shade. */
  color: z
    .object({ family: z.string().min(1), shade: z.string().optional().catch(undefined) })
    .optional()
    .catch(undefined),
  layer: clothingLayerSchema.optional().catch(undefined),
  coverage: z.array(z.string()).default([]),
  opacity: z.enum(["opaque", "sheer"]).catch("opaque"),
  sensory: z
    .object({
      appearance: z.string().optional(),
      scent: z.string().optional(),
      tactile: z.string().optional(),
    })
    .default({}),
  tags: z.array(z.string()).default([]),
});

const outfitSectionSchema = z.object({
  outfit: z.array(outfitItemSchema).default([]),
});

export type OutfitSection = z.infer<typeof outfitSectionSchema>;
export type OutfitItem = z.infer<typeof outfitItemSchema>;

export interface OutfitReusePartition {
  /** Existing library item ids the agent chose to reuse (deduped, in order). */
  reuseIds: string[];
  /** Entries with no valid reuse, to be grounded as new garments. */
  fresh: OutfitSection;
}

/**
 * Split the agent's outfit into reuse references and fresh garments. A reuseId
 * naming a real candidate becomes a library reference; an unknown reuseId
 * (the model hallucinated it) degrades to a fresh garment grounded from its own
 * fields, with a diagnostic (docs/resilience.md §1) — never a failed forge.
 */
export function partitionOutfitReuse(
  section: OutfitSection,
  candidateIds: ReadonlySet<string>,
  sink?: DiagnosticSink,
  code = "forge.character.outfit",
): OutfitReusePartition {
  const reuseIds: string[] = [];
  const fresh: OutfitItem[] = [];
  for (const item of section.outfit) {
    const reuseId = item.reuseId?.trim();
    if (reuseId) {
      if (candidateIds.has(reuseId)) {
        if (!reuseIds.includes(reuseId)) reuseIds.push(reuseId);
        continue;
      }
      sink?.push(
        diag("warn", `${code}.unknown_reuse`, `ignored unknown reuse id "${reuseId}" on "${item.name}"; drafting it as a new garment`, {
          context: { item: item.name, reuseId },
        }),
      );
    }
    fresh.push(item);
  }
  return { reuseIds, fresh: { outfit: fresh } };
}

/**
 * Validate coverage against the body-location registry (unknown ids drop with
 * a diagnostic), then re-validate each constructed definition — a garment that
 * fails the item schema drops with a diagnostic instead of throwing
 * (docs/resilience.md §1).
 */
export function groundOutfitItems(section: OutfitSection, sink?: DiagnosticSink, code = "forge.character.outfit"): ItemDefinition[] {
  const items: ItemDefinition[] = [];
  for (const item of section.outfit) {
    const category = item.category ? clothingCategoryById(normalizeEnumToken(item.category)) : undefined;
    if (item.category && !category) {
      sink?.push(diag("info", `${code}.unknown_category`, `ignored unknown clothing category "${item.category}" on "${item.name}"`));
    }
    const wearer = item.wearer ? wearerTargetById(normalizeEnumToken(item.wearer)) : undefined;
    if (item.wearer && !wearer) {
      sink?.push(diag("info", `${code}.unknown_wearer`, `ignored unknown wearer target "${item.wearer}" on "${item.name}"`));
    }
    const colorFamily = item.color ? colorFamilyById(normalizeEnumToken(item.color.family)) : undefined;
    if (item.color && !colorFamily) {
      sink?.push(diag("info", `${code}.unknown_color`, `ignored unknown color family "${item.color.family}" on "${item.name}"`));
    }
    const coverage: string[] = [];
    for (const raw of item.coverage) {
      const locationId = normalizeEnumToken(raw);
      if (!bodyLocationRegistry.byId(locationId)) {
        sink?.push(
          diag("warn", `${code}.invalid_coverage`, `dropped unknown body location "${raw}" on "${item.name}"`, {
            context: { item: item.name, bodyLocationId: raw },
          }),
        );
        continue;
      }
      if (!coverage.includes(locationId)) coverage.push(locationId);
    }
    const parsed = parseOrNull(
      itemDefinitionSchema,
      {
        kind: "clothing",
        name: item.name,
        description: item.description,
        // the category template anchors anything the model left unset
        category: category?.id,
        wearer: wearer?.id,
        color: colorFamily ? { family: colorFamily.id, shade: item.color?.shade } : undefined,
        coverage: coverage.length > 0 ? coverage : [...(category?.coverage ?? [])],
        layer: item.layer ?? category?.layer ?? 1,
        opacity: item.opacity,
        sensory: item.sensory,
        tags: item.tags,
      },
      sink,
      `${code}.item`,
    );
    if (!parsed) {
      sink?.push(diag("warn", `${code}.invalid_item`, `dropped garment "${item.name}": failed item validation`, { context: { item: item.name } }));
      continue;
    }
    items.push(parsed);
  }
  return items;
}

const OUTFIT_SYSTEM =
  "You design a character's default outfit for a roleplaying engine. Each garment lists which body locations it covers and which layer it sits on. Layers: 0 underwear, 1 base, 2 mid, 3 outerwear.";

function outfitPrompt(context: CharacterForgeContext, candidates: readonly ClothingCandidate[]): string {
  const locationIds = bodyLocationRegistry.all
    .filter((l) => l.coverageRelevant)
    .map((l) => l.id)
    .join(", ");
  const lines = [
    "Character concept:",
    context.prompt,
  ];
  const bio = context.draft?.profile.bio;
  if (bio) lines.push("", "Drafted bio:", bio);
  lines.push(
    "",
    `Valid coverage body locations: ${locationIds}`,
    `Clothing categories (set one per garment where it fits; it anchors coverage): ${clothingCategories.map((c) => c.id).join(", ")}`,
    `Wearer target (set per garment): ${wearerTargets.map((w) => w.id).join(", ")} — match the character's presentation; use unisex for anything not gender-cut.`,
    `Primary color (set per garment): "color": { "family": one of ${colorFamilyIds.join(", ")}; "shade": the precise hue in a word or two, e.g. "aqua", "olive" }.`,
    "",
    "Cover only what the garment really covers. A t-shirt covers chest, back, shoulders, waist, upper_arms — never forearms or hands. Note that arms includes hands and torso includes neck, so prefer the specific parts.",
  );
  if (candidates.length > 0) {
    lines.push(
      "",
      'You may reuse a wardrobe item this character already owns instead of inventing one: set that garment\'s "reuseId" to the listed id. Prefer reusing an existing generic basic that fits (any t-shirt, jeans, sweater, plain footwear) — minor colour or detail differences do not matter. Define a NEW garment (leave reuseId unset) for a signature or character-defining piece, or when nothing listed fits.',
      "",
      "Existing wardrobe you can reuse:",
      ...candidates.map((c) => {
        const coverage = c.coverage.length > 0 ? ` — covers ${c.coverage.join(", ")}` : "";
        const layer = c.layer === undefined ? "" : ` (layer ${c.layer})`;
        return `- ${c.id}: ${c.name}${layer}${coverage}`;
      }),
    );
  }
  lines.push(
    "",
    "Suggest 3-6 garments for the character's everyday default outfit, with a short sensory description each.",
  );
  return lines.join("\n");
}

export async function forgeOutfitSection(context: CharacterForgeContext): Promise<CharacterSectionPatch> {
  const listCandidates = context.listCandidates ?? listClothingCandidates;
  let candidates: ClothingCandidate[] = [];
  try {
    candidates = await listCandidates(context.userId, CANDIDATE_LIMIT);
  } catch (err) {
    context.sink?.push(
      diag("warn", "forge.character.outfit.candidates_failed", `wardrobe candidate lookup failed: ${errorText(err)}`),
    );
  }
  if (candidates.length >= CANDIDATE_LIMIT) {
    context.sink?.push(
      diag(
        "info",
        "forge.character.outfit.candidates_capped",
        `offered the ${CANDIDATE_LIMIT} most-recent wardrobe items as reuse candidates; older items were not shown to the agent`,
      ),
    );
  }

  const { value, degraded } = await generateChecked({
    ...FORGE_LEG_OPTIONS,
    schema: outfitSectionSchema,
    system: OUTFIT_SYSTEM,
    prompt: outfitPrompt(context, candidates),
    temperature: 0.5,
    code: "forge.character.outfit",
    sink: context.sink,
    fallback: context.scope || context.useFallbacks === false ? undefined : demoCharacterOutfitSection,
  });
  if (context.scope && (degraded || !value)) return {};
  const section = value ?? outfitSectionSchema.parse({});
  const { reuseIds, fresh } = partitionOutfitReuse(section, new Set(candidates.map((c) => c.id)), context.sink);
  const items = groundOutfitItems(fresh, context.sink);
  const { defaultOutfit, suggested } = await matchOutfitAgainstLibrary(
    items,
    context.userId,
    context.findItems ?? findItemsByName,
    context.sink,
  );
  // Explicit reuses lead; library name-matches on fresh garments follow (deduped).
  // The forge drafts the DEFAULT preset (outfits[0], ux-improvements slice 8).
  const presetItems = [...new Set([...reuseIds, ...defaultOutfit])];
  return {
    profile: { outfits: presetItems.length > 0 ? [{ id: "everyday", name: "Everyday", items: presetItems }] : [] },
    suggestedItems: suggested,
  };
}

/**
 * Library matching (docs/authoring/character-forge.md §The outfit agent):
 * name-matched garments reference the
 * existing library item id in defaultOutfit; unmatched ones become new item
 * drafts flagged "suggested". A failed lookup degrades to all-suggested.
 */
export async function matchOutfitAgainstLibrary(
  items: readonly ItemDefinition[],
  userId: string,
  findItems: LibraryLookup,
  sink?: DiagnosticSink,
): Promise<{ defaultOutfit: string[]; suggested: ItemDefinition[] }> {
  if (items.length === 0) return { defaultOutfit: [], suggested: [] };
  let rows: ReadonlyArray<{ id: string; name: string }> = [];
  try {
    rows = await findItems(userId, items.map((i) => i.name));
  } catch (err) {
    sink?.push(
      diag("warn", "forge.character.outfit.library_lookup_failed", `item library lookup failed: ${errorText(err)}`),
    );
  }
  const idByName = new Map(rows.map((r) => [r.name.toLowerCase(), r.id]));
  const defaultOutfit: string[] = [];
  const suggested: ItemDefinition[] = [];
  for (const item of items) {
    const libraryId = idByName.get(item.name.toLowerCase());
    if (libraryId) {
      if (!defaultOutfit.includes(libraryId)) defaultOutfit.push(libraryId);
    } else {
      suggested.push({ ...item, tags: item.tags.includes("suggested") ? item.tags : [...item.tags, "suggested"] });
    }
  }
  return { defaultOutfit, suggested };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
