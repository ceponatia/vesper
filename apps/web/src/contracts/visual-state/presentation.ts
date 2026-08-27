import { z } from "zod";
import { parseOr, parseOrNull } from "@/lib/parse";
import { validateBodyLocusRef } from "../appearance-features";
import { affordanceEvidence, type AffordanceEvidence } from "../affordances/core";
import { bodyLocationRegistry } from "../body/locations";
import { diag, type DiagnosticSink } from "../diagnostics";
import {
  VISUAL_STATE_KIND_UNKNOWN,
  VISUAL_STATE_LOCUS_INVALID,
  VISUAL_STATE_LOCUS_NOT_ALLOWED,
  VISUAL_STATE_PRESENTATION_ENTRY_MALFORMED,
  VISUAL_STATE_PRESENTATION_ENTRY_UNKNOWN,
  VISUAL_STATE_PRESENTATION_OPERATION_INVALID,
  VISUAL_STATE_VALUE_INVALID,
} from "./diagnostics";
import { validateVisualStateFeature, visualStateFeatureKey, visualStateFingerprint, type VisualStateFeature } from "./feature";
import {
  presentationDisturbances,
  presentationHairArrangements,
  VISUAL_STATE_PRESENTATION_COSMETIC_MARK_KIND_ID,
  VISUAL_STATE_PRESENTATION_GROOMING_KIND_ID,
  VISUAL_STATE_PRESENTATION_HAIRSTYLE_KIND_ID,
  VISUAL_STATE_PRESENTATION_MAKEUP_KIND_ID,
  VISUAL_STATE_PRESENTATION_NAIL_FINISH_KIND_ID,
} from "./kinds";
import { visualStateLocusKey, visualStateLocusKind, visualStateLocusRefSchema, type VisualStateLocusRef } from "./locus";
import { visualStateKindRegistry } from "./registry";
import type { VisualStateRelationship } from "./relationships";

/**
 * The non-item presentation owner.
 *
 * Wardrobe already owns everything a character puts ON: jewelry, glasses, hats,
 * coats, carried objects. What it cannot hold is a deliberate choice with no
 * object behind it — how the hair is worn today, whether there is makeup on,
 * how the beard is trimmed, what is on the nails, the paint across one cheek.
 * Those were free text or nothing at all, which is why they reset between
 * scenes.
 *
 * This module is that missing owner, and it is deliberately SMALL:
 *
 * - **closed vocabularies.** Every value is a registered kind's zod schema over
 *   enums (`./kinds`). There is no free-text field, so two identical looks
 *   fingerprint identically and a model cannot smuggle prose in as truth.
 * - **typed operations.** Writes are `apply` / `remove` / `rearrange` / `smudge`
 *   / `restore`. Nothing patches raw JSON, and nothing sets a numeric intensity
 *   by hand.
 * - **no persistence.** State in, state out. Where these entries are stored, how
 *   they are rolled back with a retake, and which lane writes them is the
 *   server-wiring slice's business; this file must stay pure to be replayable.
 *
 * The five kinds here are exactly the ones the spec names. Adding a sixth is a
 * data edit in `./kinds` plus one line in `presentationOwnedKindIds`.
 */

export const PRESENTATION_STATE_VERSION = 1;

/** Max entries one character's presentation holds; the oldest application is evicted. */
export const PRESENTATION_MAX_ENTRIES = 24;

/** Max operations accepted from one proposal — the same bound the garment owner uses. */
export const PRESENTATION_MAX_OPERATIONS = 12;

/**
 * The kinds THIS owner may write.
 *
 * It is a subset of the presentation-layer kinds on purpose: `wardrobe.garment`
 * and `wardrobe.item` are also presentation, and an `apply` naming one of them
 * must be refused rather than quietly creating a second, item-less copy of a
 * garment that the wardrobe already owns: jewelry, glasses, hats, coats, and
 * carried objects stay item-backed.
 */
