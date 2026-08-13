import "dotenv/config";
import { fileURLToPath } from "node:url";
import { and, eq, isNull } from "drizzle-orm";
import { materializeBodyDefaults, registryDefaultSourceId, type AttributeValue } from "@/contracts";
import { characters, db, personas } from "@/server/db";

/**
 * Idempotent backfill for persisted-baseline registry defaults
 * (`materializeDefault`, pre-slice-3 foot facts): every stored body that is
 * missing one of the flagged facts gains it, exactly as a fresh grounding
 * would — `source: "creation"` with the versioned
 * `registry-default:<category>:vN` sourceId, respecting each row's own
 * species/body-plan applicability. Authored values are never touched, and an
 * element the script does not recognize passes through verbatim (the sweep
 * script's rule: a migration must never DROP what it fails to recognize).
 *
 * Storage sites backfilled — the two authoritative full-profile locations that
 * feed a live character or persona:
 *   1. characters.profile.attributes   — library base values (incl. clones)
 *   2. personas.profile.attributes     — persona (player body) base values;
 *      a NULL profile is seeded as `{ attributes: [...] }` (every other field
 *      is schema-defaulted on read)
 *
 * Deliberately NOT touched:
 *   - character_chat_state.attributeOverlays — a partial narrative overlay,
 *     not a full profile; a creation-source default there is dead weight (the
 *     base layer already carries it after this backfill)
 *   - character_chat_state.conditions        — transient, self-expiring
 *   - sim_events / sim_snapshots             — immutable event history
 *   - chat_visual_memory                     — derived cache
 *
 *   pnpm tsx scripts/backfill-registry-defaults.ts [--dry-run]
 *
 * Counts by field and storage site are printed BEFORE anything is written;
 * `--dry-run` stops there. Safe to re-run (a filled row re-plans zero
 * additions). Run once per environment (local, then Fly via
 * `fly ssh console -a vesper -C "pnpm tsx scripts/backfill-registry-defaults.ts"`).
 *
 * Safe against a LIVE application: every write is compare-and-set — the whole
 * JSONB profile is replaced only WHERE it still equals the blob the plan was
 * computed from (jsonb equality is structural, so key order can't false-negative).
 * A row edited between the read and the write loses the race harmlessly: the
 * script re-reads it, re-plans against the fresh blob, and retries (up to
 * MAX_CAS_ATTEMPTS). A row still moving after the retries is reported as
 * conflicted and the script exits non-zero so the operator re-runs it.
 */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function stringOrUndefined(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function stringArrayOrUndefined(v: unknown): readonly string[] | undefined {
  return Array.isArray(v) && v.every((entry): entry is string => typeof entry === "string") ? v : undefined;
}

/**
 * Pure core: plan the missing persisted-baseline facts for one profile blob.
 *
 * Reads the row's own body-config (species/heritage/body-plan/intimate
 * regions/features) so applicability matches what a fresh grounding of this
 * exact body would do. The present-id scan accepts ANY element carrying a
 * string `id`, however otherwise shaped, so a malformed authored entry both
 * survives verbatim and still blocks a default from shadowing it. A NULL/absent
 * profile plans against an empty body (schema defaults). A profile whose
 * `attributes` key exists but is not an array is left completely alone — that
 * row is corrupt in a way this script must not paper over.
 */
export function planProfileBackfill(raw: unknown): { next: unknown; added: readonly AttributeValue[] } {
  const profile = isRecord(raw) ? raw : {};
  const rawAttributes = profile.attributes;
  if (rawAttributes !== undefined && !Array.isArray(rawAttributes)) return { next: raw, added: [] };
  const attributes: readonly unknown[] = Array.isArray(rawAttributes) ? rawAttributes : [];

  const present = new Set(
    attributes.flatMap((entry) => (isRecord(entry) && typeof entry.id === "string" ? [entry.id] : [])),
  );
  const added = materializeBodyDefaults([], {
    speciesId: stringOrUndefined(profile.speciesId),
    heritageId: stringOrUndefined(profile.heritageId),
    bodyPlanId: stringOrUndefined(profile.bodyPlanId),
    intimateRegions: stringArrayOrUndefined(profile.intimateRegions),
    bodyFeatures: stringArrayOrUndefined(profile.bodyFeatures),
  }).filter((value) => !present.has(value.id));

  if (added.length === 0) return { next: raw, added: [] };
  return { next: { ...profile, attributes: [...attributes, ...added] }, added };
}

type Site = "characters.profile" | "personas.profile";

interface PlannedWrite {
  readonly site: Site;
  readonly rowId: string;
  /** The blob exactly as read — the compare-and-set expectation for the write. */
  readonly original: unknown;
  readonly next: unknown;
  readonly added: readonly AttributeValue[];
}

/**
 * One CAS-guarded write: replace the profile only WHERE it still equals the
 * blob the plan was computed from. Returns false when a concurrent edit (or a
 * delete) moved the row first — the caller replans from a fresh read instead
 * of clobbering what the application just saved. A NULL profile (unseeded
 * persona) is matched with IS NULL, which `=` can't express.
 */
async function casReplace(site: Site, rowId: string, original: unknown, next: unknown): Promise<boolean> {
  if (site === "characters.profile") {
    const unchanged = original === null ? isNull(characters.profile) : eq(characters.profile, original);
    const result = await db()
      .update(characters)
      .set({ profile: next })
      .where(and(eq(characters.id, rowId), unchanged));
    return (result.rowCount ?? 0) > 0;
  }
  const unchanged = original === null ? isNull(personas.profile) : eq(personas.profile, original);
  const result = await db().update(personas).set({ profile: next }).where(and(eq(personas.id, rowId), unchanged));
  return (result.rowCount ?? 0) > 0;
}

/** Fresh single-row read for the replan after a lost CAS race. */
async function readProfile(site: Site, rowId: string): Promise<{ found: boolean; blob: unknown }> {
  const rows =
    site === "characters.profile"
      ? await db().select({ blob: characters.profile }).from(characters).where(eq(characters.id, rowId))
      : await db().select({ blob: personas.profile }).from(personas).where(eq(personas.id, rowId));
  const row = rows[0];
  return row === undefined ? { found: false, blob: null } : { found: true, blob: row.blob };
}

/** CAS attempts per row before declaring it conflicted (each retry replans). */
const MAX_CAS_ATTEMPTS = 3;

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");

  const plans: PlannedWrite[] = [];
  const plan = (site: Site, rows: readonly { id: string; blob: unknown }[]): void => {
    for (const row of rows) {
      const { next, added } = planProfileBackfill(row.blob);
      if (added.length > 0) plans.push({ site, rowId: row.id, original: row.blob, next, added });
    }
  };

  plan("characters.profile", await db().select({ id: characters.id, blob: characters.profile }).from(characters));
  plan("personas.profile", await db().select({ id: personas.id, blob: personas.profile }).from(personas));

  // Counts by field and storage site, BEFORE anything is written.
  const counts = new Map<string, Map<string, number>>();
  for (const entry of plans) {
    const bySite = counts.get(entry.site) ?? new Map<string, number>();
    for (const value of entry.added) bySite.set(value.id, (bySite.get(value.id) ?? 0) + 1);
    counts.set(entry.site, bySite);
  }
  if (plans.length === 0) {
    console.log("Every stored body already carries the persisted-baseline facts — nothing to do.");
    process.exit(0);
  }
  console.log(`Backfill sourceId: ${registryDefaultSourceId("feet")}`);
  for (const [site, bySite] of counts) {
    const rows = plans.filter((entry) => entry.site === site).length;
    console.log(`${site}: ${rows} row(s) missing fact(s)`);
    for (const [field, count] of [...bySite.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      console.log(`  ${field}: ${count}`);
    }
  }
  if (dryRun) {
    console.log("Dry run — nothing written.");
    process.exit(0);
  }

  let applied = 0;
  let settled = 0; // a concurrent edit already carries every fact
  let vanished = 0; // the row was deleted mid-run
  const conflicted: string[] = [];
  for (const entry of plans) {
    let original = entry.original;
    let next = entry.next;
    let outcome: "applied" | "settled" | "vanished" | "conflicted" = "conflicted";
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
      if (await casReplace(entry.site, entry.rowId, original, next)) {
        outcome = "applied";
        break;
      }
      // Lost the race to a live edit: replan against the fresh blob so the
      // concurrent change survives and only the still-missing facts are added.
      const fresh = await readProfile(entry.site, entry.rowId);
      if (!fresh.found) {
        outcome = "vanished";
        break;
      }
      const replanned = planProfileBackfill(fresh.blob);
      if (replanned.added.length === 0) {
        outcome = "settled";
        break;
      }
      original = fresh.blob;
      next = replanned.next;
    }
    if (outcome === "applied") applied += 1;
    else if (outcome === "settled") settled += 1;
    else if (outcome === "vanished") vanished += 1;
    else conflicted.push(`${entry.site} ${entry.rowId}`);
  }

  console.log(`Applied ${applied} row update(s).`);
  if (settled > 0) console.log(`${settled} row(s) were filled by a concurrent edit — nothing left to add.`);
  if (vanished > 0) console.log(`${vanished} row(s) were deleted mid-run — skipped.`);
  if (conflicted.length > 0) {
    console.error(
      `${conflicted.length} row(s) still conflicted after ${MAX_CAS_ATTEMPTS} CAS attempts — nothing was lost; re-run to finish:`,
    );
    for (const row of conflicted) console.error(`  ${row}`);
    process.exit(1);
  }
  process.exit(0);
}

const isMain = process.argv[1] !== undefined && process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) void main();
