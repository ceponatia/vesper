import fs from "node:fs/promises";
import { eq } from "drizzle-orm";
import { db, imageReferences, images, sessionParticipants } from "../db";
import {
  describeImageGenError,
  executeImageProvider,
  generateChecked,
  hasVenice,
  imageModelId,
  isDemoMode,
  routeSceneProviders,
  toolModelId,
  veniceEditModelId,
  type ImageProviderFailure,
  type ImageProviderId,
  type ProviderRenderResult,
  type SceneRenderRequest,
} from "../ai";
import { logEvent } from "../events";
import { diag, type DiagnosticSink } from "@/contracts/diagnostics";
import type { SceneReference, SceneReferenceSource, SceneVisualReference } from "@/contracts/images/scene-reference";
import type { SceneGenState } from "@/contracts/state/scene-gen";
import { absoluteImagePath, createImageAsset, failImage, saveImageBuffer, type ImageEntityKind, type ImageRow } from "./assets";
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
 * Scene render (docs/images.md step 2). Resolve the scene's visual references
 * (featured characters + location, with the focal/other identity anchor's
 * spawn-snapshot avatar attached), let the provider router pick an ordered
 * fallback chain, then run it with a reason-keyed retry policy (spec §8.3): a
 * transient failure retries once, a content rejection never retries and drops to
 * the next rung — uncensored Venice/Qwen edit → moderating Flux text-to-image →
 * (demo monogram). Every reference is persisted to `image_references` (the
 * queryable record). Failures mark the row failed and return its id — the
 * session is never blocked by image work.
 */
export async function renderSceneImage(input: RenderSceneInput): Promise<string> {
  const demo = isDemoMode();
  const anchor = demo || !hasVenice() ? null : await findReferenceAvatar(input.session.id, input.plan, input.sink);
  const references = await buildVisualReferences(input.session.id, input.plan, anchor, input.location ?? null);
  return renderResolvedScene({
    plan: input.plan,
    references,
    anchorBuffer: anchor?.buffer ?? null,
    linkage: { ownerId: input.userId, sessionId: input.session.id },
    logResult: (imageId, status, started) => void logScene(input.session.id, imageId, status, started),
    sink: input.sink,
  });
}

/** Where a rendered scene image is filed: a session scene, or a library-entity (character-chat) scene. */
export interface SceneAssetLinkage {
  ownerId: string;
  /** Session scenes set this (cleared if the session is deleted). */
  sessionId?: string;
  /** Library-entity scenes (character chat) set these instead of a session. */
  entityKind?: ImageEntityKind;
  entityId?: string;
}

export interface RenderResolvedSceneInput {
  plan: SceneRenderPlan;
  /** Every reference the scene features; the one carrying an `imageId` is the identity anchor. */
  references: SceneVisualReference[];
  /** The identity anchor's image bytes (for the reference-edit provider); null ⇒ text-to-image. */
  anchorBuffer: Buffer | null;
  linkage: SceneAssetLinkage;
  /** Where to log the outcome (`logScene` for sessions, a character event otherwise). */
  logResult: (imageId: string, status: string, startedMs: number) => void;
  sink?: DiagnosticSink;
}

/**
 * The provider-chain core shared by every scene render (docs/images.md step 2),
 * decoupled from where the references came from and where the asset is filed
 * (`linkage`). The session path (`renderSceneImage`) and the sessionless
 * character-chat path (`renderCharacterSceneImage`, images/character-scene.ts)
 * both resolve their own references/anchor, then hand off here.
 *
 * The provider router picks an ordered fallback chain run with the reason-keyed
 * retry policy (spec §8.3): transient → retry once, content rejection → next rung
 * — uncensored Venice/Qwen edit → moderating Flux text-to-image → (demo
 * monogram). Every reference is persisted to `image_references`. Failures mark
 * the row failed and return its id — callers are never blocked by image work.
 */
