import type { NextRequest } from "next/server";
import { asc, eq } from "drizzle-orm";
import { DiagnosticCollector, characterProfileSchema, emptyCharacterProfile } from "@/contracts";
import { parseOr } from "@/lib/parse";
import { jsonError, withUser } from "@/server/api";
import { characterChatMessages, db } from "@/server/db";
import { loadChatState, loadChatSummary, seedChatState } from "@/server/engine";
import { chatScope, listEpisodesForScope, listFactsForScope } from "@/server/memory";
import { loadOwnedChat } from "../../owned";

type Params = { chatId: string };

/**
 * Transcript export (character-chat-standalone.spec.md §7.4 — "take your story with
 * you", graduating deferred #8 at chat scale): `GET …/export?format=md|json[&memory=1]`
 * returns the whole conversation as a download — title, scenario, participants,
 * transcript, and (opt-in) a memory appendix of the chat's remembered facts + episodes.
 */

/** Hard cap on exported messages — far above any real chat, guards a runaway query. */
const EXPORT_MESSAGE_CAP = 10_000;

export const GET = withUser<Params>(async (user, req: NextRequest, ctx) => {
  const { chatId } = await ctx.params;
  const owned = await loadOwnedChat(chatId, user.id);
  if (!owned) return jsonError("not_found", "chat not found", 404);

  const url = new URL(req.url);
  const format = url.searchParams.get("format") === "json" ? "json" : "md";
  const withMemory = url.searchParams.get("memory") === "1";

  const sink = new DiagnosticCollector();
  const profile = parseOr(characterProfileSchema, owned.character.profile ?? {}, emptyCharacterProfile(), sink, "characters.profile");
  const state = (await loadChatState(chatId, owned.participant.characterId, sink)) ?? seedChatState(profile);
  const summary = await loadChatSummary(chatId);
  const rows = await db()
    .select({
      role: characterChatMessages.role,
      content: characterChatMessages.content,
      createdAt: characterChatMessages.createdAt,
    })
    .from(characterChatMessages)
    .where(eq(characterChatMessages.chatId, chatId))
    .orderBy(asc(characterChatMessages.createdAt), asc(characterChatMessages.id))
    .limit(EXPORT_MESSAGE_CAP);

  const scope = chatScope(owned.participant.memoryGroupId);
  const memory = withMemory
    ? {
        facts: (await listFactsForScope(scope)).map((f) => ({ text: f.text, pinned: f.pinned, origin: f.origin })),
        episodes: (await listEpisodesForScope(scope)).map((e) => ({ turn: e.turnNumber, summary: e.summary })),
      }
    : null;

  const title = owned.chat.title.trim() || `Chat with ${owned.character.name}`;
  const filename = `${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "chat"}.${format}`;

  if (format === "json") {
    const payload = {
      title,
      character: owned.character.name,
      premise: state.premise,
      exportedAt: new Date().toISOString(),
      summary: summary?.summary ?? "",
      messages: rows.map((r) => ({ role: r.role, content: r.content, at: r.createdAt.toISOString() })),
      ...(memory ? { memory } : {}),
    };
    return new Response(JSON.stringify(payload, null, 2), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="${filename}"`,
      },
    });
  }

  const who = owned.character.name.trim() || "Character";
  const lines: string[] = [`# ${title}`, ""];
  if (state.premise.trim()) lines.push(`> **Scenario:** ${state.premise.trim()}`, "");
  if (summary?.summary.trim()) lines.push("## The story so far", "", summary.summary.trim(), "");
  lines.push("## Transcript", "");
  for (const row of rows) {
    lines.push(`**${row.role === "user" ? "You" : who}:**`, "", row.content.trim(), "");
  }
  if (memory) {
    lines.push("## Memory appendix", "");
    if (memory.facts.length) {
      lines.push("### What they remember", "");
      for (const fact of memory.facts) lines.push(`- ${fact.pinned ? "📌 " : ""}${fact.text}`);
      lines.push("");
    }
    if (memory.episodes.length) {
      lines.push("### Moments", "");
      for (const episode of memory.episodes) lines.push(`- ${episode.summary}`);
      lines.push("");
    }
  }
  return new Response(lines.join("\n"), {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
    },
  });
});
