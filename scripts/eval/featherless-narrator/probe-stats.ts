import { NARRATIVE_TEMPERATURE } from "@/server/engine";

/**
 * The pure half of the narrator probe (#594 scope 2): everything `probe.ts` computes
 * that takes no clock, no socket and no environment variable, split out so it can be
 * tested without a credential or a billed call. `probe.ts` imports every export below
 * rather than re-implementing any of it — this file is the one place each rule is
 * stated.
 *
 * Nothing here ever sees a prompt or a completion's prose. Every input type below is
 * either a count, a timing, or the sampler-only wire body `probe.ts` already captures
 * with prompt/tool content excluded (see `probe.ts`'s `WIRE_CONTENT_KEYS`).
 */

// ---------------------------------------------------------------------------
// Percentiles and the Wilson interval
// ---------------------------------------------------------------------------

/**
 * The p-th percentile of `values`, using the NEAREST-RANK method: sort the values,
 * then take the one at rank `ceil(p / 100 * n)` (1-based, clamped to `[1, n]`).
 *
 * Chosen over linear interpolation because every percentile this probe reports is
 * then an ACTUAL observed call's latency rather than a number interpolated between
 * two calls — which matters most on the tiny samples (n as low as 3 per arm × case)
 * this probe actually produces. `p=100` is the max under the same rule, so callers
 * needing a max should call `percentile(values, 100)` rather than a second helper.
 */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  const index = Math.min(sorted.length, Math.max(1, rank)) - 1;
  const value = sorted[index];
  return value === undefined ? null : value;
}

export interface WilsonInterval {
  low: number;
  high: number;
}

/** The two-sided 95% z-score, to full double precision rather than the common 1.96 rounding. */
const WILSON_95_Z = 1.959963984540054;

/**
 * The Wilson score interval for a binomial proportion, at ~95% confidence by default.
 *
 * Preferred over the naive normal-approximation interval because it stays inside
 * `[0, 1]` and stays sane at the small n and extreme proportions (0 stubs out of 3
 * calls is a real row this probe reports) that a normal approximation mishandles.
 */
export function wilsonInterval(successes: number, n: number, z: number = WILSON_95_Z): WilsonInterval {
  if (n <= 0) return { low: 0, high: 0 };
  const phat = successes / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const center = phat + z2 / (2 * n);
  const margin = z * Math.sqrt((phat * (1 - phat)) / n + z2 / (4 * n * n));
  return {
    low: Math.max(0, (center - margin) / denominator),
    high: Math.min(1, (center + margin) / denominator),
  };
}

// ---------------------------------------------------------------------------
// Arms
// ---------------------------------------------------------------------------

/**
 * The six comparison arms (#594 acceptance point 1). `profile` is the default — the only
 * arm the pre-#594 probe ever sent — so a caller who never sets `PROBE_ARMS` gets
 * exactly the old run.
 *
 * - `profile` / `profile-uncapped` / `lane` / `lane-capped` are PRODUCTION arms: each
 *   one still runs the real `streamCharacterChat` call, and the transform below is
 *   applied to that call's own outgoing wire body inside the probe's `fetch`
 *   wrapper — nothing about the lane, the adapter or the normalizers changes.
 * - `direct-stream` / `direct-json` are DIRECT arms: they replay an already-captured
 *   `profile` body straight against the Featherless endpoint, with no SDK in the loop.
 */
export const PROBE_ARMS = ["profile", "profile-uncapped", "lane", "lane-capped", "direct-stream", "direct-json"] as const;
export type ProbeArm = (typeof PROBE_ARMS)[number];

export function isProbeArm(value: string): value is ProbeArm {
  return (PROBE_ARMS as readonly string[]).includes(value);
}

/**
 * The two arms that bypass `streamCharacterChat` entirely and replay a body
 * captured from an earlier production call, rather than building their own
 * request through the lane. `lane-capped` is NOT one of these: it still runs
 * through `streamCharacterChat` like every other production arm, and reads its
 * `max_tokens` from that SAME call's own body at the fetch wrapper — never from
 * a different call — so it needs no cross-call capture at all.
 */
export const DIRECT_ARMS: ReadonlySet<ProbeArm> = new Set(["direct-stream", "direct-json"]);

/**
 * The wire body's CONTENT keys — everything a row with no exact-model adapter still
 * carries. Deliberately a small, named list rather than `probe.ts`'s
 * `WIRE_CONTENT_KEYS` denylist: the `lane` arm's whole point is to reproduce what an
 * UNADAPTED row sends (`featherless-wire.test.ts`'s "an unadapted Featherless row is
 * shaped by its lane alone"), which is these four keys plus the lane's own
 * temperature and nothing else — not "every field this probe declines to print".
 */
