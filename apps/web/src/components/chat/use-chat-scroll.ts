"use client";

import { useEffect, useLayoutEffect, useRef, useState, type UIEvent } from "react";
import type { ChatLine } from "@/components/characters/chat-message";
import { isPinnedToBottom, prependRestoreTop, type PrependAnchor } from "@/lib/scroll-pin";
import { PER_CHAT_DEFAULTS } from "./chat-conversation-state";

const CHAT_PIN_SLACK_PX = 40;

export function useChatScroll(chatId: string, lines: ChatLine[]) {
  const [pinned, setPinned] = useState(PER_CHAT_DEFAULTS.pinned);
  // Auto-scroll the transcript (not the page) to the newest line as the
  // conversation grows / streams. Setting scrollTop directly keeps the scroll
  // contained — `scrollIntoView` bubbles to every ancestor incl. the window.
  // Pinning is stick-to-bottom: it holds only while the reader is AT the bottom
  // (scrolling up to reread stops the yanking), and a ResizeObserver on the
  // content column re-pins as async content (scene thumbnails, avatars) grows it
  // AFTER the lines effect ran — without it the initial load landed mid-transcript
  // once images finished, hiding the newest exchange below the fold.
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  // Set before a "Load earlier" prepend renders; the layout effect restores the
  // viewport from it so the reader is never yanked (lib/scroll-pin.ts).
  const prependAnchorRef = useRef<PrependAnchor | null>(null);

  // Reset before correcting the new transcript in the same commit.
  useLayoutEffect(() => {
    stickRef.current = true;
    prependAnchorRef.current = null;
  }, [chatId]);

  // One layout effect owns scroll correction (the session feed's pattern):
  // restore after a prepend, otherwise stick to the bottom while pinned.
  // Unpinned appends fall through to "do nothing".
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const anchor = prependAnchorRef.current;
    if (anchor) {
      prependAnchorRef.current = null;
      el.scrollTop = prependRestoreTop(anchor, el.scrollHeight);
      return;
    }
    if (stickRef.current) el.scrollTop = el.scrollHeight;
  }, [lines]);
  useEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content) return;
    const observer = new ResizeObserver(() => {
      // Never during a pending prepend — the anchor restore owns that frame.
      if (stickRef.current && !prependAnchorRef.current) el.scrollTop = el.scrollHeight;
    });
    // Both boxes matter: the content column grows as thumbnails/avatars land, and
    // the container itself shrinks when the sections above it (scene disclosure,
    // pickup strip) settle — either one un-bottoms a pinned reader.
    observer.observe(content);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const jumpToLatest = () => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    stickRef.current = true;
    setPinned(true);
  };

  const pin = () => {
    stickRef.current = true;
    setPinned(true);
  };
  const preparePrepend = () => {
    const el = scrollRef.current;
    if (el) prependAnchorRef.current = { height: el.scrollHeight, top: el.scrollTop };
    stickRef.current = false;
    setPinned(false);
  };
  const onScroll = (e: UIEvent<HTMLDivElement>) => {
    const nearBottom = isPinnedToBottom(e.currentTarget, CHAT_PIN_SLACK_PX);
    stickRef.current = nearBottom;
    setPinned(nearBottom);
  };
  return { scrollRef, contentRef, pinned, setPinned, pin, preparePrepend, onScroll, jumpToLatest };
}
