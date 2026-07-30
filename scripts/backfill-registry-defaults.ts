import "dotenv/config";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { materializeBodyDefaults, registryDefaultSourceId, type AttributeValue } from "../src/contracts";
import { characters, db, personas } from "../src/server/db";

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

interface PlannedWrite {
  readonly site: string;
  readonly rowId: string;
  readonly next: unknown;
  readonly added: readonly AttributeValue[];
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");

  const plans: PlannedWrite[] = [];
  const plan = (site: string, rows: readonly { id: string; blob: unknown }[]): void => {
    for (const row of rows) {
      const { next, added } = planProfileBackfill(row.blob);
      if (added.length > 0) plans.push({ site, rowId: row.id, next, added });
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

  for (const entry of plans) {
    if (entry.site === "characters.profile") {
      await db().update(characters).set({ profile: entry.next }).where(eq(characters.id, entry.rowId));
    } else {
      await db().update(personas).set({ profile: entry.next }).where(eq(personas.id, entry.rowId));
    }
  }
  console.log(`Applied ${plans.length} row update(s).`);
  process.exit(0);
}

const isMain = process.argv[1] !== undefined && process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) void main();
