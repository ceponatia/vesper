import { z } from "zod";

import { diag, diagnosticSchema, type Diagnostic, type DiagnosticSink } from "../diagnostics";
import { narratorRunProvenanceSchema, type NarratorRunProvenance } from "../narrator-prompts";
import { chatActionIdSchema, type ChatActionId } from "./chat-pulse";
import type { CompositionFallbackCode } from "./composition-fallback";

/**
 * The one durable contract for `character_chat_messages.meta` — the JSONB bag
 * every chat message row carries beside its text.
 *
 * Both lanes write it (legacy 1:1/ensemble and the successor sim exchange), both
 * roles use it, and the server, the transcript API and the browser all read it
 * back. Before this module each reader declared its own partial schema over the
 * same column and each writer rebuilt the whole bag, so a key one side did not
 * model was silently discarded by the next write — a saved narrator line came
 * back as player speech, and a retake dropped the cut provenance it was supposed
 * to re-render from. One shape, parsed one way, is the fix.
 *
 * Three rules make it safe (docs/resilience.md §1):
 *
 * - **Per-field independence.** {@link parseChatMessageMeta} parses each optional
 *   field on its own. A malformed `attachments` drops alone with a
 *   `chat_message_meta.field_invalid` diagnostic while `inputMode`, `narratorRun`
 *   and `simTurn` survive. zod's `.catch()` is deliberately NOT used for this: it
 *   is silent, and a degradation nobody can see is the blindfold that
 *   docs/resilience.md §8 warns about.
 * - **Unknown keys are preserved.** Anything this module does not model is kept
 *   in {@link ChatMessageMeta.extra} and written back out by
 *   {@link serializeChatMessageMeta}, so a key a NEWER deploy wrote survives an
 *   older reader's rewrite. A writer never discards what it does not understand.
 * - **A failed parse is never an exception.** An unreadable bag degrades to
 *   {@link emptyChatMessageMeta} and records a diagnostic. A fallback is never a
 *   positive claim: an unreadable `inputMode` is UNKNOWN, and every consumer
 *   treats unknown as player input — the same default a row that never carried
 *   the key gets — but the diagnostic fires so the loss is countable.
 *
 * Pure: schemas, parse, merge, serialize. No IO, no database, no lane knowledge.
 */

/**
 * The bag's schema version. Absent means 1 — every row written before the field
 * existed is a legal version-1 row, so nothing backfills and nothing migrates.
 *
 * The version is a READER HINT, never a gate: no reader refuses a row over `v`,
 * because refusing would lose the turn the column exists to replay.
 *
 * - A **v1 reader meeting a v2 row** parses the fields it knows, keeps the rest
 *   in `extra`, and writes them back untouched. It never destroys v2 data.
 * - A **v2 reader meeting a v1 row** finds its v2-only fields absent. Every
 *   field here is optional, so absent is already the legal state; a v2 field
 *   defaults exactly as it does on a fresh row.
 *
 * Because of that, a version bump is only ever needed to change the MEANING of
 * an existing key (the one thing per-field optionality cannot absorb). Adding a
 * key is not a bump, and is not a migration.
 */
export const CHAT_MESSAGE_META_VERSION = 1;

/** One optional field failed to parse and was dropped; `context.field` names it. */
export const CHAT_MESSAGE_META_FIELD_INVALID = "chat_message_meta.field_invalid";
/** The stored value was not a usable object; the whole bag degraded to empty. */
export const CHAT_MESSAGE_META_BAG_INVALID = "chat_message_meta.bag_invalid";

/** Attached photos on a user line: the claimed asset ids and any persisted vision read. */
export const chatMessageAttachmentsSchema = z.object({
  ids: z.array(z.string()),
  /** The batched vision description per id — same length as `ids`, or the reader ignores it. */
  descriptions: z.array(z.string()).optional(),
});
export type ChatMessageAttachments = z.infer<typeof chatMessageAttachmentsSchema>;

/** How a user line was authored: the player acting, or the storyteller narrating. */
export const chatMessageInputModeSchema = z.enum(["player", "narrator"]);
export type ChatMessageInputMode = z.infer<typeof chatMessageInputModeSchema>;

/**
 * The world-beat marker: a durable travel / time-skip / scene-ended trace, stored
 * on an assistant row whose `content` carries the phrased line.
 *
 * `kind` is a plain string on purpose. The vocabulary belongs to
 * `lib/simulation/world-beat.ts`, and a reader that narrowed it to today's enum
 * would rewrite a kind a newer deploy wrote into some other kind on the next
 * merge — corrupting the row to keep its own types tidy. Every consumer that
 * matters asks only whether the marker is PRESENT.
 */
export const chatMessageWorldBeatSchema = z.object({ kind: z.string().min(1) });
export type ChatMessageWorldBeat = z.infer<typeof chatMessageWorldBeatSchema>;

