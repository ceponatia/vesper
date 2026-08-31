import "dotenv/config";
import { and, eq, ilike, or } from "drizzle-orm";
import {
  IMAGE_PROMPT_PROGRAM_META_KEY,
  parseImagePromptProgramProvenance,
  type ImageModel,
} from "@vesper/image-core";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import { runInBatches } from "@/lib/batches";
import { isDemoMode } from "@/server/ai";
import { db, images, items } from "@/server/db";
import {
  buildEntityPromptProgram,
  ENTITY_IMAGE_BATCH_SIZE,
  generateEntityImage,
  isEntityPromptRefusal,
  resolveImageProfileForTask,
} from "@/server/images";

/**
 * Re-render the clothing images the retired support wording produced (issue #254).
 *
 * The item lane used to present clothing "on an invisible ghost mannequin",
 * which is the industry term for a support-free product shot and which put a
 * plainly visible dress form in 12 of 12 test renders. The wording was corrected
 * to describe the OUTCOME instead — the garment hanging in its own shape with
 * nothing else in frame — and rendered 0 of 12 at matched seeds. The fix is live
 * in `contracts/images/entity-digest.ts`, but a stored image keeps the picture it
 * was born with, so every clothing item rendered before the fix still shows the
 * form. This is the one-off that clears them.
 *
 * ## What counts as stale
 *
 * A clothing item whose CANONICAL image (`items.image_id` — the one the library
 * shows) has `invisible ghost mannequin` in its stored prompt. That exact clause
 * is what BOTH generations of the lane emitted: the retired paragraph builder
 * (`prompts-entity.ts`, deleted in #141) said "the garment presented on an
 * invisible ghost mannequin", and the prompt-program projection that replaced it
 * said "presented on an invisible ghost mannequin, holding the garment's own
 * shape". Matching the shipped clause rather than the bare word `mannequin`
 * costs nothing and cannot flag an item whose AUTHOR wrote the word into a
 * description.
 *
 * Because the corrected wording names no support, a re-rendered row stops
 * matching — so the selection is self-clearing, the script is safe to re-run, and
 * a run reporting zero candidates states the issue's completion criterion ("the
 * library's clothing images no longer show a support form") rather than being a
 * script that did nothing.
 *
 * Clothing images naming a support some OTHER way are listed separately and never
 * rendered. Nothing shipped such a prompt, so that bucket should stay empty; it
 * exists so an unexpected one is visible instead of silently uncovered.
 *
 * ## Running it
 *
 * ```
 * pnpm tsx scripts/rerender-clothing-item-images.ts                      # FREE: what is stale, and what the re-render would send
 * pnpm tsx scripts/rerender-clothing-item-images.ts --limit 2            # FREE: the same, narrowed to a spot-check slice
 * pnpm tsx scripts/rerender-clothing-item-images.ts --render             # PAID: one provider render per candidate
 * pnpm tsx scripts/rerender-clothing-item-images.ts --render --limit 2   # PAID: spot-check first, then the rest
 * ```
 *
 * `--owner <id>` narrows to one library. On Fly:
 * `fly ssh console -a vesper -C "pnpm tsx scripts/rerender-clothing-item-images.ts"`
 * — cwd is `/app`, so an unset `DATA_ROOT` resolves to the `/app/data` mount, the
 * same default the app itself runs on.
 *
 * ## The free run is the spot-check
 *
 * Issue #254 also asks that scarf translucency and authored details (e.g.
 * scorched cuffs) still carry through. The free run compiles each candidate's
 * REPLACEMENT prompt without contacting a provider and reports two things per
 * item: whether the new prompt still names a support, and which authored claims
 * the compile dropped. Those claims are the item's own fields — description,
 * appearance, colour, subtype, and the `sheer` opacity fact that IS the scarf's
 * translucency — so a clean report is measured evidence rather than an eyeball,
 * and the printed prompt is there to read anyway.
 *
 * An item whose replacement still names a support, or whose prompt cannot be
 * compiled at all, is EXCLUDED from `--render`: paying for a render that would
 * reproduce the defect helps nobody.
 */

/** The shipped clause both lane generations emitted — the render set's marker. */
const RETIRED_CLAUSE = "invisible ghost mannequin";
/** Every way a stored prompt could name a support at all. Superset of the clause above. */
const SUPPORT_TERMS = ["mannequin", "dress form", "ghost bust"] as const;
/** The projection's authored item facts; a drop here is what the spot-check looks for. */
const AUTHORED_CLAIM = /\.(description|appearance|color|subtype|opacity)$/;

interface Candidate {
  readonly itemId: string;
  readonly name: string;
  readonly ownerId: string;
  readonly imageId: string;
  readonly status: string;
  readonly prompt: string;
}

