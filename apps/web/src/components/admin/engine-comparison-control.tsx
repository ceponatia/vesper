"use client";

import Link from "next/link";
import { useState } from "react";
import { useAsyncData } from "@/components/hooks/use-async";
import { Button } from "@/components/ui/button";
import { engineComparisonApi } from "@/lib/api-engine-comparison";

/** Admin-only control embedded in a conversation's menu. */
export function EngineComparisonControl({ chatId }: { chatId: string }) {
  const status = useAsyncData(() => engineComparisonApi.status(chatId), [chatId]);
  const [busy, setBusy] = useState<"start" | "stop" | null>(null);
  const [error, setError] = useState("");

  const mutate = async (action: "start" | "stop") => {
    if (busy) return;
    setBusy(action);
    setError("");
    const result = action === "start" ? await engineComparisonApi.start(chatId) : await engineComparisonApi.stop(chatId);
    setBusy(null);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    status.reload({ silent: true });
  };

  const value = status.data;
  return (
    <div className="flex flex-col gap-1.5 px-2 py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium tracking-wide text-paper-400 uppercase">Engine Comparison</span>
        {value?.active ? <span className="text-[11px] font-medium text-ok-400">Active</span> : null}
      </div>
      {status.loading && value === null ? <p className="text-xs text-paper-500">Checking comparison state…</p> : null}
      {status.error ? (
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-danger-300">Couldn&rsquo;t load comparison state.</span>
          <Button size="sm" variant="quiet" onClick={() => status.reload()}>
            Retry
          </Button>
        </div>
      ) : value ? (
        <>
          {value.active ? (
            <p className="text-xs text-paper-500">Legacy remains playable; the successor mirror records each plain-send turn.</p>
          ) : value.canStart ? (
            <p className="text-xs text-paper-500">Start a successor mirror from the conversation&rsquo;s current legacy state.</p>
          ) : (
            <p className="text-xs text-paper-500">{value.reason}</p>
          )}
          {error ? <p className="text-xs text-danger-300">{error}</p> : null}
          <div className="flex flex-wrap items-center gap-1.5">
            {value.active ? (
              <Button size="sm" variant="quiet" busy={busy === "stop"} disabled={busy !== null} onClick={() => void mutate("stop")}>
                Stop
              </Button>
            ) : value.canStart ? (
              <Button size="sm" variant="quiet" busy={busy === "start"} disabled={busy !== null} onClick={() => void mutate("start")}>
                Start comparison
              </Button>
            ) : null}
            {value.rows > 0 ? (
              <Link href={`/admin/shadow/${chatId}`} className="text-xs text-accent-300 hover:text-accent-200">
                Review {value.rows} row{value.rows === 1 ? "" : "s"} →
              </Link>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}
