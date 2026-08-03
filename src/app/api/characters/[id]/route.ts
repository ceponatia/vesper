import type { NextRequest } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import {
  characterProfileSchema,
  emptyCharacterProfile,
  materializeBodyDefaults,
} from "@/contracts";
import { parseOr } from "@/lib/parse";
import { characterChats, characters, chatParticipants, db, images } from "@/server/db";
import { deleteChat } from "@/server/engine";
import {
  characterPatchSchema,
  deleteEntityImages,
  findViewable,
  jsonError,
  jsonOk,
  queueEmbedRefresh,
  readBody,
  toPublicCharacter,
  toPublicEntityImage,
  withUser,
} from "@/server/api";
import { findOwnedCharacter } from "./owned";

type Params = { id: string };

export const GET = withUser<Params>(async (user, _req, ctx) => {
  const { id } = await ctx.params;
  // Owner-or-public read (the browse/preview/copy path); private non-owned ⇒ 404.
  const row = await findViewable("character", id, user.id);
  if (!row) return jsonError("not_found", "character not found", 404);
  // Portraits scope to the entity owner so a public preview shows the author's art.
  const portraitRows = await db()
    .select()
    .from(images)
    .where(and(eq(images.ownerId, row.ownerId), eq(images.entityKind, "character"), eq(images.entityId, id)))
    .orderBy(desc(images.createdAt));
  // The strip here is a render list, so it ships the public image shape for
  // EVERY viewer (security-authz.plan.md slice 4): no client reads `path`,
  // `prompt` or the provider internals from this response — the portrait studio
  // loads full rows from the owner-strict `GET /characters/:id/portraits`.
  const portraits = portraitRows.map(toPublicEntityImage);
  // `mine` — read-only preview + duplicate CTA for foreign public rows (the
  // item/location slice-6 pattern; edits would 404 server-side anyway). A
  // foreign viewer gets the allow-listed public representation, not the row.
  const mine = row.ownerId === user.id;
  return jsonOk({ character: mine ? row : toPublicCharacter(row), portraits, mine });
});

export const PATCH = withUser<Params>(async (user, req: NextRequest, ctx) => {
  const { id } = await ctx.params;
  const body = await readBody(req, characterPatchSchema);
  if (!body.ok) return body.response;
  const existing = await findOwnedCharacter(id, user.id);
  if (!existing) return jsonError("not_found", "character not found", 404);

  const update: Partial<typeof characters.$inferInsert> = {};
  if (body.value.name !== undefined) update.name = body.value.name;
  if (body.value.tags !== undefined) update.tags = body.value.tags;
  if (body.value.visibility !== undefined) update.visibility = body.value.visibility;
  if (body.value.chatModel !== undefined) update.chatModel = body.value.chatModel;
  if (body.value.profile !== undefined) {
    const current = parseOr(characterProfileSchema, existing.profile, emptyCharacterProfile(), undefined, "characters.profile");
    const merged = { ...current, ...body.value.profile };
    // Persisted-baseline facts have no blank state: a PATCH that removed one
    // (or predates one) re-materializes it, fill-only, against the merged
    // profile's own body. Players change the value; the fact stays present.
    update.profile = { ...merged, attributes: materializeBodyDefaults(merged.attributes, merged) };
  }
  if (Object.keys(update).length === 0) return jsonOk({ character: existing });

  const [row] = await db()
    .update(characters)
    .set(update)
    .where(and(eq(characters.id, id), eq(characters.ownerId, user.id)))
    .returning();
  if (!row) return jsonError("not_found", "character not found", 404);
  queueEmbedRefresh("character", id);
  return jsonOk({ character: row });
});

export const DELETE = withUser<Params>(async (user, _req, ctx) => {
  const { id } = await ctx.params;
  const existing = await findOwnedCharacter(id, user.id);
  if (!existing) return jsonError("not_found", "character not found", 404);
  // The character's conversations go through `deleteChat` FIRST (deletion-leak audit,
  // 2026-07-10): deleting the character row alone cascades `chat_participants` +
  // `character_chat_state` away but leaves the chat row, its transcript, and the memory
  // group's facts/episodes orphaned — invisible in the hub (it inner-joins participants)
  // yet fully stored. `deleteChat` owns the purge order (prompt scrub → cascades →
  // last-reference memory purge), so route every referencing chat through it while the
  // participant rows still exist. Today every chat is 1:1; when multi-character chats
  // land, this becomes "remove the participant, delete the chat only when it empties".
  // The join is owner-scoped (security-authz.plan.md slice 2) so an anomalous cross-owner
  // participant row can never route another user's chat into deletion — it is skipped and
  // survives, correctly; `deleteChat` re-proves the pairing anyway.
  const chats = await db()
    .select({ id: characterChats.id })
    .from(chatParticipants)
    .innerJoin(characterChats, eq(characterChats.id, chatParticipants.chatId))
    .where(and(eq(chatParticipants.characterId, id), eq(characterChats.ownerId, user.id)));
  for (const chat of chats) {
    await deleteChat(chat.id, user.id);
  }
  // Worlds/sessions hold their own snapshots (world-instances.plan.md), so a
  // library delete never breaks them and never hits a FK — no in-use guard.
  await db().delete(characters).where(and(eq(characters.id, id), eq(characters.ownerId, user.id)));
  void deleteEntityImages("character", id, user.id).catch(() => undefined);
  return jsonOk({ ok: true });
});