interface Preview {
  readonly candidate: Candidate;
  /** The compiled replacement, or null when there is none. */
  readonly prompt: string | null;
  readonly refusal: string | null;
  readonly supportNamed: boolean;
  readonly droppedAuthoredClaims: readonly string[];
}

/**
 * A `--flag value` pair, or null when the flag is ABSENT.
 *
 * A flag that is present but carries no usable value — nothing after it, another
 * flag after it, or an empty string from an unset shell variable — exits rather
 * than reading as absent. The two are opposite intentions and this script spends
 * money on the difference: `--render --limit` would otherwise render every
 * candidate instead of the slice that was asked for, and `--render --owner
 * "$UNSET"` would silently widen a single-library spot check to every library.
 */
function flagValue(flag: string): string | null {
  const at = process.argv.indexOf(flag);
  if (at < 0) return null;
  const next = process.argv[at + 1];
  if (next === undefined || next.startsWith("--") || next.trim().length === 0) {
    console.error(`${flag} was given without a value. Pass one, or omit the flag entirely.`);
    process.exit(1);
  }
  return next;
}

/** How far a claim about "no image carries the wording" actually reaches. */
function scopeSuffix(ownerId: string | null): string {
  return ownerId === null ? "" : ` for owner ${ownerId} (no other library was examined)`;
}

/**
 * Every clothing item whose canonical image names a support, in one read.
 *
 * Ordered by owner then name so `--limit` takes a stable slice — a spot-check
 * that renders different items each run is not a spot-check.
 */
async function supportNamingClothing(ownerId: string | null): Promise<Candidate[]> {
  const namesASupport = or(...SUPPORT_TERMS.map((term) => ilike(images.prompt, `%${term}%`)));
  const conds = [eq(items.kind, "clothing"), namesASupport];
  if (ownerId) conds.push(eq(items.ownerId, ownerId));
  return db()
    .select({
      itemId: items.id,
      name: items.name,
      ownerId: items.ownerId,
      imageId: images.id,
      status: images.status,
      prompt: images.prompt,
    })
    .from(items)
    .innerJoin(images, eq(images.id, items.imageId))
    .where(and(...conds))
    .orderBy(items.ownerId, items.name);
}

function carriesRetiredClause(candidate: Candidate): boolean {
  return candidate.prompt.toLowerCase().includes(RETIRED_CLAUSE);
}

function namesASupport(prompt: string): boolean {
  const lower = prompt.toLowerCase();
  return SUPPORT_TERMS.some((term) => lower.includes(term));
}

/**
 * Compile what the re-render WOULD send, without contacting a provider.
 *
 * The profile is resolved once by the caller and passed in: it is the same read
 * for every item, and a per-item resolve would be one database round trip per
 * candidate in service of an identical answer.
 */
async function preview(candidate: Candidate, model: ImageModel): Promise<Preview> {
  const sink = new DiagnosticCollector();
  const blocked = (refusal: string): Preview => ({
    candidate,
    prompt: null,
    refusal,
    supportNamed: false,
    droppedAuthoredClaims: [],
  });
  const program = await buildEntityPromptProgram({
    entityKind: "item",
    entityId: candidate.itemId,
    ownerId: candidate.ownerId,
    model,
    sink,
  });
  if (program === null) return blocked("item row not found");
  if (isEntityPromptRefusal(program)) return blocked(program.refusal);

  // `droppedClaimIds` is the compile's own record of what a budget squeeze
  // removed, and a claim id IS the projection's fact key — so this reads the
  // authored fields straight out of provenance rather than guessing at wording.
  const provenance = parseImagePromptProgramProvenance(program.meta[IMAGE_PROMPT_PROGRAM_META_KEY]);
  return {
    candidate,
    prompt: program.prompt,
    refusal: null,
    supportNamed: namesASupport(program.prompt),
    droppedAuthoredClaims: (provenance?.droppedClaimIds ?? []).filter((id) => AUTHORED_CLAIM.test(id)),
  };
}

/** A window around the support term, so a long stored prompt still shows the offending clause. */
function excerpt(prompt: string): string {
  const lower = prompt.toLowerCase();
  const at = SUPPORT_TERMS.map((term) => lower.indexOf(term)).find((index) => index >= 0);
  if (at === undefined) return prompt.slice(0, 160);
  return `…${prompt.slice(Math.max(0, at - 60), at + 100)}…`;
}

