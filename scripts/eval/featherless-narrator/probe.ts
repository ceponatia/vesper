import "dotenv/config";
import { execFileSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { NARRATIVE_MODELS } from "@/lib/narrative-models";
import { FABLE_FUSION_711_ID, hasFeatherless, isNarratorLengthStub, type NarratorCompletion } from "@/server/ai";
import {
  CHARACTER_CHAT_HISTORY_TURNS,
  NARRATIVE_TEMPERATURE,
  streamCharacterChat,
  type ChatTurn,
} from "@/server/engine";
import {
  buildProbeSummary,
  createSseAccumulator,
  DIRECT_ARMS,
  isDirectArm,
  isProbeArm,
  PROBE_ARMS,
  rawLengthStub,
  sanitizeHeaders,
  summarizeJsonCompletion,
  summarizeSseEvents,
  transformArmBody,
  type ProbeArm,
  type ProbeCallRecord,
  type ProbeCase,
  type ProbeRecordKind,
  type SanitizedHeaders,
  type SseEventMeta,
} from "./probe-stats";

/**
 * Opt-in live probe of one exact Featherless narrator — the diagnostic instrument
 * behind #594's Asmodeus re-measure.
 * Not part of any suite and never run by CI: it makes real, billed calls.
 * Without `FEATHERLESS_API_TOKEN` it prints why it skipped and exits 0, so a clean
 * checkout can run it harmlessly.
 *
 *   pnpm probe:featherless-narrator
 *   PROBE_MODEL=DarkArtsForge/Asmodeus-24B-v3 PROBE_ARMS=profile,lane,lane-capped,direct-stream,direct-json \
 *     PROBE_CASES=vesper-sized pnpm probe:featherless-narrator
 *
 * ## What changed for #594 scope 2
 *
 * The pre-#594 probe sent exactly one shape of request (the production body,
 * unmodified) and reported only what `streamCharacterChat` handed back. That
 * cannot tell an owner WHERE a one-token `length` stub actually originates —
 * the model, the sampler profile, the output cap, or a layer between the host's
 * raw wire and the AI SDK's normalized completion. This probe now runs up to
 * six ARMS (see `./probe-stats.ts`'s `PROBE_ARMS`) interleaved in ROUNDS, and
 * wraps every Featherless response — production and direct alike — in a
 * pass-through tap that records RAW wire timing and content separately from
 * the VISIBLE, SDK-normalized numbers `streamCharacterChat` already reported.
 *
 * `PROBE_ARMS` defaults to `profile` alone, so a caller who sets nothing gets
 * exactly the old run's shape (three cases × `PROBE_ATTEMPTS` calls each).
 *
 * ## How an arm reaches the wire
 *
 * `profile` / `profile-uncapped` / `lane` / `lane-capped` are PRODUCTION arms:
 * every one of them still calls `streamCharacterChat`, so the exact-model
 * adapter, the lane defaults, the output normalizers and the hidden retry are
 * ALL still in force — only the fetch wrapper's arm transform (`transformArmBody`
 * in `./probe-stats.ts`) rewrites that call's own outgoing JSON body just before
 * it leaves the process. No override seam was added to application code.
 *
 * `direct-stream` / `direct-json` are DIRECT arms: they never call
 * `streamCharacterChat` at all. They replay a `profile`-shaped body — captured
 * from whichever production arm ran first for that case — straight against
 * `POST /v1/chat/completions`, with no SDK in the loop, so a difference between
 * a direct arm and `profile` isolates the AI SDK's own normalization layer.
 *
 * ## Raw vs visible, and the two stub verdicts
 *
 * Every request's response body is wrapped in a pass-through tap (`instrumentResponse`
 * for production arms via the fetch wrapper, `readTap` inline for direct arms) that
 * forwards bytes UNCHANGED to whichever consumer needs them, while a decoded copy
 * measures: time to first body byte, time to the first SSE event carrying non-empty
 * content, a content-event count and character count (counts only), the raw
 * `finish_reason` from the last event that carried one, and raw `usage` tokens. Every
 * production row therefore carries TWO independent stub verdicts —
 * `isNarratorLengthStub` on the SDK-normalized completion, and `rawLengthStub`
 * (`./probe-stats.ts`, a documented mirror) on the raw wire evidence — and any
 * disagreement between them is counted in the summary. That is what shows whether a
 * one-token stub is a host-level fact or something the SDK's own normalization
 * introduces.
 *
 * A hidden retry can make several underlying HTTP requests for one production call;
 * `requestStartOffsetMs` records the LAST request's start as an offset from the
 * call's own start, because `raw.*` timings are anchored to that last request while
 * `visible.ttftMs`/`totalMs` are anchored to the call itself — the two clocks only
 * read the same event when the offset is 0 (no retry happened).
 *
 * ## Safe metadata only
 *
 * Every response's status, every header NAME, and header VALUES for a small
 * allowlist (request/trace/correlation ids, `cf-ray`, server, worker, region, node,
 * backend, model, version, served-by — never `set-cookie`/`authorization`/`server-timing`/
 * anything key-shaped, and never longer than 120 characters, DROPPED rather than
 * truncated past that) are recorded, plus `id`/`model`/`system_fingerprint`/`created`
 * from the first SSE event or JSON body. No prompt, prose, reasoning content or
 * Authorization header is ever printed or written.
 *
 * ## Budget, kinds and the JSONL output
 *
 * The planned call count is printed before the first call. `PROBE_MAX_CALLS`
 * (default 60) refuses to start a larger run without an explicit opt-in; so does an
 * unparseable `PROBE_MAX_CALLS`/`PROBE_ATTEMPTS`, or an unrecognised `PROBE_ARMS`/
 * `PROBE_CASES` entry — none of these ever falls back silently.
 *
 * `PROBE_OUT=<path>` writes a `type:"run"` header line, one JSONL row per call typed
 * by `kind` (`call` | `bootstrap-call` | `long-history` | `warmup`), and a final
 * `type:"summary"` object. Only `kind:"call"` rows — the interleaved grid — feed the
 * summary's per-arm/case cells; every kind still counts toward the token totals,
 * because a bootstrap, long-history or warm-up call is still money spent.
 *
 * `PROBE_LONG_HISTORY=1` still adds the two ~32K-input-token edge calls, through the
 * `profile` arm only. `PROBE_WARMUP=1` adds one `profile` call before round 1 (kind
 * `warmup`) so the first grid call does not absorb a cold start.
 */

// ---------------------------------------------------------------------------
// Config parsing — every bad value refuses to start rather than falling back
// ---------------------------------------------------------------------------

/**
 * The curated narrator row under test. Any id is accepted rather than only
 * Featherless ones: the guard below is curation, not provider, so the same harness
 * can measure an OpenRouter row for comparison when a verdict needs a baseline.
 */
const MODEL_ID = process.env.PROBE_MODEL?.trim() || FABLE_FUSION_711_ID;

/** Direct arms get a generous timeout rather than stalling the run; a trip is recorded as an error row. */
const DIRECT_ARM_TIMEOUT_MS = 120_000;

const DIRECT_ARM_USER_AGENT = "vesper-featherless-narrator-probe/2 (+github.com/ceponatia/vesper issue 594)";

const FEATHERLESS_CHAT_COMPLETIONS_URL = "https://api.featherless.ai/v1/chat/completions";

const ALL_CASES: readonly ProbeCase[] = ["tiny", "vesper-sized", "terse-invite"];

/** The four arms that still run through `streamCharacterChat` (see the module doc). */
const PRODUCTION_ARMS: ReadonlySet<ProbeArm> = new Set(["profile", "profile-uncapped", "lane", "lane-capped"]);

/** A config value plus a reason it could not be used — never a silent fallback. */
type ParseResult<T> = { ok: true; value: T } | { ok: false; message: string };

function parseArms(raw: string | undefined): ParseResult<ProbeArm[]> {
  if (raw === undefined || raw.trim().length === 0) return { ok: true, value: ["profile"] };
  const arms: ProbeArm[] = [];
  for (const entry of raw.split(",").map((value) => value.trim()).filter((value) => value.length > 0)) {
    if (!isProbeArm(entry)) {
      return {
        ok: false,
        message: `PROBE_ARMS has an unknown entry "${entry}" — known arms: ${PROBE_ARMS.join(", ")}`,
      };
    }
    if (!arms.includes(entry)) arms.push(entry);
  }
  return { ok: true, value: arms.length > 0 ? arms : ["profile"] };
}

function parseCases(raw: string | undefined): ParseResult<ProbeCase[]> {
  if (raw === undefined || raw.trim().length === 0) return { ok: true, value: [...ALL_CASES] };
  const cases: ProbeCase[] = [];
  for (const entry of raw.split(",").map((value) => value.trim()).filter((value) => value.length > 0)) {
    if (!(ALL_CASES as readonly string[]).includes(entry)) {
      return {
        ok: false,
        message: `PROBE_CASES has an unknown entry "${entry}" — known cases: ${ALL_CASES.join(", ")}`,
      };
    }
    const probeCase = entry as ProbeCase;
    if (!cases.includes(probeCase)) cases.push(probeCase);
  }
  return { ok: true, value: cases.length > 0 ? cases : [...ALL_CASES] };
}

/** A positive integer, or a refusal — never a silently-substituted default for a garbage value. */
function parsePositiveInt(raw: string | undefined, fallback: number, name: string): ParseResult<number> {
  if (raw === undefined || raw.trim().length === 0) return { ok: true, value: fallback };
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    return { ok: false, message: `${name}="${raw}" is not a positive integer` };
  }
  return { ok: true, value };
}