export const ARM_CONTENT_KEYS: readonly string[] = ["messages", "model", "stream", "stream_options"];

/** A `T | undefined` read, guarded the way `noUncheckedIndexedAccess` requires. */
function definedValue(body: Record<string, unknown>, key: string): unknown {
  const value = body[key];
  return value === undefined ? undefined : value;
}

/**
 * Apply one arm's transform to an already-built wire body (#594 acceptance point 1).
 *
 * `body` is the JSON-parsed outgoing request `probe.ts`'s `fetch` wrapper captured —
 * for `profile`/`profile-uncapped`/`lane`/`lane-capped` that is the SAME call's own
 * body (the transform is applied just before it goes over the wire); for the two
 * direct arms it is a `profile` body captured from an earlier call and replayed.
 *
 * `narrativeTemperature` is threaded in rather than imported a second time so this
 * function's only external dependency is its caller — `probe.ts` passes
 * `NARRATIVE_TEMPERATURE` (`server/engine/constants.ts`) once, at the one call site
 * that owns it.
 */
export function transformArmBody(
  arm: ProbeArm,
  body: Record<string, unknown>,
  narrativeTemperature: number = NARRATIVE_TEMPERATURE,
): Record<string, unknown> {
  switch (arm) {
    case "profile":
    case "direct-stream":
      // The production request exactly as built, or its unmodified replay.
      return { ...body };
    case "profile-uncapped": {
      const next = { ...body };
      delete next.max_tokens;
      return next;
    }
    case "lane": {
      const kept: Record<string, unknown> = {};
      for (const key of ARM_CONTENT_KEYS) {
        const value = definedValue(body, key);
        if (value !== undefined) kept[key] = value;
      }
      kept.temperature = narrativeTemperature;
      return kept;
    }
    case "lane-capped": {
      const lane = transformArmBody("lane", body, narrativeTemperature);
      const cap = definedValue(body, "max_tokens");
      return cap === undefined ? lane : { ...lane, max_tokens: cap };
    }
    case "direct-json": {
      const next = { ...body, stream: false };
      delete next.stream_options;
      return next;
    }
  }
}

// ---------------------------------------------------------------------------
// Header sanitizer
// ---------------------------------------------------------------------------

export interface SanitizedHeaders {
  /** Every header name the response carried, lowercased and sorted. */
  names: string[];
  /** Values kept for the allowlisted names only, truncated at {@link MAX_HEADER_VALUE}. */
  values: Record<string, string>;
}

/**
 * Header NAMES whose VALUE is safe to print (#594 acceptance point 4): request, trace or
 * correlation ids, `cf-ray`, server, worker, region, node, backend, model, version,
 * served-by. Matched against the lowercased name as a substring, because a host's
 * exact spelling (`x-request-id` vs `request-id` vs `cf-ray`) is not this probe's to
 * predict.
 */
const HEADER_ALLOW_PATTERN = /(request|trace|correlat|cf-ray|served?-?by|server|worker|region|node|backend|model|version)/i;

/**
 * Header names that are NEVER printed even if they also match the allowlist above —
 * `set-cookie`/`authorization` by name, and anything cookie- or key-shaped. This list
 * is checked FIRST, so it always wins the disagreement it exists for.
 */
const HEADER_DENY_PATTERN = /(cookie|authoriz|api[-_]?key|secret|token|credential|signature)/i;

/** Longest header value ever printed; anything longer is truncated with its true length noted. */
const MAX_HEADER_VALUE = 120;

/**
 * Reduce a response's headers to the safe subset (#594 acceptance point 4): every header
 * NAME (so a new one shows up in evidence even before it earns an allowlist entry),
 * and a VALUE only for the names an operator would recognize as a routing or
 * correlation identifier — never a cookie, an auth header, or anything key-shaped.
 */
export function sanitizeHeaders(headers: Iterable<readonly [string, string]>): SanitizedHeaders {
  const names: string[] = [];
  const values: Record<string, string> = {};
  for (const [rawName, rawValue] of headers) {
    const name = rawName.toLowerCase();
    names.push(name);
    if (HEADER_DENY_PATTERN.test(name)) continue;
    if (!HEADER_ALLOW_PATTERN.test(name)) continue;
    values[name] =
      rawValue.length > MAX_HEADER_VALUE
        ? `${rawValue.slice(0, MAX_HEADER_VALUE)}…(+${String(rawValue.length - MAX_HEADER_VALUE)} more chars)`
        : rawValue;
  }
  names.sort();
  return { names, values };
}

