"use client";

import { useState } from "react";
import type { UseSession } from "@/lib/client/use-session";
import { ErrorState } from "@/components/ui/error-state";
import { Tabs, type TabDef } from "@/components/ui/tabs";
import { CastTab } from "./cast-tab";
import { InspectorTab } from "./inspector-tab";
import { SceneTab } from "./scene-tab";
import { WorldTab } from "./world-tab";

type PanelTab = "scene" | "cast" | "world" | "inspector";

/** Right-hand panel: Scene · Cast · World · Inspector (docs/ui.md). */
export function SidePanel({ session, isAdmin }: { session: UseSession; isAdmin: boolean }) {
  const [tab, setTab] = useState<PanelTab>("scene");

  const tabs: TabDef<PanelTab>[] = [
    { id: "scene", label: "Scene" },
    { id: "cast", label: "Cast", badge: session.status?.participants.length || undefined },
    { id: "world", label: "World" },
    ...(isAdmin ? [{ id: "inspector" as const, label: "Inspector" }] : []),
  ];
  // If admin status arrives late (or flips), never strand the selection.
  const active: PanelTab = tab === "inspector" && !isAdmin ? "scene" : tab;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Tabs tabs={tabs} value={active} onChange={setTab} className="px-2" />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {session.statusError && !session.status ? (
          <ErrorState error={session.statusError} onRetry={() => void session.refresh()} className="m-4" />
        ) : active === "scene" ? (
          <SceneTab session={session} />
        ) : active === "cast" ? (
          <CastTab session={session} />
        ) : active === "world" ? (
          <WorldTab session={session} isAdmin={isAdmin} />
        ) : (
          <InspectorTab session={session} />
        )}
      </div>
    </div>
  );
}
