import { and, count, desc, eq, isNull } from "drizzle-orm";
import {
  duplicateNarratorPromptName,
  narratorPromptLanguageSchema,
  NARRATOR_PROMPT_CONFLICT_CODE,
  NARRATOR_PROMPT_NAME_TAKEN_CODE,
  type CreateNarratorPromptRequest,
  type DuplicateNarratorPromptRequest,
  type NarratorPromptLanguage,
  type NarratorPromptTemplateDetail,
  type NarratorPromptTemplateSummary,
  type SaveNarratorPromptRequest,
} from "@/contracts/narrator-prompts";
import { fnv1aHex } from "@/lib/hash";
import { parseOrNull } from "@/lib/parse";
import { characterChats, db, narratorPromptRevisions, narratorPromptTemplates } from "@/server/db";

/**
 * Narrator Prompt Lab persistence — templates and their immutable revisions
 * (narrator-prompt-lab.plan.md slice 2).
 *
 * Every function is **owner-scoped by parameter**, never by ambient session:
 * `ownerId` is an argument, it lands in the `where` of every read and every
 * write, and a row belonging to someone else is indistinguishable from a row
 * that does not exist. The admin wrapper on the routes decides *whether* the
 * caller may use the Prompt Lab at all; these predicates decide *whose* prompts
 * they see, and an admin role is not a licence to read another account's
 * experiments.
 *
 * Nothing here throws for an expected outcome. Every operation that can be
 * refused returns a discriminated result carrying one of three codes —
 * `not_found`, `prompt_conflict`, `prompt_name_taken` — so a route maps a
 * refusal to a status without inspecting an exception.
 */

/** The language every v1 body is written in. Stored per revision, and inside the body hash. */
const CURRENT_TEMPLATE_LANGUAGE: NarratorPromptLanguage = "plain_v0";

export type NarratorPromptRefusalCode =
  | "not_found"
  | typeof NARRATOR_PROMPT_CONFLICT_CODE
  | typeof NARRATOR_PROMPT_NAME_TAKEN_CODE;

export type NarratorPromptRefusal =
  | { ok: false; code: "not_found" }
  | { ok: false; code: typeof NARRATOR_PROMPT_NAME_TAKEN_CODE }
  /** The editor saved from a base that is no longer current; `currentRevision` is what to reload. */
  | { ok: false; code: typeof NARRATOR_PROMPT_CONFLICT_CODE; currentRevision: number };

export type NarratorPromptResult<T> = { ok: true; value: T } | NarratorPromptRefusal;

export interface NarratorPromptDeleteOutcome {
  templateId: string;
  /** Conversations whose live selection this delete cleared back to production instructions. */
  clearedChatIds: string[];
}

/**
 * The stored identity of one revision body.
 *
 * The LANGUAGE is inside the hashed string, not merely stored beside it, because
 * the same characters mean different things under different template languages:
 * a body that is literal text under `plain_v0` would be a template with
 * substitutions under a future `plain_v1`. Hashing the body alone would collide
 * those two into one identity, and take provenance would then claim two
 * materially different prompts were the same prompt.
 */
