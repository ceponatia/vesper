import "dotenv/config";
import { NARRATIVE_MODELS } from "@/lib/narrative-models";
import { FABLE_FUSION_711_ID, hasFeatherless, type NarratorCompletion } from "@/server/ai";
import { streamCharacterChat } from "@/server/engine";

/**
 * Opt-in live probe of one exact Featherless narrator — the evidence behind a
 * Featherless row's request policy.
 * Not part of any suite and never run by CI: it makes real, billed calls.
 * Without `FEATHERLESS_API_TOKEN` it prints why it skipped and exits 0, so a clean
 * checkout can run it harmlessly.
 *
 *   pnpm probe:featherless-narrator
 *   PROBE_MODEL=Naphula/Slimaki-Tavern-24B-v1.3 pnpm probe:featherless-narrator
 *
 * `PROBE_MODEL` names the curated row to measure and defaults to Fable Fusion 711, the
 * first row probed this way. It exists because the questions this answers — does the
 * model spend the reply thinking, does it hold the first-token budget, does it ever
 * return nothing — have to be re-asked per model rather than inherited from a family,
 * and that rule is only cheap to follow if adding a row can reuse this harness.
 *
 * It records COUNTS AND FINISH STATE ONLY — attempt, finish reason, token counts,
 * raw/visible text lengths, TTFT, total latency. No prompt, no prose, no reasoning
 * content: the question this answers is "how did the generation end", and printing
 * the model's words would make a diagnostic tool a transcript.
 *
 * It runs through `streamCharacterChat`, the production narrator seam, rather than
 * calling the provider itself. That is deliberate — a probe with its own request
 * builder measures the probe. Everything the chat lane applies (the exact-model
 * sampler + thinking policy, the normalizers, the hidden retry) is therefore in
 * force, and the completion record printed below is the same one the pipeline
 * classifies a failed reply from.
 *
 * Two prompt sizes, because the failure being chased is budget-shaped. The tiny
 * synthetic prompt isolates the model's own behaviour; the padded one puts a
 * Vesper-sized prefill in front of it (the built narrator system prompt runs ~9K
 * tokens) so a slow first token shows up the way the chat lane would see it.
 *
 * Each call's outgoing wire body is captured through a `fetch` wrapper and printed as
 * its sampler/thinking fields, which is how this proves the exact-model policy
 * reaches the provider rather than merely being configured. Message content is never
 * read out of the captured body.
 */

/** Attempts per case — a zero-text completion is intermittent, so one call proves nothing. */
const ATTEMPTS = Number(process.env.PROBE_ATTEMPTS ?? 3);

/**
 * The curated narrator row under test. Any id is accepted rather than only Featherless
 * ones: the guard below is curation, not provider, so the same harness can measure an
 * OpenRouter row for comparison when a verdict needs a baseline.
 */
const MODEL_ID = process.env.PROBE_MODEL?.trim() || FABLE_FUSION_711_ID;

/** The sampler/thinking fields worth reporting off the wire — never message content. */
const WIRE_KEYS = [
  "temperature",
  "top_p",
  "top_k",
  "presence_penalty",
  "repetition_penalty",
  "min_tokens",
  "max_tokens",
] as const;

interface ProbeRow {
  label: string;
  call: number;
  completion: NarratorCompletion | null;
  ttftMs: number | null;
  totalMs: number;
  wire: string;
  error?: string;
}

function describeWireBody(raw: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return "unparsed";
  }
  if (typeof parsed !== "object" || parsed === null) return "unparsed";
  const body = parsed as Record<string, unknown>;
  const sampler = WIRE_KEYS.filter((key) => body[key] !== undefined).map((key) => `${key}=${String(body[key])}`);
  const kwargs = body.chat_template_kwargs;
  const thinking =
    typeof kwargs === "object" && kwargs !== null
      ? `chat_template_kwargs=${JSON.stringify(kwargs)}`
      : "chat_template_kwargs=absent";
  return [...sampler, thinking].join(" ");
}

