"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { chatsApi, type ChatMessage, type ChatTranscript } from "@/lib/client/api";
import type { ChatLine } from "@/components/characters/chat-message";
import { useAsyncData } from "@/components/hooks/use-async";
import { useToast } from "@/components/ui/toast";
import { PER_CHAT_DEFAULTS } from "./chat-conversation-state";

/** Project an API transcript row onto the renderable line shape (takes + stopped + attachments ride along). */
const toLine = (m: ChatMessage): ChatLine => ({
  id: m.id,
  role: m.role,
  content: m.content,
  takes: m.takes,
  stopped: m.meta.stopped,
  attachmentIds: m.meta.attachments?.ids.length ? m.meta.attachments.ids : undefined,
  narrator: m.meta.inputMode === "narrator" || undefined,
  // World beat: the muted travel/skip/scene-ended trace.
  worldBeat: m.meta.worldBeat?.kind,
});

/** The single transcript, pagination, and committed current-chat identity. */
export function useChatTranscript(chatId: string) {
  const toast = useToast();
  const bootstrap = useAsyncData<ChatTranscript>(() => chatsApi.transcript(chatId), [chatId]);
  // The same visit identity drives the page's render reset and every async owner.
  // A fresh object distinguishes A -> B -> A from the first visit to A.
  const [stateForChat, setStateForChat] = useState({ chatId });
  const currentChat = useRef<typeof stateForChat | null>(stateForChat);
  const sendingRef = useRef(false);
  useLayoutEffect(() => {
    currentChat.current = stateForChat;
    sendingRef.current = false;
    return () => { currentChat.current = null; };
  }, [stateForChat]);
  const isCurrent = () => currentChat.current === stateForChat;
  const [lines, setLines] = useState(PER_CHAT_DEFAULTS.lines);
  // Transcript pagination: the GET returns the
  // newest page; "Load earlier" keysets older pages via `nextBefore`.
  const [hasEarlier, setHasEarlier] = useState(PER_CHAT_DEFAULTS.hasEarlier);
  const [earlierCursor, setEarlierCursor] = useState(PER_CHAT_DEFAULTS.earlierCursor);
  const [loadingEarlier, setLoadingEarlier] = useState(PER_CHAT_DEFAULTS.loadingEarlier);
  /** "Load earlier" (slice 2): fetch the next older page and prepend it, viewport held. */
  const loadEarlier = async (preparePrepend: () => void) => {
    if (!earlierCursor || loadingEarlier) return;
    setLoadingEarlier(true);
    const result = await chatsApi.transcript(chatId, { before: earlierCursor });
    if (!isCurrent()) return;
    setLoadingEarlier(false);
    if (!result.ok) {
      toast.push({ title: "Couldn't load earlier messages", description: result.error.message, tone: "error" });
      return;
    }
    preparePrepend();
    setHasEarlier(result.data.hasMore);
    setEarlierCursor(result.data.nextBefore);
    const older = result.data.messages.map(toLine);
    setLines((prev) => [...older, ...prev]);
  };

  /**
   * Pull the newest transcript page and swap it in (bailing if a send started
   * meanwhile). The shared post-command reload — a settled exchange, a landing,
   * or a skip all end here so a server-written world beat (slice 2) shows up. This
   * resets to the newest page (paged-in history collapses; Load earlier restores it).
   */
  const reloadTranscript = async () => {
    const fresh = await chatsApi.transcript(chatId);
    if (fresh.ok && isCurrent() && !sendingRef.current) {
      setLines(fresh.data.messages.map(toLine));
      setHasEarlier(fresh.data.hasMore);
      setEarlierCursor(fresh.data.nextBefore);
    }
    return fresh;
  };

  /** Overwrite one message's text in place; updates the line on success. */
  const editLine = async (id: string, content: string): Promise<boolean> => {
    const result = await chatsApi.editMessage(chatId, id, content);
    if (!isCurrent()) return false;
    if (result.ok) {
      setLines((prev) => prev.map((l) => (l.id === id ? { ...l, content } : l)));
      return true;
    }
    toast.push({ title: "Edit failed", description: result.error.message, tone: "error" });
    return false;
  };

  /** Delete a single message; removes the line on success. */
  const deleteLine = async (id: string) => {
    const result = await chatsApi.deleteMessage(chatId, id);
    if (!isCurrent()) return;
    if (result.ok) {
      setLines((prev) => prev.filter((l) => l.id !== id));
    } else {
      toast.push({ title: "Delete failed", description: result.error.message, tone: "error" });
    }
  };

  const seedTranscript = (data: ChatTranscript) => {
    setLines(data.messages.map(toLine));
    setHasEarlier(data.hasMore);
    setEarlierCursor(data.nextBefore);
  };
  return { bootstrap, stateForChat, setStateForChat, isCurrent, sendingRef, lines, setLines, hasEarlier, setHasEarlier,
    earlierCursor, setEarlierCursor, loadingEarlier, setLoadingEarlier,
    seedTranscript, loadEarlier, reloadTranscript, editLine, deleteLine };
}