export const presentationOwnedKindIds = [
  VISUAL_STATE_PRESENTATION_HAIRSTYLE_KIND_ID,
  VISUAL_STATE_PRESENTATION_MAKEUP_KIND_ID,
  VISUAL_STATE_PRESENTATION_GROOMING_KIND_ID,
  VISUAL_STATE_PRESENTATION_NAIL_FINISH_KIND_ID,
  VISUAL_STATE_PRESENTATION_COSMETIC_MARK_KIND_ID,
] as const;

const OWNED_KIND_IDS: ReadonlySet<string> = new Set(presentationOwnedKindIds);

/**
 * Kinds that hold SEVERAL distinct facts at one body locus, and the value field
 * that tells them apart.
 *
 * A character has one hairstyle on their hair and one makeup on their face, so
 * those kinds need nothing here. Grooming and cosmetic marks are different: the
 * grooming vocabulary discriminates four areas and the mark vocabulary six
 * marks, and the body registry has no `brows` or `forehead` location, so brow
 * grooming and facial-hair grooming both land at `face`. Without a
 * discriminator, applying the second silently supersedes the first, and a state
 * holding both projects two features under one key for the snapshot to drop.
 *
 * The fix is a discriminator in the key, not a new body location — the body
 * registry belongs to another owner, and the same reasoning that kept a `wig`
 * subtype out of the wardrobe vocabulary applies here.
 */
const PRESENTATION_DISCRIMINATOR_FIELDS: ReadonlyMap<string, string> = new Map([
  [VISUAL_STATE_PRESENTATION_GROOMING_KIND_ID, "area"],
  [VISUAL_STATE_PRESENTATION_COSMETIC_MARK_KIND_ID, "mark"],
]);

/**
 * The aspect an entry projects under: its kind id, plus the discriminator when
 * the kind has one (`presentation.grooming:brows`).
 *
 * The separator is safe without escaping because every discriminator is a member
 * of a closed enum in `./kinds` — no vocabulary member contains a `:` or a `/`,
 * and one that did would be caught by the kind's own value schema before it ever
 * reached a key.
 *
 * The discriminator is fixed for an entry's whole life: `rearrange` writes
 * `arrangement` and `smudge` writes `disturbance`, neither of which is a
 * discriminator, so an entry's key cannot move out from under an observer's
 * memory row.
 */
export function presentationAspect(kindId: string, value: unknown): string {
  const field = PRESENTATION_DISCRIMINATOR_FIELDS.get(kindId);
  if (field === undefined) return kindId;
  const record = presentationRecord(value);
  const discriminator = record?.[field];
  return typeof discriminator === "string" ? `${kindId}:${discriminator}` : kindId;
}

/** Kinds whose value carries an `arrangement` that `rearrange` may move. */
const REARRANGEABLE_KIND_IDS: ReadonlySet<string> = new Set([VISUAL_STATE_PRESENTATION_HAIRSTYLE_KIND_ID]);

/** Kinds whose value carries a `disturbance` that `smudge` sets and `restore` clears. */
const DISTURBABLE_KIND_IDS: ReadonlySet<string> = new Set([
  VISUAL_STATE_PRESENTATION_HAIRSTYLE_KIND_ID,
  VISUAL_STATE_PRESENTATION_MAKEUP_KIND_ID,
  VISUAL_STATE_PRESENTATION_COSMETIC_MARK_KIND_ID,
]);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface PresentationEntry<TValue = unknown> {
  readonly id: string;
  readonly subjectId: string;
  readonly kindId: string;
  readonly locus: VisualStateLocusRef;
  readonly value: TValue;
  /** Story minutes at which the choice was MADE. */
  readonly appliedAtMinutes: number;
  /**
   * SPEC ADDITION. Story minutes at which the entry last moved — a rearrange, a
   * smudge, a restore. The spec's entry shape carries only `appliedAtMinutes`,
   * and bumping that on a smudge would claim the makeup was reapplied. Change
   * significance (slice 5) needs to know when the value actually moved, and the
   * projected feature's `changedAtMinutes` comes from here.
   */
  readonly changedAtMinutes?: number;
  readonly sourceEventId?: string;
  /**
   * PROVENANCE ONLY: the entry this one replaced when it was applied.
   *
   * `apply` deletes the entry it supersedes, so the referent is normally gone by
   * the time anyone reads this — it answers "what was here before" for an
   * inspector, not "follow the chain". There is no chain: nothing walks it,
   * nothing requires it to resolve, and the boundary parser deliberately admits
   * any value (a dangling id, a self-reference, a loop between two entries)
   * rather than validating a graph no reader traverses.
   */
  readonly supersedesEntryId?: string;
}

