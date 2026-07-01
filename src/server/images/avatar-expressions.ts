import { and, eq, sql } from "drizzle-orm";
import { type EmotionLabel, emotionLabelEnum } from "@/contracts";
import { diag, type DiagnosticSink } from "@/contracts/diagnostics";
import { characters, db, images } from "../db";
import { classifyImageFailure } from "../ai";
import { deleteOwnedImages } from "./assets";
import { metaFlag, metaTag } from "./avatar-manifest";
import { generateVariant } from "./variants";

/**
 * Avatar **expression-frame auto-generation** (docs/developer-notes/avatar-3d.plan.md
 * §"Slice 3"). Generalizes the slice-2 hand-seed script into the runtime pipeline: every
 * character's avatar gets the full `EmotionLabel` set as identity-locked
 * `portrait_variant` frames (tagged `meta.avatarExpression`), seeded at avatar-ready and
 * lazy-filled on demand. These are the frames `loadAvatarManifest` resolves and the
 * `SpriteAvatar` crossfades.
 *
 * **Boundary rule (CLAUDE.md / `lint:cycles`):** this module **generates** frames; it must
 * never **enqueue** jobs. All `enqueueJob`/route glue lives in `server/api` / `server/engine`
 * (a `server/images` → `server/api` import would be a cycle). The functions here are called
 * *from* a registered `avatar_seed` engine handler.
 */

/**
 * Face-only, anime/stylized reference-edit instruction per emotion. The variant
 * pipeline's identity lock keeps face/hair/age/build/outfit fixed, so "change the facial
 * expression" only re-renders the face — `aroused` is a flushed, heavy-lidded *look*, never
 * anatomy. The **single home** for these strings: `scripts/seed-avatar-expressions.ts`
 * imports this map (no second copy). A `Record<EmotionLabel, …>` so a new mood label is a
 * compile error until it gets an instruction.
 */
export const EXPRESSION_INSTRUCTIONS: Record<EmotionLabel, string> = {
  neutral: "a calm, neutral expression — relaxed face, soft steady gaze, lips at rest",
  happy: "a warm, happy expression — a genuine smile, bright eyes, cheeks lifted",
  affectionate: "a tender, affectionate expression — a soft loving smile, warm half-lidded eyes",
  playful: "a playful, teasing expression — a mischievous half-smile, one brow arched, sparkling eyes",
  flustered: "a flustered, bashful expression — a shy averted glance, lips pressed in a small embarrassed smile",
  concerned: "a concerned expression — a slightly furrowed brow, lips parted, attentive worried eyes",
  sad: "a sad, downcast expression — softened brow, lowered gaze, a faint frown",
  angry: "an angry expression — brows drawn down and together, jaw set, eyes hard and direct",
  afraid: "a frightened expression — wide alarmed eyes, raised inner brows, lips tense and parted",
  surprised: "a surprised expression — eyes widened, brows raised, lips parted in a soft gasp",
  aroused: "a flushed, aroused expression — heavy-lidded heated gaze, parted lips, color high on the cheeks",
};

/** The full seed set: every mood label (user ruling — all 11 up front). */
export const SEED_EMOTIONS: readonly EmotionLabel[] = emotionLabelEnum.options;

/** A failed emotion is given up after this many attempts (mirrors the job poison cap). */
export const MAX_EXPRESSION_ATTEMPTS = 2;

const EXPRESSION_KEYS = new Set<string>(emotionLabelEnum.options);

// --- Venice concurrency cap (cost/ops) ------------------------------------------
//
// A module-level semaphore bounds how many expression edits hit Venice at once across
// ALL seed/lazy-gen activity (many `avatar_seed` jobs run detached + concurrent). Without
// it, a 10-character world-create fans out into dozens of simultaneous edits. In-process,
// matching the single-instance runner assumption (rate-limit.ts / engine jobs).
const MAX_CONCURRENT_EDITS = 3;
let activeEdits = 0;
const editWaiters: Array<() => void> = [];

