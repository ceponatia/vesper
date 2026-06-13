import fs from "node:fs/promises";
import { generateImage } from "ai";
import { eq } from "drizzle-orm";
import { characters, db, images, sessionParticipants } from "../db";
import { generateChecked, hasVenice, imageModel, imageModelId, isDemoMode, toolModelId, veniceEditImage } from "../ai";
import { logEvent } from "../events";
import { diag, type DiagnosticSink } from "@/contracts/diagnostics";
import type { SceneGenState } from "@/contracts/state/scene-gen";
import { absoluteImagePath, createImageAsset, failImage, saveImageBuffer, type ImageRow } from "./assets";
import { monogramSvg } from "./monogram";
import {
  buildSceneComposerPrompt,
  buildSceneRenderPrompt,
  heuristicFocalName,
  resolveScenePlan,
  SCENE_COMPOSER_SYSTEM,
  sceneSpecSchema,
  type SceneComposerContext,
  type SceneRenderPlan,
  type SceneSpec,
} from "./prompts";

export type SceneComposeInput = SceneComposerContext & { sink?: DiagnosticSink };

/**
 * Scene composer (docs/images.md step 1): the tool model picks the focal
 * character (and any others in frame) from the present-NPC roster + recent
 * narration, then resolveScenePlan clamps every name to that roster and
 * forces every outfit from occlusion-filtered wardrobe state — prose lies,
 * and absent characters never appear. An empty roster composes a
 * location-only shot, which is a legitimate output, not an error.
 */
export async function composeSceneSpec(input: SceneComposeInput): Promise<SceneRenderPlan> {
  const { sink, ...context } = input;
  const fallback = (): SceneSpec => heuristicSceneSpec(context);
  const { value } = await generateChecked({
    schema: sceneSpecSchema,
    system: SCENE_COMPOSER_SYSTEM,
    prompt: buildSceneComposerPrompt(context),
    modelId: toolModelId(),
    code: "images.scene_composer",
    sink,
    fallback,
  });
  return resolveScenePlan(value ?? fallback(), context, sink);
}

/** Deterministic spec (demo mode / degraded fallback): heuristic focal, everyone else present in frame. */
function heuristicSceneSpec(context: SceneComposerContext): SceneSpec {
  const focalName = heuristicFocalName(context.present, context.recentNarration ?? []);
  const focal = context.present.find((c) => c.name === focalName);
  return sceneSpecSchema.parse({
    focalCharacter: focalName,
    pose: focal ? focal.posture || "standing naturally, relaxed" : "",
    activity: focal?.activity ?? "",
    others: context.present
      .filter((c) => c.name !== focalName)
      .map((c) => ({ name: c.name, action: [c.posture, c.activity].filter(Boolean).join("; ") })),
    setting: [context.locationName, context.locationDescription].filter(Boolean).join(" — ").slice(0, 300),
    lighting: heuristicLighting(context.timeOfDay),
  });
}

const TIME_OF_DAY_LIGHTING: Record<string, string> = {
  dawn: "pale dawn light",
  day: "soft natural daylight",
  dusk: "warm dusk light",
  night: "dim night-time lighting",
};

function heuristicLighting(timeOfDay: string | undefined): string {
  return (timeOfDay && TIME_OF_DAY_LIGHTING[timeOfDay]) || "soft natural light";
}

export interface RenderSceneInput {
  session: { id: string; ownerId: string };
  plan: SceneRenderPlan;
  userId: string;
  sink?: DiagnosticSink;
}

/**
 * Scene render (docs/images.md step 2). Venice is single-reference edit, so
 * one identity anchor: the focal character's ready avatar → identity-locked
 * edit with the other featured characters described textually; no focal
 * avatar → the first featured other with a ready avatar becomes the
 * reference (info diagnostic) and the focal is described textually; no
 * usable avatar, or no characters at all → OpenRouter text-to-image (a
 * location-only POV shot is a legitimate render). Monogram in demo mode.
 * Failures mark the row failed and return its id — the session is never
 * blocked by image work.
 */
