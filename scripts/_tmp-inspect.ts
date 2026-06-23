import "dotenv/config";
import { sql } from "drizzle-orm";
import { db } from "../src/server/db";

async function main() {
  const users = await db().execute(sql`select id, email, name, role from users order by created_at`);
  console.log("USERS:");
  console.table(users.rows);

  const tables = ["characters","locations","items","worlds","sessions","images","location_links","character_chat_messages","character_chat_summaries"];
  for (const t of tables) {
    const r = await db().execute(sql.raw(`select owner_id, count(*)::int as n from ${t} group by owner_id order by n desc`));
    console.log(`\n${t}:`);
    console.table(r.rows);
  }
}
main().then(async () => { await globalThis.__vesperPool?.end(); }).catch(async (e) => { console.error(e); await globalThis.__vesperPool?.end(); process.exit(1); });