export interface CharacterPresentationState {
  readonly version: 1;
  readonly entries: readonly PresentationEntry[];
}

/** Nothing chosen yet — the degraded default and the pre-seed value. */
export function emptyCharacterPresentationState(): CharacterPresentationState {
  return { version: PRESENTATION_STATE_VERSION, entries: [] };
}

const presentationIdSchema = z.string().trim().min(1).max(64);
const storyMinutesSchema = z.number().int().min(0);

export const presentationEntrySchema = z.object({
  id: presentationIdSchema,
  subjectId: presentationIdSchema,
  kindId: z.string().trim().min(1).max(64),
  locus: visualStateLocusRefSchema,
  value: z.unknown(),
  appliedAtMinutes: storyMinutesSchema,
  changedAtMinutes: storyMinutesSchema.optional(),
  sourceEventId: presentationIdSchema.optional(),
  supersedesEntryId: presentationIdSchema.optional(),
});

export const characterPresentationStateSchema = z.object({
  version: z.literal(PRESENTATION_STATE_VERSION),
  entries: z.array(presentationEntrySchema),
});

/**
 * Code-unit order, never `localeCompare` — entry order is part of the projected
 * snapshot's order, so a locale-sensitive comparator would make it
 * machine-specific.
 */
function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** The one entry order: subject, kind, locus, id. */
export function sortPresentationEntries(entries: readonly PresentationEntry[]): PresentationEntry[] {
  return [...entries].sort((left, right) => {
    const bySubject = compareStrings(left.subjectId, right.subjectId);
    if (bySubject !== 0) return bySubject;
    const byKind = compareStrings(left.kindId, right.kindId);
    if (byKind !== 0) return byKind;
    const byLocus = compareStrings(visualStateLocusKey(left.locus), visualStateLocusKey(right.locus));
    if (byLocus !== 0) return byLocus;
    return compareStrings(left.id, right.id);
  });
}

/**
 * Bound the entry list, evicting the OLDEST application first.
 *
 * Silent, like the garment store's own caps: an overflowing presentation list is
 * a bounded-storage fact, not a degraded read, and a diagnostic per turn on a
 * character with two dozen deliberate choices would be noise.
 */
function capPresentationEntries(entries: readonly PresentationEntry[]): PresentationEntry[] {
  if (entries.length <= PRESENTATION_MAX_ENTRIES) return [...entries];
  return [...entries]
    .sort((left, right) => {
      const byTime = left.appliedAtMinutes - right.appliedAtMinutes;
      return byTime !== 0 ? byTime : compareStrings(left.id, right.id);
    })
    .slice(-PRESENTATION_MAX_ENTRIES);
}

// ---------------------------------------------------------------------------
// Entry validation — one gate, shared by the parser and the reducer
// ---------------------------------------------------------------------------

/**
 * Accept one candidate entry, or `null` with a diagnostic.
 *
 * Every path that can create an entry runs through here — the reducer and the
 * boundary parser both — so "what a valid presentation entry is" has exactly one
 * definition, and the two paths cannot produce different entries from the same
 * facts.
 *
 * That second guarantee is why the ENTRY SCHEMA runs here and why the accepted
 * entry is rebuilt from its output rather than from the caller's object. Without
 * it the write path checked the kind and the value but not the record: an
 * over-long id or a negative story minute was admitted, projected for one turn,
 * and then silently dropped on reload; a subject id with surrounding whitespace
 * was admitted untrimmed, projected under one key, and came back from storage
 * under another. Nothing reported either, because the disagreement was between
 * two code paths rather than inside one.
 */