export async function renderSceneImage(input: RenderSceneInput): Promise<string> {
  const demo = isDemoMode();
  const reference = demo || !hasVenice() ? null : await findReferenceAvatar(input.session.id, input.plan, input.sink);
  const useReference = reference !== null;
  const prompt = buildSceneRenderPrompt(input.plan, useReference ? { referenceName: reference.name } : {});

  const asset = await createImageAsset({
    ownerId: input.userId,
    kind: "scene",
    sessionId: input.session.id,
    prompt,
    sourceImageId: useReference ? reference.row.id : undefined,
    meta: {
      demo,
      focalName: input.plan.focal?.name ?? null,
      referenceName: reference?.name ?? null,
      model: demo ? "demo" : useReference ? `venice/${process.env.VENICE_IMAGE_EDIT_MODEL || "qwen-edit-uncensored"}` : imageModelId(),
    },
  });

  const started = Date.now();
  try {
    let buffer: Buffer;
    if (demo) {
      buffer = monogramSvg(input.plan.focal?.name || "Scene");
    } else if (useReference) {
      const edit = await veniceEditImage({ prompt, reference: reference.buffer });
      if (!edit.ok || !edit.image) {
        await failImage(asset.id, edit.error ?? "venice edit returned no image");
        void logScene(input.session.id, asset.id, "failed", started);
        return asset.id;
      }
      buffer = edit.image;
    } else {
      const result = await generateImage({
        model: imageModel(),
        prompt,
        aspectRatio: "3:4",
      });
      buffer = Buffer.from(result.image.uint8Array);
    }
    const saved = await saveImageBuffer(asset.id, buffer, input.sink);
    void logScene(input.session.id, asset.id, saved?.status ?? "failed", started);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await failImage(asset.id, message);
    void logScene(input.session.id, asset.id, "failed", started);
  }
  return asset.id;
}

function logScene(sessionId: string, imageId: string, status: string, started: number): Promise<void> {
  return logEvent(sessionId, "image.scene", { imageId, status, durationMs: Date.now() - started });
}

/**
 * Reference selection (docs/images.md §Scene images): one identity anchor.
 * The focal character's avatar when ready; else the first plan-featured
 * other present NPC with a ready avatar — the composer's spec still
 * features them prominently, so identity-locking them is meaningful (info
 * diagnostic `images.scene_render.reference_fallback`; the focal is then
 * described textually). Absent NPCs are never candidates — the plan only
 * ever contains co-located characters.
 */
async function findReferenceAvatar(
  sessionId: string,
  plan: SceneRenderPlan,
  sink?: DiagnosticSink,
): Promise<{ name: string; row: ImageRow; buffer: Buffer } | null> {
  if (!plan.focal) return null; // location-only shot
  const focalAvatar = await findParticipantAvatar(sessionId, plan.focal.name);
  if (focalAvatar) return { name: plan.focal.name, ...focalAvatar };
  for (const other of plan.others) {
    const avatar = await findParticipantAvatar(sessionId, other.name);
    if (avatar) {
      sink?.push(
        diag(
          "info",
          "images.scene_render.reference_fallback",
          `focal character "${plan.focal.name}" has no ready avatar — using ${other.name}'s avatar as the identity reference`,
        ),
      );
      return { name: other.name, ...avatar };
    }
  }
  return null; // no usable avatar — text-to-image
}

/**
 * Resolves a participant's canonical portrait for reference editing: the
 * session participant's own avatar first, then their character's avatar.
 */
async function findParticipantAvatar(
  sessionId: string,
  participantName: string,
): Promise<{ row: ImageRow; buffer: Buffer } | null> {
  const wanted = participantName.trim().toLowerCase();
  if (!wanted) return null;
  const participants = await db()
    .select()
    .from(sessionParticipants)
    .where(eq(sessionParticipants.sessionId, sessionId));
  const subject = participants.find((p) => p.displayName.trim().toLowerCase() === wanted);
  if (!subject) return null;

  const candidateIds: string[] = [];
  if (subject.avatarImageId) candidateIds.push(subject.avatarImageId);
  if (subject.characterId) {
    const [character] = await db()
      .select({ avatarImageId: characters.avatarImageId })
      .from(characters)
      .where(eq(characters.id, subject.characterId))
      .limit(1);
    if (character?.avatarImageId) candidateIds.push(character.avatarImageId);
  }

  for (const id of candidateIds) {
    const [row] = await db().select().from(images).where(eq(images.id, id)).limit(1);
    if (!row || row.status !== "ready") continue;
    try {
      return { row, buffer: await fs.readFile(absoluteImagePath(row)) };
    } catch {
      // file lost — try the next candidate
    }
  }
  return null;
}

/**
 * Pure trigger helper (docs/images.md §Scene images): periodic every
 * `interval` turns, or on the director's imageMoment flag. `interval` 0
 * disables automatic generation entirely (manual requests bypass this);
 * an in-flight generation is never stacked.
 */
export function shouldGenerateScene(scene: SceneGenState, turnNumber: number, directorWorthIt: boolean): boolean {
  if (scene.interval <= 0) return false;
  if (scene.status === "generating") return false;
  if (directorWorthIt) return true;
  return turnNumber - (scene.lastGeneratedTurn ?? 0) >= scene.interval;
}
