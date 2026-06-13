import "dotenv/config";
import { Client } from "pg";

/**
 * Creates the app database (and the pgvector extension) inside the local
 * Vesper docker container. Idempotent. DATABASE_URL points at the target database;
 * we connect to the maintenance db `postgres` on the same server to create it.
 */
async function main() {
  const url = new URL(
    process.env.DATABASE_URL ??
      "postgresql://vesper:vesper_dev_password@localhost:5435/vesper_dev",
  );
  const dbName = url.pathname.slice(1);
  const admin = new URL(url);
  admin.pathname = "/postgres";

  const client = new Client({ connectionString: admin.toString() });
  await client.connect();
  const exists = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [dbName]);
  if (exists.rowCount === 0) {
    await client.query(`CREATE DATABASE "${dbName}"`);
    console.log(`created database ${dbName}`);
  } else {
    console.log(`database ${dbName} already exists`);
  }
  await client.end();

  const db = new Client({ connectionString: url.toString() });
  await db.connect();
  await db.query("CREATE EXTENSION IF NOT EXISTS vector");
  console.log("pgvector extension ready");
  await db.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