/** `arms` rotated left by `offset` positions (wraps around) — how the round-robin varies which arm goes first. */
function rotateLeft<T>(items: readonly T[], offset: number): T[] {
  if (items.length === 0) return [];
  const shift = ((offset % items.length) + items.length) % items.length;
  return [...items.slice(shift), ...items.slice(0, shift)];
}

/**
 * This round's arm order (#594 acceptance point 1: "the arm order rotates round to
 * round so no arm always goes first").
 *
 * Round 1 carries one bootstrap exception: every case's captured production body
 * (what the direct arms replay) is seeded by whichever production arm runs FIRST
 * for that case, so round 1 moves every production arm ahead of every direct arm —
 * whatever order the caller listed them in `PROBE_ARMS` — to guarantee that seed
 * exists before a direct arm can consume it. Rounds after the first already have a
 * capture and rotate freely.
 */
function armsForRound(arms: readonly ProbeArm[], round: number): ProbeArm[] {
  const rotated = rotateLeft(arms, round - 1);
  if (round !== 1) return rotated;
  const production = rotated.filter((arm) => PRODUCTION_ARMS.has(arm));
  const direct = rotated.filter((arm) => DIRECT_ARMS.has(arm));
  if (production.length === 0 || direct.length === 0) return rotated;
  return [...production, ...direct];
}

// ---------------------------------------------------------------------------
// Case fixtures (unchanged from the pre-#594 probe)
// ---------------------------------------------------------------------------

const TINY_SYSTEM = "You narrate one short scene beat in third person, present tense. Open the line with [Mira].";

/**
 * The neutral filler sentence every oversized fixture is built from. Its content is
 * irrelevant and deliberately so — the token count is the whole point — but it is
 * ordinary prose rather than repeated punctuation, so it tokenizes at a realistic rate.
 */
const FILLER =
  "The hallway is narrow, lit by one window at the far end, and the floorboards have been walked smooth down the middle. ";
/** Copies of {@link FILLER} in the Vesper-sized prefill — also the divisor that calibrates its token rate. */
const FILLER_REPEATS = 340;

/** A Vesper-sized prefill, without shipping a real narrator prompt into this file. */
const PADDED_SYSTEM = `${TINY_SYSTEM}\n\n${FILLER.repeat(FILLER_REPEATS)}`;

const OPENER: ChatTurn[] = [{ role: "user", content: "She opens the door." }];
/** A one-word invitation: the shape most likely to produce a genuinely short or empty completion. */
const TERSE_INVITE: ChatTurn[] = [{ role: "user", content: "..." }];

const CASE_DEFS: Record<ProbeCase, { system: string; history: ChatTurn[] }> = {
  tiny: { system: TINY_SYSTEM, history: OPENER },
  "vesper-sized": { system: PADDED_SYSTEM, history: OPENER },
  "terse-invite": { system: TINY_SYSTEM, history: TERSE_INVITE },
};

// ---------------------------------------------------------------------------
// Reply shape (unchanged from the pre-#594 probe — production rows only)
// ---------------------------------------------------------------------------