export async function renderResolvedScene(input: RenderResolvedSceneInput): Promise<string> {
  const demo = isDemoMode();
  const { plan, references, linkage } = input;
  const request: SceneRenderRequest = { references, demo };
  const chain = routeSceneProviders(request);

  // The identity anchor is the reference that carries an actual image. The
  // uncensored edit path gets identity-lock + (exposure-gated) intimate anatomy;
  // the moderating text-to-image fallback gets neither — so a fallback never
  // feeds Flux the intimate prompt it would only reject. `allowForIntimate`
  // defaults permissive today; the deferred uploaded-avatar guard (spec §3)
  // flips it for uploaded provenance, and this path already respects it.
  const anchorRef = references.find((r) => Boolean(r.imageId));
  const allowIntimate = anchorRef?.allowForIntimate ?? false;
  const textPrompt = buildSceneRenderPrompt(plan, {});
  const editPrompt = anchorRef
    ? buildSceneRenderPrompt(plan, { referenceName: anchorRef.name, allowIntimate })
    : textPrompt;
  const promptFor = (id: ImageProviderId): string => (id === "venice_edit" ? editPrompt : textPrompt);
  const modelFor = (id: ImageProviderId): string =>
    id === "demo"
      ? "demo"
      : id === "venice_edit"
        ? `venice/${veniceEditModelId()}`
        : imageModelId();

  const primary = chain[0] ?? "flux_openrouter";
  const asset = await createImageAsset({
    ownerId: linkage.ownerId,
    kind: "scene",
    sessionId: linkage.sessionId,
    entityKind: linkage.entityKind,
    entityId: linkage.entityId,
    prompt: promptFor(primary),
    sourceImageId: anchorRef?.imageId,
    meta: {
      demo,
      focalName: plan.focal?.name ?? null,
      referenceName: anchorRef?.name ?? null,
      model: modelFor(primary),
    },
  });
  await recordImageReferences(asset.id, references, input.sink);

  const ctx: SceneAttemptContext = { promptFor, anchorBuffer: input.anchorBuffer, focalName: plan.focal?.name ?? "Scene" };
  const started = Date.now();
  try {
    const outcome = await executeSceneChain(chain, (id) => runSceneProvider(id, ctx), input.sink);
    if (!outcome) {
      await failImage(asset.id, "all scene image providers failed");
      input.logResult(asset.id, "failed", started);
      return asset.id;
    }
    // A fallback rung won — correct the recorded prompt + model to what ran.
    if (outcome.providerId !== primary) {
      await correctProviderMeta(asset.id, promptFor(outcome.providerId), modelFor(outcome.providerId));
    }
    const saved = await saveImageBuffer(asset.id, outcome.image, input.sink);
    input.logResult(asset.id, saved?.status ?? "failed", started);
  } catch (err) {
    const message = describeImageGenError(err);
    await failImage(asset.id, message);
    input.logResult(asset.id, "failed", started);
  }
  return asset.id;
}

interface SceneAttemptContext {
  promptFor: (id: ImageProviderId) => string;
  anchorBuffer: Buffer | null;
  focalName: string;
}

export interface SceneRenderOutcome {
  providerId: ImageProviderId;
  image: Buffer;
}

/** One transient retry on the same provider before falling to the next rung. */
const MAX_TRANSIENT_RETRIES = 1;

/**
 * Walk the provider fallback chain with the reason-keyed retry policy (spec
 * §8.3): a transient failure retries once on the same provider; a content
 * rejection (or anything else) drops straight to the next rung with an info
 * diagnostic. When every rung failed transiently, warn of a possible outage.
 * The provider runner is injected so the policy is unit-testable in isolation.
 */
export async function executeSceneChain(
  chain: ImageProviderId[],
  run: (id: ImageProviderId) => Promise<ProviderRenderResult>,
  sink?: DiagnosticSink,
): Promise<SceneRenderOutcome | null> {
  let sawTransient = false;
  let sawNonTransient = false;
  for (let i = 0; i < chain.length; i++) {
    const id = chain[i];
    if (!id) continue;
    let failure: ImageProviderFailure | undefined;
    for (let attempt = 0; attempt <= MAX_TRANSIENT_RETRIES; attempt++) {
      const result = await run(id);
      if (result.ok && result.image) return { providerId: id, image: result.image };
      failure = result.failure ?? { reason: "other", message: "provider returned no image" };
      if (failure.reason === "transient" && attempt < MAX_TRANSIENT_RETRIES) {
        sink?.push(
          diag("info", "images.scene_render.retry", `${id} transient failure — retrying: ${failure.message.slice(0, 160)}`),
        );
        continue;
      }
      break;
    }
    if (!failure) continue;
    if (failure.reason === "transient") sawTransient = true;
    else sawNonTransient = true;
    const next = chain[i + 1];
    if (next) {
      sink?.push(
        diag("info", "images.scene_render.provider_fallback", `scene render falling back ${id} → ${next} after ${failure.reason}`, {
          context: { from: id, to: next, reason: failure.reason, message: failure.message.slice(0, 200) },
        }),
      );
    }
  }
  if (sawTransient && !sawNonTransient) {
    sink?.push(
      diag("warn", "images.scene_render.service_outage", "every scene image provider failed transiently — possible image service outage"),
    );
  }
  return null;
}

