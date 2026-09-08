"use client";

import { Button } from "@/components/ui/button";
import { imageUrl } from "@/lib/client/api";
import type { CharacterGeneration } from "./character-generation-record";

export function CharacterGenerationStatus({ records, activeId, blocked, unavailable, onRetry, onDismiss }: {
  records: CharacterGeneration[]; activeId: string | undefined; blocked: boolean; unavailable: boolean;
  onRetry: (record: CharacterGeneration) => void; onDismiss: (record: CharacterGeneration) => void;
}) {
  const visible = records.filter((record) => record.status !== "completed");
  return <div className="mb-4 flex flex-col gap-2">
    {unavailable ? <p role="status" className="text-sm text-warning">Saved generation status is temporarily unavailable. Cached status is shown until the server reconnects.</p> : null}
    {visible.map((record) => <section key={record.id} className="rounded-card border border-ink-600 bg-ink-850 p-3">
      <p role="status" className="text-sm">{record.id === activeId ? `Generating ${record.label}. You can leave this page and return for the result.` : record.status === "completed" ? "Suggestions are ready. Resolve any draft recovery above to review them." : record.status === "failed" ? `Generation failed: ${record.error}` : "Generation was interrupted or is still running in another page. Nothing restarts automatically."}</p>
      {record.status === "failed" && record.result?.portrait ? <div className="mt-3 flex items-start gap-3 text-xs text-paper-400">
        <img src={imageUrl(record.result.portrait.source.imageId)} alt="Portrait inspected by the failed run" className="h-20 w-16 rounded-md object-cover" />
        <div>
          <p>{record.result.portrait.fields.length
            ? record.result.portrait.fields.map((field) => `${field.id}: ${field.visibility}, ${Math.round(field.confidence / 100)}%`).join(" · ")
            : "No reliable field evidence was returned."}</p>
          {record.retryOf ? <p className="mt-1">Retry of {record.retryOf.slice(0, 8)}</p> : null}
        </div>
      </div> : null}
      {record.id !== activeId && record.status !== "completed" ? <div className="mt-2 flex gap-2"><Button disabled={blocked || !!activeId} onClick={() => onRetry(record)}>Retry generation</Button><Button disabled={blocked} variant="ghost" onClick={() => onDismiss(record)}>Dismiss</Button></div> : null}
    </section>)}
  </div>;
}
