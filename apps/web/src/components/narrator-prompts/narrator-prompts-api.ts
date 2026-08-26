import { z } from "zod";
import {
  NARRATOR_PROMPT_CONFLICT_CODE,
  NARRATOR_PROMPT_NAME_TAKEN_CODE,
  narratorPromptLanguageSchema,
  type CreateNarratorPromptRequest,
  type NarratorPromptTemplateDetail,
  type NarratorPromptTemplateSummary,
  type SaveNarratorPromptRequest,
} from "@/contracts/narrator-prompts";
import { apiDelete, apiGet, apiPatch, apiPost, type ApiError, type ApiResult } from "@/lib/client/api";
import { parseOr } from "@/lib/parse";

/**
 * The Prompt Lab's client data layer over `/api/admin/self/narrator-prompts`.
 *
 * The `/self/` segment is not decoration: `withOwnerAdmin` fails closed with a
 * hidden 404 for any path outside `OWNER_ADMIN_API_PREFIX`, so a call to the
 * plan's suggested `/api/admin/narrator-prompts` would 404 by construction.
 *
 * This lives beside the page rather than in `lib/client/api.ts` because the whole
 * feature is one owner-admin screen — nothing else in the app calls these
 * routes. Every response still crosses a trust boundary, so it is parsed with
 * forgiving schemas exactly like the shared layer's.
 *
 * One field is deliberately NOT forgiving: `templateLanguage`. A missing value
 * defaults to `plain_v0` (the only language v1 emits), but an unknown value
 * fails the parse instead of being guessed at. The contract's whole reason for
 * carrying the field is that a future template language must never retroactively
 * start interpreting braces an owner hand-typed years earlier — and an editor
 * that guessed would be the first place that happened.
 */

const summaryFields = {
  id: z.string(),
  name: z.string().catch(""),
  notes: z.string().catch(""),
  currentRevision: z.number().int().catch(1),
  currentRevisionId: z.string().catch(""),
  usageCount: z.number().int().nonnegative().catch(0),
  createdAt: z.string().catch(""),
  updatedAt: z.string().catch(""),
  duplicatedFromId: z.string().nullable().catch(null),
};

const summarySchema = z.object(summaryFields);

const detailSchema = z.object({
  ...summaryFields,
  body: z.string().catch(""),
  bodyHash: z.string().catch(""),
  templateLanguage: narratorPromptLanguageSchema.default("plain_v0"),
});

/** A malformed row is dropped rather than emptying the whole library. */
const listSchema = z.object({
  prompts: z
    .array(z.unknown())
    .catch([])
    .transform((rows) =>
      rows.flatMap((row) => {
        const parsed = summarySchema.safeParse(row);
        return parsed.success ? [parsed.data] : [];
      }),
    ),
});

const promptEnvelopeSchema = z.object({ prompt: detailSchema });

/** What the soft delete actually did, in the terms the owner cares about. */
const deletedSchema = z.object({
  deletedPromptId: z.string().catch(""),
  clearedChatIds: z.array(z.string()).catch([]),
});

export type NarratorPromptDeleted = z.infer<typeof deletedSchema>;

const BASE = "/api/admin/self/narrator-prompts";

export const narratorPromptsApi = {
  list: (): Promise<ApiResult<{ prompts: NarratorPromptTemplateSummary[] }>> => apiGet(listSchema, BASE),

  get: (promptId: string): Promise<ApiResult<{ prompt: NarratorPromptTemplateDetail }>> =>
    apiGet(promptEnvelopeSchema, `${BASE}/${encodeURIComponent(promptId)}`),

  create: (request: CreateNarratorPromptRequest): Promise<ApiResult<{ prompt: NarratorPromptTemplateDetail }>> =>
    apiPost(promptEnvelopeSchema, BASE, request),

  /**
   * `baseRevision` is the revision the editor loaded, not the newest one: the
   * server claims `baseRevision + 1`, so a stale editor loses the race loudly
   * (409) instead of overwriting a revision nobody has read.
   */
  save: (
    promptId: string,
    request: SaveNarratorPromptRequest,
  ): Promise<ApiResult<{ prompt: NarratorPromptTemplateDetail }>> =>
    apiPatch(promptEnvelopeSchema, `${BASE}/${encodeURIComponent(promptId)}`, request),

  /**
   * The server derives the copy's name; the editor never proposes one. The empty
   * object is required, not cosmetic — the route reads its body through
   * `readBody`, which refuses a bodyless request as `invalid_json`.
   */
  duplicate: (promptId: string): Promise<ApiResult<{ prompt: NarratorPromptTemplateDetail }>> =>
    apiPost(promptEnvelopeSchema, `${BASE}/${encodeURIComponent(promptId)}/duplicate`, {}),

  /**
   * Soft delete: the row leaves the library, its revisions stay resolvable, and
   * the response says how many live conversations just fell back to production
   * instructions — which is the only honest way to report what happened.
   */
  remove: (promptId: string): Promise<ApiResult<NarratorPromptDeleted>> =>
    apiDelete(`${BASE}/${encodeURIComponent(promptId)}`).then((result) => {
      if (!result.ok) return result;
      const fallback: NarratorPromptDeleted = { deletedPromptId: promptId, clearedChatIds: [] };
      return { ok: true as const, data: parseOr(deletedSchema, result.data, fallback) };
    }),
};

/**
 * The two 409s the editor has to recover from rather than report as noise.
 *
 * The stale save answers `{ error: { code, message }, currentRevision }` — the
 * revision number rides BESIDE the standard envelope rather than inside it
 * (`app/api/admin/self/narrator-prompts/failure.ts`), so the recovery banner can
 * name the winning revision without a second round trip. The code is read from
 * the parsed envelope and from the raw body, top level and nested, so a route
 * that ever moved it would degrade to a plain error rather than silently costing
 * the owner their typing.
 */
const failureBodySchema = z.object({
  code: z.string().optional().catch(undefined),
  currentRevision: z.number().int().nonnegative().optional().catch(undefined),
  error: z
    .object({
      code: z.string().optional().catch(undefined),
      currentRevision: z.number().int().nonnegative().optional().catch(undefined),
    })
    .optional()
    .catch(undefined),
});

export type NarratorPromptFailure =
  | { kind: "conflict"; currentRevision: number | null }
  | { kind: "name_taken" };

export function readNarratorPromptFailure(error: ApiError): NarratorPromptFailure | null {
  const raw = parseOr(failureBodySchema, error.body, {});
  const codes = [error.code, raw.code, raw.error?.code];
  if (codes.includes(NARRATOR_PROMPT_CONFLICT_CODE)) {
    return { kind: "conflict", currentRevision: raw.currentRevision ?? raw.error?.currentRevision ?? null };
  }
  if (codes.includes(NARRATOR_PROMPT_NAME_TAKEN_CODE)) return { kind: "name_taken" };
  return null;
}
