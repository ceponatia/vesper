import { describe, expect, it } from "vitest";
import { PER_CHAT_DEFAULTS } from "./chat-conversation-state";

/**
 * These pin the at-rest values the chat-switch reset applies. The conversation
 * component is not remounted when `/chat/[chatId]` changes param, so every
 * assertion here is "what the player must NOT find waiting for them in the next
 * conversation" — the regression is a partial reset that let an item through.
 */
describe("PER_CHAT_DEFAULTS", () => {
  // Regression: the composer draft, the staged photo ids and the composer
  // register all survived a chat switch. Staged ids were the sharp one — they
  // would have been submitted to the conversation the player moved to.
  it("opens a conversation with an empty composer and nothing staged", () => {
    expect(PER_CHAT_DEFAULTS.input).toBe("");
    expect(PER_CHAT_DEFAULTS.attachments).toEqual([]);
    expect(PER_CHAT_DEFAULTS.narratorMode).toBe(false);
    expect(PER_CHAT_DEFAULTS.oocActive).toBe(false);
    expect(PER_CHAT_DEFAULTS.rememberText).toBe("");
  });

  it("opens a conversation with an empty transcript and no page cursor", () => {
    expect(PER_CHAT_DEFAULTS.lines).toEqual([]);
    expect(PER_CHAT_DEFAULTS.hasEarlier).toBe(false);
    expect(PER_CHAT_DEFAULTS.earlierCursor).toBeNull();
  });

  // Regression: an open sheet or dialog stayed open over the new conversation —
  // including the delete confirmation, whose button then armed a different chat.
  it("opens every sheet, dialog and disclosure closed", () => {
    for (const [key, value] of Object.entries(PER_CHAT_DEFAULTS)) {
      if (key.endsWith("Open")) expect(value, `${key} must default to closed`).toBe(false);
    }
  });

  // Regression: `skipBusy` leaking left the composer and the world chips
  // disabled in the new conversation with nothing in flight to release them.
  it("opens with nothing in flight — no spinner or disabled control survives a switch", () => {
    for (const [key, value] of Object.entries(PER_CHAT_DEFAULTS)) {
      if (key.endsWith("Busy")) expect(value, `${key} must default to idle`).toBe(false);
    }
    expect(PER_CHAT_DEFAULTS.sending).toBe(false);
    expect(PER_CHAT_DEFAULTS.stopping).toBe(false);
    expect(PER_CHAT_DEFAULTS.deleting).toBe(false);
    expect(PER_CHAT_DEFAULTS.loadingEarlier).toBe(false);
    expect(PER_CHAT_DEFAULTS.actionBusy).toBeNull();
  });

  it("carries no snapshot of the previous conversation or its cast", () => {
    expect(PER_CHAT_DEFAULTS.chatState).toBeNull();
    expect(PER_CHAT_DEFAULTS.sheetMember).toBeNull();
    expect(PER_CHAT_DEFAULTS.sheetSnapshot).toBeNull();
    expect(PER_CHAT_DEFAULTS.title).toBe("");
    expect(PER_CHAT_DEFAULTS.archived).toBe(false);
  });

  // The reopen affordances are offered once per conversation opened, so they
  // start un-dismissed; the transcript starts pinned to its newest line.
  it("opens with the reopen affordances live and the transcript pinned", () => {
    expect(PER_CHAT_DEFAULTS.pickupDismissed).toBe(false);
    expect(PER_CHAT_DEFAULTS.wantsSay).toBe(false);
    expect(PER_CHAT_DEFAULTS.pinned).toBe(true);
  });
});
