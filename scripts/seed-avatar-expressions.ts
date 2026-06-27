import "dotenv/config";
import { eq, ilike } from "drizzle-orm";
import { characters, db, images } from "../src/server/db";
import { generateVariant } from "../src/server/images";

/**
 * Hand-seed a character's avatar **expression frames** (avatar-3d.plan.md, slice 2 hybrid):
 * run the identity-locked `portrait_variant` reference-edit once per emotion and tag each
 * row `meta.avatarExpression` so it joins the avatar manifest (`loadAvatarManifest`). This
 * is the manual stand-in for slice 3's auto-gen — it proves real expression crossfades for
 * one character (the Lysandra dev cast) before the pipeline is automated.
 *
 *   pnpm tsx scripts/seed-avatar-expressions.ts [namePrefix]   (default "Lysandra")
 *
 * Needs a canonical avatar to edit from + a Venice key (else rows fail). Re-running adds a
 * fresher frame per emotion; the manifest takes the newest, so it's safe to repeat.
 */

const EXPRESSIONS: ReadonlyArray<{ emotion: string; instruction: string }> = [
  { emotion: "neutral", instruction: "a calm, neutral expression — relaxed face, soft steady gaze, lips at rest" },
  { emotion: "happy", instruction: "a warm, happy expression — a genuine smile, bright eyes, cheeks lifted" },
  { emotion: "affectionate", instruction: "a tender, affectionate expression — a soft loving smile, warm half-lidded eyes" },
  { emotion: "concerned", instruction: "a concerned expression — a slightly furrowed brow, lips parted, attentive worried eyes" },
  { emotion: "sad", instruction: "a sad, downcast expression — softened brow, lowered gaze, a faint frown" },
];

async function main(): Promise<void> {
  const prefix = process.argv[2] ?? "Lysandra";
  const matches = await db()
    .select({ id: characters.id, ownerId: characters.ownerId, name: characters.name, avatarImageId: characters.avatarImageId })
    .from(characters)
    .where(ilike(characters.name, `${prefix}%`));

  if (matches.length === 0) {
    console.error(`No character whose name starts with "${prefix}".`);
    process.exit(1);
  }
  const character = matches.find((c) => c.avatarImageId) ?? matches[0];
  if (!character?.avatarImageId) {
    console.error(`"${character?.name ?? prefix}" has no canonical avatar to reference-edit from — generate one first.`);
    process.exit(1);
  }

  console.log(`Seeding ${EXPRESSIONS.length} expression frames for ${character.name} (${character.id})…`);
  for (const { emotion, instruction } of EXPRESSIONS) {
    const imageId = await generateVariant({
      characterId: character.id,
      userId: character.ownerId,
      kind: "expression",
      instruction,
      extraMeta: { avatarExpression: emotion },
    });
    const [row] = await db().select({ status: images.status, meta: images.meta }).from(images).where(eq(images.id, imageId)).limit(1);
    const status = row?.status ?? "unknown";
    console.log(`  ${emotion.padEnd(13)} → ${imageId} [${status}]`);
    if (status === "failed") {
      const error = row?.meta && typeof row.meta === "object" ? (row.meta as Record<string, unknown>).error : undefined;
      console.warn(`     failed: ${String(error ?? "unknown error")}`);
    }
  }
  console.log("Done. Open the character chat — the standing avatar now crossfades real expressions as the mood shifts.");
  process.exit(0);
}

void main();