/** Longest bracketed span the segmenter will read as a speaker tag (its TAG_RE bound). */
const MAX_TAG_INNER = 64;
const BRACKET_SPAN = new RegExp(`\\[[^\\[\\]\\n]{1,${MAX_TAG_INNER}}\\]`, "g");
const LEADING_TAG = new RegExp(`^\\[([^\\[\\]\\n]{1,${MAX_TAG_INNER}})\\]`);
const ASTERISK_SPAN = /\*[^*\n]+\*/g;

interface ReplyShape {
  tagOpen: boolean;
  tagStray: number;
  asterisk: number;
}

/**
 * The reply's SHAPE as three counts, computed in memory from the accumulated stream
 * and never printed as text (see the module doc on the original probe for the full
 * rationale; unchanged by #594).
 */
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

// ---------------------------------------------------------------------------
// Wire body description (unchanged from the pre-#594 probe — human-readable dump only)
// ---------------------------------------------------------------------------

/** Body fields that carry PROMPT OR TOOL CONTENT, and are never reported. */
const WIRE_CONTENT_KEYS: ReadonlySet<string> = new Set([
  "messages",
  "prompt",
  "input",
  "tools",
  "tool_choice",
  "response_format",
  "model",
  "stream",
  "stream_options",
]);

/** Longest rendered value a field may report; anything larger is elided rather than printed. */
const MAX_WIRE_VALUE = 160;

/**
 * Fields reported even when absent, because their ABSENCE is the measurement.
 * `chat_template_kwargs` is rejected outright on a Mistral tokenizer and is the only
 * thing standing between two DavidAU rows and an empty reply, so "it was not sent"
 * has to be visible rather than inferred from a missing column.
 */
const WIRE_PRESENCE_KEYS = ["chat_template_kwargs"] as const;

function renderWireValue(value: unknown): string {
  const rendered = typeof value === "string" ? value : JSON.stringify(value);
  return rendered.length > MAX_WIRE_VALUE ? `<${rendered.length} chars elided>` : rendered;
}

/** A short, human-readable dump of a wire body's sampler/profile fields — never its content. */
function describeWireBody(body: Record<string, unknown>): string {
  const reported = Object.entries(body)
    .filter(([key, value]) => !WIRE_CONTENT_KEYS.has(key) && value !== undefined)
    .map(([key, value]) => `${key}=${renderWireValue(value)}`);
  const absent = WIRE_PRESENCE_KEYS.filter((key) => body[key] === undefined).map((key) => `${key}=absent`);
  const all = [...reported, ...absent];
  return all.length > 0 ? all.join(" ") : "(no sampler/profile fields)";
}

/** The `max_tokens` a request body actually carries, or undefined for none sent. */
function extractMaxTokens(body: Record<string, unknown> | null): number | undefined {
  const value = body?.max_tokens;
  return typeof value === "number" ? value : undefined;
}

// ---------------------------------------------------------------------------
// Raw-wire instrumentation
// ---------------------------------------------------------------------------

interface RawRequestSnapshot {
  status: number;
  headers: SanitizedHeaders;
  meta: SseEventMeta;
  firstByteMs: number | null;
  firstContentMs: number | null;
  finishReason: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  contentChars: number;
  contentEventCount: number;
}

/** `readTap`'s resolved shape — named so a caller building a same-shaped fallback (no body to read) can type it explicitly. */
type DirectStreamTap = Omit<RawRequestSnapshot, "status" | "headers"> & { readError?: string };

/**
 * Read a Featherless response body to completion, decoding it as SSE, WITHOUT
 * assuming any other consumer needs the same bytes — the direct-stream arm's own
 * reader, since there is no SDK downstream of it. Production arms use
 * {@link instrumentResponse} instead, which tees the stream so this same logic can
 * run alongside the real consumer.
 *
 * `readError` is the one field the two callers read differently: a production
 * call's tee is diagnostic-only (its `whenDone` promise is never awaited for
 * correctness, only for evidence — the SDK already owns and reports that failure on
 * its own branch), so `instrumentResponse` simply never looks at this field. A
 * direct call has NO other consumer of the bytes, so the SAME failure here IS the
 * call's failure, and `runDirectCall` turns it into an errored row instead of a
 * clean empty one (#594 correction round P1).
 */
async function readTap(body: ReadableStream<Uint8Array>, startedAt: number): Promise<DirectStreamTap> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const acc = createSseAccumulator();
  let firstByteMs: number | null = null;
  let firstContentMs: number | null = null;
  let readError: string | undefined;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (firstByteMs === null) firstByteMs = Date.now() - startedAt;
      const events = acc.push(decoder.decode(value, { stream: true }));
      if (firstContentMs === null) {
        const hit = events.find((event) => event.hasContent);
        if (hit !== undefined) firstContentMs = Date.now() - startedAt;
      }
    }
    acc.flush();
  } catch (caught) {
    readError = caught instanceof Error ? caught.message.slice(0, 200) : String(caught).slice(0, 200);
  }
  const summary = summarizeSseEvents(acc.all());
  return {
    meta: summary.meta,
    firstByteMs,
    firstContentMs,
    finishReason: summary.finishReason,
    promptTokens: summary.usage?.promptTokens ?? null,
    completionTokens: summary.usage?.completionTokens ?? null,
    contentChars: summary.totalContentChars,
    contentEventCount: summary.contentEventCount,
    ...(readError === undefined ? {} : { readError }),
  };
}

/**
 * Wrap a production response so the real consumer (the AI SDK, inside
 * `streamCharacterChat`) reads the SAME bytes unchanged, while a decoded copy on a
 * second branch (`ReadableStream.tee()`) measures the raw-wire evidence (#594
 * acceptance point 2). The tee's own read failures never reach the pass-through
 * branch, and `readTap`'s `readError` is intentionally discarded here — see its doc.
 */
