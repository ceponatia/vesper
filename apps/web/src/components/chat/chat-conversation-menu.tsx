"use client";

import { useEffect, useState, type ReactNode, type RefObject } from "react";
import type { ChatSkipAmount } from "@/contracts";
import { NARRATIVE_MODELS } from "@/lib/narrative-models";
import { Button } from "@/components/ui/button";
import { cx } from "@/components/ui/cx";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ModelSelect } from "@/components/ui/model-select";

/**
 * The header menu body, shared by the two hosts (bottom Sheet on phones, popover at
 * ≥md): the narrator-model pick + the conversation's lifecycle actions.
 */
export function ConversationMenu({
  chatModel,
  onChatModelChange,
  narratorPromptControl,
  agentReasoningControl,
  sceneComposerControl,
  hasState,
  archived,
  archiveBusy,
  skipBusy,
  onScenario,
  onStateTools,
  onRelationship,
  onTimeSkip,
  onRename,
  onArchiveToggle,
  onDelete,
  onInspector,
  onPermissions,
  onRoster,
  privacyMode,
  onTogglePrivacy,
}: {
  chatModel: string;
  onChatModelChange: (modelId: string) => void;
  /** Owner-admin-only narrator-prompt experiment picker; absent for ordinary users. */
  narratorPromptControl?: ReactNode;
  /** Owner-admin-only experiment selector; absent for ordinary users. */
  agentReasoningControl?: ReactNode;
  /** Owner-admin-only scene-composer model picker; absent for ordinary users. */
  sceneComposerControl?: ReactNode;
  hasState: boolean;
  archived: boolean;
  archiveBusy: boolean;
  skipBusy: boolean;
  onScenario: () => void;
  onStateTools: () => void;
  /** The Relationship panel: stage, sparkline, milestones, story so far. */
  onRelationship: () => void;
  /** Mid-conversation time skip — the same options as the pickup strip. */
  onTimeSkip: (amount: ChatSkipAmount) => void;
  onRename: () => void;
  onArchiveToggle: () => void;
  onDelete: () => void;
  /** Admin-only: navigate to the dev memory inspector. Absent ⇒ item hidden. */
  onInspector?: () => void;
  /** Admin-only: the romantic_touch permission override panel. Absent ⇒ hidden. */
  onPermissions?: () => void;
  /** The roster panel: add/remove members, presence toggles. */
  onRoster: () => void;
  /** Privacy mode: the phone-menu path to the same
   *  toggle the desktop standing portrait carries — hides the portrait, feed
   *  avatars, and all scene imagery. */
  privacyMode: boolean;
  onTogglePrivacy: () => void;
}) {
  return (
    <div className="flex flex-col p-2">
      <label className="flex flex-col gap-1 px-2 pt-1 pb-2">
        <span className="text-xs font-medium tracking-wide text-paper-400 uppercase">Narrator model</span>
        <ModelSelect
          ariaLabel="Narrator model"
          models={NARRATIVE_MODELS}
          value={chatModel}
          onChange={onChatModelChange}
          className="h-8 text-xs"
        />
      </label>
      {/* The narrator experiments sit together: which model narrates, then which
          instructions it narrates by. */}
      {narratorPromptControl}
      {agentReasoningControl}
      {sceneComposerControl}
      <div className="my-1 border-t border-ink-600" />
      <MenuItem onClick={onScenario} disabled={!hasState}>
        Scenario setup
      </MenuItem>
      <MenuItem onClick={onRelationship} disabled={!hasState}>
        Relationship
      </MenuItem>
      <MenuItem onClick={onStateTools} disabled={!hasState}>
        Character sheet
      </MenuItem>
      <MenuItem onClick={onRoster}>Roster</MenuItem>
      {/* Privacy mode (ruling 4): the phone path to the toggle — desktop also has
          the standing-portrait affordance, but that column is hidden below lg. */}
      <MenuItem onClick={onTogglePrivacy} pressed={privacyMode}>
        {privacyMode ? "Privacy mode: On" : "Privacy mode: Off"}
      </MenuItem>
      {onInspector ? <MenuItem onClick={onInspector}>Inspector</MenuItem> : null}
      {onPermissions ? <MenuItem onClick={onPermissions}>Permissions (dev)</MenuItem> : null}
      {!archived ? (
        <div className="flex flex-col gap-1 px-2 py-1.5">
          <span className="text-xs font-medium tracking-wide text-paper-400 uppercase">Let time pass</span>
          <div className="flex flex-wrap gap-1.5">
            {(
              [
                ["moments", "Moments"],
                ["hours", "Hours"],
                ["overnight", "Overnight"],
                ["days", "Days"],
              ] as const
            ).map(([amount, label]) => (
              <button
                key={amount}
                type="button"
                disabled={skipBusy}
                onClick={() => onTimeSkip(amount)}
                className="cursor-pointer rounded-md border border-ink-600 px-2 py-1 text-xs text-paper-300 transition-colors hover:border-accent-500/50 hover:text-paper-100 disabled:cursor-not-allowed disabled:text-paper-600"
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      <MenuItem onClick={onRename}>Rename…</MenuItem>
      <MenuItem onClick={onArchiveToggle} disabled={archiveBusy}>
        {archived ? "Restore" : "Archive"}
      </MenuItem>
      <div className="my-1 border-t border-ink-600" />
      <MenuItem onClick={onDelete} danger>
        Delete chat…
      </MenuItem>
    </div>
  );
}

function MenuItem({
  onClick,
  disabled,
  danger,
  pressed,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  /** Toggle items (e.g. Privacy mode) carry their on/off state for a11y. */
  pressed?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={pressed}
      className={cx(
        "touch-target block w-full cursor-pointer rounded-md px-2 py-2 text-left text-sm transition-colors disabled:cursor-not-allowed disabled:text-paper-600",
        danger ? "text-danger-300 hover:bg-danger-500/10" : "text-paper-200 hover:bg-ink-700",
      )}
    >
      {children}
    </button>
  );
}

/**
 * Desktop popover host: outside-click + Escape close (the AccountMenu pattern).
 * `wrapRef` is the container holding the trigger *and* this panel — testing
 * containment against the panel alone would treat a trigger click as "outside",
 * closing on mousedown and re-opening on the click's toggle.
 */
export function MenuPopover({
  wrapRef,
  onClose,
  children,
}: {
  wrapRef: RefObject<HTMLDivElement | null>;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    function onDocPointer(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", onDocPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [wrapRef, onClose]);
  return (
    <div className="absolute top-full right-0 z-50 mt-1 w-64 overflow-hidden rounded-card border border-ink-600 bg-ink-800 shadow-lift">
      {children}
    </div>
  );
}

/** Rename form: mounts fresh per open, so `useState` seeds from the current title without an effect. */
export function RenameDialog({
  title,
  placeholder,
  onClose,
  onRename,
}: {
  title: string;
  placeholder: string;
  onClose: () => void;
  onRename: (next: string) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState(title);
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    const ok = await onRename(draft.trim());
    setSaving(false);
    if (ok) onClose();
  };
  return (
    <Dialog
      open
      onClose={() => {
        if (!saving) onClose();
      }}
      title="Rename conversation"
      footer={
        <>
          <Button onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" busy={saving} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-1.5">
        <Input
          value={draft}
          maxLength={120}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={placeholder}
          autoFocus
        />
        <p className="text-xs text-paper-500">Leave empty to fall back to the character&rsquo;s name.</p>
      </div>
    </Dialog>
  );
}
