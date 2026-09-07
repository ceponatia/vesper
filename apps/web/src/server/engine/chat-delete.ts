import { and, eq, isNull, ne } from "drizzle-orm";
import { PROVISIONING_STALE_AFTER_DELETE } from "@vesper/simulation-core/provisioning";
import {
  characterChats,
  chatParticipants,
  chatVisualCues,
  chatVisualMemory,
  db,
  images,
  simBranches,
  simProvisioningRequests,
  simWorlds,
} from "../db";
import { deleteChatAssets } from "../images";
import { log } from "../log";
import { deleteChatMemory } from "./chat-memory";

/**
 * Hard-delete a conversation (archive is the everyday action; this is the one
 * destructive verb). One transaction: the
 * chat row's FK cascades take the transcript, summary, participant rows, and
 * per-participant state; the scene-image prompt text is scrubbed (assets survive
 * in the Gallery, but their prompts embed chat lines — chat-keyed rows scrub
 * per-conversation; legacy rows have no chatId, so those still scrub
 * character-wide, hitting sibling conversations' legacy scenes too); and each
 * participant's memory group is purged **only when no other conversation
 * references it** — shared-history siblings keep the relationship's memory
 * alive.
 *
 * A SUCCESSOR chat takes its whole simulated world with it
 * (owner ruling): the front door is
 * 1:1 chat↔world and nothing else can ever reach that world again, so the
 * `sim_worlds` row is deleted in the same transaction. One statement suffices —
 * `sim_branches` cascades from `sim_worlds` and every branch-scoped table
 * cascades from `sim_branches` — and the chat-side FK's `set null` never fires
 * because the chat row dies in the same tx. Every delete confirm dialog (Worlds
 * page, Chats hub, in-conversation) states that consequence before the call.
 *
 * Its `ready` provisioning records are retired in that same transaction (#197):
 * the ledger's chat/world pointers are soft by design, so nothing else would
 * stop the front door replaying this chat's recorded 201 after it is gone.
 * `pending` and `failed` records are left exactly where they are — the first
 * belongs to a provision still in flight, the second is the failure audit.
 *
 * Ownership is re-read here rather than trusted from the caller: a destructive
 * service takes only ids and
 * proves the pairing itself, so no route-supplied `ownerId` — or an anomalous
 * cross-owner participant row — can route a foreign conversation into deletion.
 * A miss is a warn-level no-op, never a throw (docs/resilience.md).
 */
