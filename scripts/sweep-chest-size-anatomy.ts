import "dotenv/config";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
import { attributeRegistry, BUST_SCALE_TO_BREAST_SIZE } from "@/contracts";
import { characterChatState, characters, db, personas } from "@/server/db";

/**
 * Stored-value sweep for the chest-build / breast-size anatomy split.
 *
 * `chest.size` used to mean "chest or bust, any gender" with a vocabulary that
 * mixed ribcage structure (`broad`, `barrel`) and breast-size euphemisms
 * (`modest`, `full`, `very_full`). It is now **chest build** — the upper-torso
 * silhouette of a body WITHOUT the breasts region — and the realized body makes
 * it inapplicable the moment the breasts region is switched on, where
 * `breasts.size` owns the silhouette instead. Two things follow for rows
 * written before the split, and this script does both, keyed on each row's
 * OWN body-config so the translation matches what the realized body will read:
 *
 * Body WITH the breasts region (`intimateRegions` includes "breasts"):
 *   1. `breasts.size` already stored → it wins; the now-inapplicable
 *      `chest.size` row is dropped.
 *   2. only `chest.size` stored, on the bust scale → the row becomes
 *      `breasts.size` (provenance kept) so the only usable size value survives,
 *      through the contract's `BUST_SCALE_TO_BREAST_SIZE` (the forge's body
 *      conform step translates with the same table):
 *        flat → flat · slight → nearly_flat · modest → modest ·
 *        average → medium · full → full · very_full → very_large
 *   3. only `chest.size` stored, `broad` / `barrel` → these describe ribcage
 *      structure, not breast size, so no value is invented: the row is left
 *      verbatim and REPORTED (site + row + value) for the owner to author.
 *
 * Body WITHOUT the breasts region: structural values survive unchanged and the
 * removed euphemisms normalize onto the chest-build scale —
 *   modest → slight · full → broad · very_full → broad.
 *
 * Any other stored `chest.size` word (already off-vocabulary before the split)
 * is left verbatim and reported as unrecognized — the sweep never drops what
 * it does not understand. Elements of any other shape pass through untouched.
 *
 * Storage sites (every place an AttributeValue / condition effect persists):
 *   1. characters.profile.attributes                        — body-config on the row
 *   2. personas.profile.attributes                          — body-config on the row
 *   3. character_chat_state.attributeOverlays               — body-config read from
 *   4. character_chat_state.conditions[].attributeEffects      the chat's character row
 *
 *   pnpm db:sweep-chest-size [--dry-run]
 *
 * Every case is COUNTED per site before anything is written and `--dry-run`
 * stops there. Writes are compare-and-set per row (the blob is replaced only
 * WHERE it still equals what the plan read; a row edited underneath is re-read,
 * replanned, and retried, never clobbered) and the sweep is safe to re-run: a
 * swept row plans zero changes, and the reported structural/unrecognized rows
 * are reported again, unchanged, until someone authors them. Run once per
 * environment (`fly ssh console -a vesper -C "pnpm db:sweep-chest-size"`).
 */

/** Removed `chest.size` euphemisms → the chest-build value they normalize to (breasts region off). */
export const CHEST_BUILD_NORMALIZATION: Readonly<Record<string, string>> = {
  modest: "slight",
  full: "broad",
  very_full: "broad",
};

/** Ribcage-structure values that can never become a breast size. */
export const STRUCTURAL_CHEST_VALUES: readonly string[] = ["broad", "barrel"];

export const SWEEP_CASES = [
  "superseded_dropped",
  "translated_to_breast_size",
  "structural_untranslatable",
  "normalized_chest_build",
  "unrecognized_value",
] as const;
export type SweepCase = (typeof SWEEP_CASES)[number];

export interface SweepReport {
  /** Rewrites + drops actually planned (the reported-only cases count 0 here). */
  changes: number;
  cases: Record<SweepCase, number>;
  /** The `chest.size` values left verbatim for the owner (structural / unrecognized). */
  reported: string[];
}

function emptyReport(): SweepReport {
  return {
    changes: 0,
    cases: { superseded_dropped: 0, translated_to_breast_size: 0, structural_untranslatable: 0, normalized_chest_build: 0, unrecognized_value: 0 },
    reported: [],
  };
}