function acceptPresentationEntry(
  candidate: PresentationEntry,
  sink: DiagnosticSink | undefined,
  path: string,
): PresentationEntry | null {
  const shape = presentationEntrySchema.safeParse(candidate);
  if (!shape.success) {
    sink?.push(
      diag(
        "warn",
        VISUAL_STATE_PRESENTATION_ENTRY_MALFORMED,
        shape.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
        { path, context: { entryId: candidate.id, kindId: candidate.kindId } },
      ),
    );
    return null;
  }
  const row = shape.data;

  const kind = visualStateKindRegistry.byId(row.kindId);
  if (!kind) {
    sink?.push(
      diag("warn", VISUAL_STATE_KIND_UNKNOWN, `Unknown visual state kind ${row.kindId}`, {
        path,
        context: { entryId: row.id, kindId: row.kindId },
      }),
    );
    return null;
  }
  // A registered kind this owner does not own is a different failure from an
  // unregistered one: `wardrobe.garment` exists and is perfectly valid — it is
  // just item-backed, and applying it here would create a second, item-less copy
  // of a garment the wardrobe already owns.
  if (!OWNED_KIND_IDS.has(row.kindId)) {
    rejectOperation(sink, path, `${row.kindId} is item-backed and is not written by this owner`, {
      entryId: row.id,
      kindId: row.kindId,
    });
    return null;
  }

  const locusKind = visualStateLocusKind(row.locus);
  if (!visualStateKindRegistry.allowsLocus(row.kindId, locusKind)) {
    sink?.push(
      diag("warn", VISUAL_STATE_LOCUS_NOT_ALLOWED, `${row.kindId} may not sit at a ${locusKind} locus`, {
        path,
        context: { entryId: row.id, locusKind },
      }),
    );
    return null;
  }

  // The same rule the feature contract applies: a body locus must survive
  // registry validation UNCHANGED, because the projected feature's key is built
  // from the fine locus and a healed one would describe a different place.
  if (row.locus.kind === "body") {
    const validation = validateBodyLocusRef(row.locus.locus, sink, path);
    if (!validation.ok || validation.coarsened) {
      sink?.push(
        diag("warn", VISUAL_STATE_LOCUS_INVALID, "Presentation body locus is not usable as written", {
          path,
          context: { entryId: row.id },
        }),
      );
      return null;
    }
  }

  const parsed = visualStateKindRegistry.parseValue(row.kindId, row.value);
  if (!parsed.ok) {
    sink?.push(
      diag("warn", VISUAL_STATE_VALUE_INVALID, parsed.issues.join("; "), {
        path,
        context: { entryId: row.id, kindId: row.kindId },
      }),
    );
    return null;
  }

  return {
    id: row.id,
    subjectId: row.subjectId,
    kindId: row.kindId,
    locus: row.locus,
    value: parsed.value,
    appliedAtMinutes: row.appliedAtMinutes,
    ...(row.changedAtMinutes === undefined ? {} : { changedAtMinutes: row.changedAtMinutes }),
    ...(row.sourceEventId === undefined ? {} : { sourceEventId: row.sourceEventId }),
    ...(row.supersedesEntryId === undefined ? {} : { supersedesEntryId: row.supersedesEntryId }),
  };
}

/**
 * The trust boundary: a raw presentation record becomes a validated state, or
 * the empty one (docs/resilience.md §1). Never throws. Individual entries that
 * fail their kind are dropped with a diagnostic rather than voiding the state —
 * one unreadable row must not cost a character every other choice they made.
 */
