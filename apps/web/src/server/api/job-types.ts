import type { jobs } from "@/server/db";

/**
 * The `jobs.type` vocabulary, extracted from `jobs.ts` so the concurrency cap
 * can name it without importing the runner that depends on the cap (which would
 * close an import cycle — `pnpm lint:cycles`).
 */
export type ApiJobType = (typeof jobs.$inferInsert)["type"];
