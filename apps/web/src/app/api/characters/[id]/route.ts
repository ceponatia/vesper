import { and, desc, eq, notInArray } from "drizzle-orm";
import {
  projectPortraitAcceptance,
} from "@/contracts";
import { characterChats, characters, chatParticipants, db, images } from "@/server/db";
import { deleteChat } from "@/server/engine";
import { deleteNonGalleryCharacterImages, HIDDEN_IMAGE_KINDS } from "@/server/images";
import {
  characterPatchSchema,
  findViewable,
  jsonError,
  jsonOk,
  patchOwnedCharacter,
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
    // Acceptance is the OWNER's editing state — which portrait is this
    // character's identity source, and whether the one on screen is it. A public
    // viewer sees the portrait and nothing about how its author is working, so
    // the field is omitted from the public shape rather than nulled in it.
    const acceptance = mine ? projectPortraitAcceptance(row) : undefined;
    return jsonOk({
      character: mine ? row : toPublicCharacter(row),
      portraits,
      mine,
      ...(acceptance === undefined ? {} : { acceptance }),
    });
  },
);

export const PATCH = withAuthorizedResource(
  "character",
  async (user, params: Params) => (await findOwnedCharacter(params.id, user.id)) ?? null,
  async (user, existing, req) => {
    const body = await readBody(req, characterPatchSchema);
    if (!body.ok) return body.response;

    const saved = await patchOwnedCharacter(existing.id, user.id, body.value);
    if (saved.status === "not_found") return jsonError("not_found", "character not found", 404);
    if (saved.status === "conflict") return jsonOk({ error: { code: "character_conflict", message: "The saved character changed. Review your recovered edits before saving." }, character: saved.character }, 409);
    return jsonOk({
      character: saved.character,
      diagnostics: saved.diagnostics,
      materializedSuggestions: saved.materializedSuggestions,
    });
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