async function acquireEditSlot(): Promise<void> {
  if (activeEdits < MAX_CONCURRENT_EDITS) {
    activeEdits += 1;
    return;
  }
  await new Promise<void>((resolve) => editWaiters.push(resolve));
  // A releasing slot was handed directly to us — activeEdits already counts it.
}

function releaseEditSlot(): void {
  const next = editWaiters.shift();
  if (next) next(); // hand the (still-counted) slot to the next waiter
  else activeEdits -= 1;
}

async function withEditSlot<T>(fn: () => Promise<T>): Promise<T> {
  await acquireEditSlot();
  try {
    return await fn();
  } finally {
    releaseEditSlot();
  }
}

// --- Coverage / dedup -----------------------------------------------------------

/**
 * The emotions that should NOT be (re)generated for a character right now: those with a
 * `ready`/`pending` frame, a **permanent** failure (a content-rejection — the give-up
 * tombstone, the negative cache that stops the moderation-prone `aroused` frame from being
 * re-billed on every seed/lazy-gen/poll), or `MAX_EXPRESSION_ATTEMPTS` **non-transient**
 * failures. A **transient** failure (Venice 5xx/timeout/429) is deliberately NOT counted —
 * it stays retriable so a flaky moment doesn't permanently mute an emotion (it self-heals on
 * the next seed/lazy-gen trigger). A face change first clears all frames
 * (`clearAvatarExpressionFrames`), so this only ever sees the current avatar's set.
 */
export async function coveredExpressionEmotions(characterId: string, ownerId: string): Promise<Set<EmotionLabel>> {
  const rows = await db()
    .select({ status: images.status, meta: images.meta })
    .from(images)
    .where(
      and(
        eq(images.ownerId, ownerId),
        eq(images.entityKind, "character"),
        eq(images.entityId, characterId),
        eq(images.kind, "portrait_variant"),
      ),
    );

  const covered = new Set<EmotionLabel>();
  const hardFailures = new Map<string, number>();
  for (const row of rows) {
    const emotion = metaTag(row.meta, "avatarExpression");
    if (!emotion || !EXPRESSION_KEYS.has(emotion)) continue;
    if (row.status === "ready" || row.status === "pending") {
      covered.add(emotion as EmotionLabel);
    } else if (row.status === "failed") {
      // A content rejection (tombstoned, or re-classified defensively) is permanent — never
      // retry. A transient blip stays retriable (uncounted). Only a non-transient "other"
      // failure counts toward the give-up cap, so a genuinely broken instruction stops too.
      if (metaFlag(row.meta, "avatarExpressionGaveUp")) {
        covered.add(emotion as EmotionLabel);
        continue;
      }
      const reason = classifyImageFailure(metaTag(row.meta, "error") ?? "");
      if (reason === "content_rejection") covered.add(emotion as EmotionLabel);
      else if (reason === "other") hardFailures.set(emotion, (hardFailures.get(emotion) ?? 0) + 1);
      // reason === "transient" ⇒ uncounted, retried on the next trigger.
    }
  }
  for (const [emotion, count] of hardFailures) {
    if (count >= MAX_EXPRESSION_ATTEMPTS) covered.add(emotion as EmotionLabel);
  }
  return covered;
}

type ExpressionOutcome = "generated" | "skipped" | "failed";

/**
 * Generate ONE expression frame, identity-locked off the current canonical avatar. Gated
 * on a **ready** avatar (so it never writes fail-row thrash before the avatar lands), deduped
 * via {@link coveredExpressionEmotions}, and concurrency-capped. A content-rejection failure
 * is **tombstoned** so it is never retried. Returns the outcome; never throws.
 */
