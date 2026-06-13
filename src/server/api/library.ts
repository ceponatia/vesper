import fs from "node:fs/promises";
import { and, eq, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { diag, itemDefinitionSchema, type DiagnosticSink, type ItemDefinition } from "@/contracts";
import { log } from "@/lib/log";
import { parseOr } from "@/lib/parse";
import { currentEmbedder, embedText, toVectorLiteral } from "@/server/ai";
import { db, images, items } from "@/server/db";
import { escapeLikePattern } from "@/server/authoring";
import { fuzzyResolve, ITEM_DEDUPE_MIN_SCORE, refreshSearchEmbedding, type LibraryKind } from "@/server/memory";
import { absoluteImagePath, type ImageEntityKind } from "@/server/images";
import { startJob } from "./jobs";
import { errorText } from "./respond";
import { invalidCoverageIds, itemExtrasSchema, type ItemExtras } from "./schemas";

export const LIST_LIMIT = 100;
/** Looser than FUZZY_MIN_SCORE: search suggests, the user picks. */
export const SEARCH_MIN_SCORE = 0.25;

const TABLE_NAMES: Record<LibraryKind, string> = {
  character: "characters",
  location: "locations",
  item: "items",
};

const idRowSchema = z.object({ id: z.string() });
const scoredIdRowSchema = z.object({ id: z.string(), score: z.number() });

export interface LibrarySearchOptions {
  q?: string;
  tag?: string;
  limit?: number;
}

/**
 * List/search ids for a library table, ranked: text matches (name or tag
 * ILIKE) first, then embedding-similarity hits ≥ SEARCH_MIN_SCORE
 * (docs/streaming-api.md §Pagination & limits). An embedding failure degrades
 * to text-only results.
 */
export async function searchLibraryIds(
  kind: LibraryKind,
  ownerId: string,
  opts: LibrarySearchOptions = {},
): Promise<string[]> {
  const limit = Math.min(Math.max(opts.limit ?? LIST_LIMIT, 1), LIST_LIMIT);
  const table = sql.identifier(TABLE_NAMES[kind]);
  const q = opts.q?.trim() ?? "";
  const tag = opts.tag?.trim() ?? "";

  const conditions: SQL[] = [sql`owner_id = ${ownerId}`];
  if (tag) conditions.push(sql`tags @> ${JSON.stringify([tag])}::jsonb`);
  if (q) {
    const pattern = `%${escapeLikePattern(q)}%`;
    conditions.push(
      sql`(name ilike ${pattern} or exists (select 1 from jsonb_array_elements_text(tags) as t(v) where t.v ilike ${pattern}))`,
    );
  }
  const where = sql.join(conditions, sql` and `);
  const textResult = await db().execute(
    sql`select id from ${table} where ${where} order by updated_at desc limit ${limit}`,
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
    sql`owner_id = ${ownerId}`,
    sql`embedder = ${currentEmbedder()}`,
    sql`search_embedding is not null`,
  ];
  if (tag) embeddingConditions.push(sql`tags @> ${JSON.stringify([tag])}::jsonb`);
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
 * Entity deletion image cleanup (docs/images.md): drop the rows, then remove
 * files best-effort — sweepOrphans reconciles anything missed.
 */
export async function deleteEntityImages(entityKind: ImageEntityKind, entityId: string, ownerId: string): Promise<void> {
  const rows = await db()
    .select({ id: images.id, path: images.path })
    .from(images)
    .where(and(eq(images.ownerId, ownerId), eq(images.entityKind, entityKind), eq(images.entityId, entityId)));
  if (rows.length === 0) return;
  await db()
    .delete(images)
    .where(and(eq(images.ownerId, ownerId), eq(images.entityKind, entityKind), eq(images.entityId, entityId)));
  for (const row of rows) {
    void fs.unlink(absoluteImagePath(row)).catch(() => {
      // already gone or transient — image_sweep reconciles
    });
  }
}

/**
 * Session deletion image cleanup: scene images reference sessions via
 * sessionId (FK set-null on delete), so without this they'd linger as
 * orphaned rows + files. Same drop-rows-then-unlink pattern as
 * deleteEntityImages.
 */
export async function deleteSessionImages(sessionId: string, ownerId: string): Promise<void> {
  const rows = await db()
    .select({ id: images.id, path: images.path })
    .from(images)
    .where(and(eq(images.ownerId, ownerId), eq(images.sessionId, sessionId)));
  if (rows.length === 0) return;
  await db()
    .delete(images)
    .where(and(eq(images.ownerId, ownerId), eq(images.sessionId, sessionId)));
  for (const row of rows) {
    void fs.unlink(absoluteImagePath(row)).catch(() => {
      // already gone or transient — image_sweep reconciles
    });
  }
}