function report(previews: readonly Preview[]): void {
  previews.forEach((entry, index) => {
    const { candidate } = entry;
    console.log(`\n[${index + 1}/${previews.length}] ${candidate.name}  (item ${candidate.itemId}, owner ${candidate.ownerId})`);
    console.log(`  stored image : ${candidate.imageId} (${candidate.status})`);
    console.log(`  old prompt   : ${excerpt(candidate.prompt)}`);
    if (entry.prompt === null) {
      console.log(`  new prompt   : REFUSED — ${entry.refusal ?? "unknown reason"}`);
      return;
    }
    console.log(`  new prompt   : ${entry.prompt}`);
    console.log(`  names a support        : ${entry.supportNamed ? "YES — excluded from --render" : "no"}`);
    console.log(
      `  authored claims dropped: ${entry.droppedAuthoredClaims.length === 0 ? "none" : entry.droppedAuthoredClaims.join(", ")}`,
    );
  });
}

async function main(): Promise<void> {
  const render = process.argv.includes("--render");
  const ownerId = flagValue("--owner");
  const limitRaw = flagValue("--limit");
  const limit = limitRaw === null ? null : Number(limitRaw);
  if (limit !== null && (!Number.isInteger(limit) || limit < 1)) {
    console.error(`--limit must be a positive integer, got ${limitRaw}`);
    process.exit(1);
  }

  const supportNaming = await supportNamingClothing(ownerId);
  const stale = supportNaming.filter(carriesRetiredClause);
  const review = supportNaming.filter((row) => !carriesRetiredClause(row));
  const scoped = limit === null ? stale : stale.slice(0, limit);

  console.log(
    `${stale.length} clothing item(s) still carry the retired "${RETIRED_CLAUSE}" wording` +
      (ownerId ? ` for owner ${ownerId}` : "") +
      (limit === null ? "." : `; --limit ${limit} scopes this run to ${scoped.length}.`),
  );
  if (stale.length === 0) {
    // The completion criterion, stated as a fact rather than as silence — and
    // never wider than the query that produced it. An owner-scoped run proves
    // nothing about the libraries it did not read.
    console.log(`Nothing to re-render — no clothing image${scopeSuffix(ownerId)} was rendered with a named support form.`);
  }
  if (review.length > 0) {
    console.log(`\n${review.length} clothing image(s) name a support some OTHER way — review by hand, never rendered here:`);
    for (const row of review) {
      console.log(`  ${row.name} (item ${row.itemId}, owner ${row.ownerId}): ${excerpt(row.prompt)}`);
    }
  }
  if (scoped.length === 0) return;

  // One resolve for the whole run: the item task's profile does not vary per item,
  // and a refusal here means every candidate would refuse the same way.
  const resolved = await resolveImageProfileForTask("item", null, new DiagnosticCollector());
  if (resolved === null) {
    console.error("No image model is registered for entity images — nothing can be compiled or rendered.");
    process.exit(1);
  }

  const previews: Preview[] = [];
  for (const candidate of scoped) previews.push(await preview(candidate, resolved.model));
  report(previews);

  const renderable = previews.filter((entry) => entry.prompt !== null && !entry.supportNamed);
  const blocked = previews.length - renderable.length;
  console.log(
    `\n${renderable.length} item(s) would re-render` +
      (blocked > 0 ? `; ${blocked} blocked (refused compile, or a support still named).` : "."),
  );

  if (!render) {
    console.log("Free run — nothing was rendered. Add --render to spend one provider render per item.");
    return;
  }
  if (isDemoMode()) {
    // Demo mode paints a monogram tile. Overwriting a real product photograph
    // with a letter on a coloured square is data loss, not a re-render.
    console.error("Refusing to --render in demo mode: the entity lane would paint monograms over the stored images.");
    process.exit(1);
  }
  if (renderable.length === 0) {
    console.error("Nothing renderable — fix the blocked items above first.");
    process.exit(1);
  }

  console.log(`\nRendering ${renderable.length} item(s) in batches of ${ENTITY_IMAGE_BATCH_SIZE}…`);
  const completed = await runInBatches(renderable, ENTITY_IMAGE_BATCH_SIZE, async (entry) => {
    const imageId = await generateEntityImage({
      entityKind: "item",
      entityId: entry.candidate.itemId,
      userId: entry.candidate.ownerId,
    });
    console.log(`  rendered ${entry.candidate.name} → image ${imageId}`);
  });
  console.log(`${completed}/${renderable.length} re-render(s) completed.`);

  // The lane marks a row failed rather than throwing, so `completed` counts
  // attempts that returned an id, not pictures that landed. Re-running the
  // selection is what actually proves the wording is gone.
  const remaining = (await supportNamingClothing(ownerId)).filter(carriesRetiredClause);
  console.log(
    remaining.length === 0
      ? `No clothing image${scopeSuffix(ownerId)} carries the retired wording any more.`
      : `${remaining.length} item(s) still carry it — re-run to retry, or inspect the failed image rows.`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
