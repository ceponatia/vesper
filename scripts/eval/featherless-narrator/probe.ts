import "dotenv/config";
import { NARRATIVE_MODELS } from "@/lib/narrative-models";
import { FABLE_FUSION_711_ID, hasFeatherless, type NarratorCompletion } from "@/server/ai";
import { CHARACTER_CHAT_HISTORY_TURNS, streamCharacterChat, type ChatTurn } from "@/server/engine";

/**
 * Opt-in live probe of one exact Featherless narrator — the evidence behind a
 * Featherless row's request policy.
 * Not part of any suite and never run by CI: it makes real, billed calls.
 * Without `FEATHERLESS_API_TOKEN` it prints why it skipped and exits 0, so a clean
 * checkout can run it harmlessly.
 *
 *   pnpm probe:featherless-narrator
 *   PROBE_MODEL=Naphula/Slimaki-Tavern-24B-v1.3 pnpm probe:featherless-narrator
 *   PROBE_LONG_HISTORY=1 pnpm probe:featherless-narrator   # adds the two 32K-edge calls
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
 * Three SHAPE counts ride alongside the finish state — whether the reply opened with its
 * line-start `[Name]` speaker tag, how many bracketed spans landed where a tag cannot go,
 * and how many `*…*` asterisk-action spans it used. They are computed in memory from the
 * accumulated stream and never printed as text. They exist because a row that will not hold
 * the tag grammar, or that insists on asterisk actions, is dropped rather than having this
 * repo's output grammar widened to suit it (#215).
 *
 * `PROBE_LONG_HISTORY=1` adds the 32K edge: a full verbatim window
 * (`CHARACTER_CHAT_HISTORY_TURNS × 2` padded turns) sized once just under the model's
 * context window and once just over it. It is opt-in because those two calls carry ~32K
 * input tokens each and are by far the most expensive thing here. The fixture is sized from
 * the token rate DIVIDED OUT of the two cases above rather than from a guess, and each row
 * reports the size it was built to send next to the size the host says it received —
 * because the failure being looked for is the host quietly dropping the top of the
 * conversation and answering anyway.
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

/** Longest bracketed span the segmenter will read as a speaker tag (its TAG_RE bound). */
const MAX_TAG_INNER = 64;
/** A complete bracketed span on one line — the segmenter's tag shape, minus nesting. */
const BRACKET_SPAN = new RegExp(`\\[[^\\[\\]\\n]{1,${MAX_TAG_INNER}}\\]`, "g");
/** The same shape anchored at a line start — the one position a tag is legitimate. */
const LEADING_TAG = new RegExp(`^\\[([^\\[\\]\\n]{1,${MAX_TAG_INNER}})\\]`);
/** An asterisk action span (`*she smiles*`) — the output grammar this repo does not use. */
const ASTERISK_SPAN = /\*[^*\n]+\*/g;

/**
 * The reply's SHAPE as three counts, computed in memory from the accumulated stream and
 * never printed: whether it opens with the expected line-start speaker tag, how many
 * bracketed spans sit where a tag cannot go, and how many asterisk-action spans it used.
 *
 * These are measured on the text the PLAYER sees, because that is what the generator
 * yields. `stripMisplacedSpeakerTagStream` has already de-bracketed known names outside a
 * line start by then, so a zero `tagStray` means "nothing leaked to the player", not
 * "the model emitted none" — the `rawChars` vs `visChars` columns are where a normalizer
 * having acted shows up. Asterisk spans pass through untouched by every normalizer, so
 * that count is faithful to what the model wrote.
 */
interface ReplyShape {
  /** The reply's first non-empty line opens with `[<speaker>]`. */
  tagOpen: boolean;
  /** Bracketed spans anywhere other than a line start. */
  tagStray: number;
  /** `*…*` asterisk-action spans. */
  asterisk: number;
}

