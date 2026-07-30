/* Read-only troubleshooting query: scene-image routing for a named character's chats. */
import "dotenv/config";
import { Client } from "pg";

const NAME = process.argv[2] ?? "Kristin";
const maybeUrl = process.env.SCENE_DIAG_DB || process.env.DATABASE_URL;
if (!maybeUrl) throw new Error("no DATABASE_URL");
const url: string = maybeUrl;

async function main(): Promise<void> {
  const client = new Client({ connectionString: url, ssl: url.includes("neon.tech") ? { rejectUnauthorized: false } : undefined });
  await client.connect();
  const chars = await client.query(
    `select id, name, owner_id, avatar_image_id from characters where name ilike $1 order by created_at desc limit 10`,
    [`%${NAME}%`],
  );
  console.log("== characters ==");
  console.table(chars.rows);
  if (chars.rows.length === 0) {
    await client.end();
    return;
  }
  const ids: string[] = chars.rows.map((r: { id: string }) => r.id);

  const chats = await client.query(
    `select c.id, c.character_id, c.title, c.created_at, s.scene_model, s.scene_auto, s.outfit, s.outfit_exposed
       from character_chats c left join character_chat_state s on s.chat_id = c.id
      where c.character_id = any($1::text[]) order by c.created_at desc limit 20`,
    [ids],
  );
  console.log("== chats + scene settings ==");
  console.table(chats.rows);

  const imgs = await client.query(
    `select id, kind, status, chat_id, created_at,
            meta->>'model' as model, meta->>'flavor' as flavor, meta->>'demo' as demo,
            left(coalesce(meta->>'error',''), 220) as error,
            source_image_id, left(coalesce(prompt,''), 80) as prompt_head
       from images
      where entity_kind = 'character' and entity_id = any($1::text[])
        and kind in ('scene','chat_look','chat_place')
      order by created_at desc limit 40`,
    [ids],
  );
  console.log("== recent scene/look/place images ==");
  console.table(imgs.rows);

  const counts = await client.query(
    `select kind, status, meta->>'model' as model, count(*)::int as n
       from images where entity_kind='character' and entity_id = any($1::text[])
       group by 1,2,3 order by n desc`,
    [ids],
  );
  console.log("== model/status histogram ==");
  console.table(counts.rows);

  await client.end();
}

void main();
