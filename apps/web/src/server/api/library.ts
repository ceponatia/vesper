import { and, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { diag, itemDefinitionSchema, type Diagnostic, type DiagnosticSink, type ItemDefinition } from "@/contracts";
import { log } from "@/server/log";
import { parseOr } from "@/lib/parse";
import { currentEmbedder, embedText, toVectorLiteral } from "@/server/ai";
import { db, images, items, locationLinks, locations } from "@/server/db";
import { escapeLikePattern } from "@/server/authoring";
import { fuzzyResolve, ITEM_DEDUPE_MIN_SCORE, refreshSearchEmbedding, type LibraryKind } from "@/server/memory";
import { purgeImagesWhere, type ImageEntityKind } from "@/server/images";
import { startJob } from "./jobs";
import { errorText } from "./respond";
import { invalidCoverageIds, itemExtrasSchema, type ItemExtras } from "./schemas";
import type { ShareableKind } from "./visibility";

export const LIST_LIMIT = 100;
/** Looser than FUZZY_MIN_SCORE: search suggests, the user picks. */
export const SEARCH_MIN_SCORE = 0.25;

const TABLE_NAMES: Record<LibraryKind, string> = {
  character: "characters",
  location: "locations",
  item: "items",
  social_card: "social_cards",
  persona: "personas",
};

const idRowSchema = z.object({ id: z.string() });
const scoredIdRowSchema = z.object({ id: z.string(), score: z.number() });

/** Cross-account discovery tiers. */
export type LibraryScope = "all" | "public" | "owned";

/**
 * The library kinds with **no** public tier — their table carries no
 * `visibility` column, so `owned` is the only scope that means anything.
 * Derived from `ShareableKind` (./visibility) so the two can never drift:
 * making a kind shareable removes it from here automatically.
 */
export type OwnerOnlyLibraryKind = Exclude<LibraryKind, ShareableKind>;

/**
 * `ShareableKind` as a value, so the runtime check below and the type-level
 * split share one source of truth — widening the union breaks this map until
 * the new kind is listed.
 */
const SHAREABLE_LIBRARY_KINDS: Record<ShareableKind, true> = {
  character: true,
  location: true,
  item: true,
  social_card: true,
};

export interface LibrarySearchOptions {
  q?: string;
  /** Tag filters, ANDed (jsonb containment) — a row must carry every one. */
  tags?: readonly string[];
  limit?: number;
  /**
   * Items only: restrict to one item sub-kind (clothing/object/container)
   * **before** the result cap. Without it, the `limit` is consumed by the
   * owner's most-recently-updated rows of *every* kind, so a single-kind list
   * (e.g. the outfit editor's clothing list) silently loses items that rank past
   * the cap by `updated_at` — they then render as "not in library" even though
   * they exist (see characters' `defaultOutfit` resolution). No-op for the
   * character/location tables, which have no `kind` column.
   */
  itemKind?: string;
  /**
   * Items only: definition-jsonb facet filters, applied **before** the result
   * cap for the same reason as `itemKind`. `wearer` follows the registry's
   * filter semantics (contracts/items/wearer.ts): absent/unisex rows match
   * every wearer filter.
   */
  itemFacets?: {
    category?: string;
    subtype?: string;
    layer?: 0 | 1 | 2 | 3;
    wearer?: string;
    colorFamily?: string;
  };
  /** Browse ordering; `updated` (default) = most-recently-updated first. */
  sort?: "updated" | "name";
  /**
   * Cross-account discovery scope (debuted on social cards): `owned` (default)
   * is owner-only — the long-standing behaviour every other caller relies on;
   * `public` is everyone's published rows (your own public ones included);
   * `all` is owner ∪ public. Only the shareable tables carry a `visibility`
   * column, which is why the overloads below accept these options for
   * `ShareableKind` alone.
   *
   * This returns **ids**; whatever hydrates them for a non-`owned` scope is
   * feeding foreign rows to a client and must select an explicit column list —
   * never `select()`. Every list route already does (summary columns only, no
   * `ownerId`/`searchEmbedding`); the detail routes project through
   * `toPublic*` in `./visibility`.
   */
  scope?: LibraryScope;
}

/**
 * Search options for an owner-only kind: every filter the shareable kinds get,
 * but `owned` is the only expressible scope — a persona is *you*, so there is
 * no public tier to widen to.
 */
export type OwnerOnlyLibrarySearchOptions = Omit<LibrarySearchOptions, "scope"> & { scope?: "owned" };

/**
 * The outcome of checking a `kind × scope` pair before any SQL is built.
 */
export type LibraryScopeDecision =
  | { supported: true; scope: LibraryScope }
  | { supported: false; diagnostic: Diagnostic };

/**
 * Can this kind be searched at this scope? Pure, so the decision is unit
 * testable without a database — and the *only* thing the query builder reads
 * when it composes the scope predicate.
 *
 * A non-`owned` scope on a kind with no `visibility` column used to compile a
 * `visibility = 'public'` clause against a table that has no such column: a
 * 500 from invalid SQL, latent only because the personas route hardcodes
 * `scope: "owned"`. The overloads on `searchLibraryIds` keep that pair
 * unrepresentable for statically-known kinds; this is the backstop for dynamic
 * ones. Unsupported degrades to an
 * empty result + a `warn` diagnostic rather than throwing — and deliberately
 * does not quietly narrow `all` to `owned`, which would hand the caller their
 * own rows and hide the bug.
 */
export function resolveLibraryScope(kind: LibraryKind, scope: LibraryScope = "owned"): LibraryScopeDecision {
  if (scope === "owned" || Object.hasOwn(SHAREABLE_LIBRARY_KINDS, kind)) return { supported: true, scope };
  return {
    supported: false,
    diagnostic: diag(
      "warn",
      "api.library.scope_unsupported",
      `"${kind}" has no public tier (no visibility column); a "${scope}" search returns nothing`,
      { path: TABLE_NAMES[kind], context: { kind, scope } },
    ),
  };
}

/** Parse a `tag` query param: comma-separated values, ANDed by the search. */
export function parseTagsParam(value: string | null): string[] {
  if (!value) return [];
  return value.split(",").map((t) => t.trim()).filter(Boolean);
}

/**
 * List/search ids for a library table, ranked: text matches (name or tag
 * ILIKE) first, then embedding-similarity hits ≥ SEARCH_MIN_SCORE
 * (docs/streaming-api.md §Pagination & limits). An embedding failure degrades
 * to text-only results.
 *
 * Two overloads, so the scope split is a compile error rather than a runtime
 * one: **any** kind may be searched at `owned` (including a dynamically-typed
 * `LibraryKind`), while `public`/`all`
 * are accepted only for the shareable kinds whose table has a `visibility`
 * column. `OwnerOnlyLibraryKind` (personas) therefore cannot reach the public
 * predicate at all from statically-known call sites.
 */
export function searchLibraryIds(
  kind: LibraryKind,
  ownerId: string,
  opts?: OwnerOnlyLibrarySearchOptions,
): Promise<string[]>;
export function searchLibraryIds(kind: ShareableKind, ownerId: string, opts: LibrarySearchOptions): Promise<string[]>;
export async function searchLibraryIds(
  kind: LibraryKind,
  ownerId: string,
  opts: LibrarySearchOptions = {},
): Promise<string[]> {
  const limit = Math.min(Math.max(opts.limit ?? LIST_LIMIT, 1), LIST_LIMIT);
  const table = sql.identifier(TABLE_NAMES[kind]);
  const q = opts.q?.trim() ?? "";
  const tags = (opts.tags ?? []).map((t) => t.trim()).filter(Boolean);
  // Items only — these columns/facets exist on the items table; ignored for other kinds.
  const itemKind = kind === "item" ? (opts.itemKind?.trim() ?? "") : "";
  const facets = kind === "item" ? (opts.itemFacets ?? {}) : {};
  // Discovery scope (default owner-only, so existing callers are unchanged).
  // A kind the caller reached dynamically can still name a scope its table
  // cannot serve — degrade to no results rather than emit invalid SQL.
  const decision = resolveLibraryScope(kind, opts.scope);
  if (!decision.supported) {
    log.warn("api.library", decision.diagnostic.message, {
      code: decision.diagnostic.code,
      kind,
      scope: opts.scope,
    });
    return [];
  }
  const scope = decision.scope;
  const scopeCondition =
    scope === "public"
      ? sql`visibility = 'public'`
      : scope === "all"
        ? sql`(owner_id = ${ownerId} or visibility = 'public')`
        : sql`owner_id = ${ownerId}`;

  // Shared by the text and embedding legs, so a facet can never match in one and not the other.
  const filterConditions: SQL[] = [scopeCondition];
  if (itemKind) filterConditions.push(sql`kind = ${itemKind}`);
  if (facets.category?.trim()) filterConditions.push(sql`definition->>'category' = ${facets.category.trim()}`);
  if (facets.subtype?.trim()) filterConditions.push(sql`definition->>'subtype' = ${facets.subtype.trim()}`);
  if (facets.layer !== undefined) filterConditions.push(sql`definition->>'layer' = ${String(facets.layer)}`);
  if (facets.wearer?.trim()) {
    // Absent and unisex match every wearer filter (contracts/items/wearer.ts).
    filterConditions.push(
      sql`(definition->>'wearer' is null or definition->>'wearer' = 'unisex' or definition->>'wearer' = ${facets.wearer.trim()})`,
    );
  }
  if (facets.colorFamily?.trim()) {
    filterConditions.push(sql`definition->'color'->>'family' = ${facets.colorFamily.trim()}`);
  }
  if (tags.length > 0) filterConditions.push(sql`tags @> ${JSON.stringify(tags)}::jsonb`);

  const conditions: SQL[] = [...filterConditions];
  if (q) {
    const pattern = `%${escapeLikePattern(q)}%`;
    conditions.push(
      sql`(name ilike ${pattern} or exists (select 1 from jsonb_array_elements_text(tags) as t(v) where t.v ilike ${pattern}))`,
    );
  }
  const where = sql.join(conditions, sql` and `);
  const orderBy = opts.sort === "name" ? sql`lower(name) asc` : sql`updated_at desc`;
  const textResult = await db().execute(
    sql`select id from ${table} where ${where} order by ${orderBy} limit ${limit}`,
  );
  const ids: string[] = [];
  for (const row of textResult.rows) {
    const parsed = idRowSchema.safeParse(row);
    if (parsed.success) ids.push(parsed.data.id);
  }

  if (!q || ids.length >= limit) return ids;

  let vector: string;
  try {
    vector = toVectorLiteral((await embedText(q)).vector);
  } catch (err) {
    log.warn("api.library", "search embedding failed; text results only", { kind, error: errorText(err) });
    return ids;
  }
  const embeddingConditions: SQL[] = [
    ...filterConditions,
    sql`embedder = ${currentEmbedder()}`,
    sql`search_embedding is not null`,
  ];
  const embeddingResult = await db().execute(
    sql`select id, 1 - (search_embedding <=> ${vector}::vector) as score
        from ${table}
        where ${sql.join(embeddingConditions, sql` and `)}
        order by search_embedding <=> ${vector}::vector
        limit ${limit}`,
  );
  const seen = new Set(ids);
  for (const row of embeddingResult.rows) {
    const parsed = scoredIdRowSchema.safeParse(row);
    if (!parsed.success || parsed.data.score < SEARCH_MIN_SCORE || seen.has(parsed.data.id)) continue;
    seen.add(parsed.data.id);
    ids.push(parsed.data.id);
    if (ids.length >= limit) break;
  }
  return ids;
}

/**
 * Fire-and-forget search-embedding refresh after create/update, recorded as
 * an `embed_refresh` job for observability. Never blocks or fails the save.
 */
export function queueEmbedRefresh(kind: LibraryKind, id: string): void {
  void startJob({
    type: "embed_refresh",
    payload: { kind, id },
    run: async () => ({ refreshed: await refreshSearchEmbedding(kind, id) }),
  }).catch((err: unknown) => {
    log.warn("api.library", "embed_refresh enqueue failed", { kind, id, error: errorText(err) });
  });
}

/**
 * Materialize forge item suggestions as library items (docs/authoring.md):
 * a suggestion whose name matches an existing item (case-insensitive, same
 * owner; same kind preferred) reuses that item — never a duplicate. New rows
 * get a "suggested" tag. A bad suggestion degrades (invalid coverage ids are
 * dropped with a diagnostic); it never fails the surrounding save.
 */
export async function materializeSuggestedItems(
  ownerId: string,
  suggestions: readonly ItemDefinition[],
  sink: DiagnosticSink,
): Promise<string[]> {
  const ids: string[] = [];
  for (const def of suggestions) {
    const name = def.name.trim();
    if (!name) continue;
    const existing = await db()
      .select({ id: items.id, kind: items.kind })
      .from(items)
      .where(and(eq(items.ownerId, ownerId), sql`lower(${items.name}) = ${name.toLowerCase()}`));
    const match = existing.find((row) => row.kind === def.kind) ?? existing[0];
    if (match) {
      sink.push(diag("info", "api.library.suggested_item.reused", `"${name}" matched an existing library item`));
      ids.push(match.id);
      continue;
    }

    // Backstop for the agent's reuse pass (docs/authoring.md): a fresh garment
    // whose name is near-identical to an existing same-kind item collapses into
    // it rather than spawning a near-duplicate. Conservative threshold so only
    // obvious dupes merge; an embedding failure degrades to a new insert.
    const fuzzy = await fuzzyResolve("item", ownerId, name, {
      minScore: ITEM_DEDUPE_MIN_SCORE,
      itemKind: def.kind,
      sink,
    });
    if (fuzzy) {
      sink.push(
        diag(
          "info",
          "api.library.suggested_item.fuzzy_reused",
          `"${name}" reused near-identical existing item "${fuzzy.name}" (${fuzzy.score.toFixed(2)})`,
        ),
      );
      ids.push(fuzzy.id);
      continue;
    }

    const invalid = invalidCoverageIds(def.coverage);
    if (invalid.length > 0) {
      sink.push(
        diag(
          "warn",
          "api.library.suggested_item.coverage_dropped",
          `"${name}": dropped unknown body locations ${invalid.join(", ")}`,
        ),
      );
    }
    const [row] = await db()
      .insert(items)
      .values({
        ownerId,
        kind: def.kind,
        name,
        description: def.description,
        tags: def.tags.includes("suggested") ? def.tags : [...def.tags, "suggested"],
        definition: {
          coverage: def.coverage.filter((id) => !invalid.includes(id)),
          // category template anchors coverage semantics (docs/contracts/items.md) —
          // must be persisted so clothing reads as Top/Bra/Footwear/etc.
          category: def.category,
          subtype: def.subtype,
          wearer: def.wearer,
          color: def.color,
          layer: def.layer,
          opacity: def.opacity,
          sensory: def.sensory,
          fields: def.fields,
        },
      })
      .returning({ id: items.id });
    if (!row) {
      sink.push(diag("error", "api.library.suggested_item.insert_failed", `"${name}" could not be created`));
      continue;
    }
    queueEmbedRefresh("item", row.id);
    ids.push(row.id);
  }
  return ids;
}

/** Full ItemDefinition from an items row (columns + extras JSONB). */
export function composeItemDefinition(row: {
  kind: "clothing" | "object" | "container";
  name: string;
  description: string;
  definition: unknown;
  tags?: unknown;
}): ItemDefinition {
  const extras: ItemExtras = parseOr(itemExtrasSchema, row.definition, itemExtrasSchema.parse({}), undefined, "items.definition");
  const tags = parseOr(z.array(z.string()), row.tags ?? [], [], undefined, "items.tags");
  return parseOr(
    itemDefinitionSchema,
    { kind: row.kind, name: row.name, description: row.description, tags, ...extras },
    itemDefinitionSchema.parse({ kind: row.kind, name: row.name }),
    undefined,
    "items.definition",
  );
}

/**
 * Entity deletion image cleanup (docs/images/asset-registry.md): drop the rows, then remove
 * files best-effort — sweepOrphans reconciles anything missed.
 */
export async function deleteEntityImages(entityKind: ImageEntityKind, entityId: string, ownerId: string): Promise<void> {
  await purgeImagesWhere(
    and(eq(images.ownerId, ownerId), eq(images.entityKind, entityKind), eq(images.entityId, entityId)),
  );
}

// ---------------------------------------------------------------------------
// Library location connections (undirected; the library counterpart of world_links)
// ---------------------------------------------------------------------------

/** The library-location ids connected to `locationId` (undirected). */
export async function connectedLocationIds(ownerId: string, locationId: string): Promise<string[]> {
  const rows = await db()
    .select({ from: locationLinks.fromLocationId, to: locationLinks.toLocationId })
    .from(locationLinks)
    .where(
      and(
        eq(locationLinks.ownerId, ownerId),
        or(eq(locationLinks.fromLocationId, locationId), eq(locationLinks.toLocationId, locationId)),
      ),
    );
  return rows.map((r) => (r.from === locationId ? r.to : r.from));
}

/** A location's connections as `{ id, name }`, for the editor and detail response. */
export async function loadLocationLinks(ownerId: string, locationId: string): Promise<Array<{ id: string; name: string }>> {
  const ids = await connectedLocationIds(ownerId, locationId);
  if (ids.length === 0) return [];
  return db()
    .select({ id: locations.id, name: locations.name })
    .from(locations)
    .where(and(eq(locations.ownerId, ownerId), inArray(locations.id, ids)));
}

/**
 * Reconcile a location's undirected connections to exactly `targetIds` —
 * unknown/non-owned/self ids are dropped, missing links are inserted, removed
 * links are deleted (either orientation). One row per pair (docs/engine/world.md).
 */
export async function setLocationLinks(ownerId: string, locationId: string, targetIds: readonly string[]): Promise<void> {
  const wanted = [...new Set(targetIds.filter((t) => t && t !== locationId))];
  const valid =
    wanted.length === 0
      ? []
      : (
          await db()
            .select({ id: locations.id })
            .from(locations)
            .where(and(eq(locations.ownerId, ownerId), inArray(locations.id, wanted)))
        ).map((r) => r.id);
  const validSet = new Set(valid);
  const current = new Set(await connectedLocationIds(ownerId, locationId));

  for (const other of current) {
    if (validSet.has(other)) continue;
    await db()
      .delete(locationLinks)
      .where(
        and(
          eq(locationLinks.ownerId, ownerId),
          or(
            and(eq(locationLinks.fromLocationId, locationId), eq(locationLinks.toLocationId, other)),
            and(eq(locationLinks.fromLocationId, other), eq(locationLinks.toLocationId, locationId)),
          ),
        ),
      );
  }
  const toAdd = valid.filter((id) => !current.has(id));
  if (toAdd.length > 0) {
    await db().insert(locationLinks).values(toAdd.map((toLocationId) => ({ ownerId, fromLocationId: locationId, toLocationId })));
  }
}
