import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import { NARRATOR_INSTRUCTION_FALLBACK_CODE } from "@/contracts/narrator-prompts";
import { expectCleanSink, expectDiagnostic } from "@/test/diagnostics";
import { endTestPool, probeIntegrationDb, purgeOwnerRows, seedTestUser } from "@/server/test-support";
import { characterChats, db, narratorPromptRevisions, narratorPromptTemplates } from "../db";
import {
  createNarratorPromptTemplate,
  duplicateNarratorPromptTemplate,
  getNarratorPromptTemplate,
  listNarratorPromptTemplates,
  saveNarratorPromptRevision,
  softDeleteNarratorPromptTemplate,
} from "./templates";
import { resolveNarratorInstructionSource, setChatNarratorPromptSelection } from "./selection";

/**
 * The Prompt Lab's persistence layer against a real database: CRUD/revision
 * integration tests prove no cross-owner read/write and no stale-save
 * overwrite.
 *
 * Four claims, none of which can be proven without Postgres, and each naming the
 * bad implementation it kills:
 *
 * 1. **The compare-and-swap really swaps.** A save from a stale base is refused
 *    AND writes no revision. Falsified against the obvious implementation —
 *    read `current_revision`, then write `current_revision + 1` — which passes
 *    every single-threaded test and loses one editor's work the first time two
 *    tabs save.
 * 2. **Owner scoping is on the row, not the session.** Every read and every
 *    write refuses another owner's template. This is an admin surface, so the
 *    role check lets the caller in; only these predicates decide whose prompts
 *    they get.
 * 3. **Soft delete cannot dead-end a conversation.** The delete clears live
 *    selections in the same transaction, and a chat that still points at a
 *    deleted template (the select-during-delete race) resolves to production
 *    instructions plus the documented diagnostic rather than throwing.
 * 4. **A duplicate is independent.** Editing the copy leaves the source's
 *    revision chain alone — the whole reason duplication exists beside history.
 * 5. **Selections are per-conversation** (slice 7 hardening). Two chats of one
 *    owner hold independent selections, each resolves its own template at its
 *    template's NEWEST revision after a save (the selection follows the head,
 *    never a pinned revision), and a delete clears exactly the chats that
 *    selected the deleted template.
 *
 * Service-level rather than route-level on purpose: the routes are thin, and
 * `withOwnerAdmin*` already has its own unit coverage. What is new here is SQL
 * semantics, and SQL semantics is what this suite tests.
 */

const ready = await probeIntegrationDb("narrator-prompts.int.test", "narrator_prompt_templates");

const ids = { ownerA: "", ownerB: "", chatA: "", chatB: "" };

async function createTemplate(ownerId: string, name: string, body: string): Promise<string> {
  const created = await createNarratorPromptTemplate(ownerId, { name, notes: "hypothesis", body });
  if (!created.ok) throw new Error(`fixture template "${name}" was refused: ${created.code}`);
  return created.value.id;
}

async function revisionNumbers(templateId: string): Promise<number[]> {
  const rows = await db()
    .select({ revision: narratorPromptRevisions.revision })
    .from(narratorPromptRevisions)
    .where(eq(narratorPromptRevisions.templateId, templateId))
    .orderBy(asc(narratorPromptRevisions.revision));
  return rows.map((row) => row.revision);
}

async function storedSelection(chatId: string): Promise<string | null> {
  const [row] = await db()
    .select({ promptId: characterChats.narratorPromptTemplateId })
    .from(characterChats)
    .where(eq(characterChats.id, chatId))
    .limit(1);
  return row?.promptId ?? null;
}

beforeAll(async () => {
  if (!ready) return;
  const [ownerA, ownerB] = await Promise.all([
    seedTestUser("narrator-prompts-int-a", { name: "Prompt Owner A", role: "admin" }),
    seedTestUser("narrator-prompts-int-b", { name: "Prompt Owner B", role: "admin" }),
  ]);
  ids.ownerA = ownerA.id;
  ids.ownerB = ownerB.id;

  const chats = await db()
    .insert(characterChats)
    .values([{ ownerId: ownerA.id }, { ownerId: ownerB.id }])
    .returning({ id: characterChats.id, ownerId: characterChats.ownerId });
  ids.chatA = chats.find((chat) => chat.ownerId === ownerA.id)?.id ?? "";
  ids.chatB = chats.find((chat) => chat.ownerId === ownerB.id)?.id ?? "";
  if (ids.chatA === "" || ids.chatB === "") throw new Error("narrator prompt fixture chats were not seeded");
});

