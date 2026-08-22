import { z } from "zod";
import { apiDelete, apiGet, apiPost } from "@/lib/client/api";

export const engineComparisonStatusSchema = z.object({
  active: z.boolean(),
  canStart: z.boolean(),
  reason: z.string().nullable(),
  rows: z.number().int().nonnegative(),
});
export type EngineComparisonStatus = z.infer<typeof engineComparisonStatusSchema>;

const base = (chatId: string) => `/api/admin/self/engine-comparison/${encodeURIComponent(chatId)}`;

export const engineComparisonApi = {
  status: (chatId: string) => apiGet(engineComparisonStatusSchema, base(chatId)),
  start: (chatId: string) => apiPost(engineComparisonStatusSchema, base(chatId), {}),
  stop: async (chatId: string) => {
    const result = await apiDelete(base(chatId));
    if (!result.ok) return result;
    const parsed = engineComparisonStatusSchema.safeParse(result.data);
    return parsed.success
      ? { ok: true as const, data: parsed.data }
      : { ok: false as const, error: { code: "invalid_response", message: "Engine Comparison returned invalid data.", status: 500 } };
  },
};