export function narratorPromptBodyHash(body: string, language: NarratorPromptLanguage): string {
  return fnv1aHex(`${language}\n${body}`);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const summaryColumns = {
  id: narratorPromptTemplates.id,
  name: narratorPromptTemplates.name,
  notes: narratorPromptTemplates.notes,
  currentRevision: narratorPromptTemplates.currentRevision,
  currentRevisionId: narratorPromptTemplates.currentRevisionId,
  duplicatedFromId: narratorPromptTemplates.duplicatedFromId,
  createdAt: narratorPromptTemplates.createdAt,
  updatedAt: narratorPromptTemplates.updatedAt,
};

interface SummaryRow {
  id: string;
  name: string;
  notes: string;
  currentRevision: number;
  currentRevisionId: string | null;
  duplicatedFromId: string | null;
  createdAt: Date;
  updatedAt: Date;
  usageCount: number;
}

function toSummary(row: SummaryRow): NarratorPromptTemplateSummary {
  return {
    id: row.id,
    name: row.name,
    notes: row.notes,
    currentRevision: row.currentRevision,
    currentRevisionId: row.currentRevisionId ?? "",
    usageCount: row.usageCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    duplicatedFromId: row.duplicatedFromId,
  };
}

/**
 * The owner's ACTIVE templates, newest-edited first, each with the number of
 * conversations currently selecting it (which is what the editor's "Used by 3
 * conversations" warning is counting before a save re-points them).
 *
 * A LEFT JOIN + GROUP BY rather than a correlated subquery, deliberately: a
 * drizzle single-table select renders its columns UNQUALIFIED, so a correlated
 * subquery written the obvious way silently correlates against nothing and every
 * count comes back the same wrong number (the drizzle gotcha that has already
 * cost this repository a bug). A join has no hidden correlation to get wrong.
 * The join predicate carries `owner_id` as well, so even a cross-owner selection
 * written by some future bug cannot inflate an owner's count.
 */
export async function listNarratorPromptTemplates(ownerId: string): Promise<NarratorPromptTemplateSummary[]> {
  const rows = await db()
    .select({ ...summaryColumns, usageCount: count(characterChats.id) })
    .from(narratorPromptTemplates)
    .leftJoin(
      characterChats,
      and(
        eq(characterChats.narratorPromptTemplateId, narratorPromptTemplates.id),
        eq(characterChats.ownerId, ownerId),
      ),
    )
    .where(and(eq(narratorPromptTemplates.ownerId, ownerId), isNull(narratorPromptTemplates.deletedAt)))
    .groupBy(narratorPromptTemplates.id)
    .orderBy(desc(narratorPromptTemplates.updatedAt));
  return rows.map(toSummary);
}

/**
 * One active template with its current body — what the editor pane loads.
 *
 * `null` for a template that is not this owner's, is soft-deleted, or whose
 * current revision row does not resolve. All three collapse to the same answer
 * on purpose: the route turns it into one 404, so a probe cannot tell a foreign
 * id from a missing one.
 */
export async function getNarratorPromptTemplate(
  ownerId: string,
  templateId: string,
): Promise<NarratorPromptTemplateDetail | null> {
  const [row] = await db()
    .select({
      ...summaryColumns,
      usageCount: count(characterChats.id),
      body: narratorPromptRevisions.body,
      bodyHash: narratorPromptRevisions.bodyHash,
      templateLanguage: narratorPromptRevisions.templateLanguage,
    })
    .from(narratorPromptTemplates)
    .innerJoin(narratorPromptRevisions, eq(narratorPromptRevisions.id, narratorPromptTemplates.currentRevisionId))
    .leftJoin(
      characterChats,
      and(
        eq(characterChats.narratorPromptTemplateId, narratorPromptTemplates.id),
        eq(characterChats.ownerId, ownerId),
      ),
    )
    .where(
      and(
        eq(narratorPromptTemplates.id, templateId),
        eq(narratorPromptTemplates.ownerId, ownerId),
        isNull(narratorPromptTemplates.deletedAt),
      ),
    )
    .groupBy(narratorPromptTemplates.id, narratorPromptRevisions.id)
    .limit(1);
  if (!row) return null;

  // The drizzle enum is type-level only, so the column is a trust boundary like
  // any other stored string: an unknown language is not rendered as `plain_v0`
  // by guess. The editor simply cannot open a body it does not know how to
  // interpret (docs/resilience.md §1).
  const language = parseOrNull(narratorPromptLanguageSchema, row.templateLanguage);
  if (language === null) return null;

  return { ...toSummary(row), body: row.body, bodyHash: row.bodyHash, templateLanguage: language };
}

/** Active names for this owner — the input `duplicateNarratorPromptName` de-collides against. */
async function activeNames(ownerId: string): Promise<string[]> {
  const rows = await db()
    .select({ name: narratorPromptTemplates.name })
    .from(narratorPromptTemplates)
    .where(and(eq(narratorPromptTemplates.ownerId, ownerId), isNull(narratorPromptTemplates.deletedAt)));
  return rows.map((row) => row.name);
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Run `write` and translate the one database refusal that is an expected product
 * outcome rather than a fault: the partial `lower(name)` unique index rejecting a
 * name another ACTIVE template of this owner already holds. Everything else
 * propagates — a broken query is a bug, and swallowing it as "name taken" would
 * hide it behind a plausible-looking form error.
 */
/**
 * Postgres `unique_violation`, walking the cause chain the driver wraps errors in.
 *
 * Deliberately NOT imported from `@/server/api`, which owns the same predicate.
 * That barrel pulls the route and auth layer in behind it, and a persistence
 * service has no business dragging authentication into its module graph — the
 * concrete symptom is that any test mocking `db()` at module scope then explodes
 * on `server/auth`'s load-time database read, several imports away from anything
 * it meant to exercise. Six lines here is the cheaper half of that trade.
 */
const UNIQUE_VIOLATION = "23505";

function isNameCollision(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 6 && current !== null && typeof current === "object"; depth += 1) {
    if ((current as { code?: unknown }).code === UNIQUE_VIOLATION) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

async function catchingNameCollision<T>(
  write: () => Promise<NarratorPromptResult<T>>,
): Promise<NarratorPromptResult<T>> {
  try {
    return await write();
  } catch (err) {
    if (isNameCollision(err)) return { ok: false, code: NARRATOR_PROMPT_NAME_TAKEN_CODE };
    throw err;
  }
}

/**
 * Insert a template and its revision 1 inside ONE transaction, so a template can
 * never be committed without the body that explains it.
 *
 * The template lands at revision 0 with a null pointer, the revision is inserted,
 * and the pointer is set last — the same three steps a save runs, which is why
 * `current_revision` and `current_revision_id` are only ever observed in
 * agreement from outside a transaction.
 */
async function insertTemplateWithFirstRevision(input: {
  ownerId: string;
  name: string;
  notes: string;
  body: string;
  duplicatedFromId: string | null;
}): Promise<string> {
  return db().transaction(async (tx) => {
    const [template] = await tx
      .insert(narratorPromptTemplates)
      .values({
        ownerId: input.ownerId,
        name: input.name,
        notes: input.notes,
        currentRevision: 0,
        currentRevisionId: null,
        duplicatedFromId: input.duplicatedFromId,
      })
      .returning({ id: narratorPromptTemplates.id });
    if (!template) throw new Error("narrator prompt template insert returned no row");

    const [revision] = await tx
      .insert(narratorPromptRevisions)
      .values({
        templateId: template.id,
        revision: 1,
        body: input.body,
        bodyHash: narratorPromptBodyHash(input.body, CURRENT_TEMPLATE_LANGUAGE),
        templateLanguage: CURRENT_TEMPLATE_LANGUAGE,
      })
      .returning({ id: narratorPromptRevisions.id });
    if (!revision) throw new Error("narrator prompt revision insert returned no row");

    await tx
      .update(narratorPromptTemplates)
      .set({ currentRevision: 1, currentRevisionId: revision.id })
      .where(and(eq(narratorPromptTemplates.id, template.id), eq(narratorPromptTemplates.ownerId, input.ownerId)));

    return template.id;
  });
}

export async function createNarratorPromptTemplate(
  ownerId: string,
  request: CreateNarratorPromptRequest,
): Promise<NarratorPromptResult<NarratorPromptTemplateDetail>> {
  return catchingNameCollision<NarratorPromptTemplateDetail>(async () => {
    const templateId = await insertTemplateWithFirstRevision({
      ownerId,
      name: request.name,
      notes: request.notes,
      body: request.body,
      duplicatedFromId: null,
    });
    const detail = await getNarratorPromptTemplate(ownerId, templateId);
    return detail === null ? { ok: false, code: "not_found" } : { ok: true, value: detail };
  });
}

/**
 * Save revision `baseRevision + 1` — the optimistic-concurrency path (plan §8).
 *
 * The whole race is closed by step 1's **conditional UPDATE**, which is a
 * compare-and-swap: it claims `base + 1` only while the committed row still says
 * `current_revision = base`. At READ COMMITTED the second of two concurrent
 * saves re-evaluates that predicate against the row the winner committed, finds
 * `base + 1`, matches zero rows, and is reported as `prompt_conflict`. There is
 * therefore no `SELECT … FOR UPDATE` and no SERIALIZABLE isolation here, and
 * adding either would be a misreading of why this is already correct.
 *
 * `UNIQUE(template_id, revision)` on the revision insert is the integrity
 * backstop for a future code path that bypasses this one — not the lock.
 */
export async function saveNarratorPromptRevision(
  ownerId: string,
  templateId: string,
  request: SaveNarratorPromptRequest,
): Promise<NarratorPromptResult<NarratorPromptTemplateDetail>> {
  return catchingNameCollision<NarratorPromptTemplateDetail>(async () => {
    const claim = await db().transaction(
      async (tx): Promise<NarratorPromptResult<string>> => {
        // 1. Compare-and-swap. The name/notes edits ride the same statement, so a
        //    losing save cannot rename a template it failed to add a revision to.
        const claimed = await tx
          .update(narratorPromptTemplates)
          .set({
            currentRevision: request.baseRevision + 1,
            ...(request.name === undefined ? {} : { name: request.name }),
            ...(request.notes === undefined ? {} : { notes: request.notes }),
          })
          .where(
            and(
              eq(narratorPromptTemplates.id, templateId),
              eq(narratorPromptTemplates.ownerId, ownerId),
              isNull(narratorPromptTemplates.deletedAt),
              eq(narratorPromptTemplates.currentRevision, request.baseRevision),
            ),
          )
          .returning({ id: narratorPromptTemplates.id });

        if (!claimed[0]) {
          // Zero rows means one of two different stories. Re-read inside the
          // transaction to tell them apart: a row that is still there and still
          // this owner's lost the race; anything else is a 404.
          const [current] = await tx
            .select({ currentRevision: narratorPromptTemplates.currentRevision })
            .from(narratorPromptTemplates)
            .where(
              and(
                eq(narratorPromptTemplates.id, templateId),
                eq(narratorPromptTemplates.ownerId, ownerId),
                isNull(narratorPromptTemplates.deletedAt),
              ),
            )
            .limit(1);
          if (!current) return { ok: false, code: "not_found" };
          return {
            ok: false,
            code: NARRATOR_PROMPT_CONFLICT_CODE,
            currentRevision: current.currentRevision,
          };
        }

        // 2. The immutable body. Nothing ever updates this row again.
        const [revision] = await tx
          .insert(narratorPromptRevisions)
          .values({
            templateId,
            revision: request.baseRevision + 1,
            body: request.body,
            bodyHash: narratorPromptBodyHash(request.body, CURRENT_TEMPLATE_LANGUAGE),
            templateLanguage: CURRENT_TEMPLATE_LANGUAGE,
          })
          .returning({ id: narratorPromptRevisions.id });
        if (!revision) throw new Error("narrator prompt revision insert returned no row");

        // 3. Re-point the current pointer. Inside the same transaction as step 1,
        //    so `current_revision` and `current_revision_id` are never observed
        //    disagreeing from outside it.
        await tx
          .update(narratorPromptTemplates)
          .set({ currentRevisionId: revision.id })
          .where(and(eq(narratorPromptTemplates.id, templateId), eq(narratorPromptTemplates.ownerId, ownerId)));

        return { ok: true, value: templateId };
      },
    );

    if (!claim.ok) return claim;
    const detail = await getNarratorPromptTemplate(ownerId, claim.value);
    return detail === null ? { ok: false, code: "not_found" } : { ok: true, value: detail };
  });
}

/**
 * Branch an independent experiment (plan §6): a new template id, revision 1
 * holding the source's CURRENT body and notes, `duplicated_from_id` provenance,
 * and no conversations attached.
 *
 * The copy shares nothing with its source afterwards. Revision history explains
 * what a template used to say; duplication is how a variant diverges.
 */
export async function duplicateNarratorPromptTemplate(
  ownerId: string,
  templateId: string,
  request: DuplicateNarratorPromptRequest,
): Promise<NarratorPromptResult<NarratorPromptTemplateDetail>> {
  const source = await getNarratorPromptTemplate(ownerId, templateId);
  if (source === null) return { ok: false, code: "not_found" };

  const name = request.name ?? duplicateNarratorPromptName(source.name, await activeNames(ownerId));
  return catchingNameCollision<NarratorPromptTemplateDetail>(async () => {
    const copyId = await insertTemplateWithFirstRevision({
      ownerId,
      name,
      notes: source.notes,
      body: source.body,
      duplicatedFromId: source.id,
    });
    const detail = await getNarratorPromptTemplate(ownerId, copyId);
    return detail === null ? { ok: false, code: "not_found" } : { ok: true, value: detail };
  });
}

/**
 * Soft delete (plan §7): hide the template, and clear it from every conversation
 * of this owner currently selecting it, in ONE transaction.
 *
 * Clearing the selections is the load-bearing half. `ON DELETE SET NULL` on the
 * chat column only fires for a genuine hard delete, which this is not — without
 * this UPDATE the chats would keep pointing at a hidden template and every
 * exchange would take the degraded fallback path forever instead of simply being
 * back on production instructions. The immutable revisions are deliberately left
 * alone so a take generated last week can still say which text produced it.
 */
export async function softDeleteNarratorPromptTemplate(
  ownerId: string,
  templateId: string,
): Promise<NarratorPromptResult<NarratorPromptDeleteOutcome>> {
  return db().transaction(async (tx): Promise<NarratorPromptResult<NarratorPromptDeleteOutcome>> => {
    const [deleted] = await tx
      .update(narratorPromptTemplates)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(narratorPromptTemplates.id, templateId),
          eq(narratorPromptTemplates.ownerId, ownerId),
          isNull(narratorPromptTemplates.deletedAt),
        ),
      )
      .returning({ id: narratorPromptTemplates.id });
    if (!deleted) return { ok: false, code: "not_found" };

    const cleared = await tx
      .update(characterChats)
      .set({ narratorPromptTemplateId: null })
      .where(
        and(
          eq(characterChats.narratorPromptTemplateId, templateId),
          eq(characterChats.ownerId, ownerId),
        ),
      )
      .returning({ id: characterChats.id });

    return { ok: true, value: { templateId, clearedChatIds: cleared.map((row) => row.id) } };
  });
}