export function parseCharacterPresentationState(
  raw: unknown,
  sink?: DiagnosticSink,
  path = "visual_state.presentation",
): CharacterPresentationState {
  const parsed = parseOrNull(characterPresentationStateSchema, raw, sink, path);
  if (parsed === null) return emptyCharacterPresentationState();
  const entries: PresentationEntry[] = [];
  for (const row of parsed.entries) {
    const accepted = acceptPresentationEntry(
      {
        id: row.id,
        subjectId: row.subjectId,
        kindId: row.kindId,
        locus: row.locus,
        value: row.value,
        appliedAtMinutes: row.appliedAtMinutes,
        changedAtMinutes: row.changedAtMinutes,
        sourceEventId: row.sourceEventId,
        supersedesEntryId: row.supersedesEntryId,
      },
      sink,
      path,
    );
    if (accepted !== null) entries.push(accepted);
  }
  return { version: PRESENTATION_STATE_VERSION, entries: sortPresentationEntries(capPresentationEntries(entries)) };
}

// ---------------------------------------------------------------------------
// Typed operations
// ---------------------------------------------------------------------------

/**
 * The write surface. A model proposing a presentation change picks one of these
 * and fills registered vocabulary into it; it never hands over a value shape of
 * its own, and it never edits an entry in place.
 */
export const presentationOperationSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("apply"),
    entryId: presentationIdSchema,
    subjectId: presentationIdSchema,
    kindId: z.string().trim().min(1).max(64),
    locus: visualStateLocusRefSchema,
    value: z.unknown(),
    atMinutes: storyMinutesSchema,
    sourceEventId: presentationIdSchema.optional(),
  }),
  z.object({ kind: z.literal("remove"), entryId: presentationIdSchema, atMinutes: storyMinutesSchema }),
  z.object({
    kind: z.literal("rearrange"),
    entryId: presentationIdSchema,
    // The hair vocabulary by name rather than a generic patch: `rearrange` is
    // the hairstyle operation, and typing it this way is what stops it becoming
    // a back door for editing any field of any value.
    arrangement: z.enum(presentationHairArrangements),
    atMinutes: storyMinutesSchema,
  }),
  z.object({
    kind: z.literal("smudge"),
    entryId: presentationIdSchema,
    disturbance: z.enum(presentationDisturbances),
    atMinutes: storyMinutesSchema,
  }),
  z.object({ kind: z.literal("restore"), entryId: presentationIdSchema, atMinutes: storyMinutesSchema }),
]);

export type PresentationOperation = z.infer<typeof presentationOperationSchema>;
export type PresentationOperationKind = PresentationOperation["kind"];

/**
 * Parse a proposal's operation list, PER ITEM, so one malformed operation is
 * dropped instead of voiding the whole proposal.
 */
export function parsePresentationOperations(
  raw: unknown,
  sink?: DiagnosticSink,
  path = "visual_state.presentation.operation",
): readonly PresentationOperation[] {
  const items = parseOr(z.array(z.unknown()), raw, [], sink, path);
  const kept: PresentationOperation[] = [];
  for (const item of items) {
    // No sink on the inner parse: a per-item failure is reported once, in this
    // family's own vocabulary, rather than twice under two different codes.
    const operation = parseOrNull(presentationOperationSchema, item, undefined, path);
    if (operation === null) {
      sink?.push(diag("warn", VISUAL_STATE_PRESENTATION_OPERATION_INVALID, "Operation is not a usable record", { path }));
      continue;
    }
    kept.push(operation);
  }
  if (kept.length > PRESENTATION_MAX_OPERATIONS) {
    // Reported, unlike the entry cap's silence. An entry cap evicting the oldest
    // choice is bounded storage doing its job; a proposal arriving with more
    // operations than the contract accepts means part of what a model asked for
    // never happened, and the caller has to be able to see that.
    sink?.push(
      diag(
        "warn",
        VISUAL_STATE_PRESENTATION_OPERATION_INVALID,
        `Proposal carried ${kept.length} operations; only the first ${PRESENTATION_MAX_OPERATIONS} were kept`,
        { path, context: { received: kept.length, cap: PRESENTATION_MAX_OPERATIONS } },
      ),
    );
  }
  return kept.slice(0, PRESENTATION_MAX_OPERATIONS);
}