afterAll(async () => {
  // Templates and revisions cascade from `users`, which `purgeOwnerRows` deletes
  // last; the chats it removes earlier only SET NULL on the way out.
  await purgeOwnerRows([ids.ownerA, ids.ownerB]);
  await endTestPool();
});

describe.skipIf(!ready)("narrator prompt revision concurrency", () => {
  it("refuses a save from a stale base and writes no revision for it", async () => {
    const templateId = await createTemplate(ids.ownerA, "Stale base", "revision one body");

    const winner = await saveNarratorPromptRevision(ids.ownerA, templateId, {
      body: "revision two body",
      baseRevision: 1,
    });
    expect(winner.ok && winner.value.currentRevision).toBe(2);

    // The second tab still believes revision 1 is current. It must lose, and it
    // must lose BEFORE the revision insert — a conflict reported after a
    // successful insert would leave a forked chain behind.
    const stale = await saveNarratorPromptRevision(ids.ownerA, templateId, {
      body: "clobbering body",
      baseRevision: 1,
    });
    expect(stale).toEqual({ ok: false, code: "prompt_conflict", currentRevision: 2 });
    expect(await revisionNumbers(templateId)).toEqual([1, 2]);

    // The winner's body is what the editor reloads, and the pointer agrees with
    // the number — the invariant the three-statement transaction exists for.
    const reloaded = await getNarratorPromptTemplate(ids.ownerA, templateId);
    expect(reloaded?.body).toBe("revision two body");
    expect(reloaded?.currentRevision).toBe(2);
    expect(reloaded?.currentRevisionId).not.toBe("");
  });
});

describe.skipIf(!ready)("narrator prompt owner isolation", () => {
  it("refuses every cross-owner read and write", async () => {
    const templateId = await createTemplate(ids.ownerA, "Owner A only", "owner A body");

    expect(await getNarratorPromptTemplate(ids.ownerB, templateId)).toBeNull();
    expect((await listNarratorPromptTemplates(ids.ownerB)).map((row) => row.id)).not.toContain(templateId);

    expect(await saveNarratorPromptRevision(ids.ownerB, templateId, { body: "stolen", baseRevision: 1 })).toEqual({
      ok: false,
      code: "not_found",
    });
    expect(await duplicateNarratorPromptTemplate(ids.ownerB, templateId, {})).toEqual({
      ok: false,
      code: "not_found",
    });
    expect(await softDeleteNarratorPromptTemplate(ids.ownerB, templateId)).toEqual({
      ok: false,
      code: "not_found",
    });
    // A template id in a PATCH body is not evidence of ownership either.
    expect(await setChatNarratorPromptSelection(ids.ownerB, ids.chatB, templateId)).toEqual({
      ok: false,
      code: "not_found",
    });
    // Nor is a CHAT id: owner A cannot point another account's conversation at
    // A's own perfectly-owned template. The template predicate above cannot
    // refuse this one — only the ownerId in the UPDATE's WHERE does.
    expect(await setChatNarratorPromptSelection(ids.ownerA, ids.chatB, templateId)).toEqual({
      ok: false,
      code: "not_found",
    });

    // Every refusal above must have been a no-op, not a partial write.
    const survivor = await getNarratorPromptTemplate(ids.ownerA, templateId);
    expect(survivor?.currentRevision).toBe(1);
    expect(survivor?.body).toBe("owner A body");
    expect(await storedSelection(ids.chatB)).toBeNull();
  });
});

