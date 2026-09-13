import { z } from "zod";
import { imageGeneratorRunSchema } from "@/contracts/images/image-generator";
import { apiGet, apiPost } from "./http";

// ---------------------------------------------------------------------------
// Face repair — issue #246's flagged owner-admin action. A thin client over
// `POST /api/admin/self/face-repair`, which submits through the ordinary
// Image Generator run path, so its response reuses `imageGeneratorRunSchema`
// rather than a parallel shape.
// ---------------------------------------------------------------------------

const FACE_REPAIR_API_ROOT = "/api/admin/self/face-repair";

export const faceRepairStatusSchema = z.object({ enabled: z.boolean().catch(false) });
export type FaceRepairStatus = z.infer<typeof faceRepairStatusSchema>;

/**
 * The request body — kept as a plain interface, not a shared zod schema: the
 * server's own request schema lives in `@/server/images/face-repair.ts`, a
 * server module `lib/client` may not import (`apps/web/src/lib` is pure,
 * AGENTS.md). The server independently validates every field.
 */
export interface FaceRepairCreateRequest {
  characterId: string;
  sourceImageId: string;
  /** A profile id, model id, or model slug; omitted runs the task's default. */
  modelId?: string;
}

export const faceRepairApi = {
  /** Whether the action is enabled at all, so the UI can explain a hidden section. */
  status: () => apiGet(faceRepairStatusSchema, FACE_REPAIR_API_ROOT),
  /** Submits the repair; the row comes back `pending`/`running` like any Generator run. */
  create: (body: FaceRepairCreateRequest) =>
    apiPost(z.object({ run: imageGeneratorRunSchema }), FACE_REPAIR_API_ROOT, body),
};
