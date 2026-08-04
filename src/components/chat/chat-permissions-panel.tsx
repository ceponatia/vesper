"use client";

import { useState } from "react";
import {
  chatPermissionsApi,
  type PermissionGrant,
  type PermissionOverview,
} from "@/lib/api-permissions";
import { useAsyncData } from "@/components/hooks/use-async";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";

/**
 * The `romantic_touch` permission developer panel
 * (romantic-contact-affordances.spec.permission.md §"Authorship and developer
 * controls"; plan §"`romantic_touch` permission-owner rulings" 1 and 5) —
 * admin-gated (mounted only when `useIsAdmin` passes in the conversation menu),
 * talking to the self-scoped owner-admin override endpoint
 * (`/api/admin/self/chat-permissions/:chatId`, `src/lib/api-permissions.ts`).
 *
 * One row per DIRECTION, in plain language — "Alex may touch Mara
 * romantically", never a symmetric checkbox (ruling 1): the player toward each
 * roster NPC, and each NPC toward each other NPC. Granting targets are NPCs
 * only — the ruled player-target exception means no player-directed grant
 * exists to edit. Grant/Withdraw write one audited `developer_overridden`
 * ledger event each through the production projection and
 * contact-invalidation path; chat text can never do this (ruling 5).
 *
 * Relationship values (regard/familiarity) already have their dev editors on
 * the Character sheet — this panel deliberately does not duplicate them.
 */

/** One roster participant, as the conversation page already holds them. */
export interface PermissionRosterMember {
  readonly characterId: string;
  readonly name: string;
}

export function ChatPermissionsPanel({
  open,
  onClose,
  chatId,
  roster,
}: {
  open: boolean;
  onClose: () => void;
  chatId: string;
  roster: readonly PermissionRosterMember[];
}) {
  if (!open) return null;
  return <PermissionsDialog chatId={chatId} roster={roster} onClose={onClose} />;
}

/** A direction key the grant lookup and the busy flag share. */
const directionKey = (permittedActorId: string, grantingTargetId: string) =>
  `${permittedActorId}${grantingTargetId}`;

interface DirectionRow {
  readonly key: string;
  readonly permittedActorId: string;
  readonly grantingTargetId: string;
  /** "You may touch Mara romantically" / "Alex may touch Mara romantically". */
  readonly label: string;
}

/** Player → each NPC, then each NPC → each other NPC. Targets are NPCs only. */
function directionRows(playerSubjectId: string, roster: readonly PermissionRosterMember[]): DirectionRow[] {
  const rows: DirectionRow[] = [];
  for (const target of roster) {
    rows.push({
      key: directionKey(playerSubjectId, target.characterId),
      permittedActorId: playerSubjectId,
      grantingTargetId: target.characterId,
      label: `You may touch ${target.name} romantically`,
    });
  }
  for (const actor of roster) {
    for (const target of roster) {
      if (actor.characterId === target.characterId) continue;
      rows.push({
        key: directionKey(actor.characterId, target.characterId),
        permittedActorId: actor.characterId,
        grantingTargetId: target.characterId,
        label: `${actor.name} may touch ${target.name} romantically`,
      });
    }
  }
  return rows;
}

function standingLabel(grant: PermissionGrant | undefined): { text: string; tone: string } {
  // No entry at all is ABSENCE — a different fact from a withdrawn tombstone.
  if (grant === undefined) return { text: "Never granted", tone: "text-paper-500" };
  switch (grant.standing) {
    case "granted":
      return { text: "Granted", tone: "text-accent-300" };
    case "withdrawn":
      return { text: "Withdrawn", tone: "text-danger-300" };
    case "revoked":
      return { text: "Revoked", tone: "text-danger-300" };
  }
}

/** A subject id as the events readout names it, resolved through the roster. */
function subjectName(id: string, playerSubjectId: string, roster: readonly PermissionRosterMember[]): string {
  if (id === playerSubjectId) return "You";
  return roster.find((member) => member.characterId === id)?.name ?? id;
}