describe.skipIf(!ready)("narrator prompt soft delete", () => {
  it("clears live selections, and a stranded selection degrades to production with a diagnostic", async () => {
    const templateId = await createTemplate(ids.ownerA, "Deleted mid-experiment", "test instructions");
    expect(await setChatNarratorPromptSelection(ids.ownerA, ids.chatA, templateId)).toMatchObject({ ok: true });

    const live = new DiagnosticCollector();
    const selected = await resolveNarratorInstructionSource(ids.ownerA, ids.chatA, live);
    expect(selected).toMatchObject({ kind: "test", templateId, revision: 1, body: "test instructions" });
    expectCleanSink(live);

    const deleted = await softDeleteNarratorPromptTemplate(ids.ownerA, templateId);
    expect(deleted.ok && deleted.value.clearedChatIds).toEqual([ids.chatA]);
    expect(await storedSelection(ids.chatA)).toBeNull();

    // Cleared, so the next exchange is plainly back on production — no
    // degradation, and therefore nothing to report.
    const cleared = new DiagnosticCollector();
    expect(await resolveNarratorInstructionSource(ids.ownerA, ids.chatA, cleared)).toEqual({
      kind: "production",
      instructionHash: "",
    });
    expectCleanSink(cleared);

    // The race the FK and the clearing UPDATE both exist to survive: a chat that
    // selected the template between the delete's two statements. Writing the
    // column directly is the only way to reach that state, and it is the state
    // the plan promises never dead-ends a conversation.
    await db()
      .update(characterChats)
      .set({ narratorPromptTemplateId: templateId })
      .where(eq(characterChats.id, ids.chatA));

    const stranded = new DiagnosticCollector();
    expect(await resolveNarratorInstructionSource(ids.ownerA, ids.chatA, stranded)).toEqual({
      kind: "production",
      instructionHash: "",
    });
    expectDiagnostic(stranded, NARRATOR_INSTRUCTION_FALLBACK_CODE);
    expect(stranded.items[0]?.context).toMatchObject({ reason: "template_deleted", templateId });

    // The revisions outlive the delete, so a take generated before it can still
    // be explained by the exact text that produced it.
    expect(await revisionNumbers(templateId)).toEqual([1]);
    await db()
      .update(characterChats)
      .set({ narratorPromptTemplateId: null })
      .where(eq(characterChats.id, ids.chatA));
  });
});

describe.skipIf(!ready)("narrator prompt duplication", () => {
  it("branches an independent experiment that the source never sees", async () => {
    const sourceId = await createTemplate(ids.ownerA, "Origin", "origin body");

    const copy = await duplicateNarratorPromptTemplate(ids.ownerA, sourceId, {});
    expect(copy.ok).toBe(true);
    if (!copy.ok) return;
    expect(copy.value).toMatchObject({
      name: "Origin — Copy",
      body: "origin body",
      currentRevision: 1,
      duplicatedFromId: sourceId,
      usageCount: 0,
    });
    expect(copy.value.id).not.toBe(sourceId);

    const edited = await saveNarratorPromptRevision(ids.ownerA, copy.value.id, {
      body: "diverged body",
      baseRevision: 1,
    });
    expect(edited.ok && edited.value.currentRevision).toBe(2);

    const source = await getNarratorPromptTemplate(ids.ownerA, sourceId);
    expect(source?.currentRevision).toBe(1);
    expect(source?.body).toBe("origin body");
    expect(await revisionNumbers(sourceId)).toEqual([1]);

    // Duplicating the SAME source again de-collides the derived name instead of
    // refusing — branching several variants off one origin is the normal
    // workflow, and "— Copy" being taken must not dead-end it.
    const second = await duplicateNarratorPromptTemplate(ids.ownerA, sourceId, {});
    expect(second.ok && second.value.name).toBe("Origin — Copy 2");
  });
});

describe.skipIf(!ready)("narrator prompt active-name uniqueness", () => {
  it("refuses a second active template with the same name in any casing", async () => {
    await createTemplate(ids.ownerA, "Player Agency Minimal", "body");

    expect(
      await createNarratorPromptTemplate(ids.ownerA, {
        name: "player agency MINIMAL",
        notes: "",
        body: "another body",
      }),
    ).toEqual({ ok: false, code: "prompt_name_taken" });

    // Owner-scoped, so the same name is free for a different account — the
    // partial index is on (owner_id, lower(name)), not on the name alone.
    const otherOwner = await createNarratorPromptTemplate(ids.ownerB, {
      name: "Player Agency Minimal",
      notes: "",
      body: "owner B body",
    });
    expect(otherOwner.ok).toBe(true);
  });

  it("frees the name for reuse once its holder is soft-deleted", async () => {
    const holderId = await createTemplate(ids.ownerA, "Freed By Delete", "body");
    // The control arm: while the holder is active, every casing is refused.
    expect(
      await createNarratorPromptTemplate(ids.ownerA, { name: "FREED by delete", notes: "", body: "b" }),
    ).toEqual({ ok: false, code: "prompt_name_taken" });

    const deleted = await softDeleteNarratorPromptTemplate(ids.ownerA, holderId);
    expect(deleted.ok).toBe(true);

    // The index is partial over `deleted_at IS NULL`, so the delete released the
    // name — the documented workflow. Falsified by "tidying" the partial
    // expression index into a plain UNIQUE(owner_id, lower(name)); drizzle-kit
    // cannot diff a changed index expression, so only a test notices that drift.
    const recreated = await createNarratorPromptTemplate(ids.ownerA, {
      name: "Freed By Delete",
      notes: "",
      body: "new body",
    });
    expect(recreated.ok).toBe(true);
  });
});

