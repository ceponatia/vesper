import fs from "node:fs/promises";
import { generateImage } from "ai";
import { eq } from "drizzle-orm";
import { db, images, sessionParticipants } from "../db";
import { generateChecked, hasVenice, imageModel, imageModelId, isDemoMode, toolModelId, veniceEditImage } from "../ai";
import { logEvent } from "../events";
import { diag, type DiagnosticSink } from "@/contracts/diagnostics";
import type { SceneReference } from "@/contracts/images/scene-reference";
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
  /** Active location (library id + name) for the scene's location reference; null when emergent/unknown. */
  location?: { id: string; name: string } | null;
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
  // The reference-edit route is the uncensored Venice/Qwen model, so it may
  // depict exposed intimate anatomy (Decision 3); the text-to-image fallback is
  // Flux, which may not. Exposure-gating already happened upstream.
  const prompt = buildSceneRenderPrompt(
    input.plan,
    useReference ? { referenceName: reference.name, allowIntimate: true } : {},
  );

  // What the scene features: focal + other in-frame characters (resolved to their
  // library character ids), plus the active location. Recorded so the Gallery can
  // filter and a future multi-reference model can consume more than one (today's
  // render still anchors on the single `reference` avatar above).
  const characterNames = [input.plan.focal?.name, ...input.plan.others.map((o) => o.name)].filter(
    (n): n is string => typeof n === "string" && n.trim().length > 0,
  );
  const references = await buildSceneReferences(input.session.id, characterNames, input.location ?? null);

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
      references,
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
 * Scene references (docs/images.md §Gallery): the characters in frame (focal +
 * others, resolved to library character ids) plus the active location. Recorded
 * on the image's `meta.references` so the Gallery can filter by character/world.
 */
async function buildSceneReferences(
  sessionId: string,
  characterNames: readonly string[],
  location: { id: string; name: string } | null,
): Promise<SceneReference[]> {
  const refs = await resolveSceneCharacterRefs(sessionId, characterNames);
  if (location) refs.push({ kind: "location", id: location.id, name: location.name });
  return refs;
}

/**
 * Resolve in-frame participant display names to `character` references via their
 * library `characterId`. Names with no backing library character (the player, an
 * ad-hoc participant) are skipped — the scene still records the refs it can.
 * Exported for unit testing.
 */
export async function resolveSceneCharacterRefs(sessionId: string, names: readonly string[]): Promise<SceneReference[]> {
  const wanted = names.map((n) => n.trim()).filter(Boolean);
  if (wanted.length === 0) return [];
  const rows = await db()
    .select({ displayName: sessionParticipants.displayName, characterId: sessionParticipants.characterId })
    .from(sessionParticipants)
    .where(eq(sessionParticipants.sessionId, sessionId));
  const characterIdByName = new Map(rows.map((r) => [r.displayName.trim().toLowerCase(), r.characterId]));
  const refs: SceneReference[] = [];
  const seen = new Set<string>();
  for (const name of wanted) {
    const characterId = characterIdByName.get(name.toLowerCase());
    if (!characterId || seen.has(characterId)) continue;
    seen.add(characterId);
    refs.push({ kind: "character", id: characterId, name });
  }
  return refs;
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
 * Resolves a participant's canonical portrait for reference editing: strictly
 * the session participant's own snapshot avatar. The library character's avatar
 * is deliberately NOT consulted — a session is frozen at spawn (re-snapshot only
 * on restart, see engine/spawn.ts), so scene images depict the character as they
 * are in THIS session. Falling back to the live library avatar produced
 * wrong-character scene images when the library portrait changed after spawn (or
 * when the snapshot had none); the session snapshot is the single source.
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
  if (!subject?.avatarImageId) return null;

  const [row] = await db().select().from(images).where(eq(images.id, subject.avatarImageId)).limit(1);
  if (!row || row.status !== "ready") return null;
  try {
    return { row, buffer: await fs.readFile(absoluteImagePath(row)) };
  } catch {
    return null; // file lost — no usable reference, fall through to text-to-image
  }
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
