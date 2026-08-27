import { and, eq } from "drizzle-orm";
import { z } from "zod";
import {
  DEFAULT_SCENE_COMPOSER_MODEL_ID,
  resolveSceneComposerModelId,
  SCENE_COMPOSER_MODELS,
} from "@/lib/composer-models";
import { jsonOk, readBody, withOwnerAdminOwnedChat } from "@/server/api";
import { characterChats, db } from "@/server/db";
import { loadOwnedChat } from "@/app/api/chats/owned";

/**
 * The conversation's **scene composer model** — the admin-only per-chat override that lets
 * a candidate model be tried against the shipped default without a deploy
 * (`lib/composer-models.ts`, and the A/B that qualifies an entry:
 * `scripts/eval/scene-images/composer-model-ab.ts`).
 *
 * Implemented directly beneath `/api/admin/self` rather than as a re-export of an
 * `/api/admin/**` twin: `withOwnerAdmin` fails closed with a hidden 404 outside this
 * prefix, so the twin would be a phantom path that can never serve.
 */

type Params = { chatId: string };
type OwnedChat = NonNullable<Awaited<ReturnType<typeof loadOwnedChat>>>;

const ownedChat = (user: { id: string }, params: Params) => loadOwnedChat(params.chatId, user.id);

/**
 * The write vocabulary is the curated list itself, plus `""` for "back to the default".
 * Strict on purpose (the same reason `sceneComposerModelId` is): the value is stored and
 * later handed to `openrouter().chat()` on the deployment's key, so an arbitrary slug is
 * refused at the door rather than coerced quietly on read.
 */
const composerModelIds = SCENE_COMPOSER_MODELS.map((option) => option.id) as [string, ...string[]];
const patchSchema = z.object({ model: z.union([z.literal(""), z.enum(composerModelIds)]) }).strict();

/**
 * The payload both verbs answer with. `stored` and `model` are BOTH returned and are not
 * the same thing: `stored` is the override as saved ("" ⇒ none, which is what the dropdown
 * must show selected), while `model` is what will actually run. Collapsing them would make
 * "pinned to Aion 3.0" and "following the default, which is Aion 3.0" indistinguishable —
 * and those diverge the moment the default moves, which is the whole point of the probe.
 */
const state = (stored: string | null | undefined) => ({
  stored: stored?.trim() ?? "",
  model: resolveSceneComposerModelId(stored),
  models: SCENE_COMPOSER_MODELS,
  default: DEFAULT_SCENE_COMPOSER_MODEL_ID,
});

/** Read the conversation's composer-model override (admin-only, like agent reasoning). */
export const GET = withOwnerAdminOwnedChat<Params, OwnedChat>(ownedChat, async (_user, owned) => {
  const [row] = await db()
    .select({ model: characterChats.sceneComposerModel })
    .from(characterChats)
    .where(eq(characterChats.id, owned.chat.id))
    .limit(1);

  return jsonOk(state(row?.model));
});

/**
 * Applies to the next scene render; story rollback never touches it — the column sits
 * outside the scenario blob for exactly that reason (schema.ts).
 */
export const PATCH = withOwnerAdminOwnedChat<Params, OwnedChat>(ownedChat, async (user, owned, req) => {
  const body = await readBody(req, patchSchema);
  if (!body.ok) return body.response;

  await db()
    .update(characterChats)
    .set({ sceneComposerModel: body.value.model })
    .where(and(eq(characterChats.id, owned.chat.id), eq(characterChats.ownerId, user.id)));

  return jsonOk(state(body.value.model));
});