/**
 * Per-field schemas. The parse loop below walks this table, so adding a key here
 * is the whole change: it becomes readable, mergeable and serializable at once,
 * and stops being an unknown key carried blind in `extra`.
 *
 * Every entry is the schema for the field's VALUE. Optionality is not expressed
 * here — a key absent from the stored bag is simply never parsed.
 */
const FIELD_SCHEMAS = {
  /** Schema version; absent = 1. See {@link CHAT_MESSAGE_META_VERSION}. */
  v: z.number().int().min(1),

  // --- user lines ---------------------------------------------------------
  attachments: chatMessageAttachmentsSchema,
  inputMode: chatMessageInputModeSchema,

  // --- assistant replies, legacy lane -------------------------------------
  /** The tapped action chip, so a regenerate reproduces the cue and its effect. */
  actionBeat: chatActionIdSchema,
  /** The player cut the stream short; whatever streamed persisted. */
  stopped: z.boolean(),

  // --- either role, successor lane ----------------------------------------
  /** Written by the successor exchange rather than the legacy pipeline. */
  simTurn: z.boolean(),
  /** This reply answered an `open` — the opening-directive flag the prompt build reads. */
  simOpening: z.boolean(),
  /** The reply rendered as a solo cut (the primary was not co-present). */
  solo: z.boolean(),
  /** The committed cut this reply rendered — what a retake re-renders. */
  cutId: z.string().min(1),
  /** The narrator model that produced the content on the row. */
  modelId: z.string(),
  /** How many generation attempts the render took. */
  attempts: z.number().int().min(0),
  /** The cut's confirmation state at render time. */
  confirmStatus: z.string(),
  /** The world-beat marker (a UI trace, not narration). */
  worldBeat: chatMessageWorldBeatSchema,

  // --- provenance and degradation breadcrumbs -----------------------------
  /**
   * Which prompt and model wrote what this row currently displays. `content`
   * mirrors the active take, so this is the row-level answer, and it MOVES when
   * a different take is made active.
   */
  narratorRun: narratorRunProvenanceSchema,
  /**
   * Public-safe composition-fallback codes (never the private detail): open a
   * suspicious beat and see what degraded.
   *
   * Typed as strings for the same reason as `worldBeat.kind` — the vocabulary's
   * owner is `composition-fallback.ts`, and narrowing here would let an older
   * reader rewrite a newer code into a wrong one on the next merge.
   */
  compositionFallbacks: z.array(z.string().min(1)),
  /** The solo render's own stable diagnostic codes, kept with the reply they describe. */
  renderDiagnostics: z.array(diagnosticSchema),
} satisfies Record<string, z.ZodType>;

type KnownKey = keyof typeof FIELD_SCHEMAS;

const KNOWN_KEYS = Object.keys(FIELD_SCHEMAS) as readonly KnownKey[];
const KNOWN_KEY_SET: ReadonlySet<string> = new Set<string>(KNOWN_KEYS);

/**
 * One parsed `character_chat_messages.meta` bag.
 *
 * Every modelled field is optional, because every one of them is: a row predates
 * the key, or its lane never writes it. A consumer picks the fields it needs off
 * this type and treats absent as its own documented default.
 *
 * `extra` holds every key this module does not model — a newer deploy's field, or
 * one retired here and still present on old rows. It is required (never
 * `undefined`) so that serializing is total and a writer cannot forget it. Keys in
 * `extra` are never interpreted, only carried.
 */
export interface ChatMessageMeta {
  v?: number;
  attachments?: ChatMessageAttachments;
  inputMode?: ChatMessageInputMode;
  actionBeat?: ChatActionId;
  stopped?: boolean;
  simTurn?: boolean;
  simOpening?: boolean;
  solo?: boolean;
  cutId?: string;
  modelId?: string;
  attempts?: number;
  confirmStatus?: string;
  worldBeat?: ChatMessageWorldBeat;
  narratorRun?: NarratorRunProvenance;
  compositionFallbacks?: string[];
  renderDiagnostics?: Diagnostic[];
  /** Unmodelled keys, carried through every read-modify-write untouched. */
  extra: Record<string, unknown>;
}

/**
 * A patch for {@link mergeChatMessageMeta}. A key PRESENT on the patch wins —
 * including when its value is `undefined`, which REMOVES the field. A key absent
 * from the patch leaves the existing value alone. That distinction is what lets
 * a take switch clear a stale `narratorRun` without rebuilding the bag.
 */
export type ChatMessageMetaPatch = { [K in keyof ChatMessageMeta]?: ChatMessageMeta[K] | undefined };

/** The empty bag — the degraded default and the seed value. */
export function emptyChatMessageMeta(): ChatMessageMeta {
  return { extra: {} };
}

