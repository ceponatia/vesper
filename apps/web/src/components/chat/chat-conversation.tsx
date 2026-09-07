"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  CHAT_DEFAULT_CALENDAR_START,
  CHAT_SKIP_MINUTES,
  chatCapabilitiesForLane,
  formatChatMoment,
  type ChatSkipAmount,
} from "@/contracts";
import { charactersApi, chatsApi, type ApiResult, type ChatWorld } from "@/lib/client/api";
import { resolveChatModelId } from "@/lib/narrative-models";
import { formatStoryClockShort, storyClockAt } from "@/lib/simulation/clock";
import { decideDraftSeed } from "@/components/hooks/draft-seed";
import { useAsyncData } from "@/components/hooks/use-async";
import { useIsAdmin } from "@/components/hooks/use-is-admin";
import { useIsMobile } from "@/components/hooks/use-is-mobile";
import { usePollWhile } from "@/components/hooks/use-poll-while";
import { usePrivacyMode } from "@/components/hooks/use-privacy-mode";
import { AvatarPanel } from "@/components/avatar";
import { PER_CHAT_DEFAULTS, type PerChatState } from "@/components/chat/chat-conversation-state";
import { AgentReasoningSelect } from "@/components/chat/agent-reasoning-select";
import { NarratorPromptBadge } from "@/components/chat/narrator-prompt-badge";
import { NarratorPromptSelect, useNarratorPromptSelection } from "@/components/chat/narrator-prompt-select";
import { SceneComposerSelect } from "@/components/chat/scene-composer-select";
import { ChatPermissionsPanel } from "@/components/chat/chat-permissions-panel";
import { ChatPickupStrip } from "@/components/chat/chat-pickup-strip";
import { ChatRelationshipPanel } from "@/components/chat/chat-relationship-panel";
import { ChatRelationshipsEditor } from "@/components/chat/chat-relationships-editor";
import { ChatRosterPanel } from "@/components/chat/chat-roster-panel";
import { ChatSupportingCastPanel } from "@/components/chat/chat-supporting-cast-panel";
import { ChatPlansPanel } from "@/components/chat/chat-plans-panel";
import { ChatClockCard } from "@/components/chat/chat-clock-card";
import { ChatWorldCard } from "@/components/chat/chat-world-card";
import { scenesByAnchor } from "@/components/chat/chat-scene-moments";
import { ChatScenarioModal } from "@/components/characters/chat-scenario-modal";
import { SceneStrip } from "@/components/characters/chat-scene-strip";
import { ChatStateToolsModal } from "@/components/characters/chat-state-tools";
import { ActionChips, StatusStrip } from "@/components/characters/chat-status";
import { Button } from "@/components/ui/button";
import { cx } from "@/components/ui/cx";
import { Dialog } from "@/components/ui/dialog";
import { EntityImage } from "@/components/ui/entity-image";
import { ErrorState } from "@/components/ui/error-state";
import { ImageLightbox } from "@/components/ui/image-lightbox";
import { Sheet } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";

import { useChatTranscript } from "./use-chat-transcript";
import { useChatExchange } from "./use-chat-exchange";
import { useChatScroll } from "./use-chat-scroll";
import { ChatComposer } from "./chat-composer";
import { ChatTranscriptView } from "./chat-transcript";
import { ConversationMenu, MenuPopover, RenameDialog } from "./chat-conversation-menu";

/** Open-eye glyph — the privacy-mode toggle, off state. */
function EyeIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden className={className}>
      <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

/** Eye-with-slash glyph — the privacy-mode toggle, on state. */
function EyeOffIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden className={className}>
      <path d="M9.9 4.24A9.1 9.1 0 0 1 12 4c7 0 11 7 11 7a13.2 13.2 0 0 1-3.35 4.19M6.1 6.1C3.42 7.9 1 11 1 11s4 7 11 7a9.24 9.24 0 0 0 5-1.6M14.12 14.12a3 3 0 1 1-4.24-4.24" />
      <path d="M1 1l22 22" />
    </svg>
  );
}

/**
 * The full-screen conversation page (`/chat/[chatId]`): mobile-first single
 * column filling the full viewport below `md` (the global app header is
 * suppressed on this route at that width, so this page's own header is the only
 * one) and the viewport below the 3.25rem app header at `md`+, where that header comes
 * back (the bottom tab bar stays suppressed on this route at every width — the
 * composer owns the bottom edge). Header row: back to the Chats hub,
 * portrait, name/title, and a menu (bottom Sheet on phones, popover at ≥md) holding
 * the narrator-model pick, Scenario setup, State tools, Rename, Archive/Restore and
 * Delete. The scene strip sits in a disclosure under the header (collapsed by
 * default — the transcript keeps the room); the standing portrait is a fixed column
 * left of the transcript at ≥lg (desktop real estate) and hidden below that. Every
 * portrait affordance — header portrait, standing portrait, each reply's circular
 * avatar — opens the same ImageLightbox; the reply avatars are the phone's path to
 * a full-size portrait. Unlike the old editor tab there is no lazy create: the
 * conversation always exists — `chatId` is the address of record.
 */