describe.skipIf(!ready)("narrator prompt parallel-chat isolation", () => {
  /**
   * The A/B workflow the Prompt Lab exists for: two conversations with the same
   * owner (and, in product terms, the same character) run different instruction
   * experiments at the same time without touching one another.
   *
   * Kills two implementations that pass every single-chat test: a selection
   * write whose WHERE under-matches (re-pointing every chat of the owner), and a
   * resolution that pins the revision at selection time instead of following the
   * template head — which would silently keep old instructions running after the
   * owner saves, exactly the "which build produced which result?" confusion the
   * Lab is meant to end.
   */
  it("two chats select independently, follow their own template's head, and a delete clears only its own", async () => {
    const [chat2] = await db()
      .insert(characterChats)
      .values({ ownerId: ids.ownerA })
      .returning({ id: characterChats.id });
    if (!chat2) throw new Error("second fixture chat was not seeded");
    const templateA = await createTemplate(ids.ownerA, "Parallel A", "body A");
    const templateB = await createTemplate(ids.ownerA, "Parallel B", "body B");

    expect(await setChatNarratorPromptSelection(ids.ownerA, ids.chatA, templateA)).toMatchObject({ ok: true });
    expect(await setChatNarratorPromptSelection(ids.ownerA, chat2.id, templateB)).toMatchObject({ ok: true });

    // Same owner, same moment: each conversation resolves ITS template.
    expect(await resolveNarratorInstructionSource(ids.ownerA, ids.chatA)).toMatchObject({
      kind: "test",
      templateId: templateA,
      body: "body A",
    });
    expect(await resolveNarratorInstructionSource(ids.ownerA, chat2.id)).toMatchObject({
      kind: "test",
      templateId: templateB,
      body: "body B",
    });

    // Re-pointing one conversation leaves the other alone.
    expect(await setChatNarratorPromptSelection(ids.ownerA, ids.chatA, null)).toMatchObject({ ok: true });
    expect(await storedSelection(chat2.id)).toBe(templateB);
    expect(await setChatNarratorPromptSelection(ids.ownerA, ids.chatA, templateA)).toMatchObject({ ok: true });

    // A save moves the head, and the NEXT resolution follows it — for the chats
    // selecting that template and no others.
    const saved = await saveNarratorPromptRevision(ids.ownerA, templateB, { body: "body B v2", baseRevision: 1 });
    expect(saved.ok && saved.value.currentRevision).toBe(2);
    expect(await resolveNarratorInstructionSource(ids.ownerA, chat2.id)).toMatchObject({
      kind: "test",
      templateId: templateB,
      revision: 2,
      body: "body B v2",
    });
    expect(await resolveNarratorInstructionSource(ids.ownerA, ids.chatA)).toMatchObject({
      kind: "test",
      templateId: templateA,
      revision: 1,
      body: "body A",
    });

    // Deleting one experiment clears exactly its own conversations.
    const deleted = await softDeleteNarratorPromptTemplate(ids.ownerA, templateA);
    expect(deleted.ok && deleted.value.clearedChatIds).toEqual([ids.chatA]);
    expect(await storedSelection(ids.chatA)).toBeNull();
    expect(await storedSelection(chat2.id)).toBe(templateB);
    expect(await resolveNarratorInstructionSource(ids.ownerA, chat2.id)).toMatchObject({
      kind: "test",
      templateId: templateB,
      revision: 2,
    });

    // Leave the shared fixture chats unselected for any later suite additions.
    await db()
      .update(characterChats)
      .set({ narratorPromptTemplateId: null })
      .where(eq(characterChats.id, chat2.id));
  });
});