/** True when the bag carries nothing at all (⇒ the row's `meta` can stay `{}`). */
export function isEmptyChatMessageMeta(meta: ChatMessageMeta): boolean {
  return Object.keys(serializeChatMessageMeta(meta)).length === 0;
}

/**
 * Coerce a stored jsonb value to a plain object, or null when it is not one.
 * Mirrors `parseOr`'s string handling: a driver that hands back raw JSON text
 * still parses. An array is not a bag.
 */
function coerceBag(raw: unknown): Record<string, unknown> | null {
  let candidate = raw;
  if (typeof candidate === "string") {
    const trimmed = candidate.trim();
    if (!trimmed.startsWith("{")) return null;
    try {
      candidate = JSON.parse(trimmed);
    } catch {
      return null;
    }
  }
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) return null;
  return candidate as Record<string, unknown>;
}

/**
 * Parse a stored bag, degrading per field (docs/resilience.md §1).
 *
 * - An absent bag (`undefined` / JSON `null`) is the empty meta, silently: the
 *   column defaults to `{}` and "this row carries no metadata" is legal, not an
 *   error.
 * - Any OTHER non-object value degrades to the empty meta and records
 *   {@link CHAT_MESSAGE_META_BAG_INVALID}.
 * - A modelled key whose value is JSON `null` is treated as absent, silently —
 *   `null` is how "not set" was written before the key was always omitted.
 * - A modelled key that fails its schema is dropped ALONE and records
 *   {@link CHAT_MESSAGE_META_FIELD_INVALID} with `context.field`. Its siblings,
 *   valid or unknown, are unaffected.
 * - Every unmodelled key is carried into `extra` without inspection.
 */
export function parseChatMessageMeta(
  raw: unknown,
  sink?: DiagnosticSink,
  path = "character_chat_messages.meta",
): ChatMessageMeta {
  if (raw === undefined || raw === null) return emptyChatMessageMeta();
  const bag = coerceBag(raw);
  if (bag === null) {
    sink?.push(
      diag("warn", CHAT_MESSAGE_META_BAG_INVALID, "stored message meta was not an object; read as empty", { path }),
    );
    return emptyChatMessageMeta();
  }

  const parsed: Record<string, unknown> = {};
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(bag)) {
    if (!KNOWN_KEY_SET.has(key)) {
      // Unmodelled: carried verbatim, never interpreted.
      extra[key] = value;
      continue;
    }
    // JSON null on a modelled key means "not set" — absent, not malformed.
    if (value === null || value === undefined) continue;
    const schema: z.ZodType = FIELD_SCHEMAS[key as KnownKey];
    const result = schema.safeParse(value);
    if (!result.success) {
      sink?.push(
        diag("warn", CHAT_MESSAGE_META_FIELD_INVALID, `message meta field "${key}" was unreadable and was dropped`, {
          path: `${path}.${key}`,
          context: { field: key },
        }),
      );
      continue;
    }
    parsed[key] = result.data;
  }
  return { ...parsed, extra } as ChatMessageMeta;
}

/**
 * The bag to persist (PURE): the modelled fields that are set, plus every carried
 * unknown key. `undefined` fields are omitted rather than written as JSON null,
 * so a round trip through parse → serialize is byte-stable.
 *
 * `v` is written only when it exceeds {@link CHAT_MESSAGE_META_VERSION}: absent
 * means 1, so stamping it on today's rows would be noise, while a higher version
 * read off an existing row is carried forward rather than downgraded.
 */