/** A presentation value is always a flat record of enum members; this is the safe read. */
function presentationRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return { ...(value as Record<string, unknown>) };
}

function rejectOperation(
  sink: DiagnosticSink | undefined,
  path: string,
  message: string,
  context: Record<string, unknown>,
): void {
  sink?.push(diag("warn", VISUAL_STATE_PRESENTATION_OPERATION_INVALID, message, { path, context }));
}

function entryIndex(entries: readonly PresentationEntry[], entryId: string): number {
  return entries.findIndex((entry) => entry.id === entryId);
}

/** The entry an operation names and its position, or `null` with a diagnostic. */
function locateEntry(
  entries: readonly PresentationEntry[],
  entryId: string,
  sink: DiagnosticSink | undefined,
  path: string,
): { readonly index: number; readonly entry: PresentationEntry } | null {
  const index = entryIndex(entries, entryId);
  const entry = entries[index];
  if (index < 0 || entry === undefined) {
    sink?.push(
      diag("warn", VISUAL_STATE_PRESENTATION_ENTRY_UNKNOWN, `No presentation entry ${entryId}`, {
        path,
        context: { entryId },
      }),
    );
    return null;
  }
  return { index, entry };
}

/**
 * The mutable half of an entry an operation is allowed to touch: its value, as a
 * flat record, and only when the kind declares the capability. Returns `null`
 * with a diagnostic otherwise — a `smudge` on a nail finish is a proposal about
 * something that cannot be disturbed, not a value to coerce.
 */
function editableValue(
  entry: PresentationEntry,
  capable: ReadonlySet<string>,
  what: string,
  sink: DiagnosticSink | undefined,
  path: string,
): Record<string, unknown> | null {
  const record = presentationRecord(entry.value);
  if (!capable.has(entry.kindId) || record === null) {
    rejectOperation(sink, path, `${entry.kindId} ${what}`, { entryId: entry.id, kindId: entry.kindId });
    return null;
  }
  return record;
}

/**
 * Re-validate an entry whose value one operation changed, and stamp the change
 * ONLY when the value actually moved.
 *
 * The whole value goes back through the kind's schema rather than the changed
 * field being trusted: a `rearrange` that produced a shape the kind rejects must
 * leave the entry exactly as it was, not half-edited.
 *
 * The stamp is conditional because `changedAtMinutes` exists to answer "when did
 * this value last move" for slice 5's change significance. A restore of an entry
 * that was never disturbed, or a rearrange from `loose` to `loose`, changes
 * nothing — stamping it would advance the clock against an identical fingerprint
 * and make an unchanged feature look like a change candidate, which is the exact
 * failure the field was added to prevent.
 */
function reviseEntry(
  entries: readonly PresentationEntry[],
  index: number,
  entry: PresentationEntry,
  value: unknown,
  atMinutes: number,
  sink: DiagnosticSink | undefined,
  path: string,
): PresentationEntry[] {
  const moved = visualStateFingerprint(value) !== visualStateFingerprint(entry.value);
  const revised = acceptPresentationEntry(
    { ...entry, value, ...(moved ? { changedAtMinutes: atMinutes } : {}) },
    sink,
    path,
  );
  if (revised === null) return [...entries];
  const next = [...entries];
  next[index] = revised;
  return next;
}

