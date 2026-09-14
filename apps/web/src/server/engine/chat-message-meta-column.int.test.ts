import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isNarratorInput, parseChatMessageMeta, userLineMeta } from "@/contracts/turns/chat-message-meta";
import { characterChatMessages, db } from "@/server/db";
import {
  dropChatFixture,
  emptyChatFixture,
  newChat,
  probeIntegrationDb,
  seedChatFixture,
  type ChatFixture,
} from "@/server/test-support";
import { mergeMessageMetaColumn } from "./chat-reply-store";

/**
 * `mergeMessageMetaColumn` — the in-place `meta` merge (#193).
 *
 * The defect it kills is a live one: persisting the batched vision read for a
 * line's photos used to `.set({ meta: { attachments: … } })`, REPLACING the
 * whole bag. Every other key on the row went with it, `inputMode` first — so a
 * rerun of a saved NARRATOR line came back as ordinary player speech, and any
 * key a newer deploy had written was silently deleted by an older one.
 *
 * Only a database can prove the fix. The merge is Postgres's own `jsonb ||`
 * inside the UPDATE — chosen over read-modify-write precisely because the
 * latter has a window between the SELECT and the UPDATE in which a concurrent
 * writer's keys are read stale and written back — so the statement itself is
 * the contract: its shallow top-level semantics, its `jsonb_typeof` guard
 * against a degenerate stored bag, and its chat scoping. A pure test of
 * `mergeChatMessageMeta` proves none of that: this write path never calls it.
 */

const ready = await probeIntegrationDb("chat-message-meta-column.int.test", "character_chat_messages");

let fixture: ChatFixture = emptyChatFixture();

beforeAll(async () => {
  if (!ready) return;
  fixture = await seedChatFixture({ slug: "chat-meta-column-int", userName: "Meta Column Int" });
});

afterAll(async () => {
  await dropChatFixture(fixture);
});

/** The bag as the column actually holds it — no parse in between. */
async function storedMeta(messageId: string): Promise<unknown> {
  const [row] = await db()
    .select({ meta: characterChatMessages.meta })
    .from(characterChatMessages)
    .where(eq(characterChatMessages.id, messageId))
    .limit(1);
  return row?.meta;
}

describe.runIf(ready)("mergeMessageMetaColumn", () => {
  it("adds the vision read and keeps every other key — the narrator-line data-loss regression", async () => {
    const seat = await newChat(fixture);
    await db()
      .update(characterChatMessages)
      .set({
        // The register this write must not lose, a lane marker, a stored version,
        // and a key this build does not model at all.
        meta: { inputMode: "narrator", simTurn: true, v: 2, writtenByANewerDeploy: { nested: true } },
      })
      .where(eq(characterChatMessages.id, seat.messageId));

    await mergeMessageMetaColumn(
      seat.chatId,
      seat.messageId,
      userLineMeta({ attachmentIds: ["img_1"], attachmentDescriptions: ["a cat on a mat"] }),
    );

    const after = await storedMeta(seat.messageId);
    expect(after).toEqual({
      inputMode: "narrator",
      simTurn: true,
      v: 2,
      writtenByANewerDeploy: { nested: true },
      attachments: { ids: ["img_1"], descriptions: ["a cat on a mat"] },
    });
    // The read seam the rerun goes through still says narrator — the whole point.
    expect(isNarratorInput(parseChatMessageMeta(after))).toBe(true);
  });

  it("replaces the named key WHOLE, so ids and descriptions can never disagree", async () => {
    const seat = await newChat(fixture);
    await db()
      .update(characterChatMessages)
      .set({ meta: { attachments: { ids: ["img_1", "img_2"], descriptions: ["one", "two"] } } })
      .where(eq(characterChatMessages.id, seat.messageId));

    await mergeMessageMetaColumn(seat.chatId, seat.messageId, userLineMeta({ attachmentIds: ["img_3"] }));

    // `||` is SHALLOW: the new `attachments` object supersedes the old one rather
    // than merging into it, so a stale `descriptions` cannot outlive the ids it
    // described and be read back as this line's photo captions.
    expect(await storedMeta(seat.messageId)).toEqual({ attachments: { ids: ["img_3"] } });
  });

  it("treats a stored bag that is not a JSON object as empty rather than losing the write", async () => {
    const seat = await newChat(fixture);
    await db().execute(
      sql`update ${characterChatMessages} set meta = '"not-a-bag"'::jsonb where id = ${seat.messageId}`,
    );

    await mergeMessageMetaColumn(seat.chatId, seat.messageId, userLineMeta({ inputMode: "narrator" }));

    // A degenerate bag costs its own unreadable contents, never the write:
    // `'"not-a-bag"'::jsonb || '{…}'::jsonb` would have raised instead.
    expect(await storedMeta(seat.messageId)).toEqual({ inputMode: "narrator" });
  });

  it("is scoped to the conversation — a write addressed to another chat lands nowhere", async () => {
    const seat = await newChat(fixture);
    const other = await newChat(fixture);

    await mergeMessageMetaColumn(other.chatId, seat.messageId, userLineMeta({ inputMode: "narrator" }));

    // The message id alone must not be enough: the statement's `chat_id`
    // predicate is what keeps a mis-addressed write from editing a row in a
    // conversation the caller never named.
    expect(await storedMeta(seat.messageId)).toEqual({});
    expect(await storedMeta(other.messageId)).toEqual({});
  });
});