function instrumentResponse(response: Response, startedAt: number): { passThrough: Response; whenDone: Promise<RawRequestSnapshot> } {
  const status = response.status;
  const headers = sanitizeHeaders(response.headers.entries());
  if (!response.body) {
    return {
      passThrough: response,
      whenDone: Promise.resolve({
        status,
        headers,
        meta: {},
        firstByteMs: null,
        firstContentMs: null,
        finishReason: null,
        promptTokens: null,
        completionTokens: null,
        contentChars: 0,
        contentEventCount: 0,
      }),
    };
  }
  const [passThroughBody, tapBody] = response.body.tee();
  const passThrough = new Response(passThroughBody, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  // `tap.readError`, when present, is deliberately never read here — see `readTap`'s
  // doc. Spreading it into the result is harmless: `RawRequestSnapshot` simply has
  // no such field, and nothing downstream of this promise looks for one.
  const whenDone = readTap(tapBody, startedAt).then((tap) => ({ status, headers, ...tap }));
  return { passThrough, whenDone };
}

/** One production call's in-flight state, read by the installed `fetch` wrapper while it runs. */
interface RawSink {
  arm: ProbeArm;
  probeCase: ProbeCase;
  /** The body `streamCharacterChat` actually built, BEFORE this arm's transform — captured for direct-arm replay. */
  builtBody: Record<string, unknown> | null;
  /** One promise per underlying HTTP request this call made (a hidden retry makes more than one). */
  requests: Promise<RawRequestSnapshot>[];
  /** This call's own start (`Date.now()`), so the wrapper can offset each request's start against it. */
  callStartedAt: number;
  /** The LAST request's start, as an offset from `callStartedAt` — see the module doc on `requestStartOffsetMs`. */
  lastRequestStartOffsetMs: number | null;
}

let activeSink: RawSink | null = null;
/** The pristine `fetch`, captured before the wrapper is installed — direct arms always call this, never the wrapped one. */
let trueFetch: typeof fetch = globalThis.fetch;
/** The last wire body actually sent for each `arm`/`case` pair, for the end-of-run human-readable dump. */
const lastWireBodyByArmCase = new Map<string, string>();

/**
 * Install the one `fetch` wrapper that applies each production arm's transform
 * (#594 acceptance point 1) to that call's own outgoing Featherless request, and
 * instruments its response. Every other request (a non-Featherless call, or any
 * call made while no probe call is in flight) passes through `trueFetch` untouched.
 */
function installFetchWrapper(): () => void {
  const original = globalThis.fetch;
  trueFetch = original;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const requestBody = init?.body;
    if (activeSink === null || url !== FEATHERLESS_CHAT_COMPLETIONS_URL || typeof requestBody !== "string") {
      return original(input, init);
    }
    const sink = activeSink;
    let outgoing = requestBody;
    try {
      const parsed = JSON.parse(requestBody) as Record<string, unknown>;
      sink.builtBody = parsed;
      const transformed = transformArmBody(sink.arm, parsed, NARRATIVE_TEMPERATURE);
      outgoing = JSON.stringify(transformed);
      lastWireBodyByArmCase.set(`${sink.arm}\u0000${sink.probeCase}`, describeWireBody(transformed));
    } catch {
      // An unparseable body is passed through untouched; the arm's own bytes are
      // simply whatever the SDK sent, unrewritten.
    }
    const startedAt = Date.now();
    sink.lastRequestStartOffsetMs = startedAt - sink.callStartedAt;
    const response = await original(input, { ...init, body: outgoing });
    const { passThrough, whenDone } = instrumentResponse(response, startedAt);
    sink.requests.push(whenDone);
    return passThrough;
  }) as typeof globalThis.fetch;
  return () => {
    globalThis.fetch = original;
  };
}

// ---------------------------------------------------------------------------
// One production call (profile / profile-uncapped / lane / lane-capped)
// ---------------------------------------------------------------------------

interface ExtendedRow extends ProbeCallRecord {
  /** The actual sampler/profile fields this row's request carried — never its content. */
  wire: string;
  /** Reply shape counts, production rows only (a direct arm has no SDK normalizer to measure). */
  shape: ReplyShape | null;
}

async function runProductionCall(args: {
  arm: ProbeArm;
  probeCase: ProbeCase;
  kind: ProbeRecordKind;
  round: number;
  position: number;
  positionInRound: number;
  system: string;
  history: ChatTurn[];
}): Promise<{ row: ExtendedRow; builtBody: Record<string, unknown> | null }> {
  const startedAt = Date.now();
  const startedAtIso = new Date(startedAt).toISOString();
  const sink: RawSink = {
    arm: args.arm,
    probeCase: args.probeCase,
    builtBody: null,
    requests: [],
    callStartedAt: startedAt,
    lastRequestStartOffsetMs: null,
  };
  activeSink = sink;
  let ttftMs: number | null = null;
  // A box rather than a bare `let`: `completion` is written only from inside
  // `onCompletion`'s closure, and reading a plain closure-only-assigned `let`
  // after the call it was passed to has returned is exactly the pattern that
  // trips some TypeScript versions into narrowing it away entirely (#594
  // correction round type error). A property read is not narrowed that way.
  const completionBox: { value: NarratorCompletion | null } = { value: null };
  let errorMessage: string | undefined;
  let full = "";
  try {
    const stream = streamCharacterChat({
      system: args.system,
      history: args.history,
      name: "Mira",
      names: { speakers: ["Mira"], plain: ["Brian"] },
      model: MODEL_ID,
      onCompletion: (value) => {
        completionBox.value = value;
      },
    });
    for await (const delta of stream) {
      if (ttftMs === null && delta.length > 0) ttftMs = Date.now() - startedAt;
      full += delta;
    }
  } catch (caught) {
    errorMessage = caught instanceof Error ? caught.message.slice(0, 200) : String(caught).slice(0, 200);
  } finally {
    activeSink = null;
  }
  const totalMs = Date.now() - startedAt;
  const snapshots = await Promise.all(sink.requests);
  const last = snapshots.length > 0 ? snapshots[snapshots.length - 1] : undefined;
  const requestMaxTokens =
    extractMaxTokens(sink.builtBody === null ? null : transformArmBody(args.arm, sink.builtBody, NARRATIVE_TEMPERATURE)) ?? null;
  const rawFinishReason = last?.finishReason ?? null;
  const rawCompletionTokens = last?.completionTokens ?? undefined;
  const rawContentChars = last?.contentChars ?? 0;
  const stubRaw = rawLengthStub({
    finishReason: rawFinishReason,
    completionTokens: rawCompletionTokens,
    contentChars: rawContentChars,
    maxTokens: requestMaxTokens ?? undefined,
  });
  const completion = completionBox.value;
  const stubCompletion = completion !== null && isNarratorLengthStub(completion);
  const errored = errorMessage !== undefined;
  const providerError = completion?.providerError;
  const row: ExtendedRow = {
    arm: args.arm,
    probeCase: args.probeCase,
    kind: args.kind,
    round: args.round,
    position: args.position,
    positionInRound: args.positionInRound,
    startedAt: startedAtIso,
    totalMs,
    requestStartOffsetMs: sink.lastRequestStartOffsetMs,
    requestMaxTokens,
    errored,
    timedOut: false,
    requestCount: snapshots.length,
    raw: {
      status: last?.status ?? null,
      headers: last?.headers ?? { names: [], values: {} },
      meta: last?.meta ?? {},
      finishReason: rawFinishReason,
      promptTokens: last?.promptTokens ?? null,
      completionTokens: last?.completionTokens ?? null,
      contentChars: rawContentChars,
      contentEventCount: last?.contentEventCount ?? 0,
      firstByteMs: last?.firstByteMs ?? null,
      firstContentMs: last?.firstContentMs ?? null,
      stub: stubRaw,
    },
    visible: {
      finishReason: completion?.finishReason ?? null,
      rawFinishReason: completion?.rawFinishReason ?? null,
      ttftMs,
      rawTextLength: completion?.rawTextLength ?? null,
      visibleTextChars: completion?.visibleTextChars ?? null,
      inputTokens: completion?.inputTokens ?? null,
      outputTokens: completion?.outputTokens ?? null,
      textTokens: completion?.textTokens ?? null,
      reasoningTokens: completion?.reasoningTokens ?? null,
      maxOutputTokens: completion?.maxOutputTokens ?? null,
      attempts: completion?.attempts ?? null,
      providerError: providerError ? { code: providerError.code, detail: providerError.detail } : null,
      stub: stubCompletion,
    },
    wire: sink.builtBody === null ? "(no request captured)" : describeWireBody(transformArmBody(args.arm, sink.builtBody, NARRATIVE_TEMPERATURE)),
    shape: errored ? null : replyShape(full, "Mira"),
    ...(errorMessage === undefined ? {} : { errorMessage }),
  };
  return { row, builtBody: sink.builtBody };
}