function applyOperation(
  entries: readonly PresentationEntry[],
  operation: PresentationOperation,
  sink: DiagnosticSink | undefined,
  path: string,
): PresentationEntry[] {
  switch (operation.kind) {
    case "apply": {
      if (entryIndex(entries, operation.entryId) >= 0) {
        rejectOperation(sink, path, `Entry ${operation.entryId} already exists`, { entryId: operation.entryId });
        return [...entries];
      }
      // Superseding is per (subject, locus, aspect) — the same identity the
      // projected feature key carries, so the slot a new choice takes and the key
      // it lands on can never disagree. A character has one hairstyle on their
      // hair, and one BROW grooming on their face beside one FACIAL-HAIR
      // grooming, because the aspect carries the discriminator.
      const locusKey = visualStateLocusKey(operation.locus);
      const aspect = presentationAspect(operation.kindId, operation.value);
      const superseded = entries.find(
        (entry) =>
          entry.subjectId === operation.subjectId &&
          visualStateLocusKey(entry.locus) === locusKey &&
          presentationAspect(entry.kindId, entry.value) === aspect,
      );
      const accepted = acceptPresentationEntry(
        {
          id: operation.entryId,
          subjectId: operation.subjectId,
          kindId: operation.kindId,
          locus: operation.locus,
          value: operation.value,
          appliedAtMinutes: operation.atMinutes,
          sourceEventId: operation.sourceEventId,
          supersedesEntryId: superseded?.id,
        },
        sink,
        path,
      );
      if (accepted === null) return [...entries];
      return [...entries.filter((entry) => entry.id !== superseded?.id), accepted];
    }
    case "remove": {
      const located = locateEntry(entries, operation.entryId, sink, path);
      if (located === null) return [...entries];
      return entries.filter((entry) => entry.id !== operation.entryId);
    }
    case "rearrange": {
      const located = locateEntry(entries, operation.entryId, sink, path);
      if (located === null) return [...entries];
      const record = editableValue(located.entry, REARRANGEABLE_KIND_IDS, "has no arrangement", sink, path);
      if (record === null) return [...entries];
      record.arrangement = operation.arrangement;
      return reviseEntry(entries, located.index, located.entry, record, operation.atMinutes, sink, path);
    }
    case "smudge": {
      const located = locateEntry(entries, operation.entryId, sink, path);
      if (located === null) return [...entries];
      const record = editableValue(located.entry, DISTURBABLE_KIND_IDS, "cannot be disturbed", sink, path);
      if (record === null) return [...entries];
      record.disturbance = operation.disturbance;
      return reviseEntry(entries, located.index, located.entry, record, operation.atMinutes, sink, path);
    }
    case "restore": {
      const located = locateEntry(entries, operation.entryId, sink, path);
      if (located === null) return [...entries];
      const record = editableValue(located.entry, DISTURBABLE_KIND_IDS, "cannot be disturbed", sink, path);
      if (record === null) return [...entries];
      // Restoring clears the disturbance and nothing else. It does not undo a
      // rearrange: the hair is genuinely in a different arrangement now, and
      // "put it back" is another rearrange with the arrangement named.
      delete record.disturbance;
      return reviseEntry(entries, located.index, located.entry, record, operation.atMinutes, sink, path);
    }
  }
}

/**
 * The reducer: state plus typed operations in, state out.
 *
 * Pure and total — an operation that cannot apply is dropped with a diagnostic
 * and the state carries on, so a malformed proposal costs a change rather than
 * a turn (docs/resilience.md §2).
 */
