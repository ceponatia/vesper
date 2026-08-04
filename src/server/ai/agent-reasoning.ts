import { eq } from "drizzle-orm";
import {
  resolveAgentReasoningProfile,
  type AgentReasoningProfileId,
} from "@/lib/agent-reasoning";
import { characterChats, db } from "../db";

/**
 * Load one conversation's admin-selected reasoning experiment. Missing chats,
 * absent telemetry anchors, and malformed/legacy values all fail closed to off.
 */
export async function loadChatAgentReasoningProfile(
  chatId: string | null | undefined,
): Promise<AgentReasoningProfileId> {
  if (!chatId) return "off";
  const [row] = await db()
    .select({ profile: characterChats.agentReasoningProfile })
    .from(characterChats)
    .where(eq(characterChats.id, chatId))
    .limit(1);
  return resolveAgentReasoningProfile(row?.profile);
}