// ---------------------------------------------------------------------------
// The SSE event accumulator
// ---------------------------------------------------------------------------

/** Safe top-level identifiers a chat-completion event may carry (#594 acceptance point 4). */
export interface SseEventMeta {
  id?: string;
  model?: string;
  systemFingerprint?: string;
  created?: number;
}

export interface SseUsage {
  promptTokens?: number;
  completionTokens?: number;
}

export interface SseParsedEvent {
  /** True when this event carried non-empty `delta.content` or `delta.reasoning_content`. */
  hasContent: boolean;
  /** Characters of content/reasoning content on this event (a COUNT only; never the text). */
  contentChars: number;
  /** This event's own `choices[0].finish_reason`, when it carried one. */
  finishReason: string | null;
  /** This event's own `usage` block, when present (usually only the terminal event). */
  usage: SseUsage | null;
  meta: SseEventMeta;
  /** True for the terminal `[DONE]` sentinel, which carries no other fields. */
  done: boolean;
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** A nested object field, read defensively — never `any`, and never a cross-variable narrow. */
function objectField(container: Record<string, unknown> | undefined, key: string): Record<string, unknown> | undefined {
  const value = container?.[key];
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

/** The parsed body's `choices[0]`, when the shape actually has one — never `any`. */
function firstChoice(body: Record<string, unknown>): Record<string, unknown> | undefined {
  const choices: unknown[] = Array.isArray(body.choices) ? body.choices : [];
  const first: unknown = choices[0];
  return typeof first === "object" && first !== null ? (first as Record<string, unknown>) : undefined;
}

/** The parsed body's `usage` block, when present, read into the safe counts-only shape. */
function readUsage(body: Record<string, unknown>): SseUsage | null {
  const usageRaw = body.usage;
  if (typeof usageRaw !== "object" || usageRaw === null) return null;
  const usage = usageRaw as Record<string, unknown>;
  return { promptTokens: numberField(usage.prompt_tokens), completionTokens: numberField(usage.completion_tokens) };
}

/** The parsed body's safe top-level metadata (#594 acceptance point 4). */
function readMeta(body: Record<string, unknown>): SseEventMeta {
  return {
    id: stringField(body.id),
    model: stringField(body.model),
    systemFingerprint: stringField(body.system_fingerprint),
    created: numberField(body.created),
  };
}

/** Parse one `data: …` SSE frame (already split on the blank-line frame boundary). */
function parseSseFrame(frame: string): SseParsedEvent | null {
  const dataLines = frame
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trimStart());
  if (dataLines.length === 0) return null;
  const data = dataLines.join("");
  if (data.trim() === "[DONE]") {
    return { hasContent: false, contentChars: 0, finishReason: null, usage: null, meta: {}, done: true };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const body = parsed as Record<string, unknown>;
  const choice = firstChoice(body);
  const delta = objectField(choice, "delta");
  const content = stringField(delta?.content) ?? "";
  const reasoning = stringField(delta?.reasoning_content) ?? "";
  const finishReason = stringField(choice?.finish_reason) ?? null;
  return {
    hasContent: content.length > 0 || reasoning.length > 0,
    contentChars: content.length + reasoning.length,
    finishReason,
    usage: readUsage(body),
    meta: readMeta(body),
    done: false,
  };
}

export interface SseAccumulator {
  /** Feed one decoded chunk of raw SSE bytes; returns the events this chunk completed. */
  push(chunk: string): SseParsedEvent[];
  /** Flush a final frame that never received its trailing blank line. */
  flush(): SseParsedEvent[];
  /** Every event parsed so far, in arrival order. */
  all(): readonly SseParsedEvent[];
}

/**
 * A stateful SSE parser that survives chunk boundaries falling mid-frame and mid-line
 * (#594 acceptance point 7) — the shape a real TCP stream actually delivers in, unlike a
 * fixture that hands one whole frame per chunk. Frames are separated by a blank line
 * (`\n\n`); a chunk boundary may land anywhere inside one, including inside `[DONE]`
 * itself, so the buffer only ever yields a frame once a blank line has actually been
 * seen for it.
 */
export function createSseAccumulator(): SseAccumulator {
  let buffer = "";
  const events: SseParsedEvent[] = [];
  function drain(text: string): SseParsedEvent[] {
    const frames = text.split("\n\n");
    // The last split part is either empty (text ended exactly on a boundary) or an
    // incomplete frame — either way it is not yet parseable and stays in the buffer.
    const trailing = frames.pop() ?? "";
    buffer = trailing;
    const parsed: SseParsedEvent[] = [];
    for (const frame of frames) {
      const event = parseSseFrame(frame);
      if (event) parsed.push(event);
    }
    events.push(...parsed);
    return parsed;
  }
  return {
    push(chunk: string): SseParsedEvent[] {
      return drain(buffer + chunk);
    },
    flush(): SseParsedEvent[] {
      if (buffer.trim().length === 0) return [];
      const event = parseSseFrame(buffer);
      buffer = "";
      if (!event) return [];
      events.push(event);
      return [event];
    },
    all: () => events,
  };
}

export interface SseSummary {
  /** Count of events that carried non-empty content — a COUNT only, never the text. */
  contentEventCount: number;
  /** Total content characters across every event (a COUNT only). */
  totalContentChars: number;
  /** The `finish_reason` from the LAST event that carried one; null when none did. */
  finishReason: string | null;
  /** The `usage` block from the LAST event that carried one; null when none did. */
  usage: SseUsage | null;
  /** Safe metadata from the FIRST parsed event (id/model/system_fingerprint/created). */
  meta: SseEventMeta;
}

/** Reduce an accumulator's parsed events to the safe, printable summary (#594 acceptance points 2 and 4). */
export function summarizeSseEvents(events: readonly SseParsedEvent[]): SseSummary {
  let contentEventCount = 0;
  let totalContentChars = 0;
  let finishReason: string | null = null;
  let usage: SseUsage | null = null;
  let meta: SseEventMeta = {};
  let sawMeta = false;
  for (const event of events) {
    if (event.hasContent) contentEventCount += 1;
    totalContentChars += event.contentChars;
    if (event.finishReason !== null) finishReason = event.finishReason;
    if (event.usage !== null) usage = event.usage;
    if (!sawMeta && Object.keys(event.meta).length > 0) {
      meta = event.meta;
      sawMeta = true;
    }
  }
  return { contentEventCount, totalContentChars, finishReason, usage, meta };
}

/**
 * The same safe summary, read off a non-streaming `/v1/chat/completions` JSON body
 * (the `direct-json` arm) instead of an SSE stream. There is exactly one "event" —
 * the whole body — so this mirrors {@link summarizeSseEvents}'s shape without a
 * accumulator loop.
 */
export function summarizeJsonCompletion(bodyText: string): SseSummary | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const body = parsed as Record<string, unknown>;
  const choice = firstChoice(body);
  const message = objectField(choice, "message");
  const content = stringField(message?.content) ?? "";
  const finishReason = stringField(choice?.finish_reason) ?? null;
  return {
    contentEventCount: content.length > 0 ? 1 : 0,
    totalContentChars: content.length,
    finishReason,
    usage: readUsage(body),
    meta: readMeta(body),
  };
}

// ---------------------------------------------------------------------------
// The pathological length-stub verdict, mirrored for raw wire evidence
// ---------------------------------------------------------------------------

/** Mirrors `LENGTH_STUB_MAX_OUTPUT_TOKENS` in `apps/web/src/server/ai/narrator-completion.ts`. */
export const RAW_LENGTH_STUB_MAX_OUTPUT_TOKENS = 1;
/** Mirrors `LENGTH_STUB_MAX_RAW_CHARS` in `apps/web/src/server/ai/narrator-completion.ts`. */
export const RAW_LENGTH_STUB_MAX_CONTENT_CHARS = 32;

export interface RawLengthStubInput {
  /** The raw `finish_reason` string this arm's call reported (from the wire, not the SDK). */
  finishReason: string | null;
  /** Raw `usage.completion_tokens`, when the host reported one. */
  completionTokens: number | undefined;
  /** Content characters actually observed on the wire (a count only). */
  contentChars: number;
  /** The `max_tokens` this ARM's own request actually carried, or undefined for none sent. */
  maxTokens: number | undefined;
}

/**
 * A PURE mirror of `isNarratorLengthStub`
 * (`apps/web/src/server/ai/narrator-completion.ts`), applied to raw wire evidence
 * instead of the SDK-normalized `NarratorCompletion` record. Same three-part
 * contradiction, renamed to the fields the wire actually carries:
 *
 * - the raw finish reason is `"length"` — Featherless's OpenAI-compatible transport
 *   uses that exact word, so no unified-vocabulary translation is needed here;
 * - it reports one completion token or fewer — believed only when the observed
 *   content is consistent with it (at most {@link RAW_LENGTH_STUB_MAX_CONTENT_CHARS});
 *   when the host reported no count at all, exactly one content character stands in
 *   for it, the smallest fragment a single token can be;
 * - the arm's own request budget was larger than that — an explicit `max_tokens`
 *   above one, or none sent at all, which leaves the host's own (much larger)
 *   default in force. A request that deliberately capped itself at one token and
 *   stopped at one token did exactly what it was asked.
 *
 * This is NOT a minimum reply length: a short reply that ends on `stop` never
 * matches, and neither does a long reply that ran into a real cap.
 */
export function rawLengthStub(input: RawLengthStubInput): boolean {
  if (input.finishReason !== "length") return false;
  if (input.maxTokens !== undefined && input.maxTokens <= RAW_LENGTH_STUB_MAX_OUTPUT_TOKENS) return false;
  if (input.completionTokens !== undefined) {
    return (
      input.completionTokens <= RAW_LENGTH_STUB_MAX_OUTPUT_TOKENS &&
      input.contentChars <= RAW_LENGTH_STUB_MAX_CONTENT_CHARS
    );
  }
  return input.contentChars === 1;
}

// ---------------------------------------------------------------------------
// The summary builder
// ---------------------------------------------------------------------------

export type ProbeCase = "tiny" | "vesper-sized" | "terse-invite";

/**
 * One call's flattened, counts-only record — what `probe.ts` both prints as a row
 * and writes as one JSONL line (`PROBE_OUT`), and what {@link buildProbeSummary}
 * consumes. `visible` is null for the two direct arms, which have no SDK completion
 * to report one from.
 */
export interface ProbeCallRecord {
  arm: ProbeArm;
  probeCase: ProbeCase;
  round: number;
  position: number;
  startedAt: string;
  totalMs: number;
  errored: boolean;
  timedOut: boolean;
  /** A thrown/aborted call's own message, truncated; absent for a call that returned. */
  errorMessage?: string;
  requestCount: number;
  raw: {
    status: number | null;
    /** Every header name; values present only for the sanitizer's allowlisted names. */
    headers: SanitizedHeaders;
    /** Safe `id`/`model`/`system_fingerprint`/`created`, from the first SSE event or the JSON body. */
    meta: SseEventMeta;
    finishReason: string | null;
    promptTokens: number | null;
    completionTokens: number | null;
    contentChars: number;
    contentEventCount: number;
    firstByteMs: number | null;
    firstContentMs: number | null;
    stub: boolean;
  };
  visible: {
    finishReason: string | null;
    rawFinishReason: string | null;
    ttftMs: number | null;
    visibleTextChars: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
    maxOutputTokens: number | null;
    attempts: number | null;
    stub: boolean;
  } | null;
}

export interface LatencyStats {
  count: number;
  p50: number | null;
  p90: number | null;
  max: number | null;
}

function latencyStats(values: readonly (number | null)[]): LatencyStats {
  const present = values.filter((value): value is number => value !== null);
  return {
    count: present.length,
    p50: percentile(present, 50),
    p90: percentile(present, 90),
    max: percentile(present, 100),
  };
}

export interface ProbeCellSummary {
  arm: ProbeArm;
  probeCase: ProbeCase;
  n: number;
  errored: number;
  empty: number;
  stub: { count: number; rate: number; wilson95: WilsonInterval };
  finishReasonTally: Record<string, number>;
  rawFirstContentMs: LatencyStats;
  visibleFirstMs: LatencyStats;
  totalMs: LatencyStats;
  promptTokensTotal: number;
  completionTokensTotal: number;
}

/** Raw-wire verdict vs completion verdict, over every PRODUCTION row (both verdicts present). */
export interface StubCrossTab {
  bothStub: number;
  rawOnlyStub: number;
  completionOnlyStub: number;
  neitherStub: number;
  /** `rawOnlyStub + completionOnlyStub` — the two verdicts disagreed on this row. */
  disagreements: number;
}

export interface ProbeSummary {
  percentileMethod: "nearest-rank";
  cells: ProbeCellSummary[];
  stubCrossTab: StubCrossTab;
  tokenTotalsByArm: Record<string, { promptTokens: number; completionTokens: number }>;
}

/** Whichever verdict this row is actually judged by: the completion verdict when there is one, else the raw one. */
function rowStub(row: ProbeCallRecord): boolean {
  return row.visible ? row.visible.stub : row.raw.stub;
}

/** Whichever "no visible reply" a row can report: visible text for production rows, raw content for direct ones. */
function rowEmpty(row: ProbeCallRecord): boolean {
  if (row.errored) return false;
  return row.visible ? (row.visible.visibleTextChars ?? 0) === 0 : row.raw.contentChars === 0;
}

function rowFinishReason(row: ProbeCallRecord): string {
  if (row.errored) return row.timedOut ? "timeout" : "error";
  return row.visible?.finishReason ?? row.raw.finishReason ?? "unknown";
}

function emptyCrossTab(): StubCrossTab {
  return { bothStub: 0, rawOnlyStub: 0, completionOnlyStub: 0, neitherStub: 0, disagreements: 0 };
}

/**
 * Build the arm × case distributions and the two run-wide tallies from a flat list
 * of call records (#594 acceptance point 5) — PURE: every input is already the counts-only
 * shape `probe.ts` records per call, so this can be exercised (and its arithmetic
 * proved) without a credential or a network call.
 */
export function buildProbeSummary(rows: readonly ProbeCallRecord[]): ProbeSummary {
  const cellKeys = new Map<string, { arm: ProbeArm; probeCase: ProbeCase }>();
  for (const row of rows) cellKeys.set(`${row.arm}\u0000${row.probeCase}`, { arm: row.arm, probeCase: row.probeCase });

  const cells: ProbeCellSummary[] = [];
  for (const { arm, probeCase } of cellKeys.values()) {
    const cellRows = rows.filter((row) => row.arm === arm && row.probeCase === probeCase);
    const errored = cellRows.filter((row) => row.errored).length;
    const empty = cellRows.filter(rowEmpty).length;
    const stubbed = cellRows.filter(rowStub).length;
    const finishReasonTally: Record<string, number> = {};
    for (const row of cellRows) {
      const reason = rowFinishReason(row);
      finishReasonTally[reason] = (finishReasonTally[reason] ?? 0) + 1;
    }
    const wilson = wilsonInterval(stubbed, cellRows.length);
    cells.push({
      arm,
      probeCase,
      n: cellRows.length,
      errored,
      empty,
      stub: { count: stubbed, rate: cellRows.length === 0 ? 0 : stubbed / cellRows.length, wilson95: wilson },
      finishReasonTally,
      rawFirstContentMs: latencyStats(cellRows.map((row) => row.raw.firstContentMs)),
      visibleFirstMs: latencyStats(cellRows.map((row) => row.visible?.ttftMs ?? null)),
      totalMs: latencyStats(cellRows.map((row) => row.totalMs)),
      promptTokensTotal: cellRows.reduce((sum, row) => sum + (row.raw.promptTokens ?? row.visible?.inputTokens ?? 0), 0),
      completionTokensTotal: cellRows.reduce(
        (sum, row) => sum + (row.raw.completionTokens ?? row.visible?.outputTokens ?? 0),
        0,
      ),
    });
  }
  cells.sort((a, b) => (a.arm === b.arm ? a.probeCase.localeCompare(b.probeCase) : a.arm.localeCompare(b.arm)));

  const stubCrossTab = emptyCrossTab();
  for (const row of rows) {
    if (!row.visible || row.errored) continue;
    const raw = row.raw.stub;
    const completion = row.visible.stub;
    if (raw && completion) stubCrossTab.bothStub += 1;
    else if (raw && !completion) stubCrossTab.rawOnlyStub += 1;
    else if (!raw && completion) stubCrossTab.completionOnlyStub += 1;
    else stubCrossTab.neitherStub += 1;
  }
  stubCrossTab.disagreements = stubCrossTab.rawOnlyStub + stubCrossTab.completionOnlyStub;

  const tokenTotalsByArm: Record<string, { promptTokens: number; completionTokens: number }> = {};
  for (const row of rows) {
    const totals = tokenTotalsByArm[row.arm] ?? { promptTokens: 0, completionTokens: 0 };
    totals.promptTokens += row.raw.promptTokens ?? row.visible?.inputTokens ?? 0;
    totals.completionTokens += row.raw.completionTokens ?? row.visible?.outputTokens ?? 0;
    tokenTotalsByArm[row.arm] = totals;
  }

  return { percentileMethod: "nearest-rank", cells, stubCrossTab, tokenTotalsByArm };
}