function mergeReports(a: SweepReport, b: SweepReport): SweepReport {
  const out = emptyReport();
  out.changes = a.changes + b.changes;
  for (const c of SWEEP_CASES) out.cases[c] = a.cases[c] + b.cases[c];
  out.reported = [...a.reported, ...b.reported];
  return out;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Whether a stored profile blob's body-config switches the breasts region on. */
export function hasBreastsRegion(profile: unknown): boolean {
  return isRecord(profile) && Array.isArray(profile.intimateRegions) && profile.intimateRegions.includes("breasts");
}

/**
 * Pure core: sweep one JSONB list of `{ <idKey>, value }` entries — an
 * `AttributeValue[]` (`idKey: "id"`) or a condition's `attributeEffects`
 * (`idKey: "attributeId"`). Only `chest.size` entries are ever touched; every
 * other element passes through by reference. Returns the input itself when
 * nothing changed so a CAS write is planned only for rows that move.
 */
export function sweepEntries(raw: unknown, breastsOn: boolean, idKey: "id" | "attributeId"): { next: unknown; report: SweepReport } {
  const report = emptyReport();
  if (!Array.isArray(raw)) return { next: raw, report };
  const entries = raw as readonly unknown[];
  let breastSizePresent = entries.some((el) => isRecord(el) && el[idKey] === "breasts.size");
  const next: unknown[] = [];
  for (const el of entries) {
    if (!isRecord(el) || el[idKey] !== "chest.size") {
      next.push(el);
      continue;
    }
    const value = el.value;
    if (breastsOn) {
      if (breastSizePresent) {
        report.cases.superseded_dropped += 1;
        report.changes += 1;
        continue;
      }
      const translated = typeof value === "string" ? BUST_SCALE_TO_BREAST_SIZE[value] : undefined;
      if (translated !== undefined) {
        report.cases.translated_to_breast_size += 1;
        report.changes += 1;
        // A second chest.size row (duplicate ids) now meets a breast size and drops.
        breastSizePresent = true;
        next.push({ ...el, [idKey]: "breasts.size", value: translated });
        continue;
      }
      report.cases[typeof value === "string" && STRUCTURAL_CHEST_VALUES.includes(value) ? "structural_untranslatable" : "unrecognized_value"] += 1;
      report.reported.push(String(value));
      next.push(el);
      continue;
    }
    const normalized = typeof value === "string" ? CHEST_BUILD_NORMALIZATION[value] : undefined;
    if (normalized !== undefined) {
      report.cases.normalized_chest_build += 1;
      report.changes += 1;
      next.push({ ...el, value: normalized });
      continue;
    }
    if (!attributeRegistry.parseValue("chest.size", value).ok) {
      report.cases.unrecognized_value += 1;
      report.reported.push(String(value));
    }
    next.push(el);
  }
  return report.changes > 0 ? { next, report } : { next: raw, report };
}

/**
 * Sweep a profile-shaped blob (`characters.profile` / `personas.profile`) —
 * the breasts state is the row's own `intimateRegions`.
 */
export function sweepProfile(raw: unknown): { next: unknown; report: SweepReport } {
  if (!isRecord(raw)) return { next: raw, report: emptyReport() };
  const { next: attributes, report } = sweepEntries(raw.attributes, hasBreastsRegion(raw), "id");
  return report.changes > 0 ? { next: { ...raw, attributes }, report } : { next: raw, report };
}

/**
 * Sweep a chat-state row's two attribute-bearing columns. The breasts state
 * comes from the chat's character profile — an overlay carries no body-config
 * of its own. A condition always survives; only its effects are rewritten.
 */
export function sweepChatState(
  row: { overlays: unknown; conditions: unknown },
  breastsOn: boolean,
): { overlays: unknown; conditions: unknown; report: SweepReport } {
  const overlays = sweepEntries(row.overlays, breastsOn, "id");
  let report = overlays.report;
  let conditions = row.conditions;
  if (Array.isArray(row.conditions)) {
    let moved = false;
    const swept = row.conditions.map((cond: unknown) => {
      if (!isRecord(cond) || !Array.isArray(cond.attributeEffects)) return cond;
      const effects = sweepEntries(cond.attributeEffects, breastsOn, "attributeId");
      report = mergeReports(report, effects.report);
      if (effects.report.changes === 0) return cond;
      moved = true;
      return { ...cond, attributeEffects: effects.next };
    });
    if (moved) conditions = swept;
  }
  return { overlays: overlays.next, conditions, report };
}

// ---------------------------------------------------------------------------
// DB glue — thin; the risk lives in the pure core above.
// ---------------------------------------------------------------------------

type ProfileSite = "characters.profile" | "personas.profile";
type Site = ProfileSite | "character_chat_state";

interface ProfilePlan {
  readonly site: ProfileSite;
  readonly rowId: string;
  readonly original: unknown;
  readonly next: unknown;
  readonly report: SweepReport;
}

interface ChatStatePlan {
  readonly site: "character_chat_state";
  readonly chatId: string;
  readonly characterId: string;
  readonly original: { overlays: unknown; conditions: unknown };
  readonly next: { overlays: unknown; conditions: unknown };
  readonly report: SweepReport;
}

const MAX_CAS_ATTEMPTS = 3;

async function readProfile(site: ProfileSite, rowId: string): Promise<{ found: boolean; blob: unknown }> {
  const rows =
    site === "characters.profile"
      ? await db().select({ blob: characters.profile }).from(characters).where(eq(characters.id, rowId))
      : await db().select({ blob: personas.profile }).from(personas).where(eq(personas.id, rowId));
  const row = rows[0];
  return row === undefined ? { found: false, blob: null } : { found: true, blob: row.blob };
}

async function casReplaceProfile(plan: ProfilePlan): Promise<boolean> {
  const result =
    plan.site === "characters.profile"
      ? await db().update(characters).set({ profile: plan.next }).where(and(eq(characters.id, plan.rowId), eq(characters.profile, plan.original)))
      : await db().update(personas).set({ profile: plan.next }).where(and(eq(personas.id, plan.rowId), eq(personas.profile, plan.original)));
  return (result.rowCount ?? 0) > 0;
}

async function readChatState(chatId: string, characterId: string) {
  const rows = await db()
    .select({
      overlays: characterChatState.attributeOverlays,
      conditions: characterChatState.conditions,
      profile: characters.profile,
    })
    .from(characterChatState)
    .innerJoin(characters, eq(characterChatState.characterId, characters.id))
    .where(and(eq(characterChatState.chatId, chatId), eq(characterChatState.characterId, characterId)));
  return rows[0];
}

async function casReplaceChatState(plan: ChatStatePlan): Promise<boolean> {
  const result = await db()
    .update(characterChatState)
    .set({ attributeOverlays: plan.next.overlays, conditions: plan.next.conditions })
    .where(
      and(
        eq(characterChatState.chatId, plan.chatId),
        eq(characterChatState.characterId, plan.characterId),
        eq(characterChatState.attributeOverlays, plan.original.overlays),
        eq(characterChatState.conditions, plan.original.conditions),
      ),
    );
  return (result.rowCount ?? 0) > 0;
}

type Outcome = "applied" | "settled" | "vanished" | "conflicted";

/** CAS loop shared by both row kinds: write, else re-read + replan, up to MAX_CAS_ATTEMPTS. */
async function applyWithRetry(
  write: () => Promise<boolean>,
  replan: () => Promise<{ found: boolean; changes: number; retry: () => Promise<boolean> }>,
): Promise<Outcome> {
  let attempt = write;
  for (let i = 0; i < MAX_CAS_ATTEMPTS; i++) {
    if (await attempt()) return "applied";
    const fresh = await replan();
    if (!fresh.found) return "vanished";
    if (fresh.changes === 0) return "settled";
    attempt = fresh.retry;
  }
  return "conflicted";
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");

  const profilePlans: ProfilePlan[] = [];
  const chatPlans: ChatStatePlan[] = [];
  const perSite = new Map<Site, SweepReport>();
  const reportedRows: string[] = [];
  const note = (site: Site, label: string, report: SweepReport): void => {
    perSite.set(site, mergeReports(perSite.get(site) ?? emptyReport(), report));
    for (const value of report.reported) reportedRows.push(`${site} ${label}: chest.size=${value}`);
  };

  for (const site of ["characters.profile", "personas.profile"] as const) {
    const rows =
      site === "characters.profile"
        ? await db().select({ id: characters.id, blob: characters.profile }).from(characters)
        : await db().select({ id: personas.id, blob: personas.profile }).from(personas);
    for (const row of rows) {
      const { next, report } = sweepProfile(row.blob);
      note(site, row.id, report);
      if (report.changes > 0) profilePlans.push({ site, rowId: row.id, original: row.blob, next, report });
    }
  }

  const chatRows = await db()
    .select({
      chatId: characterChatState.chatId,
      characterId: characterChatState.characterId,
      overlays: characterChatState.attributeOverlays,
      conditions: characterChatState.conditions,
      profile: characters.profile,
    })
    .from(characterChatState)
    .innerJoin(characters, eq(characterChatState.characterId, characters.id));
  for (const row of chatRows) {
    const swept = sweepChatState(row, hasBreastsRegion(row.profile));
    note("character_chat_state", `${row.chatId}/${row.characterId}`, swept.report);
    if (swept.report.changes > 0) {
      chatPlans.push({
        site: "character_chat_state",
        chatId: row.chatId,
        characterId: row.characterId,
        original: { overlays: row.overlays, conditions: row.conditions },
        next: { overlays: swept.overlays, conditions: swept.conditions },
        report: swept.report,
      });
    }
  }

  // Counts by case and site, BEFORE anything is written.
  let anything = false;
  for (const [site, report] of perSite) {
    const touched = SWEEP_CASES.filter((c) => report.cases[c] > 0);
    if (touched.length === 0) continue;
    anything = true;
    console.log(`${site}: ${report.changes} change(s) planned`);
    for (const c of touched) console.log(`  ${c}: ${report.cases[c]}`);
  }
  if (!anything) {
    console.log("No stored chest.size row needs the anatomy sweep — nothing to do (already swept or none present).");
    process.exit(0);
  }
  if (reportedRows.length > 0) {
    console.log(`${reportedRows.length} row(s) left verbatim for the owner (structural / unrecognized chest.size on a body with breasts, or off-vocabulary):`);
    for (const line of reportedRows) console.log(`  ${line}`);
  }
  if (dryRun) {
    console.log("Dry run — nothing written.");
    process.exit(0);
  }

  const tally: Record<Outcome, number> = { applied: 0, settled: 0, vanished: 0, conflicted: 0 };
  const conflicted: string[] = [];
  for (const plan of profilePlans) {
    let current = plan;
    const outcome = await applyWithRetry(
      () => casReplaceProfile(current),
      async () => {
        const fresh = await readProfile(plan.site, plan.rowId);
        if (!fresh.found) return { found: false, changes: 0, retry: async () => false };
        const replanned = sweepProfile(fresh.blob);
        current = { ...plan, original: fresh.blob, next: replanned.next, report: replanned.report };
        return { found: true, changes: replanned.report.changes, retry: () => casReplaceProfile(current) };
      },
    );
    tally[outcome] += 1;
    if (outcome === "conflicted") conflicted.push(`${plan.site} ${plan.rowId}`);
  }
  for (const plan of chatPlans) {
    let current = plan;
    const outcome = await applyWithRetry(
      () => casReplaceChatState(current),
      async () => {
        const fresh = await readChatState(plan.chatId, plan.characterId);
        if (fresh === undefined) return { found: false, changes: 0, retry: async () => false };
        const swept = sweepChatState(fresh, hasBreastsRegion(fresh.profile));
        current = {
          ...plan,
          original: { overlays: fresh.overlays, conditions: fresh.conditions },
          next: { overlays: swept.overlays, conditions: swept.conditions },
          report: swept.report,
        };
        return { found: true, changes: swept.report.changes, retry: () => casReplaceChatState(current) };
      },
    );
    tally[outcome] += 1;
    if (outcome === "conflicted") conflicted.push(`character_chat_state ${plan.chatId}/${plan.characterId}`);
  }

  console.log(`Applied ${tally.applied} row update(s).`);
  if (tally.settled > 0) console.log(`${tally.settled} row(s) were swept by a concurrent edit — nothing left to change.`);
  if (tally.vanished > 0) console.log(`${tally.vanished} row(s) were deleted mid-run — skipped.`);
  if (conflicted.length > 0) {
    console.error(`${conflicted.length} row(s) still conflicted after ${MAX_CAS_ATTEMPTS} CAS attempts — nothing was lost; re-run to finish:`);
    for (const row of conflicted) console.error(`  ${row}`);
    process.exit(1);
  }
  process.exit(0);
}

const isMain = process.argv[1] !== undefined && process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) void main();
