import { and, desc, eq } from "drizzle-orm";
import {
  IMAGE_TARGET_ASPECT,
  type ImageProfileTask,
  type ImageRenderIntent,
  type ImageRenderReference,
  planImageRender,
  type ResolvedImageProfile,
} from "@vesper/image-core";
import type { DiagnosticSink } from "@/contracts/diagnostics";
import { characterChats, characters, db, imageLabExperiments, images } from "../db";
import { resolveImageProfileForTask } from "./model-profiles";
import {
  labFailure,
  labRenderer,
  labRuntimeFacts,
  planOutcome,
  readOwnedImageBytes,
  settleFailed,
  storeLabRender,
} from "./image-lab-render";
import {
  type ImageLabExperimentRow,
  type ImageLabRunPayload,
  LAB_PROFILE_UNAVAILABLE,
  primaryChatCharacterId,
} from "./image-lab-store";

/**
 * The two baseline lanes — the ones that deliberately run the production lane's
 * own path, because a baseline compiled some other way would not be a baseline.
 */

// --- baselines -------------------------------------------------------------

/**
 * A baseline re-runs an ordinary lane's own CONFIGURATION so a later comparison
 * has a same-settings control to sit beside (spec §"Baseline runs").
 *
 * Settings parity is achieved by construction rather than by copying numbers:
 * the same `resolveImageProfileForTask` call the lane makes, the same reference
 * choice, and the same `renderImageIntent` entry point — which is where the
 * profile's controls, prompt strategy, negative, aspect negotiation and
 * provider overrides are all compiled. Anything the lane sends, this sends,
 * because it is the same code compiling the same profile.
 *
 * ONE deliberate difference: the PROMPT is the admin's instruction, not the
 * lane's composed text. A variant prompt is built from a variant kind and an
 * age anchor; a scene prompt is composed by an agent out of live chat state,
 * meters and wardrobe. Reproducing either would drag the bench into the chat
 * pipeline and make the baseline's text depend on state that moved since. The
 * admin types the text both arms of a comparison share, which is what makes it
 * a comparison. Recorded as `finalPrompt` post-compile, so the record says what
 * was actually sent.
 *
 * Neither baseline enqueues the lane's own job type, and neither writes a
 * lane-visible asset: the output is a hidden `lab_output`, so no portrait
 * variant or chat scene ever appears from lab activity.
 */
export async function runBaseline(
  row: ImageLabExperimentRow,
  task: Extract<ImageProfileTask, "variant" | "scene">,
  sink?: DiagnosticSink,
): Promise<ImageLabRunPayload> {
  const resolvedSubject = await resolveBaselineSubject(row, task, sink);
  if (!resolvedSubject.ok) return await settleFailed(row, resolvedSubject.code, resolvedSubject.message, sink);

  const subject = resolvedSubject.subject;
  const resolved = subject.profile;
  const intent: ImageRenderIntent = {
    profile: resolved,
    prompt: row.instruction,
    references: subject.references,
    target: { aspectRatio: IMAGE_TARGET_ASPECT },
  };
  // Planned first purely to CAPTURE the compiled prompt: `renderImageIntent`
  // does not report it, and a baseline whose recorded text is the admin's raw
  // instruction would claim parity it cannot show. The render's own plan is NOT
  // byte-identical to this one: `renderImageIntent` may resolve a drawn seed
  // into the plan it executes (a `random` seed policy). Everything this
  // baseline STORES from the plan — `finalPrompt`, the `planOutcome` reference
  // record — is seed-independent, which is what keeps the capture honest.
  const planned = planImageRender(intent, labRuntimeFacts());
  if (!planned.ok) return await settleFailed(row, LAB_PROFILE_UNAVAILABLE, planned.refusal.message, sink);

  const finalPrompt = planned.plan.prompt;
  const columns = {
    profileId: resolved.profile.id,
    // The resolved model, overwriting whatever slug the request carried: a
    // baseline runs what the LANE runs, and recording the request's guess would
    // describe a render that did not happen.
    modelSlug: resolved.model.slug,
    // Deliberately no `requestedVersionId`: `renderImageIntent` pins nothing,
    // because production does not, and a baseline that pinned would stop being
    // a baseline. What actually ran arrives as the provider's own echo.
    finalPrompt,
  };
  await db()
    .update(imageLabExperiments)
    .set(columns)
    .where(and(eq(imageLabExperiments.id, row.id), eq(imageLabExperiments.ownerId, row.ownerId)));

  const rendered = await labRenderer()({ mode: "intent", intent }, sink);
  return await storeLabRender(row, rendered, {
    finalPrompt,
    sourceImageId: subject.references[0]?.sourceImageId,
    columns,
    sink,
    // Recorded for baselines too — no recipe key, but the same "what was sent,
    // what was dropped" honesty, so the two arms of a comparison read alike.
    outcome: planOutcome(planned.plan),
  });
}

interface BaselineSubject {
  profile: ResolvedImageProfile;
  references: ImageRenderReference[];
}

