import { z } from "zod";
import { jsonError, jsonOk, readBody, withOwnerAdmin } from "@/server/api";
import {
  AdminFilesError,
  createAdminFolder,
  deleteAdminEntries,
  deleteAdminEntry,
  listAdminFiles,
  moveAdminEntries,
  previewAdminDelete,
  renameAdminEntry,
} from "@/server/admin-files";

const pathSchema = z.string();
const nameSchema = z.string();
/**
 * One selection. The floor keeps an empty batch from answering 200 with nothing
 * done; the ceiling bounds the filesystem work one request can ask for, since
 * every entry is walked and the whole batch holds the mutation lock.
 */
const pathsSchema = z.array(pathSchema).min(1).max(500);

const mutationSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create_folder"), path: pathSchema, name: nameSchema }),
  z.object({ action: z.literal("rename"), path: pathSchema, name: nameSchema }),
  z.object({ action: z.literal("delete"), path: pathSchema }),
  // `recursive` is opt-in and absent means false: a folder delete that did not
  // ask for recursion still meets the `folder_not_empty` refusal.
  z.object({ action: z.literal("delete_many"), paths: pathsSchema, recursive: z.boolean().optional() }),
  z.object({ action: z.literal("move"), paths: pathsSchema, destination: pathSchema }),
  z.object({ action: z.literal("delete_preview"), paths: pathsSchema }),
]);

function expectedError(error: unknown): Response {
  if (error instanceof AdminFilesError) return jsonError(error.code, error.message, error.status);
  throw error;
}

export const GET = withOwnerAdmin(async (_user, req) => {
  const relativePath = req.nextUrl.searchParams.get("path") ?? "";
  try {
    const entries = await listAdminFiles(relativePath);
    return jsonOk({ path: relativePath, entries });
  } catch (error) {
    return expectedError(error);
  }
});

/**
 * The three batch actions are partial-success operations: a per-entry refusal
 * becomes a `failures` row and the batch carries on, so they answer 200 even
 * when every entry failed. Only a malformed body, the authorization gate, one
 * whole-request fact (a `move` whose destination is missing or is not a folder)
 * and an unexpected throw fail the request itself.
 */
export const POST = withOwnerAdmin(async (_user, req) => {
  const body = await readBody(req, mutationSchema);
  if (!body.ok) return body.response;

  try {
    switch (body.value.action) {
      case "create_folder": {
        const entry = await createAdminFolder(body.value.path, body.value.name);
        return jsonOk({ entry }, 201);
      }
      case "rename": {
        const entry = await renameAdminEntry(body.value.path, body.value.name);
        return jsonOk({ entry });
      }
      case "delete": {
        await deleteAdminEntry(body.value.path);
        return jsonOk({ ok: true });
      }
      case "delete_many": {
        return jsonOk(await deleteAdminEntries(body.value.paths, body.value.recursive === true));
      }
      case "move": {
        return jsonOk(await moveAdminEntries(body.value.paths, body.value.destination));
      }
      case "delete_preview": {
        return jsonOk(await previewAdminDelete(body.value.paths));
      }
    }
  } catch (error) {
    return expectedError(error);
  }
});
