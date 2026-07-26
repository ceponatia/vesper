import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { applyDatabaseHardening } from "./db-hardening";

async function main() {
  if (process.env.NODE_ENV === "production" && !process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required outside development");
  }
  const pool = new Pool({
    connectionString:
      process.env.DATABASE_URL ??
      "postgresql://vesper:vesper_dev_password@localhost:5435/vesper_dev",
  });
  await migrate(drizzle(pool), { migrationsFolder: "./drizzle" });
  await applyDatabaseHardening(pool);
  console.log("migrations and database hardening applied");
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