export function ChatConversation({ chatId }: { chatId: string }) {
  const router = useRouter();
  const toast = useToast();
  const isMobile = useIsMobile();
  // Privacy mode: owned here, passed down to every
  // consumer as props — see use-privacy-mode.ts for why that's the single source
  // of truth instead of a module-level store.
  const [privacyMode, setPrivacyMode] = usePrivacyMode();

  // One GET settles the whole screen: transcript + chat header + character card.
  const transcript = useChatTranscript(chatId);
  const { bootstrap, stateForChat, setStateForChat, isCurrent, lines, setLines, hasEarlier, setHasEarlier,
    setEarlierCursor, loadingEarlier, setLoadingEarlier, seedTranscript,
    reloadTranscript, editLine, deleteLine } = transcript;
  const ready = !bootstrap.loading && bootstrap.error === null;

  // The conversation's scene images — ONE fetch/poll shared by the strip and the
  // inline transcript moments (slice 9). Polls while a render job is live server-side
  // (`rendering` — covers the slow composer step BEFORE the pending image row exists,
  // the painting-forever fix) or a pending row is visible; refetched after each settled
  // exchange (an auto scene may have queued).
  const scenes = useAsyncData(() => chatsApi.scenes(chatId), [chatId]);
  const sceneList = scenes.data?.scenes ?? [];
  const sceneRendering = scenes.data?.rendering ?? false;
  usePollWhile(
    sceneRendering || sceneList.some((s) => s.status === "pending"),
    () => scenes.reload({ silent: true }),
    2500,
  );
  const sceneAnchors = scenesByAnchor(sceneList);
  // `simRouted` remains presentation metadata (including delete-chat copy).
  // Actionable controls consume the server-owned capability manifest instead.
  // Trusted only when the bootstrap payload is FOR this chat: on an in-place
  // chat switch the previous chat's payload lingers until the new one settles,
  // and a stale true would issue /world for a legacy chat — the exact 409 the
  // gate below exists to prevent.
  const bootstrapChat = bootstrap.data?.chat ?? null;
  const simRouted = bootstrapChat !== null && bootstrapChat.id === chatId && bootstrapChat.simRouted;
  // The player-facing world envelope: fetched only once
  // the bootstrap proves the chat sim-routed — a legacy chat never issues the
  // request (the server would just 409 `not_sim_enabled`, which the browser logs
  // as console noise) and settles on null, so the ChatWorldCard hides itself.
  // Re-fetched wherever refreshState runs so the card tracks play after
  // exchanges / skips / travel.
  const world = useAsyncData(
    () => (simRouted ? chatsApi.world(chatId) : Promise.resolve<ApiResult<ChatWorld | null>>({ ok: true, data: null })),
    [chatId, simRouted],
  );
  const character = bootstrap.data?.character ?? null;
  const name = character?.name ?? "";
  const who = name.trim() || "this character";

  // Per-chat state (chat-conversation-state.ts): the page and focused hooks own one
  // conversation and seed from `PER_CHAT_DEFAULTS`, the same object the
  // chat-switch reset applies — one list, one set of at-rest values, so a switch
  // can't carry an item into the next chat by omission.
  // Mutable chat header (rename / archive write through these mirrors).
  const [title, setTitle] = useState(PER_CHAT_DEFAULTS.title);
  const [archived, setArchived] = useState(PER_CHAT_DEFAULTS.archived);
  const [chatModel, setChatModel] = useState(PER_CHAT_DEFAULTS.chatModel);
  const [input, setInput] = useState(PER_CHAT_DEFAULTS.input);
  // True while the composer caret sits inside a `((…))` OOC block — drives the
  // amber affordance. A plain flag, not caret
  // state: recomputed from the live textarea on every edit / selection change.
  const [oocActive, setOocActive] = useState(PER_CHAT_DEFAULTS.oocActive);
  // Composer register: narrator mode sends the line as story narration authored
  // as the storyteller, not the player's POV.
  const [narratorMode, setNarratorMode] = useState(PER_CHAT_DEFAULTS.narratorMode);
  // Light chat state: the strip + premise. Held in
  // local state (not useAsyncData) so a post-send refresh can drive the
  // stage-change toast off the value it just fetched.
  const [chatState, setChatState] = useState(PER_CHAT_DEFAULTS.chatState);
  const [menuOpen, setMenuOpen] = useState(PER_CHAT_DEFAULTS.menuOpen);
  const [scenarioOpen, setScenarioOpen] = useState(PER_CHAT_DEFAULTS.scenarioOpen);
  const [toolsOpen, setToolsOpen] = useState(PER_CHAT_DEFAULTS.toolsOpen);
  // Dedicated responsive world sheet. Below `lg` this is the first-class path
  // to location, clock, inventory, travel, and activities; Roster stays people.
  const [worldOpen, setWorldOpen] = useState(PER_CHAT_DEFAULTS.worldOpen);
  // Roster sheet — the phone-width path to the roster panel; desktop also gets it
  // inline in the aside.
  const [rosterOpen, setRosterOpen] = useState(PER_CHAT_DEFAULTS.rosterOpen);
  // Per-character sheet: tapping a roster member opens THEIR
  // sheet — their state fetched fresh on open, edited via characterId targeting.
  const [sheetMember, setSheetMember] = useState(PER_CHAT_DEFAULTS.sheetMember);
  const [sheetSnapshot, setSheetSnapshot] = useState(PER_CHAT_DEFAULTS.sheetSnapshot);
  const [renameOpen, setRenameOpen] = useState(PER_CHAT_DEFAULTS.renameOpen);
  const [deleteOpen, setDeleteOpen] = useState(PER_CHAT_DEFAULTS.deleteOpen);
  const [deleting, setDeleting] = useState(PER_CHAT_DEFAULTS.deleting);
  const [archiveBusy, setArchiveBusy] = useState(PER_CHAT_DEFAULTS.archiveBusy);
  // Attached photos staged for the next send: uploaded
  // eagerly on pick (the ids preview via the immutable file route), sent as ids.
  // Removing a staged photo only unstages it — the orphaned upload row is cleaned
  // up with the conversation, never surfaced anywhere.
  const [attachments, setAttachments] = useState(PER_CHAT_DEFAULTS.attachments);
  const [attachBusy, setAttachBusy] = useState(PER_CHAT_DEFAULTS.attachBusy);
  // "Remember this": the pinned-note dialog, openable from the composer
  // affordance (blank) or a message hover action (prefilled with that line).
  const [rememberOpen, setRememberOpen] = useState(PER_CHAT_DEFAULTS.rememberOpen);
  const [rememberText, setRememberText] = useState(PER_CHAT_DEFAULTS.rememberText);
  const [rememberBusy, setRememberBusy] = useState(PER_CHAT_DEFAULTS.rememberBusy);
  // The Relationship panel + the reopen pickup strip / time skips.
  const [relationshipOpen, setRelationshipOpen] = useState(PER_CHAT_DEFAULTS.relationshipOpen);
  // Admin-only romantic_touch permission override panel.
  const [permissionsOpen, setPermissionsOpen] = useState(PER_CHAT_DEFAULTS.permissionsOpen);
  const [pickupDismissed, setPickupDismissed] = useState(PER_CHAT_DEFAULTS.pickupDismissed);
  const [skipBusy, setSkipBusy] = useState(PER_CHAT_DEFAULTS.skipBusy);
  // "Has something to say": a marker tap arrives as ?say=1 — surfaced as a
  // one-tap opener banner (generation stays player-triggered), the param stripped so a
  // reload doesn't re-offer it.
  const [wantsSay, setWantsSay] = useState(PER_CHAT_DEFAULTS.wantsSay);
  const isAdmin = useIsAdmin();
  // The conversation's narrator-prompt experiment, shared by the menu picker and
  // the header badge so the two can never
  // disagree about which instructions this chat is narrating with. Admin-gated —
  // a player issues neither request. Deliberately NOT in `PerChatState`: the hook
  // stamps the value with its own chat id, so a switch reads as loading rather
  // than as the previous conversation's pick, and this operational configuration
  // never joins the resettable per-chat surface (scenario presets and the state
  // tools must not touch it).
  const narratorPrompt = useNarratorPromptSelection(chatId, isAdmin);
  // The scene-image disclosure: collapsed by default at every width — the
  // transcript keeps the room; a tap remembers the choice for this conversation.
  const [scenesOpen, setScenesOpen] = useState(PER_CHAT_DEFAULTS.scenesOpen);
  // The character-portrait lightbox, openable from the header portrait, the desktop
  // standing portrait, and each reply's avatar (the mobile path to a big portrait).
  const [portraitOpen, setPortraitOpen] = useState(PER_CHAT_DEFAULTS.portraitOpen);

  const stageRef = useRef<string | null>(null);
  /** Bumped per chat-model pick so a superseded pick is skipped, plus the serializing chain. */
  const chatModelGenRef = useRef(0);
  const chatModelChainRef = useRef<Promise<void>>(Promise.resolve());
  const sceneModelGenRef = useRef(0);
  const sceneModelChainRef = useRef<Promise<void>>(Promise.resolve());
  /** Wraps the menu trigger + desktop popover, for the popover's outside-click test. */
  const menuWrapRef = useRef<HTMLDivElement>(null);

  const scroll = useChatScroll(chatId, lines);
  const { setPinned } = scroll;
  const { sending, setSending, stopping, setStopping, actionBusy, setActionBusy,
    requestInitiative, send, rerun, runAction, promptCharacter, stopReply, goOn, anotherTake,
    switchTake, letThemSpeak } = useChatExchange({
    chatId, transcript, ready, archived, setArchived, chatModel, chatState, input,
    setInput, narratorMode, attachments, setAttachments, setOocActive, attachBusy,
    skipBusy, setPickupDismissed, setWantsSay, pin: scroll.pin, refreshState,
    refreshScenes: () => scenes.reload({ silent: true }),
    refreshWorld: () => world.reload({ silent: true }), who,
  });
  useLayoutEffect(() => { stageRef.current = null; }, [chatId]);

  /**
   * Drop every per-chat item back to its at-rest value. One entry per key of
   * `PerChatState`, so the mapped type keeps this exhaustive: a new piece of
   * per-chat state can be added to `chat-conversation-state.ts` (where its
   * `useState` seed lives) only by also resetting it here, or the build fails.
   * That is the point — the previous hand-written reset covered 10 of ~25 items
   * and everything else rode into the next conversation.
   */
  const resetPerChatState = () => {
    const atRest = PER_CHAT_DEFAULTS;
    const resets: { [K in keyof PerChatState]: () => void } = {
      lines: () => setLines(atRest.lines),
      hasEarlier: () => setHasEarlier(atRest.hasEarlier),
      earlierCursor: () => setEarlierCursor(atRest.earlierCursor),
      loadingEarlier: () => setLoadingEarlier(atRest.loadingEarlier),
      title: () => setTitle(atRest.title),
      archived: () => setArchived(atRest.archived),
      chatModel: () => setChatModel(atRest.chatModel),
      input: () => setInput(atRest.input),
      oocActive: () => setOocActive(atRest.oocActive),
      narratorMode: () => setNarratorMode(atRest.narratorMode),
      attachments: () => setAttachments(atRest.attachments),
      attachBusy: () => setAttachBusy(atRest.attachBusy),
      sending: () => setSending(atRest.sending),
      stopping: () => setStopping(atRest.stopping),
      actionBusy: () => setActionBusy(atRest.actionBusy),
      skipBusy: () => setSkipBusy(atRest.skipBusy),
      chatState: () => setChatState(atRest.chatState),
      sheetMember: () => setSheetMember(atRest.sheetMember),
      sheetSnapshot: () => setSheetSnapshot(atRest.sheetSnapshot),
      menuOpen: () => setMenuOpen(atRest.menuOpen),
      scenarioOpen: () => setScenarioOpen(atRest.scenarioOpen),
      toolsOpen: () => setToolsOpen(atRest.toolsOpen),
      worldOpen: () => setWorldOpen(atRest.worldOpen),
      rosterOpen: () => setRosterOpen(atRest.rosterOpen),
      renameOpen: () => setRenameOpen(atRest.renameOpen),
      deleteOpen: () => setDeleteOpen(atRest.deleteOpen),
      deleting: () => setDeleting(atRest.deleting),
      archiveBusy: () => setArchiveBusy(atRest.archiveBusy),
      rememberOpen: () => setRememberOpen(atRest.rememberOpen),
      rememberText: () => setRememberText(atRest.rememberText),
      rememberBusy: () => setRememberBusy(atRest.rememberBusy),
      relationshipOpen: () => setRelationshipOpen(atRest.relationshipOpen),
      permissionsOpen: () => setPermissionsOpen(atRest.permissionsOpen),
      scenesOpen: () => setScenesOpen(atRest.scenesOpen),
      portraitOpen: () => setPortraitOpen(atRest.portraitOpen),
      pickupDismissed: () => setPickupDismissed(atRest.pickupDismissed),
      wantsSay: () => setWantsSay(atRest.wantsSay),
      pinned: () => setPinned(atRest.pinned),
    };
    for (const key of Object.keys(resets) as (keyof PerChatState)[]) resets[key]();
  };

  // The transcript owner supplies the identity this mount's state belongs to. Next reuses the
  // client component across /chat/[chatId] param navigations (a hub link, a
  // ?say= tap, the dashboard's "latest chat"), so a switch is NOT a remount:
  // without this, everything the reset below missed — the composer draft, the
  // staged photo ids, the narrator/OOC register, the busy flags, every open
  // sheet and dialog — carried into the new conversation. Keyed on chatId
  // rather than on the seed verdict so the reset can't be raced by the fetch:
  // it fires on the switch itself, whether or not anything has loaded yet.
  // Seed the transcript + chat header from the bootstrap exactly once per chatId
  // (decideDraftSeed via the "adjust state while rendering" pattern) so a
  // streamed/optimistic reply is never clobbered by the fetch settling. "seed"
  // only fires once the fetched payload is *this* chat's (loadedId === chatId), so
  // a stale previous-chat payload can never seed during a chatId switch.
  const [seededFor, setSeededFor] = useState<string | null>(null);
  const seedAction = decideDraftSeed({
    entityId: chatId,
    seededId: seededFor,
    loadedId: bootstrap.data?.chat.id ?? null,
  });
  if (stateForChat.chatId !== chatId) {
    // Switched chats: the previous conversation's everything goes, immediately —
    // its transcript/header included, rather than lingering until the new fetch
    // lands. `seededFor` is bookkeeping for the seed-once machinery, not per-chat
    // payload, so the switch clears it here and the new chat seeds when it loads.
    setStateForChat({ chatId });
    setSeededFor(null);
    resetPerChatState();
  } else if (seedAction === "seed" && bootstrap.data) {
    setSeededFor(chatId);
    seedTranscript(bootstrap.data);
    setTitle(bootstrap.data.chat.title);
    setArchived(bootstrap.data.chat.archivedAt !== null);
    setChatModel(resolveChatModelId(bootstrap.data.character.chatModel));
    // Reset chatState so the load effect re-seeds stageRef from this chat's snapshot.
    setChatState(null);
  }

  // Read (and strip) the ?say=1 marker-tap param once per chat mount.
  // Deferred past a microtask per the strict hooks rule (no sync setState in effects).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await Promise.resolve();
      if (cancelled) return;
      const url = new URL(window.location.href);
      if (url.searchParams.get("say") === "1") {
        window.history.replaceState(null, "", url.pathname);
        setWantsSay(true);
      }
    })();
    // Stamp the "has something to say" seen-cursor once per conversation OPEN
    // (fire-and-forget):
    // milestones landing later in this visit stay "unseen", so the hub marker can
    // light on the next visit and clears the next time the chat is opened.
    void chatsApi.update(chatId, { seen: true });
    return () => {
      cancelled = true;
    };
  }, [chatId]);

  // Load the light state (the conversation always exists, so GET always returns a
  // snapshot — a seed-on-read pre-first-exchange). Keyed on chatState too: a settled
  // write (modal save, post-send refresh) cancels a straggling initial GET instead
  // of letting it clobber the fresher snapshot.
  useEffect(() => {
    if (chatState !== null) return;
    let cancelled = false;
    void chatsApi.state(chatId).then((r) => {
      if (cancelled || !r.ok) return;
      setChatState(r.data);
      stageRef.current = r.data.regardBand.label;
    });
    return () => {
      cancelled = true;
    };
  }, [chatId, chatState]);

  // Per-character sheet: fetch the tapped member's own
  // snapshot on open — never the primary's cached one.
  useEffect(() => {
    if (!sheetMember) return;
    let cancelled = false;
    void chatsApi.state(chatId, sheetMember.characterId).then((r) => {
      if (cancelled || !r.ok) return;
      setSheetSnapshot(r.data);
    });
    return () => {
      cancelled = true;
    };
  }, [chatId, sheetMember]);

  /** Refetch the state strip; toast when the regard band changed (the romance arc made visible). */
  async function refreshState() {
    const prior = stageRef.current;
    const result = await chatsApi.state(chatId);
    if (!isCurrent() || !result.ok) return;
    setChatState(result.data);
    if (prior && result.data.regardBand.label !== prior) {
      toast.push({ title: `${who} now regards you as ${result.data.regardBand.label.toLowerCase()}.` });
    }
    stageRef.current = result.data.regardBand.label;
  }

  /**
   * After a world-changing command from the card (a travel landing, an item
   * handoff, or a performed action — slices 1–3): refresh the transcript (the
   * new world beat lands there — slice 2 replaced the toast), plus the chat state
   * (clock) and the world card.
   */
  const refreshWorldAndState = () => {
    void reloadTranscript();
    void refreshState();
    world.reload({ silent: true });
  };

  // A5 slice 5: while the server is catching the world up after a long skip, poll the world (its
  // own next-request sweep re-drives the durable job) AND the transcript, so the catch-up banner
  // updates and the landing beat appears the moment the job settles and `catchingUp` clears. The
  // world card disables every affordance meanwhile.
  usePollWhile(world.data?.catchingUp != null, () => refreshWorldAndState(), 2000);

  /**
   * Persist the narrator pick immediately (save-on-update), same guarantees as the
   * editor tab: PATCHes serialize through a promise chain so rapid picks can't land
   * out of order server-side; a pick superseded before its turn is skipped entirely.
   */
  const saveChatModel = (modelId: string) => {
    const characterId = character?.id;
    if (!characterId) return;
    setChatModel(modelId);
    const gen = ++chatModelGenRef.current;
    chatModelChainRef.current = chatModelChainRef.current.then(async () => {
      if (gen !== chatModelGenRef.current) return; // a newer pick superseded this one
      const result = await charactersApi.update(characterId, { chatModel: modelId });
      if (gen !== chatModelGenRef.current) return;
      if (!result.ok) {
        toast.push({ title: "Couldn't save the chat model", description: result.error.message, tone: "error" });
      }
    });
  };

  /**
   * Persist the scene-model pick immediately (save-on-select, the owner's hot-swap
   * dropdown on the scene strip) — same serialized-chain guarantees as the narrator
   * pick above. The PATCH returns the fresh snapshot, which replaces the local state
   * (a superseded pick never writes back).
   */
  const saveSceneModel = (modelId: string) => {
    const previous = chatState?.sceneModel ?? "";
    setChatState((current) => (current ? { ...current, sceneModel: modelId } : current));
    const gen = ++sceneModelGenRef.current;
    sceneModelChainRef.current = sceneModelChainRef.current.then(async () => {
      if (gen !== sceneModelGenRef.current) return; // a newer pick superseded this one
      const result = await chatsApi.editState(chatId, { sceneModel: modelId });
      if (gen !== sceneModelGenRef.current) return;
      if (result.ok) {
        setChatState(result.data);
        return;
      }
      // Put the dropdown back. Without this the picker keeps showing a model the
      // server never stored, and the next render silently uses the OLD one —
      // `queueChatScene` reads the model from the database, not from the client.
      // Guarded by the same generation counter as the save, so a newer pick that
      // landed while this one failed is never clobbered.
      setChatState((current) => (current ? { ...current, sceneModel: previous } : current));
      toast.push({
        title: "Couldn't save the scene model",
        description:
          result.error.code === "chat_busy"
            ? "The conversation is busy — try again in a moment."
            : result.error.message,
        tone: "error",
      });
    });
  };

  /** Archive shelves (read-only, restorable); restore reopens — the everyday lifecycle pair. */
  const toggleArchived = async () => {
    const next = !archived;
    setArchiveBusy(true);
    const result = await chatsApi.update(chatId, { archived: next });
    setArchiveBusy(false);
    setMenuOpen(false);
    if (result.ok) {
      setArchived(next);
      toast.push({ title: next ? "Conversation archived" : "Conversation restored" });
    } else {
      toast.push({ title: "Update failed", description: result.error.message, tone: "error" });
    }
  };

  const renameChat = async (nextTitle: string): Promise<boolean> => {
    const result = await chatsApi.update(chatId, { title: nextTitle });
    if (result.ok) {
      setTitle(nextTitle);
      return true;
    }
    toast.push({ title: "Rename failed", description: result.error.message, tone: "error" });
    return false;
  };

  /** Hard delete: transcript, summary, state and memory go; back to the hub. */
  const deleteChat = async () => {
    setDeleting(true);
    const result = await chatsApi.remove(chatId);
    setDeleting(false);
    if (!result.ok) {
      setDeleteOpen(false);
      toast.push({ title: "Delete failed", description: result.error.message, tone: "error" });
      return;
    }
    toast.push({ title: "Chat deleted" });
    router.push("/chat");
  };

  /** Open the "Remember this" dialog, optionally prefilled from a message line. */
  const openRemember = (prefill: string) => {
    setRememberText(prefill.trim().slice(0, 500));
    setRememberOpen(true);
  };

  /** Pin the note into the chat's long-term memory (D15). */
  const saveRemember = async () => {
    const content = rememberText.trim();
    if (!content) return;
    setRememberBusy(true);
    const result = await chatsApi.remember(chatId, content);
    setRememberBusy(false);
    if (!result.ok) {
      toast.push({ title: "Couldn't save the note", description: result.error.message, tone: "error" });
      return;
    }
    setRememberOpen(false);
    setRememberText("");
    toast.push({ title: "Noted", description: `${who} will always remember that.` });
  };

  /** Apply a player time skip — from the pickup strip or the header menu. */
  const skipTime = async (amount: ChatSkipAmount) => {
    if (skipBusy || archived) return;
    setSkipBusy(true);
    // Sim-routed chats (R3 slice 4, ruling 17): the skip is a world command —
    // wrap the standing scene, drain the bounded advance — never the legacy
    // scenario-clock write. Same amounts, same chips, different lane.
    if (chatState?.simClock != null) {
      const result = await chatsApi.simAdvanceTime(chatId, CHAT_SKIP_MINUTES[amount]);
      setSkipBusy(false);
      setPickupDismissed(true);
      if (!result.ok) {
        toast.push({ title: "Time skip failed", description: result.error.message, tone: "error" });
        return;
      }
      // The landing shows as a durable "Time passes…" beat in the transcript
      // now, not a toast — pull it in with the world + clock.
      await reloadTranscript();
      await refreshState();
      world.reload({ silent: true });
      return;
    }
    const result = await chatsApi.timeSkip(chatId, amount);
    setSkipBusy(false);
    setPickupDismissed(true);
    if (!result.ok) {
      toast.push({ title: "Time skip failed", description: result.error.message, tone: "error" });
      return;
    }
    setChatState(result.data);
    stageRef.current = result.data.regardBand.label;
    // Name the landing: a skip is never a leap in the dark.
    toast.push({
      title: "Time passes…",
      description: `It's now ${formatChatMoment(result.data.clockMinutes, result.data.calendarStart)}. ${who} will pick the scene up from there.`,
    });
  };

  /** "Mark this moment": pin a player milestone on a message. */
  const markMoment = async (messageId: string) => {
    const result = await chatsApi.markMoment(chatId, messageId);
    if (result.ok) {
      toast.push({ title: "Moment marked", description: "It now shows in the Relationship panel." });
    } else {
      toast.push({ title: "Couldn't mark the moment", description: result.error.message, tone: "error" });
    }
  };

  /** Menu actions close the menu, then open their surface (dialog/modal). */
  const menuAction = (open: () => void) => () => {
    setMenuOpen(false);
    open();
  };
  const menuBody = (
    <ConversationMenu
      chatModel={chatModel}
      onChatModelChange={saveChatModel}
      narratorPromptControl={isAdmin ? <NarratorPromptSelect selection={narratorPrompt} /> : undefined}
      agentReasoningControl={isAdmin ? <AgentReasoningSelect chatId={chatId} /> : undefined}
      sceneComposerControl={isAdmin ? <SceneComposerSelect chatId={chatId} /> : undefined}
      hasState={chatState !== null}
      archived={archived}
      archiveBusy={archiveBusy}
      skipBusy={skipBusy || sending}
      onScenario={menuAction(() => setScenarioOpen(true))}
      onStateTools={menuAction(() => setToolsOpen(true))}
      onRelationship={menuAction(() => setRelationshipOpen(true))}
      onTimeSkip={(amount) => {
        setMenuOpen(false);
        void skipTime(amount);
      }}
      onRename={menuAction(() => setRenameOpen(true))}
      onArchiveToggle={() => void toggleArchived()}
      onDelete={menuAction(() => setDeleteOpen(true))}
      onInspector={
        isAdmin
          ? // Open the inspector in a NEW tab so it never unmounts the live conversation
            // (a same-tab navigation would tear down a streaming reply / the composer).
            menuAction(() => window.open(`/chat/${chatId}/inspector`, "_blank", "noopener,noreferrer"))
          : undefined
      }
      onPermissions={isAdmin ? menuAction(() => setPermissionsOpen(true)) : undefined}
      onRoster={menuAction(() => setRosterOpen(true))}
      privacyMode={privacyMode}
      onTogglePrivacy={() => setPrivacyMode(!privacyMode)}
    />
  );
  const roster = bootstrap.data?.roster ?? [];
  const capabilities = bootstrap.data?.chat.capabilities ?? chatCapabilitiesForLane(simRouted);
  // The dialogue-tag vocabulary for rendering replies: every roster member's name (primary
  // first), so a group reply's non-primary `[Name]` tags attribute instead of leaking as
  // literal text. Falls back to the primary name on legacy/empty-roster payloads.
  const rosterNames = roster.length ? roster.map((m) => m.name) : name ? [name] : [];

  const premise = chatState?.premise.trim() ?? "";
  // Another take targets the last assistant REPLY — only there, only
  // idle. A trailing world beat (slice 2) is not a reply, so it's skipped.
  const lastAssistantId = [...lines].reverse().find((l) => l.role === "assistant" && !l.worldBeat)?.id ?? null;
  // Go on: the newest SETTLED message is a reply and nothing is streaming.
  const lastLine = lines[lines.length - 1];
  const canGoOn =
    !sending && ready && !archived && lastLine?.role === "assistant" && !lastLine.id.startsWith("tmp-");
  const worldClockLabel = chatState?.simClock
    ? formatStoryClockShort(storyClockAt(chatState.simClock.storySecond))
    : chatState
      ? formatChatMoment(chatState.clockMinutes, chatState.calendarStart)
      : "";
  const worldLocationLabel = world.loading && world.data === null
    ? "Loading world…"
    : world.error
      ? "World temporarily unavailable"
      : world.data?.catchingUp
        ? "World catching up…"
        : world.data?.transit
          ? `Walking to ${world.data.transit.toLabel}`
          : world.data?.place?.label || "Whereabouts unknown";
  const renderWorldSurface = () => (
    <div className="flex flex-col gap-3">
      {world.loading && world.data === null ? (
        <div
          role="status"
          className="flex items-center gap-2 rounded-md border border-ink-600 bg-ink-850 px-3 py-2 text-sm text-paper-400"
        >
          <span className="size-2 animate-pulse rounded-full bg-accent-400" aria-hidden />
          Loading world…
        </div>
      ) : null}
      {world.error ? (
        <div
          role="alert"
          className="rounded-md border border-danger-500/35 bg-danger-500/10 px-3 py-2 text-sm text-paper-300"
        >
          <p className="font-medium text-paper-100">World temporarily unavailable</p>
          <p className="mt-0.5 text-xs text-paper-400">
            Your transcript is safe. Try the world projection again without leaving the conversation.
          </p>
          <div className="mt-2 flex items-center justify-between gap-2">
            <span className="truncate font-mono text-[10px] text-paper-600">{world.error.code}</span>
            <Button size="sm" variant="quiet" onClick={() => world.reload()}>
              Retry
            </Button>
          </div>
        </div>
      ) : null}
      {world.data ? (
        <ChatWorldCard
          chatId={chatId}
          world={world.data}
          archived={archived}
          busy={skipBusy || sending}
          onWorldChanged={refreshWorldAndState}
        />
      ) : null}
    </div>
  );

  return (
    // Below md the global app header is suppressed on this route (app-shell.tsx),
    // so the page owns the full viewport height; at md+ it comes back and this
    // reverts to subtracting its 3.25rem (do not let that constant drift). The
    // transcript scrolls internally, the composer owns the bottom edge (the
    // bottom tab bar is suppressed on /chat/[chatId] at every width).
    <div className="flex h-dvh min-h-0 flex-col md:h-[calc(100dvh-3.25rem)]">
      <header className="flex shrink-0 items-center gap-2.5 border-b border-ink-600 bg-ink-900/95 px-3 py-2 sm:px-4">
        <Link
          href="/chat"
          aria-label="Back to chats"
          className="touch-target -ml-1 inline-flex shrink-0 items-center justify-center rounded-md px-1.5 py-1 text-paper-400 transition-colors hover:text-paper-100"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden className="size-5">
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </Link>
        {character ? (
          <>
            <button
              type="button"
              onClick={() => setPortraitOpen(true)}
              disabled={!character.avatarImageId || privacyMode}
              aria-label={privacyMode ? `${who}'s portrait is hidden — privacy mode is on` : `View ${who}'s portrait`}
              className="shrink-0 cursor-pointer rounded-full disabled:cursor-default"
            >
              <EntityImage
                imageId={character.avatarImageId}
                name={name}
                privacy={privacyMode}
                className="size-8 rounded-full text-xs"
              />
            </button>
            <div className="min-w-0 flex-1">
              {/* Auto-title: an unnamed conversation is titled by its character. */}
              <p className="truncate text-sm text-paper-100">{title || name}</p>
              {title ? <p className="truncate text-[11px] text-paper-500">{name}</p> : null}
              {/* The active narrator-prompt experiment — under the name, so it is
                  visible with the menu CLOSED and
                  never competes with the title for width. Admin + active selection only,
                  so an ordinary player's header is unchanged. */}
              {isAdmin ? <NarratorPromptBadge template={narratorPrompt.active} /> : null}
            </div>
          </>
        ) : (
          <Skeleton className="h-8 flex-1" />
        )}
        <div ref={menuWrapRef} className="relative shrink-0">
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label="Conversation menu"
            disabled={!ready}
            className="touch-target inline-flex cursor-pointer items-center justify-center rounded-md px-2 py-1 text-paper-400 transition-colors hover:text-paper-100 disabled:cursor-not-allowed disabled:text-paper-600"
          >
            <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden className="size-5">
              <circle cx="5" cy="12" r="1.6" />
              <circle cx="12" cy="12" r="1.6" />
              <circle cx="19" cy="12" r="1.6" />
            </svg>
          </button>
          {!isMobile && menuOpen ? (
            <MenuPopover wrapRef={menuWrapRef} onClose={() => setMenuOpen(false)}>
              {menuBody}
            </MenuPopover>
          ) : null}
        </div>
      </header>

      {capabilities.canUseWorldActions ? (
        <button
          type="button"
          onClick={() => setWorldOpen(true)}
          aria-label={`Open world — ${worldLocationLabel}${worldClockLabel ? `, ${worldClockLabel}` : ""}`}
          className="flex shrink-0 items-center gap-2 border-b border-ink-600 bg-ink-850/95 px-4 py-2 text-left transition-colors hover:bg-ink-800 lg:hidden"
        >
          <span
            className={cx(
              "size-2 shrink-0 rounded-full",
              world.error
                ? "bg-danger-400"
                : world.loading || world.data?.catchingUp
                  ? "animate-pulse bg-accent-400"
                  : "bg-accent-400",
            )}
            aria-hidden
          />
          <span className="min-w-0 flex-1 truncate text-xs text-paper-200">{worldLocationLabel}</span>
          {worldClockLabel ? <span className="shrink-0 text-[11px] text-paper-500">{worldClockLabel}</span> : null}
          <span className="shrink-0 text-xs text-accent-300">World ›</span>
        </button>
      ) : null}

      {isMobile ? (
        <Sheet open={menuOpen} onClose={() => setMenuOpen(false)} side="bottom" title="Conversation">
          {menuBody}
        </Sheet>
      ) : null}

      {/* First-class phone/tablet world surface. The compact strip above opens
          this directly; Roster remains scoped to people and relationships. */}
      <Sheet
        open={worldOpen && capabilities.canUseWorldActions}
        onClose={() => setWorldOpen(false)}
        side="bottom"
        title="World"
        className="lg:hidden"
      >
        <div className="flex flex-col gap-4 p-3">
          <ChatClockCard
            chatId={chatId}
            clockMinutes={chatState?.clockMinutes ?? 0}
            calendarStart={chatState?.calendarStart ?? CHAT_DEFAULT_CALENDAR_START}
            simClock={chatState?.simClock ?? null}
            archived={archived}
            skipBusy={skipBusy || sending}
            onSkip={(amount) => void skipTime(amount)}
            onSaved={(snapshot) => setChatState(snapshot)}
            onSimCalendarSaved={() => void refreshState()}
          />
          {renderWorldSurface()}
        </div>
      </Sheet>

      {/* Roster sheet: the menu path to the roster
          panel + the relationship matrix (roster > 1). */}
      <Sheet open={rosterOpen} onClose={() => setRosterOpen(false)} side="bottom" title="Roster">
        <div className="flex flex-col gap-4 p-3">
          {roster.length > 0 ? (
            <ChatRosterPanel
              chatId={chatId}
              roster={roster}
              archived={archived}
              onChanged={() => bootstrap.reload({ silent: true })}
              onOpenSheet={(member) => {
                setRosterOpen(false);
                setSheetMember(member);
              }}
              privacyMode={privacyMode}
            />
          ) : null}
          <ChatSupportingCastPanel
            chatId={chatId}
            cast={chatState?.supportingCast ?? []}
            archived={archived}
            onSaved={(snapshot) => setChatState(snapshot)}
          />
          <ChatPlansPanel
            chatId={chatId}
            plans={chatState?.plans ?? []}
            clockMinutes={chatState?.clockMinutes ?? 0}
            calendarStart={chatState?.calendarStart ?? CHAT_DEFAULT_CALENDAR_START}
            archived={archived}
            onSaved={(snapshot) => setChatState(snapshot)}
          />
          {rosterOpen && roster.length > 1 ? <ChatRelationshipsEditor chatId={chatId} archived={archived} /> : null}
        </div>
      </Sheet>

      {archived ? (
        <div className="flex shrink-0 items-center justify-center gap-2 border-b border-ink-600 bg-ink-800/80 px-4 py-1 text-xs text-paper-400">
          <span>Archived — restore to continue.</span>
          <Button size="sm" variant="quiet" busy={archiveBusy} onClick={() => void toggleArchived()}>
            Restore
          </Button>
        </div>
      ) : null}

      {/* Scene strip: a disclosure, collapsed by default so the transcript keeps the
          room. Privacy mode removes the whole section —
          toggle included — while active: "no point showing it" if the images
          themselves never render. */}
      {!privacyMode ? (
        <section className="shrink-0 border-b border-ink-600">
          <button
            type="button"
            aria-expanded={scenesOpen}
            onClick={() => setScenesOpen(!scenesOpen)}
            className="flex w-full cursor-pointer items-center justify-between px-4 py-1.5 text-xs font-medium tracking-wide text-paper-400 uppercase transition-colors hover:text-paper-200"
          >
            <span>Scene images</span>
            <svg
              viewBox="0 0 16 16"
              fill="none"
              aria-hidden
              className={cx("size-3.5 transition-transform", scenesOpen && "rotate-180")}
            >
              <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          {scenesOpen && ready && character ? (
            <div className="px-4 pb-3">
              <SceneStrip
                chatId={chatId}
                name={name}
                hasChat={lines.length > 0}
                scenes={sceneList}
                rendering={sceneRendering}
                onRefresh={() => scenes.reload({ silent: true })}
                sceneModel={chatState?.sceneModel ?? ""}
                onSceneModelChange={saveSceneModel}
                sending={sending}
              />
            </div>
          ) : null}
        </section>
      ) : null}

      <div className="flex min-h-0 flex-1">
        {/* Standing portrait (≥lg only): the companion beside the story, using the
            desktop side real estate. Hidden below lg — phones reach the full-size
            portrait by tapping the header portrait or any reply's avatar instead. */}
        {ready && character ? (
          <aside className="hidden min-h-0 w-52 shrink-0 flex-col gap-4 overflow-y-auto p-4 lg:flex xl:w-64">
            {privacyMode ? (
              // Privacy mode: the standing portrait
              // collapses to nothing — page background, no "[hidden]" placeholder —
              // leaving only this quiet toggle in its place to turn it back off.
              <button
                type="button"
                onClick={() => setPrivacyMode(false)}
                aria-pressed
                aria-label="Privacy mode is on — show the portrait"
                title="Privacy mode is on — tap to show the portrait again"
                className="touch-target inline-flex w-fit cursor-pointer items-center gap-1.5 self-start rounded-md px-1.5 py-1 text-paper-500 transition-colors hover:text-paper-300"
              >
                <EyeOffIcon className="size-4" />
                <span className="text-xs">Privacy mode</span>
              </button>
            ) : (
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setPrivacyMode(true)}
                  aria-pressed={false}
                  aria-label="Turn on privacy mode"
                  title="Hide the portrait and scene imagery — for when someone's looking over your shoulder"
                  className="touch-target absolute top-1.5 right-1.5 z-10 inline-flex cursor-pointer items-center justify-center rounded-full bg-ink-950/70 p-1.5 text-paper-300 backdrop-blur-sm transition-colors hover:text-paper-50"
                >
                  <EyeIcon className="size-4" />
                </button>
                <button
                  type="button"
                  onClick={() => setPortraitOpen(true)}
                  disabled={!character.avatarImageId}
                  aria-label={`View ${who}'s portrait`}
                  title={character.avatarImageId ? "View full size" : undefined}
                  className="block w-full cursor-pointer rounded-card transition-opacity hover:opacity-90 disabled:cursor-default disabled:hover:opacity-100"
                >
                  <AvatarPanel name={name} avatarImageId={character.avatarImageId} className="w-full" />
                </button>
              </div>
            )}
            {roster.length > 0 ? (
              <ChatRosterPanel
                chatId={chatId}
                roster={roster}
                archived={archived}
                onChanged={() => bootstrap.reload({ silent: true })}
                onOpenSheet={(member) => setSheetMember(member)}
                privacyMode={privacyMode}
              />
            ) : null}
            {/* Supporting cast: recurring side characters,
                below "In this story" — the dev-visible add/edit/remove surface. */}
            <ChatSupportingCastPanel
              chatId={chatId}
              cast={chatState?.supportingCast ?? []}
              archived={archived}
              onSaved={(snapshot) => setChatState(snapshot)}
            />
            {/* Plans & promises: tracked commitments that come
                due on the story clock — below Supporting Cast. */}
            <ChatPlansPanel
              chatId={chatId}
              plans={chatState?.plans ?? []}
              clockMinutes={chatState?.clockMinutes ?? 0}
              calendarStart={chatState?.calendarStart ?? CHAT_DEFAULT_CALENDAR_START}
              archived={archived}
              onSaved={(snapshot) => setChatState(snapshot)}
            />
          </aside>
        ) : null}
        <ChatTranscriptView
          lines={lines} loading={bootstrap.loading} error={bootstrap.error} onRetry={() => bootstrap.reload()}
          ready={ready} hasEarlier={hasEarlier} loadingEarlier={loadingEarlier}
          loadEarlier={() => transcript.loadEarlier(scroll.preparePrepend)} scroll={scroll}
          who={who} name={name} rosterNames={rosterNames} avatarImageId={character?.avatarImageId ?? null}
          sending={sending} archived={archived} lastAssistantId={lastAssistantId} capabilities={capabilities}
          privacyMode={privacyMode} sceneAnchors={sceneAnchors} onEnlargeAvatar={() => setPortraitOpen(true)}
          actions={{ editLine, deleteLine, rerun, anotherTake, switchTake, openRemember, markMoment }}
        />
        {/* Right aside: the transcript is a centered
            max-w-3xl column, so the right gutter is free real estate at desktop
            widths — story time lives here, with the skip chips beside the display
            that makes them legible. */}
        {ready && character ? (
          <aside className="hidden min-h-0 w-52 shrink-0 flex-col gap-4 overflow-y-auto p-4 lg:flex xl:w-64">
            <ChatClockCard
              chatId={chatId}
              clockMinutes={chatState?.clockMinutes ?? 0}
              calendarStart={chatState?.calendarStart ?? CHAT_DEFAULT_CALENDAR_START}
              simClock={chatState?.simClock ?? null}
              archived={archived}
              skipBusy={skipBusy || sending}
              onSkip={(amount) => void skipTime(amount)}
              onSaved={(snapshot) => setChatState(snapshot)}
              onSimCalendarSaved={() => void refreshState()}
            />
            {/* Successor world status + controls. Projection failure stays visible
                and retryable instead of collapsing to an empty gutter. */}
            {capabilities.canUseWorldActions ? renderWorldSurface() : null}
          </aside>
        ) : null}
      </div>

      <div className="shrink-0 border-t border-ink-600 bg-ink-900/95 px-4 pt-2.5 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
        <div className="mx-auto flex max-w-3xl flex-col gap-2">
          {/* Reopen pickup: a lightweight, dismissable choice — Continue is the default no-op. */}
          {ready && !archived && lines.length > 0 && !pickupDismissed && !sending ? (
            <ChatPickupStrip
              who={who}
              busy={skipBusy}
              clock={
                chatState
                  ? { clockMinutes: chatState.clockMinutes, calendarStart: chatState.calendarStart }
                  : undefined
              }
              simClock={chatState?.simClock ?? null}
              onPick={(amount) => {
                if (amount === null) setPickupDismissed(true);
                else void skipTime(amount);
              }}
              onInitiative={() => void requestInitiative()}
            />
          ) : null}
          {/* "Has something to say" opener: the tapped marker's one-tap beat.
              v2: the marker also fires on unseen milestones, so the banner no longer
              requires open loops — a loop-less tap runs the full initiative opener. */}
          {wantsSay && !archived && !sending ? (
            <div className="flex items-center justify-between gap-2 rounded-card border border-accent-500/30 bg-accent-500/10 px-3 py-1.5 text-xs text-paper-300">
              <span className="truncate" title={chatState?.openLoops[0]}>
                {who} has something on their mind.
              </span>
              <Button size="sm" variant="quiet" onClick={() => void letThemSpeak()}>
                Let {who} speak
              </Button>
            </div>
          ) : null}
          {premise && !archived ? (
            <button
              type="button"
              onClick={() => setScenarioOpen(true)}
              title={premise}
              className="cursor-pointer truncate text-left text-xs text-paper-500 transition-colors hover:text-paper-300"
            >
              Scenario: {premise}
            </button>
          ) : null}
          {!archived ? (
            <div className="flex flex-wrap items-center justify-between gap-2">
              {chatState ? <StatusStrip state={chatState} onOpenScenario={() => setScenarioOpen(true)} /> : <span />}
              {lines.length === 0 ? (
                <Button
                  size="sm"
                  variant="quiet"
                  disabled={sending || !ready}
                  onClick={() => void promptCharacter()}
                  title={`Let ${who} open the scene`}
                >
                  Prompt {who}
                </Button>
              ) : canGoOn ? (
                <Button
                  size="sm"
                  variant="quiet"
                  onClick={() => void goOn()}
                  title={`Let ${who} continue without a reply from you`}
                >
                  Go on <span aria-hidden>→</span>
                </Button>
              ) : (
                <span />
              )}
            </div>
          ) : null}
          {chatState && !archived && capabilities.canUseLegacyActionBeats ? (
            <ActionChips busy={actionBusy} disabled={sending} onAction={(a) => void runAction(a)} />
          ) : null}
          <ChatComposer
            chatId={chatId} isCurrent={isCurrent} who={who} ready={ready} archived={archived}
            input={input} setInput={setInput} oocActive={oocActive} setOocActive={setOocActive}
            narratorMode={narratorMode} setNarratorMode={setNarratorMode}
            attachments={attachments} setAttachments={setAttachments} attachBusy={attachBusy} setAttachBusy={setAttachBusy}
            sending={sending} stopping={stopping} canAttachPhotos={capabilities.canAttachPhotos} canStop={capabilities.canStop}
            send={send} stopReply={stopReply} openRemember={openRemember}
          />
        </div>
      </div>

      <Dialog
        open={deleteOpen}
        onClose={() => {
          if (!deleting) setDeleteOpen(false);
        }}
        title="Delete this chat?"
        footer={
          <div className="flex justify-end gap-2">
            <Button onClick={() => setDeleteOpen(false)} disabled={deleting}>
              Cancel
            </Button>
            <Button variant="danger" onClick={() => void deleteChat()} disabled={deleting}>
              {deleting ? "Deleting…" : "Delete chat"}
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-3 text-sm text-paper-400">
          <p>
            This deletes the conversation and its memory: the transcript, the running summary, {who}&rsquo;s
            disposition (regard, mood, scenario), and everything {who}
            {/* String-expression children: swc in next 16.2.x drops the leading space of a multi-line JSX text node
                containing an HTML entity (swc#11521; fixed in next 16.3.0). */}
            {" remembers about you from it. Archiving keeps all of that — this can’t be undone."}
          </p>
          {/* A world-bound chat owns its
              world 1:1, and the world is hard-deleted with it — say so here too. */}
          {simRouted ? (
            <p>
              This conversation has its own world, and the world goes with it: its people, places, and everything
              that has happened there.
            </p>
          ) : null}
          <p className="text-xs text-paper-500">Generated scene images are kept — find them in the Gallery.</p>
        </div>
      </Dialog>

      {renameOpen ? (
        <RenameDialog
          title={title}
          placeholder={name}
          onClose={() => setRenameOpen(false)}
          onRename={renameChat}
        />
      ) : null}

      <Dialog
        open={rememberOpen}
        onClose={() => {
          if (!rememberBusy) setRememberOpen(false);
        }}
        title="Remember this"
        footer={
          <div className="flex justify-end gap-2">
            <Button onClick={() => setRememberOpen(false)} disabled={rememberBusy}>
              Cancel
            </Button>
            <Button variant="primary" busy={rememberBusy} onClick={() => void saveRemember()} disabled={!rememberText.trim()}>
              Remember
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-2">
          <p className="text-sm text-paper-400">
            {who} will always keep this in mind — it outranks anything picked up in play, and only you can change it.
          </p>
          <Textarea
            rows={3}
            value={rememberText}
            maxLength={500}
            onChange={(e) => setRememberText(e.target.value)}
            placeholder="e.g. I'm allergic to peanuts. / My brother's name is Jonas."
            autoFocus
          />
        </div>
      </Dialog>

      {chatState ? (
        <ChatStateToolsModal
          open={toolsOpen}
          onClose={() => setToolsOpen(false)}
          chatId={chatId}
          who={who}
          characterId={roster[0]?.characterId}
          presence={roster.length > 1 ? roster[0]?.presence : undefined}
          onPresenceChanged={() => bootstrap.reload({ silent: true })}
          snapshot={chatState}
          onSaved={(next) => {
            setChatState(next);
            stageRef.current = next.regardBand.label;
          }}
        />
      ) : null}

      {/* Per-character sheet: a roster member's own state,
          fetched fresh on open and edited via characterId targeting. */}
      {sheetMember && sheetSnapshot ? (
        <ChatStateToolsModal
          open
          onClose={() => {
            setSheetMember(null);
            setSheetSnapshot(null);
          }}
          chatId={chatId}
          who={sheetMember.name}
          characterId={sheetMember.characterId}
          presence={roster.length > 1 ? sheetMember.presence : undefined}
          onPresenceChanged={() => bootstrap.reload({ silent: true })}
          snapshot={sheetSnapshot}
          onSaved={(next) => {
            // Editing the PRIMARY through their sheet also refreshes the strip.
            if (sheetMember.characterId === roster[0]?.characterId) {
              setChatState(next);
              stageRef.current = next.regardBand.label;
            }
            setSheetMember(null);
            setSheetSnapshot(null);
          }}
        />
      ) : null}

      {chatState ? (
        <ChatScenarioModal
          open={scenarioOpen}
          onClose={() => setScenarioOpen(false)}
          chatId={chatId}
          who={who}
          snapshot={chatState}
          onSaved={(next) => {
            setChatState(next);
            stageRef.current = next.regardBand.label;
          }}
        />
      ) : null}

      <ChatRelationshipPanel chatId={chatId} who={who} open={relationshipOpen} onClose={() => setRelationshipOpen(false)} />

      {/* Admin-only: the romantic_touch permission override panel — its menu item only
          mounts for admins, and the endpoint re-checks the role server-side. */}
      <ChatPermissionsPanel
        open={permissionsOpen}
        onClose={() => setPermissionsOpen(false)}
        chatId={chatId}
        roster={roster.map((member) => ({ characterId: member.characterId, name: member.name }))}
      />

      {/* One lightbox serves every portrait affordance (header / standing / reply avatars). */}
      <ImageLightbox
        imageId={portraitOpen ? (character?.avatarImageId ?? null) : null}
        alt={name}
        onClose={() => setPortraitOpen(false)}
      />
    </div>
  );
}