// ---------------------------------------------------------------------------
// One direct call (direct-stream / direct-json)
// ---------------------------------------------------------------------------

async function runDirectCall(args: {
  arm: "direct-stream" | "direct-json";
  probeCase: ProbeCase;
  profileBody: Record<string, unknown>;
  round: number;
  position: number;
  positionInRound: number;
}): Promise<ExtendedRow> {
  const startedAt = Date.now();
  const startedAtIso = new Date(startedAt).toISOString();
  const body = transformArmBody(args.arm, args.profileBody, NARRATIVE_TEMPERATURE);
  const requestMaxTokens = extractMaxTokens(body) ?? null;
  lastWireBodyByArmCase.set(`${args.arm}\u0000${args.probeCase}`, describeWireBody(body));

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), DIRECT_ARM_TIMEOUT_MS);
  let snapshot: RawRequestSnapshot | null = null;
  let errorMessage: string | undefined;
  try {
    const response = await trueFetch(FEATHERLESS_CHAT_COMPLETIONS_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${process.env.FEATHERLESS_API_TOKEN ?? ""}`,
        "user-agent": DIRECT_ARM_USER_AGENT,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    // Measured right when the response object arrives (headers received) — the
    // true "first byte" moment, and shared by both branches below. Reading it
    // AFTER `response.text()` (the pre-correction-round bug) always equals total
    // time, because `.text()` only resolves once the whole body has arrived.
    const firstByteMs = Date.now() - startedAt;
    const status = response.status;
    const headers = sanitizeHeaders(response.headers.entries());
    if (args.arm === "direct-stream") {
      const tap: DirectStreamTap = response.body
        ? await readTap(response.body, startedAt)
        : {
            meta: {},
            firstByteMs: null,
            firstContentMs: null,
            finishReason: null,
            promptTokens: null,
            completionTokens: null,
            contentChars: 0,
            contentEventCount: 0,
          };
      const { readError, ...rest } = tap;
      if (readError !== undefined) errorMessage = readError;
      snapshot = { status, headers, ...rest };
    } else {
      const text = await response.text();
      const summary = summarizeJsonCompletion(text);
      snapshot = {
        status,
        headers,
        meta: summary?.meta ?? {},
        firstByteMs,
        // Never derived from firstByteMs: a non-streaming read gives one moment
        // (the whole body), which firstByteMs already reports (#594 correction
        // round P3.2) — a second "first content" number here would only pretend
        // to measure something firstByteMs did not already cover.
        firstContentMs: null,
        finishReason: summary?.finishReason ?? null,
        promptTokens: summary?.usage?.promptTokens ?? null,
        completionTokens: summary?.usage?.completionTokens ?? null,
        contentChars: summary?.totalContentChars ?? 0,
        contentEventCount: summary?.contentEventCount ?? 0,
      };
    }
  } catch (caught) {
    errorMessage = caught instanceof Error ? caught.message.slice(0, 200) : String(caught).slice(0, 200);
  } finally {
    clearTimeout(timeoutHandle);
  }
  const totalMs = Date.now() - startedAt;
  // Read from the signal itself rather than from which catch fired: an abort can
  // land after headers arrived but mid-body, which throws from inside `readTap`
  // (now surfaced via `readError` above) rather than as an `AbortError` from the
  // outer `fetch` call.
  const timedOut = controller.signal.aborted;
  const errored = errorMessage !== undefined;
  const stub =
    snapshot !== null
      ? rawLengthStub({
          finishReason: snapshot.finishReason,
          completionTokens: snapshot.completionTokens ?? undefined,
          contentChars: snapshot.contentChars,
          maxTokens: requestMaxTokens ?? undefined,
        })
      : false;
  return {
    arm: args.arm,
    probeCase: args.probeCase,
    kind: "call",
    round: args.round,
    position: args.position,
    positionInRound: args.positionInRound,
    startedAt: startedAtIso,
    totalMs,
    // A direct call makes exactly one attempt (no SDK retry), so its one request
    // starts immediately — the offset is always 0 by construction.
    requestStartOffsetMs: 0,
    requestMaxTokens,
    errored,
    timedOut,
    requestCount: 1,
    raw: {
      status: snapshot?.status ?? null,
      headers: snapshot?.headers ?? { names: [], values: {} },
      meta: snapshot?.meta ?? {},
      finishReason: snapshot?.finishReason ?? null,
      promptTokens: snapshot?.promptTokens ?? null,
      completionTokens: snapshot?.completionTokens ?? null,
      contentChars: snapshot?.contentChars ?? 0,
      contentEventCount: snapshot?.contentEventCount ?? 0,
      firstByteMs: snapshot?.firstByteMs ?? null,
      firstContentMs: snapshot?.firstContentMs ?? null,
      stub,
    },
    visible: null,
    wire: describeWireBody(body),
    shape: null,
    ...(errorMessage === undefined ? {} : { errorMessage }),
  };
}

// ---------------------------------------------------------------------------
// The 32K context edge (unchanged from the pre-#594 probe — `profile` arm only)
// ---------------------------------------------------------------------------

const UNDER_TARGET_TOKENS = 31_500;
const OVER_TARGET_TOKENS = 33_500;
const MESSAGE_OVERHEAD_TOKENS = 8;
const LONG_HISTORY_TURNS = CHARACTER_CHAT_HISTORY_TURNS * 2;

function medianInputTokens(rows: readonly ExtendedRow[], probeCase: ProbeCase): number | null {
  const values = rows
    .filter((row) => row.arm === "profile" && row.probeCase === probeCase)
    .map((row) => row.visible?.inputTokens ?? null)
    .filter((value): value is number => value !== null)
    .sort((a, b) => a - b);
  if (values.length === 0) return null;
  const middle = values[Math.floor(values.length / 2)];
  return middle === undefined ? null : middle;
}

function fillerTokenRate(rows: readonly ExtendedRow[]): number | null {
  const tiny = medianInputTokens(rows, "tiny");
  const padded = medianInputTokens(rows, "vesper-sized");
  if (tiny === null || padded === null || padded <= tiny) return null;
  return (padded - tiny) / FILLER_REPEATS;
}

function fillerPerTurn(rows: readonly ExtendedRow[], perFiller: number, target: number): number {
  const base = medianInputTokens(rows, "tiny") ?? 0;
  const perTurn = (target - base) / LONG_HISTORY_TURNS - MESSAGE_OVERHEAD_TOKENS;
  return Math.max(1, Math.round(perTurn / perFiller));
}

function estimateInput(rows: readonly ExtendedRow[], perFiller: number, turns: number): number {
  const base = medianInputTokens(rows, "tiny") ?? 0;
  return Math.round(base + LONG_HISTORY_TURNS * (MESSAGE_OVERHEAD_TOKENS + turns * perFiller));
}

function longHistory(fillerCount: number): ChatTurn[] {
  const turns: ChatTurn[] = [];
  for (let i = 0; i < LONG_HISTORY_TURNS; i++) {
    const role = (LONG_HISTORY_TURNS - 1 - i) % 2 === 0 ? "user" : "assistant";
    turns.push({ role, content: `Beat ${i + 1}. ${FILLER.repeat(fillerCount)}`.trimEnd() });
  }
  return turns;
}

/**
 * The 32K edge is a VERDICT, not a row: a request over the window either completes
 * or errors with the host's own words, and a 200 whose reported input is materially
 * smaller than what was sent is SILENT TRUNCATION. Restored from the pre-#594 probe
 * (#594 correction round P2b), adapted to the arm × case row shape.
 */
function longHistoryVerdict(row: ExtendedRow, estimated: number, label: string): string {
  const reported = row.visible?.inputTokens ?? null;
  const truncated = reported !== null && reported < estimated * 0.95;
  const built = `built ~${String(estimated)} input tokens`;
  if (row.errored) return `${label} (${built}): THREW${row.timedOut ? " (timeout)" : ""} ${row.errorMessage ?? ""}`;
  if (row.visible?.providerError) {
    return `${label} (${built}): errored — ${row.visible.providerError.code}: ${row.visible.providerError.detail.slice(0, 160)}`;
  }
  if (row.visible === null) return `${label} (${built}): no completion record`;
  if (truncated) return `${label} (${built}): SILENTLY TRUNCATED — host reported ${String(reported)}`;
  return (
    `${label} (${built}): completed — finish ${row.visible.finishReason}/${row.visible.rawFinishReason ?? "—"}, ` +
    `${String(reported ?? "—")} in / ${String(row.visible.outputTokens ?? "—")} out`
  );
}

// ---------------------------------------------------------------------------
// Console + JSONL output
// ---------------------------------------------------------------------------

const num = (value: number | null | undefined): string => (typeof value === "number" ? String(value) : "—");

function printRow(row: ExtendedRow): void {
  console.log(
    [
      `r${row.round}`,
      `#${row.position}(${row.positionInRound})`,
      row.kind === "call" ? row.arm : `${row.arm}[${row.kind}]`,
      row.probeCase,
      `reqs=${row.requestCount}`,
      `reqOffset=${num(row.requestStartOffsetMs)}ms`,
      `cap=${num(row.requestMaxTokens)}`,
      `rawFinish=${row.raw.finishReason ?? "—"}`,
      `visFinish=${row.visible?.finishReason ?? "—"}`,
      `rawStub=${row.raw.stub ? 1 : 0}`,
      `compStub=${row.visible === null ? "—" : row.visible.stub ? 1 : 0}`,
      `in=${num(row.raw.promptTokens ?? row.visible?.inputTokens)}`,
      `out=${num(row.raw.completionTokens ?? row.visible?.outputTokens)}`,
      `rawFirstMs=${num(row.raw.firstContentMs)}`,
      `visFirstMs=${num(row.visible?.ttftMs)}`,
      `totalMs=${row.totalMs}`,
      row.shape ? `tagOpen=${row.shape.tagOpen ? 1 : 0} tagStray=${row.shape.tagStray} aster=${row.shape.asterisk}` : "shape=—",
      row.visible
        ? `rawLen=${num(row.visible.rawTextLength)} visLen=${num(row.visible.visibleTextChars)} textTok=${num(row.visible.textTokens)} reasonTok=${num(row.visible.reasoningTokens)}`
        : "text=—",
      row.visible?.providerError
        ? `providerError=${row.visible.providerError.code}: ${row.visible.providerError.detail.slice(0, 90)}`
        : "providerError=—",
    ].join(" ") + (row.errored ? ` ERRORED${row.timedOut ? " (timeout)" : ""}: ${row.errorMessage ?? ""}` : ""),
  );
}