function replyShape(text: string, speaker: string): ReplyShape {
  const lines = text.split("\n");
  const first = lines.find((line) => line.trim().length > 0) ?? "";
  const leading = LEADING_TAG.exec(first.trimStart());
  const lineStartTags = lines.filter((line) => LEADING_TAG.test(line.trimStart())).length;
  const allTags = (text.match(BRACKET_SPAN) ?? []).length;
  return {
    tagOpen: leading !== null && leading[1]?.trim().toLowerCase() === speaker.trim().toLowerCase(),
    tagStray: Math.max(0, allTags - lineStartTags),
    asterisk: (text.match(ASTERISK_SPAN) ?? []).length,
  };
}

interface ProbeRow {
  label: string;
  call: number;
  completion: NarratorCompletion | null;
  ttftMs: number | null;
  totalMs: number;
  wire: string;
  shape: ReplyShape;
  /** Input tokens this fixture was BUILT to send, when it was sized to a target. */
  estimatedInputTokens?: number;
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
  history: ChatTurn[];
  wire: () => string;
  estimatedInputTokens?: number;
}): Promise<ProbeRow> {
  const started = Date.now();
  let ttftMs: number | null = null;
  let completion: NarratorCompletion | null = null;
  let error: string | undefined;
  // The accumulated reply, held only to count its shape below. It is never printed and
  // never leaves this function.
  let full = "";
  try {
    const stream = streamCharacterChat({
      system: args.system,
      history: args.history,
      name: "Mira",
      names: { speakers: ["Mira"], plain: ["Brian"] },
      model: MODEL_ID,
      onCompletion: (value) => {
        completion = value;
      },
    });
    for await (const delta of stream) {
      if (ttftMs === null && delta.length > 0) ttftMs = Date.now() - started;
      full += delta;
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
    shape: replyShape(full, "Mira"),
    ...(args.estimatedInputTokens === undefined ? {} : { estimatedInputTokens: args.estimatedInputTokens }),
    ...(error === undefined ? {} : { error }),
  };
}

const num = (value: number | undefined): string => (typeof value === "number" ? String(value) : "—");

/**
 * The neutral filler sentence every oversized fixture is built from. Its content is
 * irrelevant and deliberately so — the token count is the whole point — but it is ordinary
 * prose rather than repeated punctuation, so it tokenizes at a realistic rate.
 */
const FILLER =
  "The hallway is narrow, lit by one window at the far end, and the floorboards have been walked smooth down the middle. ";
/** Copies of {@link FILLER} in the Vesper-sized prefill — also the divisor that calibrates its token rate. */
const FILLER_REPEATS = 340;

/**
 * Input-token targets for the 32K edge. The model's window is 32,768, so one fixture lands
 * comfortably inside it and one comfortably outside, close enough on both sides that the
 * answer is about the boundary rather than about an absurd request.
 */
const UNDER_TARGET_TOKENS = 31_500;
const OVER_TARGET_TOKENS = 33_500;

/**
 * Assumed per-message chat-template overhead. An ESTIMATE, and the only guessed number in
 * the sizing: it shifts the fixture by at most a few hundred tokens across 80 messages,
 * which is why the rows report the estimate and the host's own count side by side instead
 * of trusting either alone.
 */
const MESSAGE_OVERHEAD_TOKENS = 8;

/** The chat lane's verbatim ceiling — `windowChatHistory` keeps exactly this many messages. */
const LONG_HISTORY_TURNS = CHARACTER_CHAT_HISTORY_TURNS * 2;

function medianInputTokens(rows: ProbeRow[], label: string): number | null {
  const values = rows
    .filter((row) => row.label === label)
    .map((row) => row.completion?.inputTokens)
    .filter((value): value is number => typeof value === "number")
    .sort((a, b) => a - b);
  return values.length === 0 ? null : (values[Math.floor(values.length / 2)] ?? null);
}

/**
 * Tokens per filler sentence for THIS model's tokenizer, divided out of two measurements
 * this probe already made: the padded system prompt is the tiny one plus FILLER_REPEATS
 * copies of one sentence, so the difference in reported input tokens is that sentence's
 * rate. Null when either case did not report a count — sizing a 32K fixture off a guessed
 * rate would measure the guess.
 */
function fillerTokenRate(rows: ProbeRow[]): number | null {
  const tiny = medianInputTokens(rows, "tiny");
  const padded = medianInputTokens(rows, "vesper-sized");
  if (tiny === null || padded === null || padded <= tiny) return null;
  return (padded - tiny) / FILLER_REPEATS;
}

/** Filler sentences per history turn that put the whole request near `target` input tokens. */
function fillerPerTurn(rows: ProbeRow[], perFiller: number, target: number): number {
  const base = medianInputTokens(rows, "tiny") ?? 0;
  const perTurn = (target - base) / LONG_HISTORY_TURNS - MESSAGE_OVERHEAD_TOKENS;
  return Math.max(1, Math.round(perTurn / perFiller));
}

/** What that fixture is expected to weigh — the number the host's own count is checked against. */
function estimateInput(rows: ProbeRow[], perFiller: number, turns: number): number {
  const base = medianInputTokens(rows, "tiny") ?? 0;
  return Math.round(base + LONG_HISTORY_TURNS * (MESSAGE_OVERHEAD_TOKENS + turns * perFiller));
}

/**
 * A full verbatim window of padded history: `CHARACTER_CHAT_HISTORY_TURNS × 2` alternating
 * turns, which is exactly what `windowChatHistory` keeps, so nothing is trimmed before the
 * request is built and the fixture's size is the request's size.
 */
function longHistory(fillerCount: number): ChatTurn[] {
  const turns: ChatTurn[] = [];
  for (let i = 0; i < LONG_HISTORY_TURNS; i++) {
    // Anchored so the LAST message is the player's: a history ending on an assistant turn
    // asks the model to continue itself rather than to reply, which is a different test.
    const role = (LONG_HISTORY_TURNS - 1 - i) % 2 === 0 ? "user" : "assistant";
    turns.push({ role, content: `Beat ${i + 1}. ${FILLER.repeat(fillerCount)}`.trimEnd() });
  }
  return turns;
}

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
  const padded = `${tiny}\n\n${FILLER.repeat(FILLER_REPEATS)}`;
  const opener: ChatTurn[] = [{ role: "user", content: "She opens the door." }];

  const capture = captureWire();
  const rows: ProbeRow[] = [];
  try {
    for (let call = 1; call <= ATTEMPTS; call++) {
      rows.push(await runCall({ label: "tiny", call, system: tiny, history: opener, wire: capture.last }));
    }
    for (let call = 1; call <= ATTEMPTS; call++) {
      rows.push(await runCall({ label: "vesper-sized", call, system: padded, history: opener, wire: capture.last }));
    }
    // A one-word invitation: the shape most likely to produce a genuinely short or
    // empty completion, which is what the hidden retry exists for.
    for (let call = 1; call <= ATTEMPTS; call++) {
      rows.push(
        await runCall({ label: "terse-invite", call, system: tiny, history: [{ role: "user", content: "..." }], wire: capture.last }),
      );
    }

    // ---- The 32K edge -------------------------------------------------------------
    // Off by default: two calls that each carry ~32K input tokens are the most expensive
    // thing in this file, and the answer only changes when the model or its host does.
    if (process.env.PROBE_LONG_HISTORY === "1") {
      // Tokens per filler sentence, derived from the two cases already measured rather
      // than guessed: the padded system prompt is the tiny one plus FILLER_REPEATS copies
      // of the same sentence, so the difference in reported input tokens divides out to
      // this model's own tokenizer rate. That is what lets the fixture below be sized to
      // a token target without a tokenizer in this repo.
      const perFiller = fillerTokenRate(rows);
      if (perFiller === null) {
        rows.push(await runCall({ label: "long-history", call: 0, system: tiny, history: opener, wire: capture.last }));
        console.log("long-history: skipped — the tiny and vesper-sized cases did not both report input tokens to calibrate from.");
      } else {
        const underTurns = fillerPerTurn(rows, perFiller, UNDER_TARGET_TOKENS);
        const under = await runCall({
          label: "long-history-under",
          call: 1,
          system: tiny,
          history: longHistory(underTurns),
          wire: capture.last,
          estimatedInputTokens: estimateInput(rows, perFiller, underTurns),
        });
        rows.push(under);
        // The over-limit fixture is scaled from what the host ACTUALLY reported for the
        // under-limit one, so the second call inherits a measurement instead of stacking a
        // second estimate on the first.
        const measured = under.completion?.inputTokens ?? null;
        const overTurns =
          measured !== null && measured > 0
            ? Math.max(underTurns + 1, Math.ceil((underTurns * OVER_TARGET_TOKENS) / measured))
            : Math.ceil((underTurns * OVER_TARGET_TOKENS) / UNDER_TARGET_TOKENS);
        rows.push(
          await runCall({
            label: "long-history-over",
            call: 1,
            system: tiny,
            history: longHistory(overTurns),
            wire: capture.last,
            estimatedInputTokens: estimateInput(rows, perFiller, overTurns),
          }),
        );
      }
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
    "estIn",
    "out",
    "text",
    "reasoning",
    "rawChars",
    "visChars",
    "tagOpen",
    "tagStray",
    "aster",
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
        num(row.estimatedInputTokens),
        num(c?.outputTokens),
        num(c?.textTokens),
        num(c?.reasoningTokens),
        c?.rawTextLength ?? "—",
        c?.visibleTextLength ?? "—",
        row.shape.tagOpen ? 1 : 0,
        row.shape.tagStray,
        row.shape.asterisk,
        row.ttftMs ?? "—",
        row.totalMs,
        c?.providerError ? `${c.providerError.code}: ${c.providerError.detail.slice(0, 90)}` : "—",
      ].join("\t") + (row.error ? `\tTHREW ${row.error}` : ""),
    );
  }
  const empties = rows.filter((row) => (row.completion?.visibleTextChars ?? 0) === 0 && !row.error);
  console.log(`\n${rows.length} calls, ${empties.length} with no visible text, ${rows.filter((r) => r.error).length} errored.`);
  // The 32K edge is a verdict, not a row: a request over the window either completes or
  // errors with the host's own words, and a 200 whose reported input is materially smaller
  // than what was sent is SILENT TRUNCATION — the outcome this model may not have, because
  // a narrator that quietly forgets the top of the conversation is worse than one that
  // refuses it.
  //
  // Two DIFFERENT rejections live at this edge on Featherless, and reading them as one
  // failure is how the usable window gets overstated. A prompt larger than the window is
  // refused outright ("your prompt has N tokens"). But a prompt that FITS is also refused
  // when no `max_tokens` is sent, because the host reserves a 4096-token default output
  // inside the same window — measured 2026-09-04, where a 31,594-token prompt was refused
  // bare and answered fine at `max_tokens: 256`. So a caller that sends no output cap gets
  // roughly window-minus-4096 of usable prompt, not the whole window.
  const longRows = rows.filter((row) => row.label.startsWith("long-history"));
  if (longRows.length > 0) {
    console.log("\n32K edge:");
    for (const row of longRows) {
      const c = row.completion;
      const reported = c?.inputTokens ?? null;
      const estimated = row.estimatedInputTokens ?? null;
      const truncated = reported !== null && estimated !== null && reported < estimated * 0.95;
      const verdict = row.error
        ? `THREW ${row.error}`
        : c?.providerError
          ? `errored — ${c.providerError.code}: ${c.providerError.detail.slice(0, 160)}`
          : c === null
            ? "no completion record"
            : truncated
              ? `SILENTLY TRUNCATED — built ~${String(estimated)} input tokens, host reported ${String(reported)}`
              : `completed — finish ${c.finishReason}/${c.rawFinishReason ?? "—"}, ${String(reported ?? "—")} in / ${String(c.outputTokens ?? "—")} out`;
      console.log(`  ${row.label} (built ~${String(estimated ?? "—")} input tokens): ${verdict}`);
    }
  }
  console.log("wire body per case (sampler + thinking fields only):");
  for (const label of [...new Set(rows.map((row) => row.label))]) {
    console.log(`  ${label}: ${rows.find((row) => row.label === label)?.wire}`);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