function PermissionsDialog({
  chatId,
  roster,
  onClose,
}: {
  chatId: string;
  roster: readonly PermissionRosterMember[];
  onClose: () => void;
}) {
  const toast = useToast();
  const overview = useAsyncData<PermissionOverview>(() => chatPermissionsApi.overview(chatId), [chatId]);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const data = overview.data;
  const playerSubjectId = data?.playerSubjectId ?? "player";
  const grantByKey = new Map(
    (data?.grants ?? []).map((grant) => [directionKey(grant.permittedActorId, grant.grantingTargetId), grant]),
  );
  const rows = directionRows(playerSubjectId, roster);
  const overrideEnabled = data?.overrideEnabled ?? false;

  const apply = async (row: DirectionRow, operation: "grant" | "withdraw") => {
    setBusyKey(row.key);
    const result = await chatPermissionsApi.override(chatId, {
      permittedActorId: row.permittedActorId,
      grantingTargetId: row.grantingTargetId,
      operation,
    });
    setBusyKey(null);
    if (!result.ok) {
      // The capability-off POST answers the hidden 404 — surface whatever the
      // server said rather than guessing at the cause.
      toast.push({ title: "Override failed", description: result.error.message, tone: "error" });
      return;
    }
    const ended = result.data.endedContactIds.length;
    toast.push({
      title: operation === "grant" ? "Permission granted" : "Permission withdrawn",
      description: [
        result.data.standingChanged ? "Standing changed." : "Standing was already there — recorded as evidence.",
        ended > 0 ? `Ended ${ended} active contact${ended === 1 ? "" : "s"}.` : null,
      ]
        .filter((part) => part !== null)
        .join(" "),
    });
    overview.reload({ silent: true });
  };

  return (
    <Dialog open onClose={onClose} title="Permissions (dev)" size="lg">
      <div className="flex flex-col gap-4">
        <p className="text-xs text-paper-500">
          Directional <code>romantic_touch</code> grants for this conversation. Each direction is independent —
          granting one never grants the reverse. Overrides are recorded as audited developer events and go through
          the same projection and contact-invalidation path as in-story events.
        </p>

        {!overview.loading && !overrideEnabled ? (
          <p className="rounded-md border border-ink-600 bg-ink-850 px-3 py-2 text-xs text-paper-400">
            The override capability is off (<code>CHAT_ROMANTIC_PERMISSION_DEV_OVERRIDE</code>), so writes are
            disabled — this view stays readable for inspection.
          </p>
        ) : null}

        {overview.error ? (
          <p className="rounded-md border border-danger-500/35 bg-danger-500/10 px-3 py-2 text-sm text-paper-300">
            Couldn&rsquo;t load permissions: {overview.error.message}
          </p>
        ) : null}

        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium tracking-wide text-paper-400 uppercase">Directions</span>
          {rows.length === 0 ? (
            <p className="text-sm text-paper-500">No roster characters — there is no direction to set.</p>
          ) : (
            rows.map((row) => {
              const standing = standingLabel(grantByKey.get(row.key));
              const busy = busyKey === row.key;
              return (
                <div
                  key={row.key}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-ink-600 bg-ink-850 px-3 py-2"
                >
                  <div className="flex min-w-0 flex-col">
                    <span className="text-sm text-paper-200">{row.label}</span>
                    <span className={`text-xs ${standing.tone}`}>{standing.text}</span>
                  </div>
                  <div className="flex shrink-0 gap-1.5">
                    <Button
                      size="sm"
                      busy={busy}
                      disabled={!overrideEnabled || busyKey !== null}
                      onClick={() => void apply(row, "grant")}
                    >
                      Grant
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      busy={busy}
                      disabled={!overrideEnabled || busyKey !== null}
                      onClick={() => void apply(row, "withdraw")}
                    >
                      Withdraw
                    </Button>
                  </div>
                </div>
              );
            })
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium tracking-wide text-paper-400 uppercase">Recent events</span>
          {(data?.events.length ?? 0) === 0 ? (
            <p className="text-sm text-paper-500">No permission events recorded in this conversation.</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {(data?.events ?? []).map((event) => (
                <li key={event.id} className="rounded-md bg-ink-850 px-3 py-1.5 text-xs text-paper-400">
                  <span className="text-paper-300">
                    {event.kind}
                    {event.operation ? ` (${event.operation})` : ""}
                  </span>{" "}
                  — {subjectName(event.permittedActorId, playerSubjectId, roster)} →{" "}
                  {subjectName(event.grantingTargetId, playerSubjectId, roster)} · {event.scope} · min{" "}
                  {event.storyMinute} · {event.sourceKind}
                </li>
              ))}
            </ul>
          )}
        </div>

        <p className="text-xs text-paper-500">
          Relationship values (regard, familiarity) are edited on the Character sheet — this panel only owns
          permission.
        </p>
      </div>
    </Dialog>
  );
}
