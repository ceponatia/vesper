import "dotenv/config";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
import { characterChatState, characters, db } from "../src/server/db";

/**
 * One-off, idempotent stored-value sweep for the attribute-narrator-guidance
 * vocabulary audit (attribute-narrator-guidance.plan.md, slice 3).
 *
 * The entangled-vocabulary renames were made as REGISTRY data edits in prior
 * sessions (never a schema migration — registries are the extension point), but
 * the old value words may still sit in JSONB rows written before the rename.
 * A stored value no longer in `allowedValues` fails `registry.parseValue` and
 * degrades away on read, silently losing authored detail — this maps each old
 * value to its canonical successor so nothing is lost.
 *
 * The renames covered (old → new), keyed BY ATTRIBUTE ID because the same word
 * can be valid elsewhere (`soft` stays valid on weight/skin; `sour` stays valid
 * on vulva/penis scent — only the listed id is remapped):
 *
 *   build.frame (2026-07-08 skeletal-gauge rescope): willowy/lean/athletic/curvy
 *     → slight/average, stocky/broad → sturdy, heavyset → heavy_boned. `slight`
 *     and `average` already survive unchanged.
 *   build.musculature (same rescope): dropped `soft` → `untoned` (soft still
 *     means light adiposity on weight_presentation).
 *   feet.smell (palette swap): the space-containing / re-scoped members
 *     freshly washed / neutral → clean, cheesy and vinegary → cheesy,
 *     sour → sour_sweat, erotically stinky → thick_musk. (cheesy / vinegary /
 *     pungent / ripe already survive unchanged.)
 *   vulva.labia (split into majora/minora): the DEAD ID moves to
 *     vulva.labia_minora, mapping prominent → protruding (tucked / even /
 *     asymmetric already survive unchanged under the new id).
 *
 * Storage sites swept (every place an AttributeValue / condition effect persists):
 *   1. characters.profile.attributes                       — library base values
 *   2. character_chat_state.attributeOverlays              — chat runtime overlays
 *   3. character_chat_state.conditions[].attributeEffects  — chat condition effects
 *
 *   pnpm tsx scripts/sweep-renamed-attribute-values.ts [--dry-run]
 *
 * Safe to re-run (idempotent — a swept value no longer matches any old key) and
 * prints what it changed. Run once against each environment (local, then Fly via
 * `fly ssh console -a vesper -C "pnpm tsx scripts/sweep-renamed-attribute-values.ts"`).
 * Deliberately NOT `parseOr`-based: a migration must never DROP an element it
 * fails to recognize, so unknown-shaped entries pass through verbatim and only
 * the `{id,value}` (or `{attributeId,value}`) pair is ever rewritten.
 */

/** The feet-scent palette swap — shared by the same-id `feet.smell` value rename
 * and the defensive `feet.scent` id rename below (one map, two entry points). */
const FEET_SCENT_VALUE_MAP: Readonly<Record<string, string>> = {
  "freshly washed": "clean",
  neutral: "clean",
  "cheesy and vinegary": "cheesy",
  sour: "sour_sweat",
  "erotically stinky": "thick_musk",
};

/** Same-id value renames: `{ attributeId: { oldValue: newValue } }`. */
export const VALUE_RENAMES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "build.frame": {
    willowy: "slight",
    lean: "average",
    athletic: "average",
    curvy: "average",
    stocky: "sturdy",
    broad: "sturdy",
    heavyset: "heavy_boned",
  },
  "build.musculature": {
    soft: "untoned",
  },
  "feet.smell": FEET_SCENT_VALUE_MAP,
};

