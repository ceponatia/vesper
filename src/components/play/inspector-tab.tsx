"use client";

import { useMemo, useState } from "react";
import { z } from "zod";
import { apiGet, type ApiResult } from "@/lib/client/api";
import type { UseSession } from "@/lib/client/use-session";
import { Button } from "@/components/ui/button";
import { cx } from "@/components/ui/cx";
import { Select } from "@/components/ui/select";
import { SkeletonText } from "@/components/ui/skeleton";

/**
 * Inspector tab (admin only, docs/ui.md): per-turn agent results, persisted
 * diagnostics, and retrieval scores from GET /turns/:id/inspect — fetched
 * lazily per selected turn and cached for the session of the panel.
 */

const diagnosticEntrySchema = z.object({
  severity: z.enum(["info", "warn", "error"]).catch("info"),
  code: z.string().catch("unknown"),
  message: z.string().catch(""),
  path: z
    .string()
    .nullish()
    .catch(null)
    .transform((v) => v ?? null),
});
type DiagnosticEntry = z.infer<typeof diagnosticEntrySchema>;

const retrievalEventSchema = z.preprocess(
  (raw) => (raw && typeof raw === "object" ? raw : {}),
  z.object({
    kind: z.string().catch("retrieval"),
    query: z
      .string()
      .nullish()
      .catch(null)
      .transform((v) => v ?? null),
    text: z
      .string()
      .nullish()
      .catch(null)
      .transform((v) => v ?? null),
    score: z
      .number()
      .nullish()
      .catch(null)
      .transform((v) => v ?? null),
  }),
);
type RetrievalEvent = z.infer<typeof retrievalEventSchema>;

function dropInvalid<T>(item: z.ZodType<T>) {
  return z
    .array(z.unknown())
    .catch([])
    .transform((xs) =>
      xs.flatMap((x) => {
        const parsed = item.safeParse(x);
        return parsed.success ? [parsed.data] : [];
      }),
    );
}

const inspectPayloadSchema = z.preprocess(
  (raw) => {
    const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    return {
      agentResults: obj.agentResults ?? obj.agent_results ?? obj.results ?? {},
      diagnostics: obj.diagnostics ?? [],
      retrieval: obj.retrieval ?? obj.retrievalEvents ?? obj.retrieval_events ?? [],
    };
  },
  z.object({
    agentResults: z.record(z.string(), z.unknown()).catch({}),
    diagnostics: dropInvalid(diagnosticEntrySchema),
    retrieval: dropInvalid(retrievalEventSchema),
  }),
);
type InspectPayload = z.infer<typeof inspectPayloadSchema>;

const severityColor: Record<DiagnosticEntry["severity"], string> = {
  info: "text-paper-400",
  warn: "text-accent-300",
  error: "text-danger-300",
};

function JsonBlock({ label, value }: { label: string; value: unknown }) {
  let pretty: string;
  try {
    pretty = JSON.stringify(value, null, 2) ?? "null";
  } catch {
    pretty = String(value);
  }
  return (
    <details className="rounded-md border border-ink-600">
      <summary className="cursor-pointer px-3 py-1.5 text-xs font-medium text-paper-200 select-none">
        {label}
        {value === null ? <span className="ml-2 text-paper-500 italic">degraded → null</span> : null}
      </summary>
      <pre className="max-h-72 overflow-auto border-t border-ink-700 px-3 py-2 text-[11px] leading-4 text-paper-300">
        {pretty}
      </pre>
    </details>
  );
}