/** Wrap global fetch so each call's outgoing body is captured (sampler fields only). */
function captureWire(): { last: () => string; restore: () => void } {
  const original = globalThis.fetch;
  let last = "unobserved";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof init?.body === "string") last = describeWireBody(init.body);
    return original(input, init);
  }) as typeof globalThis.fetch;
  return {
    last: () => last,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

async function runCall(args: {
  label: string;
  call: number;
  system: string;
  player: string;
  wire: () => string;
}): Promise<ProbeRow> {
  const started = Date.now();
  let ttftMs: number | null = null;
  let completion: NarratorCompletion | null = null;
  let error: string | undefined;
  try {
    const stream = streamCharacterChat({
      system: args.system,
      history: [{ role: "user", content: args.player }],
      name: "Mira",
      names: { speakers: ["Mira"], plain: ["Brian"] },
      model: MODEL_ID,
      onCompletion: (value) => {
        completion = value;
      },
    });
    for await (const delta of stream) {
      if (ttftMs === null && delta.length > 0) ttftMs = Date.now() - started;
    }
  } catch (caught) {
    error = caught instanceof Error ? caught.message.slice(0, 200) : String(caught).slice(0, 200);
  }
  return {
    label: args.label,
    call: args.call,
    completion,
    ttftMs,
    totalMs: Date.now() - started,
    wire: args.wire(),
    ...(error === undefined ? {} : { error }),
  };
}

const num = (value: number | undefined): string => (typeof value === "number" ? String(value) : "—");

async function main(): Promise<void> {
  if (!hasFeatherless()) {
    console.log("skipped: FEATHERLESS_API_TOKEN is not set (this probe makes real, billed calls).");
    return;
  }
  if (!NARRATIVE_MODELS.some((option) => option.id === MODEL_ID)) {
    console.log(`skipped: ${MODEL_ID} is not a curated narrator row.`);
    return;
  }
  console.log(`model: ${MODEL_ID}`);

  const tiny = "You narrate one short scene beat in third person, present tense. Open the line with [Mira].";
  // A Vesper-sized prefill, without shipping a real narrator prompt into this file:
  // filler setting text sized to the ~9K-token system prompt the chat lane carries.
  // The content is irrelevant; the token count is the point.
  const padded = `${tiny}\n\n${"The hallway is narrow, lit by one window at the far end, and the floorboards have been walked smooth down the middle. ".repeat(
    340,
  )}`;

  const capture = captureWire();
  const rows: ProbeRow[] = [];
  try {
    for (let call = 1; call <= ATTEMPTS; call++) {
      rows.push(await runCall({ label: "tiny", call, system: tiny, player: "She opens the door.", wire: capture.last }));
    }
    for (let call = 1; call <= ATTEMPTS; call++) {
      rows.push(
        await runCall({ label: "vesper-sized", call, system: padded, player: "She opens the door.", wire: capture.last }),
      );
    }
    // A one-word invitation: the shape most likely to produce a genuinely short or
    // empty completion, which is what the hidden retry exists for.
    for (let call = 1; call <= ATTEMPTS; call++) {
      rows.push(await runCall({ label: "terse-invite", call, system: tiny, player: "...", wire: capture.last }));
    }
  } finally {
    capture.restore();
  }

  const header = [
    "case",
    "call",
    "attempts",
    "finish",
    "rawFinish",
    "in",
    "out",
    "text",
    "reasoning",
    "rawChars",
    "visChars",
    "ttftMs",
    "totalMs",
    "providerError",
  ];
  console.log(header.join("\t"));
  for (const row of rows) {
    const c = row.completion;
    console.log(
      [
        row.label,
        row.call,
        c?.attempts ?? "—",
        c?.finishReason ?? "—",
        c?.rawFinishReason ?? "—",
        num(c?.inputTokens),
        num(c?.outputTokens),
        num(c?.textTokens),
        num(c?.reasoningTokens),
        c?.rawTextLength ?? "—",
        c?.visibleTextLength ?? "—",
        row.ttftMs ?? "—",
        row.totalMs,
        c?.providerError ? `${c.providerError.code}: ${c.providerError.detail.slice(0, 90)}` : "—",
      ].join("\t") + (row.error ? `\tTHREW ${row.error}` : ""),
    );
  }
  const empties = rows.filter((row) => (row.completion?.visibleTextChars ?? 0) === 0 && !row.error);
  console.log(`\n${rows.length} calls, ${empties.length} with no visible text, ${rows.filter((r) => r.error).length} errored.`);
  console.log("wire body per case (sampler + thinking fields only):");
  for (const label of [...new Set(rows.map((row) => row.label))]) {
    console.log(`  ${label}: ${rows.find((row) => row.label === label)?.wire}`);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
