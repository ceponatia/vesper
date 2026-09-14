import { z } from "zod";
import { jsonError, jsonOk, readBody, withOwnerAdmin } from "@/server/api";
import {
  AdminFilesError,
  createAdminFolder,
  deleteAdminEntry,
  listAdminFiles,
  renameAdminEntry,
} from "@/server/admin-files";

const pathSchema = z.string();
const nameSchema = z.string();

const mutationSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create_folder"), path: pathSchema, name: nameSchema }),
  z.object({ action: z.literal("rename"), path: pathSchema, name: nameSchema }),
  z.object({ action: z.literal("delete"), path: pathSchema }),
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
    }
  } catch (error) {
    return expectedError(error);
  }
});