/** Id renames: the attribute id itself changed. Optional per-value remap under the new id. */
export const ID_RENAMES: Readonly<Record<string, { readonly newId: string; readonly valueMap?: Readonly<Record<string, string>> }>> = {
  "vulva.labia": {
    newId: "vulva.labia_minora",
    valueMap: { prominent: "protruding" },
  },
  // Defensive: git shows the attribute id was ALWAYS `feet.smell` (the plan/task
  // name the swap "feet.scent → feet.smell" loosely — only the palette changed),
  // so no `feet.scent` rows are expected. This carries any stray hand-authored
  // one to `feet.smell` and remaps its value through the same palette map.
  "feet.scent": {
    newId: "feet.smell",
    valueMap: FEET_SCENT_VALUE_MAP,
  },
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Map a single value (or each member of an enum_list array) through a rename map. */
function mapValue(value: unknown, valueMap: Readonly<Record<string, string>> | undefined): { value: unknown; changed: boolean } {
  if (!valueMap) return { value, changed: false };
  if (typeof value === "string") {
    const next = valueMap[value];
    return next !== undefined && next !== value ? { value: next, changed: true } : { value, changed: false };
  }
  if (Array.isArray(value)) {
    let changed = false;
    const mapped = value.map((v: unknown) => {
      if (typeof v !== "string") return v;
      const next = valueMap[v];
      if (next !== undefined && next !== v) {
        changed = true;
        return next;
      }
      return v;
    });
    return changed ? { value: mapped, changed } : { value, changed: false };
  }
  return { value, changed: false };
}

/**
 * Pure core: remap one `(attribute id, value)` pair to its canonical form.
 * Returns the possibly-new id + value and whether anything changed. Handles both
 * id renames (id changes, value optionally remapped) and same-id value renames.
 */
export function remapIdValue(id: string, value: unknown): { id: string; value: unknown; changed: boolean } {
  const idRename = ID_RENAMES[id];
  if (idRename) {
    const { value: mappedValue } = mapValue(value, idRename.valueMap);
    return { id: idRename.newId, value: mappedValue, changed: true };
  }
  const { value: mappedValue, changed } = mapValue(value, VALUE_RENAMES[id]);
  return { id, value: mappedValue, changed };
}

/**
 * Sweep an `AttributeValue[]`-shaped JSONB array (elements carry `id` + `value`,
 * plus provenance fields we preserve verbatim). Non-conforming elements pass
 * through untouched.
 */
export function sweepAttributeValueList(raw: unknown): { next: unknown; changes: number } {
  if (!Array.isArray(raw)) return { next: raw, changes: 0 };
  let changes = 0;
  const next = raw.map((el: unknown) => {
    if (!isRecord(el) || typeof el.id !== "string") return el;
    const { id, value, changed } = remapIdValue(el.id, el.value);
    if (!changed) return el;
    changes += 1;
    return { ...el, id, value };
  });
  return changes > 0 ? { next, changes } : { next: raw, changes: 0 };
}

/**
 * Sweep an `ActiveCondition[]`-shaped JSONB array — the renames can live inside
 * each condition's `attributeEffects` (`{ attributeId, value }`), e.g. a sweaty-
 * feet condition overlaying `feet.smell`.
 */
export function sweepConditionList(raw: unknown): { next: unknown; changes: number } {
  if (!Array.isArray(raw)) return { next: raw, changes: 0 };
  let changes = 0;
  const next = raw.map((cond: unknown) => {
    if (!isRecord(cond) || !Array.isArray(cond.attributeEffects)) return cond;
    let effectChanges = 0;
    const effects = cond.attributeEffects.map((eff: unknown) => {
      if (!isRecord(eff) || typeof eff.attributeId !== "string") return eff;
      const { id, value, changed } = remapIdValue(eff.attributeId, eff.value);
      if (!changed) return eff;
      effectChanges += 1;
      return { ...eff, attributeId: id, value };
    });
    if (effectChanges === 0) return cond;
    changes += effectChanges;
    return { ...cond, attributeEffects: effects };
  });
  return changes > 0 ? { next, changes } : { next: raw, changes: 0 };
}

/** Sweep a `CharacterProfile`-shaped JSONB blob's `attributes` base array. */
export function sweepProfile(raw: unknown): { next: unknown; changes: number } {
  if (!isRecord(raw)) return { next: raw, changes: 0 };
  const { next: attributes, changes } = sweepAttributeValueList(raw.attributes);
  return changes > 0 ? { next: { ...raw, attributes }, changes } : { next: raw, changes: 0 };
}

/** Sweep a `ParticipantState`-shaped JSONB blob: attribute overlays + condition effects. */
export function sweepParticipantState(raw: unknown): { next: unknown; changes: number } {
  if (!isRecord(raw)) return { next: raw, changes: 0 };
  const overlays = sweepAttributeValueList(raw.attributeOverlays);
  const conditions = sweepConditionList(raw.conditions);
  const changes = overlays.changes + conditions.changes;
  if (changes === 0) return { next: raw, changes: 0 };
  return { next: { ...raw, attributeOverlays: overlays.next, conditions: conditions.next }, changes };
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const totals: Record<string, { rows: number; changes: number }> = {};
  const bump = (site: string, changes: number): void => {
    const t = (totals[site] ??= { rows: 0, changes: 0 });
    t.rows += 1;
    t.changes += changes;
  };

  // 1: characters.profile — library base values.
  for (const row of await db().select({ id: characters.id, blob: characters.profile }).from(characters)) {
    const { next, changes } = sweepProfile(row.blob);
    if (changes === 0) continue;
    bump("characters.profile", changes);
    if (!dryRun) await db().update(characters).set({ profile: next }).where(eq(characters.id, row.id));
  }

  // 2 + 3: character_chat_state (attribute overlays column + conditions column).
  const chatStates = await db()
    .select({
      chatId: characterChatState.chatId,
      characterId: characterChatState.characterId,
      overlays: characterChatState.attributeOverlays,
      conditions: characterChatState.conditions,
    })
    .from(characterChatState);
  for (const row of chatStates) {
    const overlays = sweepAttributeValueList(row.overlays);
    const conditions = sweepConditionList(row.conditions);
    const changes = overlays.changes + conditions.changes;
    if (changes === 0) continue;
    bump("character_chat_state", changes);
    if (!dryRun) {
      await db()
        .update(characterChatState)
        .set({ attributeOverlays: overlays.next, conditions: conditions.next })
        .where(and(eq(characterChatState.chatId, row.chatId), eq(characterChatState.characterId, row.characterId)));
    }
  }

  const sites = Object.keys(totals);
  if (sites.length === 0) {
    console.log("No stored values matched any rename — nothing to do (already swept or none present).");
  } else {
    for (const site of sites) {
      const t = totals[site];
      console.log(`${dryRun ? "[dry-run] " : ""}${site}: ${t?.changes ?? 0} value(s) remapped across ${t?.rows ?? 0} row(s)`);
    }
  }
  if (dryRun) console.log("Dry run — nothing written.");
  process.exit(0);
}

const isMain = process.argv[1] !== undefined && process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) void main();