export async function deleteChat(chatId: string, ownerId: string): Promise<void> {
  const [chat] = await db()
    .select({ id: characterChats.id, ownerId: characterChats.ownerId, simBranchId: characterChats.simBranchId })
    .from(characterChats)
    .where(and(eq(characterChats.id, chatId), eq(characterChats.ownerId, ownerId)))
    .limit(1);
  if (!chat) {
    log.warn("engine.chat", "chat delete denied: no chat matches this owner", {
      code: "chat.delete_denied",
      chatId,
      ownerId,
    });
    return;
  }

  // The linked world, resolved through the branch the chat points at. A dangling
  // link (branch already gone) is a degraded default, not a failure: the chat
  // still deletes, the diagnostic records what was unreachable
  // (docs/resilience.md — diagnostics over exceptions).
  let simWorldId: string | null = null;
  if (chat.simBranchId !== null) {
    const [branch] = await db()
      .select({ worldId: simBranches.worldId })
      .from(simBranches)
      .where(eq(simBranches.id, chat.simBranchId))
      .limit(1);
    if (branch) {
      simWorldId = branch.worldId;
    } else {
      log.warn("engine.chat", "chat links a sim branch that no longer exists; deleting the chat alone", {
        code: "chat.delete_sim_branch_missing",
        chatId: chat.id,
        simBranchId: chat.simBranchId,
      });
    }
  }

  const participants = await db()
    .select({ characterId: chatParticipants.characterId, memoryGroupId: chatParticipants.memoryGroupId })
    .from(chatParticipants)
    .where(eq(chatParticipants.chatId, chat.id));

  // Chat-private assets (player uploads + the look/place render anchors) are chat
  // content, not Gallery assets: hard-delete them BEFORE the chat row goes (the FK
  // would SET NULL their chat_id and strand them invisibly — scenes deliberately
  // survive that way, these must not).
  await deleteChatAssets(chat.id, ["chat_upload", "chat_look", "chat_place"]);

  await db().transaction(async (tx) => {
    await tx.update(images).set({ prompt: "" }).where(eq(images.chatId, chat.id));
    for (const p of participants) {
      await tx
        .update(images)
        .set({ prompt: "" })
        .where(
          and(
            eq(images.ownerId, chat.ownerId),
            eq(images.kind, "scene"),
            eq(images.entityKind, "character"),
            eq(images.entityId, p.characterId),
            isNull(images.chatId),
          ),
        );
    }
    await tx.delete(characterChats).where(eq(characterChats.id, chat.id));
    // E20-1: the world graph goes with the chat that owned it.
    if (simWorldId !== null) await tx.delete(simWorlds).where(eq(simWorlds.id, simWorldId));
    // #197: retire this chat's SUCCESSFUL provisioning records in the same tx, so
    // a re-POST of the original request id cannot replay a 201 naming ids that
    // just died. The front door re-checks the graph anyway; this is the belt —
    // dropping `response`/`http_status` here means there is no recorded 201 left
    // to replay even if that check were removed.
    //
    // The ids stay: `world_id`/`branch_id`/`chat_id` are soft pointers precisely
    // so this ledger can outlive the graph it names (#283 — no cascade FK), and
    // a retired record that still says WHICH world it built is the audit this
    // table exists for. They are also how the front door knows the refusal is
    // still owed: it answers one `provision_stale`, nulls them, and the next POST
    // with that key is an ordinary failed → retry.
    //
    // `ready` ONLY. A pending row belongs to a provision still in flight (the
    // owner lock makes that unreachable here, but the predicate says so rather
    // than relying on it), and a `failed` row is somebody else's failure record.
    // `sim_provisioning_requests` has no FK to this chat, so this plain
    // owner-scoped UPDATE is the only thing that reaches these rows; it matches
    // nothing when the chat is a legacy one, which is why it is safe on every
    // delete rather than only successor ones.
    await tx
      .update(simProvisioningRequests)
      .set({
        state: "failed",
        response: null,
        httpStatus: null,
        error: PROVISIONING_STALE_AFTER_DELETE,
        completedAt: new Date(),
      })
      .where(
        and(
          eq(simProvisioningRequests.ownerId, chat.ownerId),
          eq(simProvisioningRequests.chatId, chat.id),
          eq(simProvisioningRequests.state, "ready"),
        ),
      );
    for (const p of participants) {
      const [survivor] = await tx
        .select({ chatId: chatParticipants.chatId })
        .from(chatParticipants)
        .where(and(eq(chatParticipants.memoryGroupId, p.memoryGroupId), ne(chatParticipants.chatId, chat.id)))
        .limit(1);
      if (!survivor) {
        await deleteChatMemory(p.memoryGroupId, tx);
        // Observer visual memory is memory-group-scoped too (slice 7), so it goes
        // on exactly the same condition: the group's last conversation is gone.
        // `chat_visual_memory` carries no FK — memory groups are not a table — so
        // nothing would cascade it, and orphaned rows would silently resurrect
        // recognition if the group id were ever minted again.
        await tx.delete(chatVisualMemory).where(eq(chatVisualMemory.memoryGroupId, p.memoryGroupId));
        // `chat_visual_cues` is the sibling record for the same observer/subject
        // pair, keyed the same way: memory holds what the observer recognizes,
        // cues hold what the narrator has had in view/said. It carries no FK
        // either, so it goes on the same condition or it orphans the same way.
        await tx.delete(chatVisualCues).where(eq(chatVisualCues.memoryGroupId, p.memoryGroupId));
      }
    }
  });
}