export async function generateAvatarExpression(
  characterId: string,
  userId: string,
  emotion: EmotionLabel,
  sink?: DiagnosticSink,
): Promise<ExpressionOutcome> {
  const [character] = await db()
    .select({ avatarImageId: characters.avatarImageId })
    .from(characters)
    .where(and(eq(characters.id, characterId), eq(characters.ownerId, userId)))
    .limit(1);
  if (!character?.avatarImageId) return "skipped"; // no avatar yet — seed-at-create runs once it lands

  const [avatar] = await db().select({ status: images.status }).from(images).where(eq(images.id, character.avatarImageId)).limit(1);
  if (avatar?.status !== "ready") return "skipped"; // pending/failed avatar — don't thrash fail rows

  if ((await coveredExpressionEmotions(characterId, userId)).has(emotion)) return "skipped";

  const imageId = await withEditSlot(() =>
    generateVariant({
      characterId,
      userId,
      kind: "expression",
      instruction: EXPRESSION_INSTRUCTIONS[emotion],
      extraMeta: { avatarExpression: emotion },
      sink,
    }),
  );

  const [row] = await db().select({ status: images.status, meta: images.meta }).from(images).where(eq(images.id, imageId)).limit(1);
  if (row?.status === "ready") return "generated";

  // Failed: tombstone a content rejection so the negative cache never re-bills it.
  const error = metaTag(row?.meta, "error") ?? "";
  if (classifyImageFailure(error) === "content_rejection") {
    await db()
      .update(images)
      .set({ meta: sql`${images.meta} || ${JSON.stringify({ avatarExpressionGaveUp: true })}::jsonb` })
      .where(eq(images.id, imageId));
  }
  sink?.push(
    diag("warn", "images.avatar_expression.failed", `expression "${emotion}" failed for ${characterId}`, {
      path: "images",
      context: { characterId, emotion, error: error.slice(0, 200) },
    }),
  );
  return "failed";
}

export interface SeedExpressionResult {
  seeded: number;
  failed: number;
  skipped: number;
}

/**
 * Seed (or top up) a character's expression set. `emotions` defaults to the full
 * {@link SEED_EMOTIONS}; lazy-gen passes a single label. Each frame is deduped + capped
 * inside {@link generateAvatarExpression}, so this is **idempotent and resumable** — a
 * re-run after a crash/outage only fills the genuinely-missing frames. Emits an aggregate
 * diagnostic (seeded/failed/skipped) so a half-blank cast is visible in the server log.
 */
export async function seedAvatarExpressions(
  characterId: string,
  userId: string,
  emotions: readonly EmotionLabel[] = SEED_EMOTIONS,
  sink?: DiagnosticSink,
): Promise<SeedExpressionResult> {
  const result: SeedExpressionResult = { seeded: 0, failed: 0, skipped: 0 };
  for (const emotion of emotions) {
    const outcome = await generateAvatarExpression(characterId, userId, emotion, sink);
    if (outcome === "generated") result.seeded += 1;
    else if (outcome === "failed") result.failed += 1;
    else result.skipped += 1;
  }
  sink?.push(
    diag("info", "images.avatar_expression.seeded", `seeded ${result.seeded}/${emotions.length} expression frames`, {
      path: "images",
      context: { characterId, ...result },
    }),
  );
  return result;
}

/**
 * Delete every avatar-expression frame for a character (any status). Called when the
 * canonical avatar's **face changes** (regen / promote / upload), since each frame was
 * reference-edited from the prior avatar — keeping them would show the old face. Seed/lazy-gen
 * then refill against the new avatar. Clones never call this (a clone's frames are pixel-copies
 * of the same face — still valid). Returns the count removed.
 */
export async function clearAvatarExpressionFrames(characterId: string, ownerId: string): Promise<number> {
  const [character] = await db()
    .select({ avatarImageId: characters.avatarImageId })
    .from(characters)
    .where(and(eq(characters.id, characterId), eq(characters.ownerId, ownerId)))
    .limit(1);
  const rows = await db()
    .select({ id: images.id, meta: images.meta })
    .from(images)
    .where(
      and(
        eq(images.ownerId, ownerId),
        eq(images.entityKind, "character"),
        eq(images.entityId, characterId),
        eq(images.kind, "portrait_variant"),
      ),
    );
  // Never delete the frame that is itself the canonical avatar (a user can promote an
  // expression frame to be the avatar) — that would orphan `characters.avatarImageId`.
  const ids = rows
    .filter((row) => metaTag(row.meta, "avatarExpression") !== null && row.id !== character?.avatarImageId)
    .map((row) => row.id);
  if (ids.length === 0) return 0;
  return deleteOwnedImages(ids, ownerId, { kind: "portrait_variant" });
}
