import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as coreSchema from "./schema";
import * as schedulerSchema from "./scheduler-schema";

const schema = { ...coreSchema, ...schedulerSchema };
const DEFAULT_URL = "postgresql://vesper:vesper_dev_password@localhost:5435/vesper_dev";

declare global {
   
  var __vesperPool: Pool | undefined;
}

function getPool(): Pool {
  if (!globalThis.__vesperPool) {
    globalThis.__vesperPool = new Pool({
      connectionString: process.env.DATABASE_URL ?? DEFAULT_URL,
      max: 10,
    });
  }
  return globalThis.__vesperPool;
}

export type Db = NodePgDatabase<typeof schema>;

/**
 * The write surface shared by the root client and a `db().transaction` callback —
 * helpers that take this (defaulting to `db()`) can run standalone or inside a
 * caller's transaction (e.g. the chat Clear's atomic wipe).
 */
export type DbWriter = Pick<Db, "insert" | "update" | "delete">;

let cached: Db | undefined;

export function db(): Db {
  cached ??= drizzle(getPool(), { schema });
  return cached;
}

export { schema };
