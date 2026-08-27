import { z } from "zod";
import { familiarityBandById, regardBandById } from "../relationships/bands";

/**
 * Character drives: the wants a character PURSUES
 * across exchanges — the inner life `mindNote` (one transient note) and
 * `openLoops` (conversational leftovers) never carried. Authored on the profile
 * (≤3), seeded into chat state with runtime `progress`/`revealed`, updated by
 * the archivist, and rendered as prompt LAW: open drives steer, `guarded` ones
 * withhold-until-asked, `secret` ones are protected — below their reveal band
 * with a full (but tightly scoped) lie license, owner ruling 2026-07-11.
 */

export const DRIVES_MAX = 3;
export const DRIVE_WANT_MAX_CHARS = 120;
export const DRIVE_WHY_MAX_CHARS = 200;
export const DRIVE_PROGRESS_MAX_CHARS = 200;

/** How openly the character holds a drive. */
export const driveSecrecySchema = z.enum(["open", "guarded", "secret"]).catch("open");
export type DriveSecrecy = z.infer<typeof driveSecrecySchema>;

/** An authored reveal gate: which relationship axis unlocks the secret, at which band. */
export const driveRevealBandSchema = z.object({
  axis: z.enum(["familiarity", "regard"]).catch("familiarity"),
  band: z.string().trim().min(1),
});
export type DriveRevealBand = z.infer<typeof driveRevealBandSchema>;

// Over-length text TRUNCATES at the cap rather than failing the field (forge-gaps
// ruling 2026-07-12): the old `.max()` shapes made an over-cap `want` drop the whole
// row and an over-cap `why` catch-wipe to "" — losing authored content wholesale
// where cutting it at the cap loses only the overflow. The editor's maxLength +
// live counters keep humans inside the caps; this is the trust-boundary backstop.
const cappedText = (max: number) =>
  z
    .string()
    .catch("")
    .default("")
    .transform((s) => s.trim().slice(0, max));

/** The authored drive (CharacterProfile.drives). */
export const driveSchema = z.object({
  /** What she wants — a short phrase ("to reopen the gallery under her own name"). An empty want still drops the row. */
  want: cappedText(DRIVE_WANT_MAX_CHARS).pipe(z.string().min(1)),
  /** Why it matters — one line of motive; "" is fine. */
  why: cappedText(DRIVE_WHY_MAX_CHARS),
  secrecy: driveSecrecySchema.default("open"),
  /** Secret-only: the gate that unlocks the reveal. Absent ⇒ the ruled default (familiarity ≥ familiar). */
  revealBand: driveRevealBandSchema.optional().catch(undefined),
});
export type Drive = z.infer<typeof driveSchema>;

// Element-wise catch: one bad entry (an editor row saved with an empty want)
// drops alone instead of wiping the whole authored list (docs/resilience.md §1).
export const drivesSchema = z
  .array(driveSchema.nullable().catch(null))
  .catch([])
  .default([])
  .transform((d) => d.filter((x): x is Drive => x !== null).slice(0, DRIVES_MAX));

/** The runtime drive on chat state: the authored shape + what play has done to it. */
export const chatDriveSchema = driveSchema.extend({
  /** The archivist's latest progress note ("she told her landlord; the lease falls through Friday"). */
  progress: cappedText(DRIVE_PROGRESS_MAX_CHARS),
  /** A `secret` that has been spoken aloud to the player (a `secret_shared` milestone marked it). */
  revealed: z.boolean().catch(false).default(false),
  /** The fiction resolved it (achieved or abandoned) — kept for texture, no longer pursued. */
  resolved: z.boolean().catch(false).default(false),
});
export type ChatDrive = z.infer<typeof chatDriveSchema>;

export const chatDrivesSchema = z
  .array(chatDriveSchema.nullable().catch(null))
  .catch([])
  .default([])
  .transform((d) => d.filter((x): x is ChatDrive => x !== null).slice(0, DRIVES_MAX));

/** Seed the runtime drives from the authored profile. PURE. */
export function seedChatDrives(authored: readonly Drive[]): ChatDrive[] {
  return authored.slice(0, DRIVES_MAX).map((d) => ({ ...d, progress: "", revealed: false, resolved: false }));
}

/** The ruled default gate for a `secret` with no authored band: familiarity ≥ `familiar`. */
const DEFAULT_REVEAL: DriveRevealBand = { axis: "familiarity", band: "familiar" };

/**
 * Is a `secret` drive still WITHHELD at these axis values? Open/guarded/revealed
 * drives are never withheld; an unknown authored band degrades to the ruled
 * default rather than locking the secret forever. PURE.
 */
export function driveWithheld(drive: ChatDrive, axes: { regard: number; familiarity: number }): boolean {
  if (drive.secrecy !== "secret" || drive.revealed) return false;
  const gate = drive.revealBand ?? DEFAULT_REVEAL;
  const floor =
    gate.axis === "regard"
      ? (regardBandById(gate.band) ?? regardBandById("close"))?.min
      : (familiarityBandById(gate.band) ?? familiarityBandById("familiar"))?.min;
  const value = gate.axis === "regard" ? axes.regard : axes.familiarity;
  return value < (floor ?? 55);
}

/** One archivist drive update, matched to an existing drive by its `want` text. */
export const driveUpdateSchema = z.object({
  want: cappedText(DRIVE_WANT_MAX_CHARS).pipe(z.string().min(1)),
  /** Fresh progress note; "" keeps the prior one. */
  progress: cappedText(DRIVE_PROGRESS_MAX_CHARS),
  /** The character spoke this (previously secret) drive aloud to the player this exchange. */
  revealed: z.boolean().catch(false).default(false),
  /** The fiction resolved it (achieved / abandoned). */
  resolved: z.boolean().catch(false).default(false),
});
export type DriveUpdate = z.infer<typeof driveUpdateSchema>;

const normalize = (text: string): string => text.trim().toLowerCase();

/**
 * Fold archivist drive updates into the runtime set (match by normalized `want`;
 * unmatched updates drop — the archivist can only move drives that exist).
 * Returns the next drives plus which secrets were newly revealed (the
 * `secret_shared` milestone source). PURE.
 */
export function applyDriveUpdates(
  drives: readonly ChatDrive[],
  updates: readonly DriveUpdate[],
): { drives: ChatDrive[]; revealed: ChatDrive[] } {
  if (!updates.length) return { drives: [...drives], revealed: [] };
  const byWant = new Map(updates.map((u) => [normalize(u.want), u]));
  const revealed: ChatDrive[] = [];
  const next = drives.map((drive) => {
    const update = byWant.get(normalize(drive.want));
    if (!update) return drive;
    const out: ChatDrive = {
      ...drive,
      progress: update.progress.trim() || drive.progress,
      revealed: drive.revealed || update.revealed,
      resolved: drive.resolved || update.resolved,
    };
    if (!drive.revealed && out.revealed && drive.secrecy === "secret") revealed.push(out);
    return out;
  });
  return { drives: next, revealed };
}
