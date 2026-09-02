import { and, desc, eq, notInArray } from "drizzle-orm";
import {
  characterProfileSchema,
  emptyCharacterProfile,
  materializeBodyDefaults,
  withItemsInDefaultOutfit,
} from "@/contracts";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import { parseOr } from "@/lib/parse";
import { characterChats, characters, chatParticipants, db, images } from "@/server/db";
import { deleteChat } from "@/server/engine";
import { deleteNonGalleryCharacterImages, HIDDEN_IMAGE_KINDS } from "@/server/images";
import {
  characterPatchSchema,
  findViewable,
  jsonError,
  jsonOk,
  materializeSuggestedItems,
  queueEmbedRefresh,
  readBody,
  toPublicCharacter,
  toPublicEntityImage,
  withAuthorizedResource,
} from "@/server/api";
import { findOwnedCharacter } from "./owned";

type Params = { id: string };

export const GET = withAuthorizedResource(
  "character",
  // Owner-or-public read (the browse/preview/copy path); private non-owned ⇒ 404.
  async (user, params: Params) => (await findViewable("character", params.id, user.id)) ?? null,
  async (user, row) => {
    // Portraits scope to the entity owner so a public preview shows the author's art.
    // `HIDDEN_IMAGE_KINDS` is subtracted: an identity face crop is an internal render
    // input, and this strip is read by the character's OWNER and by every public
    // viewer alike, so a hidden asset must never surface through it.
    const portraitRows = await db()
      .select()
      .from(images)
      .where(
        and(
          eq(images.ownerId, row.ownerId),
          eq(images.entityKind, "character"),
          eq(images.entityId, row.id),
          notInArray(images.kind, [...HIDDEN_IMAGE_KINDS]),
        ),
      )
      .orderBy(desc(images.createdAt));
    // The strip here is a render list, so it ships the public image shape for
    // EVERY viewer: no client reads `path`, `prompt` or the provider internals from
    // this response — the portrait studio loads full rows from the owner-strict
    // `GET /characters/:id/portraits`.
    const portraits = portraitRows.map(toPublicEntityImage);
    // `mine` — read-only preview + duplicate CTA for foreign public rows (the same
    // pattern items and locations use; edits would 404 server-side anyway). A
    // foreign viewer gets the allow-listed public representation, not the row.
    const mine = row.ownerId === user.id;
    return jsonOk({ character: mine ? row : toPublicCharacter(row), portraits, mine });
  },
);

export const PATCH = withAuthorizedResource(
  "character",
  async (user, params: Params) => (await findOwnedCharacter(params.id, user.id)) ?? null,
  async (user, existing, req) => {
    const body = await readBody(req, characterPatchSchema);
    if (!body.ok) return body.response;

    // Outfit suggestions reach the SHEET editor too — the in-sheet Forge and the
    // per-tab Re-draft both draft them — so they materialize here on exactly the
    // POST terms (reuse-by-name, `suggested` tag, ids into the default preset).
    // Without this the editor's "saved as new items with this character" was a
    // lie on the edit page: the rows survived every save and could only be
    // discarded. Items are created BEFORE the row update, as on create — a stray
    // item is harmless, a dangling outfit id is not.
    const sink = new DiagnosticCollector();
    const suggestedIds = await materializeSuggestedItems(user.id, body.value.suggestedItems, sink);

    const update: Partial<typeof characters.$inferInsert> = {};
    if (body.value.name !== undefined) update.name = body.value.name;
    if (body.value.tags !== undefined) update.tags = body.value.tags;
    if (body.value.visibility !== undefined) update.visibility = body.value.visibility;
    if (body.value.chatModel !== undefined) update.chatModel = body.value.chatModel;
    if (body.value.profile !== undefined || suggestedIds.length > 0) {
      const current = parseOr(characterProfileSchema, existing.profile, emptyCharacterProfile(), undefined, "characters.profile");
      // Materialized ids land in the default preset of the MERGED profile, so a
      // save that rewrote the outfit tab keeps both its edits and the new items.
      const merged = withItemsInDefaultOutfit({ ...current, ...body.value.profile }, suggestedIds);
      // Persisted-baseline facts have no blank state: a PATCH that removed one
      // (or predates one) re-materializes it, fill-only, against the merged
      // profile's own body. Players change the value; the fact stays present.
      update.profile = { ...merged, attributes: materializeBodyDefaults(merged.attributes, merged) };
    }
    if (Object.keys(update).length === 0) return jsonOk({ character: existing, diagnostics: sink.items });

    const [row] = await db()
      .update(characters)
      .set(update)
      .where(and(eq(characters.id, existing.id), eq(characters.ownerId, user.id)))
      .returning();
    if (!row) return jsonError("not_found", "character not found", 404);
    queueEmbedRefresh("character", existing.id);
    return jsonOk({ character: row, diagnostics: sink.items });
  },
);

export const DELETE = withAuthorizedResource(
  "character",
  async (user, params: Params) => (await findOwnedCharacter(params.id, user.id)) ?? null,
  async (user, existing) => {
    const id = existing.id;
    // Deleting a character deletes every chat it participated in, through `deleteChat`
    // (deletion-leak audit, 2026-07-10) — multi-character chats included: removing a
    // participant from a chat's cast invalidates the transcript (every remaining line
    // was said to or in front of a character who is no longer there), so the chat goes
    // rather than the participant alone. Deleting the character row by itself cascades
    // `chat_participants` + `character_chat_state` away but leaves the chat row, its
    // transcript, and the memory group's facts/episodes orphaned — invisible in the hub
    // (it inner-joins participants) yet fully stored. `deleteChat` owns the purge order
    // (prompt scrub → cascades → last-reference memory purge) AND the chat's own hidden
    // assets (`chat_upload`, `chat_look`, `chat_place`), so route every referencing chat
    // through it while the participant rows still exist rather than adding a second
    // chat-image cleanup path here. The join is owner-scoped so an anomalous cross-owner
    // participant row can never route another user's chat into deletion — it is skipped
    // and survives, correctly; `deleteChat` re-proves the pairing anyway.
    const chats = await db()
      .select({ id: characterChats.id })
      .from(chatParticipants)
      .innerJoin(characterChats, eq(characterChats.id, chatParticipants.chatId))
      .where(and(eq(chatParticipants.characterId, id), eq(characterChats.ownerId, user.id)));
    for (const chat of chats) {
      await deleteChat(chat.id, user.id);
    }
    // Worlds/sessions hold their own snapshots, so a library delete never breaks
    // them and never hits a FK — no in-use guard.
    await db().delete(characters).where(and(eq(characters.id, id), eq(characters.ownerId, user.id)));
    // An image survives its character iff its kind is Gallery-listable
    // (`GALLERY_IMAGE_KINDS` — scene, portrait_variant, entity): those rows are
    // owner-visible Gallery history, not internal state, so this route never calls
    // `deleteEntityImages` for a character and `images.entity_id` is left dangling on
    // purpose — the row keeps rendering with no character to point at. Everything else
    // — the canonical `avatar` (reachable only through the portrait studio, which dies
    // with the character) and every hidden identity asset alike — dies with the
    // character here, in the one call that states the rule.
    void deleteNonGalleryCharacterImages(id, user.id).catch(() => undefined);
    return jsonOk({ ok: true });
  },
);