function fmtStat(value: number | null): string {
  return value === null ? "—" : String(value);
}

function printSummary(rows: readonly ExtendedRow[]): void {
  const summary = buildProbeSummary(rows);
  console.log(`\n=== summary (percentile method: ${summary.percentileMethod}) ===`);
  for (const cell of summary.cells) {
    console.log(
      `\n${cell.arm} / ${cell.probeCase}: n=${cell.n} errored=${cell.errored} failed=${cell.failed} empty=${cell.empty} ` +
        `stub=${cell.stub.count}/${cell.n - cell.failed} (rate ${cell.stub.rate.toFixed(3)}, 95% CI ` +
        `${cell.stub.wilson95.low.toFixed(3)}–${cell.stub.wilson95.high.toFixed(3)}) [stub/latency stats exclude failed rows]`,
    );
    const reasons = Object.entries(cell.finishReasonTally)
      .map(([reason, count]) => `${reason}=${count}`)
      .join(", ");
    console.log(`  finish reasons (all rows, failed included): ${reasons || "—"}`);
    console.log(
      `  raw first-content ms: n=${cell.rawFirstContentMs.count} p50=${fmtStat(cell.rawFirstContentMs.p50)} ` +
        `p90=${fmtStat(cell.rawFirstContentMs.p90)} max=${fmtStat(cell.rawFirstContentMs.max)}`,
    );
    console.log(
      `  visible first ms:     n=${cell.visibleFirstMs.count} p50=${fmtStat(cell.visibleFirstMs.p50)} ` +
        `p90=${fmtStat(cell.visibleFirstMs.p90)} max=${fmtStat(cell.visibleFirstMs.max)}`,
    );
    console.log(
      `  total ms:             n=${cell.totalMs.count} p50=${fmtStat(cell.totalMs.p50)} ` +
        `p90=${fmtStat(cell.totalMs.p90)} max=${fmtStat(cell.totalMs.max)}`,
    );
    console.log(`  tokens (all rows): prompt=${cell.promptTokensTotal} completion=${cell.completionTokensTotal}`);
  }
  console.log("\nstub cross-tab (raw-wire verdict vs completion verdict, non-failed production rows only):");
  console.log(
    `  both=${summary.stubCrossTab.bothStub} raw-only=${summary.stubCrossTab.rawOnlyStub} ` +
      `completion-only=${summary.stubCrossTab.completionOnlyStub} neither=${summary.stubCrossTab.neitherStub} ` +
      `— disagreements=${summary.stubCrossTab.disagreements}`,
  );
  console.log("\ntoken totals by arm (every billed call, every kind):");
  for (const [arm, totals] of Object.entries(summary.tokenTotalsByArm)) {
    console.log(`  ${arm}: prompt=${totals.promptTokens} completion=${totals.completionTokens}`);
  }
  console.log("\ntoken totals by kind:");
  for (const [kind, totals] of Object.entries(summary.tokenTotalsByKind)) {
    console.log(`  ${kind}: prompt=${totals.promptTokens} completion=${totals.completionTokens}`);
  }
  console.log("\nwire body per arm x case (sampler + thinking fields only):");
  for (const [key, wire] of [...lastWireBodyByArmCase.entries()].sort()) {
    const [arm, probeCase] = key.split("\u0000");
    console.log(`  ${arm ?? "?"} / ${probeCase ?? "?"}: ${wire}`);
  }
}