export function InspectorTab({ session }: { session: UseSession }) {
  // Distinct turns present in the loaded feed, newest first.
  const turns = useMemo(() => {
    const seen = new Map<string, number | null>();
    for (const message of session.feed) {
      if (message.turnId && !seen.has(message.turnId)) seen.set(message.turnId, message.turnNumber);
    }
    return [...seen.entries()].map(([id, number]) => ({ id, number })).reverse();
  }, [session.feed]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [cache, setCache] = useState<Record<string, ApiResult<InspectPayload>>>({});
  const [loading, setLoading] = useState(false);

  const turnId = selectedId ?? turns[0]?.id ?? null;
  const cached = turnId ? cache[turnId] : undefined;

  const load = async (id: string, force = false) => {
    if (!force && cache[id]) return;
    setLoading(true);
    const result = await apiGet(inspectPayloadSchema, `/api/sessions/${session.sessionId}/turns/${id}/inspect`);
    setCache((prev) => ({ ...prev, [id]: result }));
    setLoading(false);
  };

  if (turns.length === 0) {
    return <p className="p-4 text-xs text-paper-500 italic">No turns yet — nothing to inspect.</p>;
  }

  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex items-center gap-2">
        <Select
          value={turnId ?? ""}
          onChange={(e) => {
            setSelectedId(e.target.value);
            void load(e.target.value);
          }}
          aria-label="Inspect turn"
          className="h-8 text-xs"
        >
          {turns.map((turn) => (
            <option key={turn.id} value={turn.id}>
              {turn.number !== null ? `Turn ${turn.number}` : turn.id.slice(0, 8)}
            </option>
          ))}
        </Select>
        <Button size="sm" variant="quiet" busy={loading} onClick={() => turnId && void load(turnId, true)}>
          {cached ? "Reload" : "Inspect"}
        </Button>
      </div>

      {!cached ? (
        loading ? (
          <SkeletonText lines={4} />
        ) : (
          <p className="text-xs text-paper-500 italic">Pick a turn and press Inspect.</p>
        )
      ) : !cached.ok ? (
        <p className="text-xs text-danger-300">
          {cached.error.code}: {cached.error.message}
        </p>
      ) : (
        <InspectView payload={cached.data} />
      )}
    </div>
  );
}

function InspectView({ payload }: { payload: InspectPayload }) {
  const agents = Object.entries(payload.agentResults);
  return (
    <div className="flex flex-col gap-3">
      <section className="flex flex-col gap-1.5">
        <h3 className="text-xs font-medium tracking-wide text-paper-400 uppercase">Agent results</h3>
        {agents.length === 0 ? (
          <p className="text-xs text-paper-500 italic">No agent results recorded.</p>
        ) : (
          agents.map(([name, value]) => <JsonBlock key={name} label={name} value={value} />)
        )}
      </section>

      <section className="flex flex-col gap-1.5">
        <h3 className="text-xs font-medium tracking-wide text-paper-400 uppercase">
          Diagnostics <span className="text-paper-500">({payload.diagnostics.length})</span>
        </h3>
        {payload.diagnostics.length === 0 ? (
          <p className="text-xs text-paper-500 italic">Clean turn — nothing degraded.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {payload.diagnostics.map((diagnostic, i) => (
              <li key={i} className="rounded-md border border-ink-600 px-2.5 py-1.5 text-[11px] leading-4">
                <span className={cx("font-medium", severityColor[diagnostic.severity])}>
                  {diagnostic.severity}
                </span>{" "}
                <span className="font-mono text-paper-300">{diagnostic.code}</span>
                <p className="mt-0.5 text-paper-400">{diagnostic.message}</p>
                {diagnostic.path ? <p className="text-paper-500">at {diagnostic.path}</p> : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-1.5">
        <h3 className="text-xs font-medium tracking-wide text-paper-400 uppercase">Retrieval</h3>
        {payload.retrieval.length === 0 ? (
          <p className="text-xs text-paper-500 italic">No retrieval events.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {payload.retrieval.map((event: RetrievalEvent, i) => (
              <li key={i} className="rounded-md border border-ink-600 px-2.5 py-1.5 text-[11px] leading-4">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-paper-300">{event.kind}</span>
                  {event.score !== null ? (
                    <span className="font-mono text-accent-300">{event.score.toFixed(3)}</span>
                  ) : null}
                </div>
                {event.query ? <p className="truncate text-paper-500">q: {event.query}</p> : null}
                {event.text ? <p className="line-clamp-2 text-paper-400">{event.text}</p> : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