export function serializeChatMessageMeta(meta: ChatMessageMeta): Record<string, unknown> {
  // Unknown keys first: a modelled field always wins a name collision.
  const out: Record<string, unknown> = { ...meta.extra };
  for (const key of KNOWN_KEYS) {
    const value = meta[key];
    if (value === undefined) continue;
    if (key === "v" && typeof value === "number" && value <= CHAT_MESSAGE_META_VERSION) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Merge a patch onto an existing bag (PURE), keeping every unrelated key —
 * modelled or not.
 *
 * This is the read-modify-write every in-place meta update uses instead of
 * rebuilding the bag from the fields it happens to know. A key PRESENT on the
 * patch wins, and a present `undefined` REMOVES the field; a key the patch does
 * not mention keeps its existing value.
 *
 * `extra` merges key by key under the same rule, so a patch can carry unknown
 * keys forward or drop one deliberately without touching the others.
 */
export function mergeChatMessageMeta(existing: ChatMessageMeta, patch: ChatMessageMetaPatch): ChatMessageMeta {
  const merged: Record<string, unknown> = {};
  for (const key of KNOWN_KEYS) {
    const value = Object.hasOwn(patch, key) ? patch[key] : existing[key];
    if (value !== undefined) merged[key] = value;
  }
  const extra: Record<string, unknown> = { ...existing.extra };
  if (patch.extra !== undefined) {
    for (const [key, value] of Object.entries(patch.extra)) {
      if (value === undefined) delete extra[key];
      else extra[key] = value;
    }
  }
  return { ...merged, extra } as ChatMessageMeta;
}

/**
 * Drop `undefined` entries so a constructor's optional arguments never
 * materialize as explicit keys (which `mergeChatMessageMeta` would read as
 * deliberate removals).
 */
function compact(fields: ChatMessageMetaPatch): ChatMessageMeta {
  const out: Record<string, unknown> = {};
  for (const key of KNOWN_KEYS) {
    const value = fields[key];
    if (value !== undefined) out[key] = value;
  }
  return { ...out, extra: { ...fields.extra } } as ChatMessageMeta;
}

/** A player/narrator line's meta: its claimed attachments and how it was authored. */
export function userLineMeta(input: {
  attachmentIds?: readonly string[];
  attachmentDescriptions?: readonly string[];
  inputMode?: ChatMessageInputMode;
  simTurn?: boolean;
}): ChatMessageMeta {
  const ids = input.attachmentIds ?? [];
  return compact({
    ...(ids.length === 0
      ? {}
      : {
          attachments: {
            ids: [...ids],
            ...(input.attachmentDescriptions === undefined
              ? {}
              : { descriptions: [...input.attachmentDescriptions] }),
          },
        }),
    // "player" is the default every reader already assumes — only the narrator
    // register is worth a durable key.
    ...(input.inputMode === "narrator" ? { inputMode: "narrator" as const } : {}),
    ...(input.simTurn ? { simTurn: true } : {}),
  });
}

/** A legacy-lane assistant reply's meta: the beat chip, the run that wrote it, the stop marker. */
export function assistantReplyMeta(input: {
  actionBeat?: ChatActionId | null;
  narratorRun?: NarratorRunProvenance;
  stopped?: boolean;
}): ChatMessageMeta {
  return compact({
    ...(input.actionBeat ? { actionBeat: input.actionBeat } : {}),
    ...(input.narratorRun === undefined ? {} : { narratorRun: input.narratorRun }),
    ...(input.stopped ? { stopped: true } : {}),
  });
}

/** A successor-lane reply's meta: the rendered cut, the model, and this turn's breadcrumbs. */
export function successorReplyMeta(input: {
  cutId?: string;
  modelId?: string;
  attempts?: number;
  solo?: boolean;
  simOpening?: boolean;
  confirmStatus?: string;
  narratorRun?: NarratorRunProvenance;
  compositionFallbacks?: readonly CompositionFallbackCode[] | readonly string[];
  renderDiagnostics?: readonly Diagnostic[];
}): ChatMessageMeta {
  return compact({
    simTurn: true,
    ...(input.cutId === undefined || input.cutId === "" ? {} : { cutId: input.cutId }),
    ...(input.modelId === undefined ? {} : { modelId: input.modelId }),
    ...(input.attempts === undefined ? {} : { attempts: input.attempts }),
    ...(input.solo ? { solo: true } : {}),
    ...(input.simOpening ? { simOpening: true } : {}),
    ...(input.confirmStatus === undefined ? {} : { confirmStatus: input.confirmStatus }),
    ...(input.narratorRun === undefined ? {} : { narratorRun: input.narratorRun }),
    ...(input.compositionFallbacks && input.compositionFallbacks.length
      ? { compositionFallbacks: [...input.compositionFallbacks] }
      : {}),
    ...(input.renderDiagnostics && input.renderDiagnostics.length
      ? { renderDiagnostics: [...input.renderDiagnostics] }
      : {}),
  });
}

/** A world beat's meta: the marker that makes the row a muted system line. */
export function worldBeatMeta(input: {
  kind: string;
  compositionFallbacks?: readonly CompositionFallbackCode[] | readonly string[];
}): ChatMessageMeta {
  return compact({
    simTurn: true,
    worldBeat: { kind: input.kind },
    ...(input.compositionFallbacks && input.compositionFallbacks.length
      ? { compositionFallbacks: [...input.compositionFallbacks] }
      : {}),
  });
}

/**
 * True when a parsed bag marks its row as a world beat. Presence is the whole
 * test — the kind drives no behavior, so an unrecognized one is still a beat.
 */
export function isWorldBeat(meta: ChatMessageMeta): boolean {
  return meta.worldBeat !== undefined;
}

/**
 * True when a parsed bag says its user line was authored as NARRATOR input.
 *
 * The one question four separate call sites used to answer with their own cast
 * or schema. Unknown reads as player input — the documented default — and the
 * diagnostic from the parse is what says so out loud.
 */
export function isNarratorInput(meta: ChatMessageMeta): boolean {
  return meta.inputMode === "narrator";
}