/** Best-effort `git rev-parse HEAD` for the JSONL run header; null when it cannot be read. Never network, never billed. */
function resolveGitHead(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

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

  const armsResult = parseArms(process.env.PROBE_ARMS);
  if (!armsResult.ok) {
    console.log(`refusing to start: ${armsResult.message}.`);
    return;
  }
  const arms = armsResult.value;

  const casesResult = parseCases(process.env.PROBE_CASES);
  if (!casesResult.ok) {
    console.log(`refusing to start: ${casesResult.message}.`);
    return;
  }
  const cases = casesResult.value;

  const roundsResult = parsePositiveInt(process.env.PROBE_ATTEMPTS, 3, "PROBE_ATTEMPTS");
  if (!roundsResult.ok) {
    console.log(`refusing to start: ${roundsResult.message}.`);
    return;
  }
  const ROUNDS = roundsResult.value;

  const maxCallsResult = parsePositiveInt(process.env.PROBE_MAX_CALLS, 60, "PROBE_MAX_CALLS");
  if (!maxCallsResult.ok) {
    console.log(`refusing to start: ${maxCallsResult.message}.`);
    return;
  }
  const PROBE_MAX_CALLS = maxCallsResult.value;

  console.log(`arms: ${arms.join(", ")}`);
  console.log(`cases: ${cases.join(", ")}`);

  // Direct arms replay a per-case body captured from a production arm's own call.
  // Only when NO production arm is selected at all is there no such call to
  // capture it from — every other combination captures it for free the first
  // time any production arm runs for that case (`armsForRound`'s round-1 bootstrap
  // ordering guarantees that happens before a direct arm's turn).
  const anyDirect = arms.some((arm) => DIRECT_ARMS.has(arm));
  const anyProduction = arms.some((arm) => PRODUCTION_ARMS.has(arm));
  const needsBootstrapCall = anyDirect && !anyProduction;
  if (needsBootstrapCall && cases.length > 1) {
    console.log(
      "refusing to start: a direct arm is selected without any production arm, and PROBE_CASES names more than " +
        "one case. Without a production arm this run can only capture ONE case's body to replay (see the module " +
        "doc), so a direct-arm-only run must name exactly one PROBE_CASES entry.",
    );
    return;
  }
  const longHistoryEnabled = process.env.PROBE_LONG_HISTORY === "1" && arms.includes("profile");
  const warmupEnabled = process.env.PROBE_WARMUP === "1";
  const plannedCalls =
    ROUNDS * arms.length * cases.length +
    (needsBootstrapCall ? 1 : 0) +
    (longHistoryEnabled ? 2 : 0) +
    (warmupEnabled ? 1 : 0);

  console.log(
    `planned calls: ${plannedCalls} (${ROUNDS} round(s) x ${arms.length} arm(s) x ${cases.length} case(s)` +
      `${needsBootstrapCall ? " + 1 bootstrap capture call" : ""}` +
      `${longHistoryEnabled ? " + 2 long-history edge calls" : ""}` +
      `${warmupEnabled ? " + 1 warm-up call" : ""})`,
  );
  if (plannedCalls > PROBE_MAX_CALLS) {
    console.log(
      `refusing to start: planned ${plannedCalls} calls exceeds PROBE_MAX_CALLS=${PROBE_MAX_CALLS}. ` +
        "Set PROBE_MAX_CALLS to opt into a larger run.",
    );
    return;
  }

  const outPath = process.env.PROBE_OUT?.trim();
  if (outPath) writeFileSync(outPath, "");
  const appendOut = (record: unknown): void => {
    if (!outPath) return;
    appendFileSync(outPath, `${JSON.stringify(record)}\n`);
  };

  appendOut({
    type: "run",
    modelId: MODEL_ID,
    arms,
    cases,
    attempts: ROUNDS,
    plannedCalls,
    plannedBreakdown: {
      grid: ROUNDS * arms.length * cases.length,
      bootstrap: needsBootstrapCall ? 1 : 0,
      longHistory: longHistoryEnabled ? 2 : 0,
      warmup: warmupEnabled ? 1 : 0,
    },
    gitHead: resolveGitHead(),
    startedAt: new Date().toISOString(),
  });

  const restoreFetch = installFetchWrapper();
  const rows: ExtendedRow[] = [];
  const capturedProfileBody = new Map<ProbeCase, Record<string, unknown>>();
  /** Set only in the "direct arms with no production arm selected" fallback (see the module doc). */
  let bootstrapFallbackBody: Record<string, unknown> | null = null;

  try {
    if (warmupEnabled) {
      // `cases[0]` always exists: `parseCases` never returns an empty array.
      const warmupCase = cases[0] ?? "tiny";
      console.log(`warm-up: one profile call on case "${warmupCase}", excluded from the summary grid.`);
      const { row: warmupRow, builtBody } = await runProductionCall({
        arm: "profile",
        probeCase: warmupCase,
        kind: "warmup",
        round: 0,
        position: 0,
        positionInRound: 0,
        ...CASE_DEFS[warmupCase],
      });
      if (builtBody) capturedProfileBody.set(warmupCase, builtBody);
      printRow(warmupRow);
      rows.push(warmupRow);
      appendOut({ type: "warmup", ...warmupRow });
    }

    if (needsBootstrapCall) {
      const bootstrapCase = cases[0] ?? "tiny";
      if (!capturedProfileBody.has(bootstrapCase)) {
        console.log(
          `bootstrap: capturing one un-transformed production call from case "${bootstrapCase}" to seed the ` +
            "direct arm(s) — profile is not among the selected arms.",
        );
        const { row: bootstrapRow, builtBody } = await runProductionCall({
          arm: "profile",
          probeCase: bootstrapCase,
          kind: "bootstrap-call",
          round: 0,
          position: 0,
          positionInRound: 0,
          ...CASE_DEFS[bootstrapCase],
        });
        if (builtBody) capturedProfileBody.set(bootstrapCase, builtBody);
        printRow(bootstrapRow);
        rows.push(bootstrapRow);
        appendOut({ type: "bootstrap-call", ...bootstrapRow });
      } else {
        console.log(`bootstrap: the warm-up call already captured case "${bootstrapCase}" — no extra call needed.`);
      }
      bootstrapFallbackBody = capturedProfileBody.get(bootstrapCase) ?? null;
    }

    let position = 0;
    for (let round = 1; round <= ROUNDS; round++) {
      const armOrder = armsForRound(arms, round);
      let positionInRound = 0;
      for (const arm of armOrder) {
        for (const probeCase of cases) {
          position += 1;
          positionInRound += 1;
          if (isDirectArm(arm)) {
            const body = capturedProfileBody.get(probeCase) ?? bootstrapFallbackBody ?? undefined;
            if (!body) {
              console.log(
                `  skipped r${round} #${position} ${arm}/${probeCase}: no captured production body yet for this case`,
              );
              continue;
            }
            const row = await runDirectCall({ arm, probeCase, profileBody: body, round, position, positionInRound });
            rows.push(row);
            printRow(row);
            appendOut({ type: "call", ...row });
          } else {
            const { row, builtBody } = await runProductionCall({
              arm,
              probeCase,
              kind: "call",
              round,
              position,
              positionInRound,
              ...CASE_DEFS[probeCase],
            });
            if (builtBody && !capturedProfileBody.has(probeCase)) capturedProfileBody.set(probeCase, builtBody);
            rows.push(row);
            printRow(row);
            appendOut({ type: "call", ...row });
          }
        }
      }
    }

    // ---- The 32K edge, `profile` arm only (restored from the pre-#594 probe) ----
    if (process.env.PROBE_LONG_HISTORY === "1") {
      if (!longHistoryEnabled) {
        console.log("\nlong-history: skipped — PROBE_LONG_HISTORY=1 only extends the `profile` arm, which is not selected.");
      } else {
        const perFiller = fillerTokenRate(rows);
        if (perFiller === null) {
          console.log(
            "\nlong-history: skipped, no edge call made — the tiny and vesper-sized `profile` cases did not both " +
              "report input tokens to calibrate from.",
          );
        } else {
          const underTurns = fillerPerTurn(rows, perFiller, UNDER_TARGET_TOKENS);
          position += 1;
          const { row: under } = await runProductionCall({
            arm: "profile",
            probeCase: "tiny",
            kind: "long-history",
            round: 0,
            position,
            positionInRound: 0,
            system: TINY_SYSTEM,
            history: longHistory(underTurns),
          });
          const underEstimated = estimateInput(rows, perFiller, underTurns);
          rows.push(under);
          appendOut({ type: "long-history", label: "long-history-under", estimatedInputTokens: underEstimated, ...under });

          const measured = under.visible?.inputTokens ?? null;
          const overTurns =
            measured !== null && measured > 0
              ? Math.max(underTurns + 1, Math.ceil((underTurns * OVER_TARGET_TOKENS) / measured))
              : Math.ceil((underTurns * OVER_TARGET_TOKENS) / UNDER_TARGET_TOKENS);
          position += 1;
          const { row: over } = await runProductionCall({
            arm: "profile",
            probeCase: "tiny",
            kind: "long-history",
            round: 0,
            position,
            positionInRound: 0,
            system: TINY_SYSTEM,
            history: longHistory(overTurns),
          });
          const overEstimated = estimateInput(rows, perFiller, overTurns);
          rows.push(over);
          appendOut({ type: "long-history", label: "long-history-over", estimatedInputTokens: overEstimated, ...over });

          console.log("\n32K edge:");
          console.log(`  ${longHistoryVerdict(under, underEstimated, "long-history-under")}`);
          console.log(`  ${longHistoryVerdict(over, overEstimated, "long-history-over")}`);
        }
      }
    }
  } finally {
    restoreFetch();
  }

  const gridRows = rows.filter((row) => row.kind === "call");
  console.log(`\n${gridRows.length} calls in the interleaved grid, ${gridRows.filter((row) => row.errored).length} errored.`);
  printSummary(rows);

  if (outPath) {
    const summary = buildProbeSummary(rows);
    appendOut({ type: "summary", ...summary });
    console.log(`\nwrote ${rows.length} call row(s) (every kind) + 1 run header + 1 summary row to ${outPath}`);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