export function applyPresentationOperations(
  state: CharacterPresentationState,
  operations: readonly PresentationOperation[],
  sink?: DiagnosticSink,
  path = "visual_state.presentation.operation",
): CharacterPresentationState {
  let entries: readonly PresentationEntry[] = state.entries;
  for (const operation of operations) {
    entries = applyOperation(entries, operation, sink, path);
  }
  return {
    version: PRESENTATION_STATE_VERSION,
    entries: sortPresentationEntries(capPresentationEntries(entries)),
  };
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

export interface VisualStatePresentationProjectionInput {
  readonly state: CharacterPresentationState;
  /**
   * The features earlier adapters already produced. `modifies` edges are emitted
   * ONLY against these: a relationship pointing at a feature the snapshot does
   * not hold would be resolved away as a missing target, so an adapter that
   * cannot see its target asserts nothing instead of guessing.
   */
  readonly composeAgainst?: readonly VisualStateFeature[];
  readonly sink?: DiagnosticSink;
  readonly path?: string;
}

/** Every enum member in a flat presentation value, in canonical key order. */
function presentationValueTags(value: unknown): string[] {
  const record = presentationRecord(value);
  if (record === null) return [];
  return Object.keys(record)
    .sort(compareStrings)
    .flatMap((key) => {
      const item = record[key];
      return typeof item === "string" ? [item] : [];
    });
}

/**
 * The identity features a presentation choice sits on top of.
 *
 * The rule is the body-location SUBTREE of the entry's own locus: makeup on the
 * face modifies what is under the face, a nail finish on the fingers modifies
 * what is on the fingers. Nothing outside the subtree is touched, and a sided
 * entry only reaches features on that side (or unsided ones) — a smudge on the
 * left cheek is not a statement about the right.
 */
function modifiedIdentityKeys(
  entry: PresentationEntry,
  composeAgainst: readonly VisualStateFeature[],
): string[] {
  if (entry.locus.kind !== "body") return [];
  const covered = new Set(bodyLocationRegistry.expand(entry.locus.locus.bodyLocationId));
  const side = entry.locus.locus.side;
  const keys: string[] = [];
  for (const target of composeAgainst) {
    if (target.subjectId !== entry.subjectId) continue;
    if (target.layer !== "identity") continue;
    if (target.locus.kind !== "body") continue;
    if (!covered.has(target.locus.locus.bodyLocationId)) continue;
    if (side !== undefined && target.locus.locus.side !== undefined && target.locus.locus.side !== side) continue;
    keys.push(target.key);
  }
  return keys.sort(compareStrings);
}

function presentationEvidence(entry: PresentationEntry): AffordanceEvidence[] {
  return [
    affordanceEvidence("adapter", "visual_state.presentation", entry.kindId),
    affordanceEvidence("state", `presentation:${entry.id}`),
  ];
}

/**
 * Presentation entries as visual-state features.
 *
 * Everything a feature needs is already on the entry or its registered kind, so
 * there is nothing to infer: the layer, stability and priors come from the kind,
 * the value and locus from the entry, and the only computed field is the
 * `modifies` edge set.
 */
export function projectPresentationFeatures(
  input: VisualStatePresentationProjectionInput,
): readonly VisualStateFeature[] {
  const path = input.path ?? "visual_state.presentation.projection";
  const composeAgainst = input.composeAgainst ?? [];
  const projected: VisualStateFeature[] = [];

  for (const entry of sortPresentationEntries(input.state.entries)) {
    const kind = visualStateKindRegistry.byId(entry.kindId);
    if (!kind) {
      input.sink?.push(
        diag("warn", VISUAL_STATE_KIND_UNKNOWN, `Unknown visual state kind ${entry.kindId}`, {
          path,
          context: { entryId: entry.id, kindId: entry.kindId },
        }),
      );
      continue;
    }
    const relationships: VisualStateRelationship[] = modifiedIdentityKeys(entry, composeAgainst).map((targetKey) => ({
      kind: "modifies",
      targetKey,
    }));
    const candidate: VisualStateFeature = {
      version: 1,
      // The aspect is the kind id plus any discriminator, so one subject can
      // carry a hairstyle and a makeup — or two different groomings — at the
      // same locus without either claiming the other's key.
      key: visualStateFeatureKey(entry.subjectId, entry.locus, presentationAspect(entry.kindId, entry.value)),
      subjectId: entry.subjectId,
      kindId: entry.kindId,
      layer: kind.layer,
      locus: entry.locus,
      sourceRef: { kind: "presentation", presentationId: entry.id },
      value: entry.value,
      truthFingerprint: visualStateFingerprint(entry.value),
      semanticTags: [kind.repeatFamily, ...presentationValueTags(entry.value)],
      stability: kind.stability,
      relationships,
      priors: kind.priors,
      evidence: presentationEvidence(entry),
      changedAtMinutes: entry.changedAtMinutes ?? entry.appliedAtMinutes,
    };
    const accepted = validateVisualStateFeature(candidate, input.sink, path);
    if (accepted !== null) projected.push(accepted);
  }

  return projected;
}
