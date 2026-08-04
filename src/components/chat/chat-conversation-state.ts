import { resolveChatModelId } from "@/lib/narrative-models";
import type { ChatActionId } from "@/contracts";
import type { ChatRosterMember, ChatStateSnapshot } from "@/lib/client/api";
import type { ChatLine } from "@/components/characters/chat-message";

/**
 * Every piece of `ChatConversation` state that belongs to ONE conversation —
 * i.e. everything that must go back to its at-rest value the moment the mount
 * switches chats.
 *
 * Next reuses the client component across `/chat/[chatId]` param navigations,
 * so a chat switch is NOT a remount: any per-chat item the switch forgets to
 * reset simply survives into the next conversation. That was a live bug class,
 * not hygiene — staged photo ids from the previous chat could be submitted to
 * the new one, an open delete dialog kept its confirm button armed over a
 * different chat, and a leftover `skipBusy` locked the composer for good.
 *
 * So the list lives here exactly once: the component seeds every `useState`
 * from `PER_CHAT_DEFAULTS` and resets through the same object, keyed by this
 * type (`{ [K in keyof PerChatState]: () => void }`), which makes a per-chat
 * field that isn't reset a compile error rather than a silent leak.
 *
 * Deliberately NOT here — legitimately cross-chat, must survive a switch:
 * - `privacyMode` — an app-wide, localStorage-persisted viewing preference
 *   (`use-privacy-mode.ts`), not a property of any one conversation.
 * - `seededFor` — bookkeeping for the seed-once machinery itself
 *   (`decideDraftSeed`), owned by the switch branch rather than reset by it.
 * - The `useAsyncData` fetches (transcript bootstrap, scenes, world) — keyed on
 *   `chatId` inside the hook, which refetches on a switch of its own accord.
 * - The save-serializing chains and their generation counters (`chatModelGenRef`
 *   …) — one session-wide queue whose queued writes carry their own target id.
 * - `tempId` — the monotonic counter behind optimistic ids; resetting it would
 *   RE-issue ids that may still be on screen, the opposite of what it is for.
 *
 * Refs can't be written during render, so the per-chat REFS (`stageRef`,
 * `stickRef`, `sendingRef`, `abortRef`, `prependAnchorRef`) are reset in the
 * component's `chatId`-keyed layout effect — the other half of the same job.
 */
export interface PerChatState {
  // Transcript + keyset pagination.
  lines: ChatLine[];
  hasEarlier: boolean;
  earlierCursor: string | null;
  loadingEarlier: boolean;
  // Chat header mirrors (rename / archive / narrator model).
  title: string;
  archived: boolean;
  chatModel: string;
  // Composer: draft text, register, staged photos.
  input: string;
  oocActive: boolean;
  narratorMode: boolean;
  attachments: string[];
  attachBusy: boolean;
  // Exchange lifecycle.
  sending: boolean;
  stopping: boolean;
  actionBusy: ChatActionId | null;
  skipBusy: boolean;
  // Light chat state + the per-member sheet.
  chatState: ChatStateSnapshot | null;
  sheetMember: ChatRosterMember | null;
  sheetSnapshot: ChatStateSnapshot | null;
  // Sheets, dialogs, disclosures and their busy flags — a switch closes every surface.
  menuOpen: boolean;
  scenarioOpen: boolean;
  toolsOpen: boolean;
  worldOpen: boolean;
  rosterOpen: boolean;
  renameOpen: boolean;
  deleteOpen: boolean;
  deleting: boolean;
  archiveBusy: boolean;
  rememberOpen: boolean;
  rememberText: string;
  rememberBusy: boolean;
  relationshipOpen: boolean;
  /** Admin-only romantic_touch permission override panel (chat-permissions-panel.tsx). */
  permissionsOpen: boolean;
  scenesOpen: boolean;
  portraitOpen: boolean;
  // Reopen affordances (pickup strip, "has something to say").
  pickupDismissed: boolean;
  wantsSay: boolean;
  // Scroll pin: a conversation opens pinned to its newest line.
  pinned: boolean;
}

/**
 * The at-rest value of each per-chat item: what a conversation looks like the
 * instant it opens — nothing typed, nothing staged, nothing busy, every sheet
 * and dialog closed, pinned to the newest line.
 *
 * The two collections are shared across every reset. That is safe (and useful):
 * every update in the component is copy-on-write, and the stable identity means
 * a redundant reset is a value React bails out of instead of a re-render.
 */
export const PER_CHAT_DEFAULTS: PerChatState = {
  lines: [],
  hasEarlier: false,
  earlierCursor: null,
  loadingEarlier: false,
  title: "",
  archived: false,
  chatModel: resolveChatModelId(null),
  input: "",
  oocActive: false,
  narratorMode: false,
  attachments: [],
  attachBusy: false,
  sending: false,
  stopping: false,
  actionBusy: null,
  skipBusy: false,
  chatState: null,
  sheetMember: null,
  sheetSnapshot: null,
  menuOpen: false,
  scenarioOpen: false,
  toolsOpen: false,
  worldOpen: false,
  rosterOpen: false,
  renameOpen: false,
  deleteOpen: false,
  deleting: false,
  archiveBusy: false,
  rememberOpen: false,
  rememberText: "",
  rememberBusy: false,
  relationshipOpen: false,
  permissionsOpen: false,
  scenesOpen: false,
  portraitOpen: false,
  pickupDismissed: false,
  wantsSay: false,
  pinned: true,
};