/** Dispatch one rung: the demo monogram lives in this (images) layer; AI-backed providers run through the gateway. */
async function runSceneProvider(id: ImageProviderId, ctx: SceneAttemptContext): Promise<ProviderRenderResult> {
  if (id === "demo") return { ok: true, image: monogramSvg(ctx.focalName || "Scene") };
  const reference = id === "venice_edit" ? (ctx.anchorBuffer ?? undefined) : undefined;
  return executeImageProvider(id, { prompt: ctx.promptFor(id), reference });
}

/**
 * The scene's visual references (spec §4): featured characters resolved to their
 * library `characterId`, plus the active location, with the identity anchor's
 * spawn-snapshot avatar attached (imageId + provenance). The anchor is always
 * represented even when it has no backing library character, so the router still
 * routes it to the reference-edit provider. Persisted to `image_references`.
 */
async function buildVisualReferences(
  sessionId: string,
  plan: SceneRenderPlan,
  anchor: { name: string; row: ImageRow; buffer: Buffer } | null,
  location: { id: string; name: string } | null,
): Promise<SceneVisualReference[]> {
  const focalName = plan.focal?.name ?? null;
  const names = [plan.focal?.name, ...plan.others.map((o) => o.name)].filter(
    (n): n is string => typeof n === "string" && n.trim().length > 0,
  );
  const characterRefs = await resolveSceneCharacterRefs(sessionId, names);
  const refs: SceneVisualReference[] = characterRefs.map((c) => ({
    kind: "character",
    entityId: c.id,
    name: c.name,
    role: c.name === focalName ? "focal" : "other",
    allowForIntimate: true,
  }));

  if (anchor) {
    const anchorKey = anchor.name.trim().toLowerCase();
    const existing = refs.find((r) => r.name?.trim().toLowerCase() === anchorKey);
    const source = avatarSource(anchor.row.meta);
    if (existing) {
      existing.imageId = anchor.row.id;
      existing.source = source;
    } else {
      // Anchor avatar with no backing library character — still feed the image.
      refs.push({
        kind: "character",
        name: anchor.name,
        role: anchor.name === focalName ? "focal" : "other",
        imageId: anchor.row.id,
        source,
        allowForIntimate: true,
      });
    }
  }

  if (location) {
    refs.push({ kind: "location", entityId: location.id, name: location.name, role: "location", source: "entity", allowForIntimate: true });
  }
  return refs;
}

/** Uploaded avatars carry `meta.source: "upload"` (upload.ts); everything else we generate. */
function avatarSource(meta: unknown): SceneReferenceSource {
  const source = meta && typeof meta === "object" && !Array.isArray(meta) ? (meta as Record<string, unknown>).source : undefined;
  return source === "upload" ? "uploaded" : "generated";
}

/** Persist the scene's references to the join table (spec §4). Never throws — a write failure degrades to a diagnostic. */
async function recordImageReferences(
  sceneImageId: string,
  references: readonly SceneVisualReference[],
  sink?: DiagnosticSink,
): Promise<void> {
  if (references.length === 0) return;
  try {
    await db()
      .insert(imageReferences)
      .values(
        references.map((r) => ({
          sceneImageId,
          kind: r.kind,
          entityId: r.entityId ?? null,
          role: r.role ?? null,
          source: r.source ?? null,
          imageId: r.imageId ?? null,
          name: r.name ?? "",
        })),
      );
  } catch (err) {
    sink?.push(
      diag("error", "images.scene_render.references_write_failed", err instanceof Error ? err.message : String(err)),
    );
  }
}

/** Correct the recorded prompt + model when a fallback rung (not the primary) produced the image. */
async function correctProviderMeta(assetId: string, prompt: string, model: string): Promise<void> {
  const [row] = await db().select({ meta: images.meta }).from(images).where(eq(images.id, assetId)).limit(1);
  await db()
    .update(images)
    .set({ prompt, meta: { ...metaRecord(row?.meta), model } })
    .where(eq(images.id, assetId));
}

function metaRecord(meta: unknown): Record<string, unknown> {
  return meta && typeof meta === "object" && !Array.isArray(meta) ? { ...(meta as Record<string, unknown>) } : {};
}

function logScene(sessionId: string, imageId: string, status: string, started: number): Promise<void> {
  return logEvent(sessionId, "image.scene", { imageId, status, durationMs: Date.now() - started });
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
