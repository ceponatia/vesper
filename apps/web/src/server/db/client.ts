import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

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
 *
 * `execute` belongs here because not every write is a builder call: the chat
 * settle path's state upsert and scenario update are raw `sql` templates run
 * through `execute`, and a helper whose only reachable methods were
 * insert/update/delete would have to fall back to the root client — opening a
 * SECOND connection while the caller's transaction is still open. A write that
 * cannot join the caller's transaction cannot take part in an atomic
 * settlement, so leaving `execute` out silently made those helpers ineligible.
 */
export type DbWriter = Pick<Db, "insert" | "update" | "delete" | "execute">;

let cached: Db | undefined;

export function db(): Db {
  cached ??= drizzle(getPool(), { schema });
  return cached;
}

export { schema };