type BaselineSubjectResult = { ok: true; subject: BaselineSubject } | { ok: false; code: string; message: string };

/**
 * The resolved profile and references, or the message saying what is missing.
 *
 * The SUBJECT is resolved before the profile, deliberately. A baseline whose
 * character has no canonical avatar has nothing to re-run whatever the registry
 * offers, and resolving a profile for a subject that is not there would report
 * the registry's state as the reason a missing avatar failed.
 */
async function resolveBaselineSubject(
  row: ImageLabExperimentRow,
  task: Extract<ImageProfileTask, "variant" | "scene">,
  sink?: DiagnosticSink,
): Promise<BaselineSubjectResult> {
  const references = task === "scene" ? await sceneBaselineReferences(row) : await portraitBaselineReferences(row);
  if (references.length === 0) {
    return {
      ok: false,
      code: labFailure("input_missing"),
      message: "the lane's reference anchor could not be read for this subject",
    };
  }

  const stored = task === "scene" ? await chatSceneSelection(row.chatId) : null;
  const profile = await resolveImageProfileForTask(task, stored, sink);
  if (!profile) {
    return { ok: false, code: LAB_PROFILE_UNAVAILABLE, message: `no image model profile is offered for ${task} renders` };
  }
  return { ok: true, subject: { profile, references } };
}

/**
 * The variant lane's reference choice: the canonical avatar, always re-rolled
 * from rather than chained off a previous edit.
 */
async function portraitBaselineReferences(row: ImageLabExperimentRow): Promise<ImageRenderReference[]> {
  if (row.characterId === null) return [];
  const [character] = await db()
    .select({ avatarImageId: characters.avatarImageId })
    .from(characters)
    .where(and(eq(characters.id, row.characterId), eq(characters.ownerId, row.ownerId)))
    .limit(1);
  if (!character?.avatarImageId) return [];
  const bytes = await readOwnedImageBytes(character.avatarImageId, row.ownerId);
  if (!bytes) return [];
  return [{ role: "identity", required: true, buffer: bytes, sourceImageId: character.avatarImageId }];
}

/**
 * The scene lane's reference choice: the chat's current look anchor, falling
 * back to the character's canonical avatar, plus the chat's place shot when one
 * exists — the same `chat_look` → avatar → `+ chat_place` ladder
 * `renderCharacterSceneImage` climbs.
 *
 * ONE simplification, and it is worth stating: the lane additionally requires
 * the look's cache KEY to match the chat's current wardrobe state, and the bench
 * has no wardrobe state to derive a key from. So it anchors on the newest look
 * the chat actually holds — the same image the lane uses whenever the wardrobe
 * has not moved since, and an honestly-labelled anchor when it has.
 */
async function sceneBaselineReferences(row: ImageLabExperimentRow): Promise<ImageRenderReference[]> {
  if (row.chatId === null) return [];
  const references: ImageRenderReference[] = [];

  const look = await newestChatAsset(row.chatId, row.ownerId, "chat_look");
  const anchorId = look ?? (await baselineChatAvatarId(row));
  if (!anchorId) return [];
  const anchor = await readOwnedImageBytes(anchorId, row.ownerId);
  if (!anchor) return [];
  references.push({ role: "identity", required: true, buffer: anchor, sourceImageId: anchorId });

  const place = await newestChatAsset(row.chatId, row.ownerId, "chat_place");
  if (place) {
    const bytes = await readOwnedImageBytes(place, row.ownerId);
    if (bytes) references.push({ role: "location", buffer: bytes, sourceImageId: place });
  }
  return references;
}

/** The character a scene baseline is about: the experiment's, else the chat's first. */
async function baselineChatAvatarId(row: ImageLabExperimentRow): Promise<string | null> {
  const characterId = row.characterId ?? (row.chatId === null ? null : await primaryChatCharacterId(row.chatId));
  if (!characterId) return null;
  const [character] = await db()
    .select({ avatarImageId: characters.avatarImageId })
    .from(characters)
    .where(and(eq(characters.id, characterId), eq(characters.ownerId, row.ownerId)))
    .limit(1);
  return character?.avatarImageId ?? null;
}



/** The chat's stored scene-model pick, resolved by the profile registry exactly as the lane resolves it. */
async function chatSceneSelection(chatId: string | null): Promise<string | null> {
  if (chatId === null) return null;
  const [chat] = await db()
    .select({ sceneModel: characterChats.sceneModel })
    .from(characterChats)
    .where(eq(characterChats.id, chatId))
    .limit(1);
  return chat?.sceneModel ?? null;
}

async function newestChatAsset(
  chatId: string,
  ownerId: string,
  kind: "chat_look" | "chat_place",
): Promise<string | null> {
  const [row] = await db()
    .select({ id: images.id })
    .from(images)
    .where(
      and(eq(images.chatId, chatId), eq(images.ownerId, ownerId), eq(images.kind, kind), eq(images.status, "ready")),
    )
    .orderBy(desc(images.createdAt))
    .limit(1);
  return row?.id ?? null;
}
