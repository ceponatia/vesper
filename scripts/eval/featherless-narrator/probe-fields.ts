import "dotenv/config";
import { createHash } from "node:crypto";

/**
 * Opt-in live probe of what FEATHERLESS does with each candidate request field on one
 * exact model — the host-behaviour half of a narrator's evidence, and the input a text
 * adapter's per-host availability map is built from.
 * Not part of any suite and never run by CI: it makes real, billed calls.
 * Without `FEATHERLESS_API_TOKEN` it prints why it skipped and exits 0, so a clean
 * checkout can run it harmlessly.
 *
 *   pnpm probe:featherless-fields
 *   PROBE_MODEL=Naphula/Slimaki-Tavern-24B-v1.3 pnpm probe:featherless-fields
 *   PROBE_FIELDS=top_nsigma,seed pnpm probe:featherless-fields
 *
 * ## Why this calls the host directly, when `probe.ts` deliberately does not
 *
 * `probe.ts` measures Vesper: it runs the production narrator seam so that whatever the
 * chat lane applies is in force, and a probe with its own request builder would measure
 * the probe. This script asks the opposite question — what does the HOST do with a field
 * Vesper does not send today — and for that the production seam is the wrong instrument,
 * because it can only send fields it already knows about. So this one owns its request
 * body, sends ONE candidate field per call, and reads the answer off a non-streaming
 * `/v1/chat/completions`. The two halves are complementary, not redundant.
 *
 * An explicit `User-Agent` is mandatory rather than polite: Cloudflare answers a
 * header-less request `1010` and no call gets through.
 *
 * ## Counts and finish state only
 *
 * Same rule as `probe.ts`, and it is what makes a text-generation probe safe to paste into
 * an issue: no prompt, no completion, no reasoning content is printed or returned. A
 * reply's identity travels as the first 8 hex of a SHA-256 of its text, its length, its
 * token counts, its finish reason, and the two derived RATIOS defined below. The text is
 * hashed and measured inside one function and never leaves it.
 *
 * ## How a verdict is earned
 *
 * The naive method — "send the field at an extreme value and see whether the text changed"
 * — was measured and rejected. Featherless serves this model from a POOL: each server
 * decodes deterministically (five different requests that reduce to plain greedy came back
 * byte-identical), but repeated `temperature: 0` calls do not all land on the same server,
 * so greedy decoding returns a small SET of completions rather than one. A verdict resting
 * on equality with whichever sample came back first therefore inherits both a
 * false-positive and a false-negative rate. The families below are measured against signals
 * that survive that:
 *
 * - **Truncation samplers cannot move the argmax**, so they are sent at their most
 *   restrictive value on top of `temperature: 5` — a temperature measured to visibly
 *   degrade this model (ordinary-character ratio 0.84–0.91, and it rambles to the token cap
 *   instead of stopping). A sampler that is honored suppresses that disorder: the ratio
 *   returns to 1.0 AND the model stops on its own, two independent signals neither of which
 *   depends on which server answered. A sampler that is ignored leaves the temperature-5
 *   disorder untouched. One call each, and the gap between the two outcomes is wide.
 * - **Argmax-changing fields** (penalties, DRY, XTC, mirostat) ride ON TOP of the greedy
 *   baseline at an extreme value and are judged by MEMBERSHIP in the greedy set: a
 *   completion the plain greedy anchors also produced is the field doing nothing, and a
 *   completion outside that set is a candidate that must survive a confirmation call before
 *   it is called an effect. That is what keeps pool variation from being read as a result.
 * - **Budget and stop control** (`max_tokens`, `min_tokens`, `stop`, `stop_token_ids`) are
 *   read off the counts and the finish reason, which is where their effect actually lands.
 *   `include_stop_str_in_output` is read off the completion's TAIL — whether it ends with
 *   the stop string — because that is a property of the one completion under test rather
 *   than a comparison against a second, independently sampled call.
 * - **`seed`** is reproducibility, so it is the one field still measured as a pair: the
 *   same seed twice at `temperature: 1`, against a temperature-1 control proving those two
 *   calls could have differed.
 * - Fields whose effect this harness genuinely cannot observe (`logit_bias` needs
 *   tokenizer ids) are `accepted+unmeasured` WITH the reason.
 *
 * Every family states a PRECONDITION, and a family whose precondition fails reports
 * `accepted+unmeasured` naming it rather than being quietly downgraded to `ignored`. An
 * unmeasurable field is a fact about this harness; "ignored" is a claim about the host,
 * and the two must never be confused.
 */

/** The exact model under test. Any id is accepted so the next narrator reuses this harness. */
const MODEL_ID = process.env.PROBE_MODEL?.trim() || "DarkArtsForge/Asmodeus-24B-v3";

/**
 * What one `PROBE_FIELDS` name must ALSO run. Two kinds of entry, and both exist because
 * exact-membership filtering would otherwise skip the very call a verdict is read from and
 * bill the always-on baselines for nothing:
 *
 * - **Grouped fields** are probed under one synthetic name (`dry_*`), because a single
 *   member is meaningless on its own. Naming any member selects the group.
 * - **Dependent fields** are decided against another field's call, so selecting one alone
 *   could only ever report `unmeasured`.
 *
 * A new grouped or dependent field is registered HERE and nowhere else.
 */
const FIELD_EXPANSIONS: Readonly<Record<string, readonly string[]>> = {
  dry_multiplier: ["dry_*"],
  dry_base: ["dry_*"],
  dry_allowed_length: ["dry_*"],
  dry_sequence_breakers: ["dry_*"],
  xtc_threshold: ["xtc_*"],
  xtc_probability: ["xtc_*"],
  mirostat_mode: ["mirostat_*"],
  mirostat_tau: ["mirostat_*"],
  mirostat_eta: ["mirostat_*"],
  smoothing_factor: ["smoothing_*"],
  smoothing_curve: ["smoothing_*"],
  dynatemp_min: ["dynatemp_*"],
  dynatemp_max: ["dynatemp_*"],
  dynatemp_exponent: ["dynatemp_*"],
  include_stop_str_in_output: ["stop"],
  repetition_penalty_range: ["repetition_penalty"],
};

/**
 * Optional comma-separated filter, for iterating on one field without re-billing the sweep.
 * Expanded through {@link FIELD_EXPANSIONS} at parse time, so naming one field always runs
 * the calls its verdict is read from.
 */
const ONLY = new Set(
  (process.env.PROBE_FIELDS ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0)
    .flatMap((name) => [name, ...(FIELD_EXPANSIONS[name] ?? [])]),
);

const COMPLETIONS_URL = "https://api.featherless.ai/v1/chat/completions";
const MODEL_DETAIL_URL = `https://api.featherless.ai/v1/models/${MODEL_ID}`;

/**
 * Cloudflare rejects a request with no `User-Agent` as `1010` before Featherless ever sees
 * it, so this is load-bearing rather than courtesy.
 */
const USER_AGENT = "vesper-field-probe/1.0";

/** Per-call ceiling. A hung socket must not strand the sweep. */
const CALL_TIMEOUT_MS = 120_000;

/**
 * Featherless answers `503 capacity_exhausted` for roughly 25s while an idle model's
 * weights load. That is a cold start, not a failure, so it is slept through and counted —
 * the count is itself the cold-start evidence this probe is asked for.
 */
const COLD_START_RETRIES = 3;
const COLD_START_SLEEP_MS = 25_000;

/**
 * The fixed prompt, chosen for what it makes measurable rather than for what it says: an
 * instruction to answer in two short sentences, so the greedy completion terminates on its
 * own well under the token cap. That headroom is what gives `min_tokens` something to push
 * against and `stop` something to cut short; a prompt that ran to the cap would make both
 * unmeasurable. Its prose is never printed — only its length and the host's token count.
 */
const SYSTEM_PROMPT =
  "You are a terse narrator. Answer with exactly two short sentences of third-person, present-tense narration, then stop.";
const USER_PROMPT = "She opens the door.";

/** Greedy reference conditions — the base every argmax-changing and counts probe rides on. */
const GREEDY_BASE: Readonly<Record<string, unknown>> = { temperature: 0, max_tokens: 48 };

/**
 * The degradation base for truncation samplers. Temperature 5 was measured on this model to
 * produce visibly disordered output that diverges from the greedy argmax almost
 * immediately, which is exactly the background a working truncation sampler has to erase.
 */
const HOT_BASE: Readonly<Record<string, unknown>> = { temperature: 5, max_tokens: 40 };

/** Ordinary sampling conditions — the control the `seed` verdict is measured against. */
const SAMPLING_BASE: Readonly<Record<string, unknown>> = { temperature: 1, max_tokens: 40 };

/**
 * A stop string chosen to be independent of what the model says: a period occurs inside any
 * two-sentence completion, so the cut is guaranteed observable, and unlike a stop string
 * lifted from the model's own output it carries no prose into this file or its report.
 */
const STOP_STRING = ".";

/**
 * Greedy reference calls. More than one because a `temperature: 0` pair is NOT reliably
 * identical here: Featherless serves this model from a pool and each server decodes
 * deterministically, so repeated greedy calls return a small SET of completions rather than
 * one. Three anchors make that set observable, which is what lets "this field returned a
 * plain greedy completion" be decided by membership instead of by equality with whichever
 * sample happened to come first.
 */
const GREEDY_ANCHORS = 3;

/** Temperature-5 controls, for the same reason: the disorder has to be characterized, not sampled once. */
const HOT_CONTROLS = 3;

/**
 * Ordinary-character ratio at or above which a completion counts as coherent text. The
 * temperature-5 controls measure well below it (0.84–0.91) while collapsed and greedy
 * completions sit at 1.0, so the threshold falls in a wide empty gap rather than on a knife
 * edge — and unlike a text comparison it does not care which server answered.
 */
const CLEAN_COLLAPSE_MIN = 0.99;

type Verdict = "accepted+effective" | "accepted+ignored" | "accepted+unmeasured" | "rejected" | "call-failed";

interface CallResult {
  /** HTTP status, or 0 when the request never completed (network, timeout). */
  status: number;
  finishReason: string;
  promptTokens: number | null;
  completionTokens: number | null;
  /** Full SHA-256 of the completion text. The text itself is discarded immediately. */
  textHash: string | null;
  textLength: number | null;
  /**
   * Fraction of characters that are ordinary English text or punctuation. Near 1.0 for
   * coherent prose; measurably below it for high-temperature disorder, which is what makes
   * "did this sampler suppress the garbage" answerable without looking at the text.
   */
  cleanRatio: number | null;
  /** Characters shared as a common prefix with the greedy baseline. Null for the baseline itself. */
  prefixVsGreedy: number | null;
  /**
   * The completion ends with {@link STOP_STRING} once trailing whitespace is trimmed; null
   * when the call returned no completion. This is how `include_stop_str_in_output` is
   * judged, because it is a property of the ONE completion under test — unlike a length
   * compared against a second pooled call, it cannot be moved by which server answered.
   */
  tailIsStop: boolean | null;
  /** The host's own words on a 4xx, truncated. An API error message, never prose. */
  errorMessage: string | null;
  /** 503 `capacity_exhausted` rounds slept through before this call landed. */
  coldStarts: number;
  latencyMs: number;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const short = (value: unknown): string => {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return (text ?? "").replace(/\s+/g, " ").slice(0, 160);
};

/** Ordinary-text characters. Everything else counts as disorder. */
const ORDINARY = /[A-Za-z0-9 .,;:'"!?()[\]\-\n*]/g;

const cleanRatioOf = (text: string): number =>
  text.length === 0 ? 0 : Number(((text.match(ORDINARY) ?? []).length / text.length).toFixed(3));

const commonPrefix = (a: string, b: string): number => {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
};

/**
 * The single point where a completion's text is in scope. It goes in, and only counts,
 * ratios and a hash come out — so no caller can print it even by accident.
 */
function measure(text: string, greedyText: string | null): {
  textHash: string;
  textLength: number;
  cleanRatio: number;
  prefixVsGreedy: number | null;
  tailIsStop: boolean;
} {
  return {
    textHash: createHash("sha256").update(text).digest("hex"),
    textLength: text.length,
    cleanRatio: cleanRatioOf(text),
    prefixVsGreedy: greedyText === null ? null : commonPrefix(text, greedyText),
    tailIsStop: text.trimEnd().endsWith(STOP_STRING),
  };
}

/**
 * Read the pieces this probe reports out of an OpenAI-shaped completion body, defensively:
 * every field is optional and a shape that does not match records `null` rather than
 * throwing. A probe that dies on an unfamiliar envelope measures nothing, and an
 * unfamiliar envelope is itself a result worth seeing in the table.
 */
function readCompletion(payload: unknown): { finishReason: string; promptTokens: number | null; completionTokens: number | null; text: string | null } {
  const body = typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : {};
  const choices = Array.isArray(body.choices) ? body.choices : [];
  const first = typeof choices[0] === "object" && choices[0] !== null ? (choices[0] as Record<string, unknown>) : {};
  const message =
    typeof first.message === "object" && first.message !== null ? (first.message as Record<string, unknown>) : {};
  const usage = typeof body.usage === "object" && body.usage !== null ? (body.usage as Record<string, unknown>) : {};
  const count = (value: unknown): number | null => (typeof value === "number" ? value : null);
  return {
    finishReason: typeof first.finish_reason === "string" ? first.finish_reason : "—",
    promptTokens: count(usage.prompt_tokens),
    completionTokens: count(usage.completion_tokens),
    text: typeof message.content === "string" ? message.content : null,
  };
}

/** The host's error text, wherever this envelope keeps it. Never assumes one shape. */
function readError(raw: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return short(raw);
  }
  const body = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  const error = body.error;
  if (typeof error === "string") return short(error);
  if (typeof error === "object" && error !== null) {
    const detail = (error as Record<string, unknown>).message;
    if (typeof detail === "string") return short(detail);
  }
  if (typeof body.message === "string") return short(body.message);
  if (typeof body.detail === "string") return short(body.detail);
  return short(raw);
}

const empty = (status: number, errorMessage: string | null, coldStarts: number, latencyMs: number): CallResult => ({
  status,
  finishReason: "—",
  promptTokens: null,
  completionTokens: null,
  textHash: null,
  textLength: null,
  cleanRatio: null,
  prefixVsGreedy: null,
  tailIsStop: null,
  errorMessage,
  coldStarts,
  latencyMs,
});

/**
 * The greedy baseline's text, held in ONE module-level binding so prefix comparisons are
 * possible without passing prose through call signatures. Set once, read only by `measure`.
 */
let greedyText: string | null = null;

async function call(
  token: string,
  base: Readonly<Record<string, unknown>>,
  fields: Record<string, unknown>,
  options: { captureAsGreedy?: boolean } = {},
): Promise<CallResult> {
  const body = {
    model: MODEL_ID,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: USER_PROMPT },
    ],
    stream: false,
    ...base,
    ...fields,
  };
  let coldStarts = 0;
  const started = Date.now();
  for (let attempt = 0; attempt <= COLD_START_RETRIES; attempt++) {
    let status = 0;
    let raw = "";
    try {
      const response = await fetch(COMPLETIONS_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": USER_AGENT,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
      status = response.status;
      raw = await response.text();
    } catch (caught) {
      // Network or timeout: report a failed call rather than ending the sweep.
      return empty(0, caught instanceof Error ? short(caught.message) : short(String(caught)), coldStarts, Date.now() - started);
    }
    // A loading model answers 503 while its weights page in. Sleep through it and count it.
    if (status === 503 && attempt < COLD_START_RETRIES) {
      coldStarts += 1;
      await sleep(COLD_START_SLEEP_MS);
      continue;
    }
    if (status < 200 || status >= 300) {
      return empty(status, readError(raw), coldStarts, Date.now() - started);
    }
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
    const { text, ...rest } = readCompletion(parsed);
    if (text === null) return { ...empty(status, "no completion content in a 200 body", coldStarts, Date.now() - started), ...rest };
    if (options.captureAsGreedy === true) greedyText = text;
    return {
      status,
      ...rest,
      ...measure(text, greedyText),
      errorMessage: null,
      coldStarts,
      latencyMs: Date.now() - started,
    };
  }
  return empty(503, `capacity_exhausted after ${COLD_START_RETRIES} cold-start retries`, coldStarts, Date.now() - started);
}

interface Row {
  field: string;
  value: string;
  result: CallResult;
  /** Verdict on the field, printed on the LAST row of a multi-call probe only. */
  verdict: Verdict | null;
  note: string;
}

const rows: Row[] = [];
const verdicts = new Map<string, { verdict: Verdict; note: string }>();

const hash8 = (result: CallResult): string => (result.textHash === null ? "—" : result.textHash.slice(0, 8));
const n = (value: number | null): string => (value === null ? "—" : String(value));

function record(field: string, value: string, result: CallResult, verdict: Verdict | null, note: string): void {
  rows.push({ field, value, result, verdict, note });
  if (verdict !== null) verdicts.set(field, { verdict, note });
}

/** A 4xx short-circuits every effect test: the host never ran the field. */
const rejected = (result: CallResult): boolean => result.status >= 400 && result.status < 500;

async function main(): Promise<void> {
  const token = process.env.FEATHERLESS_API_TOKEN?.trim();
  if (!token) {
    console.log("skipped: FEATHERLESS_API_TOKEN is not set (this probe makes real, billed calls).");
    return;
  }
  // Hoisted function declarations below do not inherit the narrowing from the guard above.
  const bearer: string = token;
  console.log(`model: ${MODEL_ID}`);
  console.log(`prompt: fixed 2-message chat, ${SYSTEM_PROMPT.length + USER_PROMPT.length} prompt chars (text never printed)`);

  // ---- Host detail record (unauthenticated, free) --------------------------------
  try {
    const response = await fetch(MODEL_DETAIL_URL, {
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(30_000),
    });
    const raw = await response.text();
    let detail: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null) detail = parsed as Record<string, unknown>;
    } catch {
      detail = {};
    }
    const availability =
      typeof detail.availability === "object" && detail.availability !== null
        ? (detail.availability as Record<string, unknown>)
        : {};
    console.log(
      [
        `detail: status=${response.status}`,
        `model_class=${String(detail.model_class ?? "—")}`,
        `context_length=${String(detail.context_length ?? "—")}`,
        `concurrency_cost=${String(detail.concurrency_cost ?? "—")}`,
        `availability.tier=${String(availability.tier ?? "—")}`,
        `status=${String(detail.status ?? "—")}`,
        `max_completion_tokens=${detail.max_completion_tokens === undefined ? "unreported" : String(detail.max_completion_tokens)}`,
      ].join(" "),
    );
  } catch (caught) {
    console.log(`detail: unavailable (${caught instanceof Error ? short(caught.message) : "unknown"})`);
  }

  // ---- Baselines -----------------------------------------------------------------
  // Always run, whatever PROBE_FIELDS says: every verdict below is a comparison against one
  // of them, so a filtered run without them would compare against nothing.
  const greedy: CallResult[] = [];
  for (let i = 0; i < GREEDY_ANCHORS; i++) {
    greedy.push(await call(token, GREEDY_BASE, {}, { captureAsGreedy: i === 0 }));
  }
  const hot: CallResult[] = [];
  for (let i = 0; i < HOT_CONTROLS; i++) hot.push(await call(token, HOT_BASE, {}));
  const samplingA = await call(token, SAMPLING_BASE, {});
  const samplingB = await call(token, SAMPLING_BASE, {});

  const greedyA = greedy[0] ?? empty(0, "no greedy anchor", 0, 0);
  const greedyLength = greedyA.textLength ?? 0;
  /**
   * Every distinct completion plain greedy decoding produced. A field whose call lands
   * inside this set changed nothing the decoder did; one that lands outside it is the
   * candidate signal, and gets a confirmation call before it is called an effect.
   */
  const greedyHashes = new Set(greedy.map((row) => row.textHash).filter((hash): hash is string => hash !== null));
  const greedyIdentical = greedyHashes.size === 1;
  const hotClean = hot.map((row) => row.cleanRatio ?? 1);
  const hotCleanMax = hotClean.length > 0 ? Math.max(...hotClean) : 1;
  /**
   * The temperature-5 control has to be measurably disordered, or "this sampler restored
   * coherent text" is not a distinguishable outcome and the whole family is unmeasured.
   */
  const hotSeparates = hotCleanMax < CLEAN_COLLAPSE_MIN;
  const samplingVaries =
    samplingA.textHash !== null && samplingB.textHash !== null && samplingA.textHash !== samplingB.textHash;

  greedy.forEach((row, i) => record("temperature", "0", row, null, `greedy anchor ${i + 1}`));
  hot.forEach((row, i) => {
    const last = i === hot.length - 1;
    record(
      "temperature",
      last ? "0 vs 5" : "5",
      row,
      last ? (greedyA.status !== 200 ? "call-failed" : hotSeparates ? "accepted+effective" : "accepted+unmeasured") : null,
      last
        ? hotSeparates
          ? `temperature 5 degrades the ordinary-character ratio to ${hotClean.join("/")} and runs to the cap, against ${n(greedyA.cleanRatio)} and a natural stop at temperature 0`
          : "temperature 5 did not measurably differ from greedy — the host may clamp it"
        : `degradation control ${i + 1}`,
    );
  });
  record("temperature", "1", samplingA, null, "sampling control call 1");
  record("temperature", "1", samplingB, null, "sampling control call 2");

  console.log(
    `preconditions: greedy-anchors=${greedy.length} distinct-greedy-completions=${greedyHashes.size}` +
      ` (all-identical=${greedyIdentical}, ${greedyLength} chars on anchor 1)` +
      ` hot-separates=${hotSeparates} (hot clean ${hotClean.join("/")} vs collapse floor ${CLEAN_COLLAPSE_MIN})` +
      ` sampling-varies=${samplingVaries}`,
  );

  const wanted = (field: string): boolean => ONLY.size === 0 || ONLY.has(field);

  /**
   * A field whose effect changes what the greedy decoder picks: one call on the greedy base
   * at an extreme value, effective when the completion diverges from the greedy baseline
   * sooner than the greedy pair diverged from itself.
   */
  async function argmaxProbe(field: string, fields: Record<string, unknown>, note: string): Promise<CallResult | null> {
    if (!wanted(field)) return null;
    const result = await call(bearer, GREEDY_BASE, fields);
    if (rejected(result)) {
      record(field, short(fields), result, "rejected", result.errorMessage ?? "4xx");
      return result;
    }
    if (result.status !== 200) {
      record(field, short(fields), result, "call-failed", result.errorMessage ?? `status ${result.status}`);
      return result;
    }
    // Inside the greedy set means the decoder did exactly what it does with no field at
    // all — the strongest possible "ignored", and the one this model's undocumented fields
    // land on byte for byte.
    if (result.textHash !== null && greedyHashes.has(result.textHash)) {
      record(field, short(fields), result, "accepted+ignored", `byte-identical to a plain greedy completion; ${note}`);
      return result;
    }
    // Outside it is only a candidate: the pool can serve a greedy call from a server the
    // anchors did not sample. A confirmation call decides, and a confirmation that lands
    // back inside the greedy set downgrades the verdict rather than defending it.
    const confirm = await call(bearer, GREEDY_BASE, fields);
    if (confirm.status !== 200) {
      record(field, short(fields), confirm, "accepted+unmeasured", `the confirmation call returned ${confirm.status}; ${note}`);
      return result;
    }
    const confirmedOutside = confirm.textHash !== null && !greedyHashes.has(confirm.textHash);
    const reproduced = confirm.textHash === result.textHash;
    record(
      field,
      short(fields),
      confirm,
      confirmedOutside ? "accepted+effective" : "accepted+unmeasured",
      confirmedOutside
        ? `two calls both produced a completion no greedy anchor produced${reproduced ? ", identical to each other" : ""}; ${note}`
        : `the first call left the greedy set but the confirmation landed back inside it — pool variation, not the field; ${note}`,
    );
    return result;
  }

  /**
   * A field whose effect lands on the counts or the finish reason rather than the text.
   * `measurable` states the precondition the baseline has to satisfy for a null result to
   * mean anything; when it does not hold the verdict is `unmeasured`, never `ignored`.
   */
  async function countsProbe(args: {
    field: string;
    fields: Record<string, unknown>;
    measurable: { ok: boolean; why: string };
    effective: (result: CallResult) => boolean;
    note: string;
  }): Promise<CallResult | null> {
    if (!wanted(args.field)) return null;
    const result = await call(bearer, GREEDY_BASE, args.fields);
    if (rejected(result)) {
      record(args.field, short(args.fields), result, "rejected", result.errorMessage ?? "4xx");
      return result;
    }
    if (result.status !== 200) {
      record(args.field, short(args.fields), result, "call-failed", result.errorMessage ?? `status ${result.status}`);
      return result;
    }
    if (!args.measurable.ok) {
      record(args.field, short(args.fields), result, "accepted+unmeasured", args.measurable.why);
      return result;
    }
    const hit = args.effective(result);
    record(args.field, short(args.fields), result, hit ? "accepted+effective" : "accepted+ignored", args.note);
    return result;
  }

  /**
   * A truncation sampler at its most restrictive value on top of temperature 5. Honored, it
   * collapses the distribution back onto the argmax: the ordinary-character ratio returns to
   * the greedy level and the model stops on its own. Ignored, the disorder stays.
   */
  async function collapseProbe(field: string, fields: Record<string, unknown>, note: string): Promise<void> {
    if (!wanted(field)) return;
    const result = await call(bearer, HOT_BASE, fields);
    if (rejected(result)) {
      record(field, short(fields), result, "rejected", result.errorMessage ?? "4xx");
      return;
    }
    if (result.status !== 200) {
      record(field, short(fields), result, "call-failed", result.errorMessage ?? `status ${result.status}`);
      return;
    }
    if (!hotSeparates) {
      record(field, short(fields), result, "accepted+unmeasured", `200, but the temperature-5 control did not separate from greedy; ${note}`);
      return;
    }
    // The ordinary-character ratio is the discriminator, and it is server-independent: every
    // temperature-5 control lands in a band well below the floor while a suppressed
    // distribution returns to the greedy 1.0. Stopping on its own and reproducing a greedy
    // completion are CORROBORATION, reported when present but not required — a sampler that
    // restores coherent prose has demonstrably been read even if the model then keeps
    // writing past the token cap.
    const collapsed = (result.cleanRatio ?? 0) >= CLEAN_COLLAPSE_MIN;
    const ontoGreedy = result.textHash !== null && greedyHashes.has(result.textHash);
    const corroboration = [
      result.finishReason === "stop" ? "and it stopped on its own" : `though it ran to finish ${result.finishReason}`,
      ...(ontoGreedy ? ["byte-identical to a plain greedy completion"] : []),
    ].join(", ");
    record(
      field,
      short(fields),
      result,
      collapsed ? "accepted+effective" : "accepted+ignored",
      collapsed
        ? `suppressed the temperature-5 disorder — ordinary-character ratio ${n(result.cleanRatio)} against a control of ${hotClean.join("/")}, ${corroboration}; ${note}`
        : `temperature-5 disorder survived — ordinary-character ratio ${n(result.cleanRatio)} against a control of ${hotClean.join("/")}, finish ${result.finishReason}; ${note}`,
    );
  }

  // ---- Budget and stop control ----------------------------------------------------
  // Aggregated over every greedy anchor rather than taken from one, because the pool makes
  // any single anchor an unreliable stand-in for "what this model does left alone".
  const greedyTokens = greedy.map((row) => row.completionTokens).filter((count): count is number => count !== null);
  const baselineStops = greedy.every((row) => row.finishReason === "stop");
  const maxGreedyTokens = greedyTokens.length > 0 ? Math.max(...greedyTokens) : null;
  const minGreedyTokens = greedyTokens.length > 0 ? Math.min(...greedyTokens) : null;

  await countsProbe({
    field: "max_tokens",
    fields: { max_tokens: 5 },
    measurable: { ok: true, why: "" },
    effective: (r) => (r.completionTokens ?? 99) <= 5 && r.finishReason === "length",
    note: "capped at 5: expects finish_reason length and completion_tokens <= 5",
  });

  await countsProbe({
    field: "min_tokens",
    fields: { min_tokens: 47 },
    measurable: {
      ok: baselineStops && maxGreedyTokens !== null && maxGreedyTokens < 47,
      why: `the greedy anchors ran to ${n(maxGreedyTokens)} tokens (all stopped: ${baselineStops}), so a 47-token floor has nothing to push against`,
    },
    effective: (r) => (r.completionTokens ?? 0) >= 47,
    note: `floor of 47 against greedy anchors that stopped by ${n(maxGreedyTokens)} tokens`,
  });

  const stopResult = await countsProbe({
    field: "stop",
    fields: { stop: [STOP_STRING] },
    measurable: {
      ok: minGreedyTokens !== null && minGreedyTokens > 2,
      why: `the shortest greedy anchor produced ${n(minGreedyTokens)} tokens, too few for a stop string to visibly cut`,
    },
    // Strictly shorter than EVERY greedy anchor, so pool variation cannot supply the cut.
    effective: (r) => (r.completionTokens ?? 99) < (minGreedyTokens ?? 0),
    note: `stop on "${STOP_STRING}": expects fewer completion tokens than the shortest greedy anchor (${n(minGreedyTokens)})`,
  });

  // Judged by this completion's own TAIL, never by its length against the unflagged `stop`
  // call. Those are two independent draws from a multi-server pool, so the text before the
  // first period can legitimately differ between them, and an exact one-character comparison
  // would be decided by pool variation — labelling an honored flag ignored, or passing by
  // coincidence. Whether THIS completion ends with the stop string is a property of this
  // completion alone.
  if (wanted("include_stop_str_in_output")) {
    const fields = { stop: [STOP_STRING], include_stop_str_in_output: true };
    const result = await call(token, GREEDY_BASE, fields);
    if (rejected(result)) {
      record("include_stop_str_in_output", short(fields), result, "rejected", result.errorMessage ?? "4xx");
    } else if (result.status !== 200) {
      record("include_stop_str_in_output", short(fields), result, "call-failed", result.errorMessage ?? `status ${result.status}`);
    } else if (result.tailIsStop === null) {
      record("include_stop_str_in_output", short(fields), result, "accepted+unmeasured", "the flagged call returned no completion to read a tail from");
    } else {
      // Corroboration only: with the flag off the host should STRIP the matched stop string,
      // so the unflagged call is expected NOT to end with it.
      const referenceTail = stopResult !== null && stopResult.status === 200 ? stopResult.tailIsStop : null;
      const corroboration =
        referenceTail === null
          ? "no unflagged `stop` call was available to corroborate against"
          : referenceTail
            ? "though the unflagged `stop` call ends with it too, so the contrast is inconclusive"
            : "and the unflagged `stop` call does not, which is the expected contrast";
      record(
        "include_stop_str_in_output",
        short(fields),
        result,
        result.tailIsStop ? "accepted+effective" : "accepted+ignored",
        result.tailIsStop
          ? `the flagged completion ends with the stop string — it was retained; ${corroboration}`
          : `the flagged completion does not end with the stop string — it was not retained; ${corroboration}`,
      );
    }
  }

  // Token id 2 is `</s>` in the Mistral tokenizer this 24B family uses. An early stop is
  // positive evidence the field was honored; a null result cannot separate "ignored" from
  // "that id was never sampled", so it is reported unmeasured rather than ignored.
  if (wanted("stop_token_ids")) {
    const fields = { stop_token_ids: [2] };
    const result = await call(token, GREEDY_BASE, fields);
    if (rejected(result)) {
      record("stop_token_ids", short(fields), result, "rejected", result.errorMessage ?? "4xx");
    } else if (result.status !== 200) {
      record("stop_token_ids", short(fields), result, "call-failed", result.errorMessage ?? `status ${result.status}`);
    } else {
      const insideGreedy = result.textHash !== null && greedyHashes.has(result.textHash);
      const cut = !insideGreedy && (result.completionTokens ?? 99) < (minGreedyTokens ?? 0);
      record(
        "stop_token_ids",
        short(fields),
        result,
        cut ? "accepted+effective" : "accepted+unmeasured",
        cut
          ? `generation stopped short of every greedy anchor (${n(minGreedyTokens)} tokens) with id 2 (Mistral </s>) listed`
          : `200 with ${insideGreedy ? "a byte-identical greedy completion" : "no shortening"}; id 2 may simply never have been sampled, so this cannot separate ignored from never-reached`,
      );
    }
  }

  // ---- Argmax-changing fields ------------------------------------------------------
  const penalty = await argmaxProbe("repetition_penalty", { repetition_penalty: 2 }, "extreme penalty on the greedy argmax");
  await argmaxProbe("presence_penalty", { presence_penalty: 2 }, "extreme penalty on the greedy argmax");
  await argmaxProbe("frequency_penalty", { frequency_penalty: 2 }, "extreme penalty on the greedy argmax");
  await argmaxProbe(
    "dry_*",
    { dry_multiplier: 5, dry_base: 1.75, dry_allowed_length: 2, dry_sequence_breakers: ["\n"] },
    "sent as a group — a DRY member alone is meaningless",
  );
  await argmaxProbe(
    "xtc_*",
    { xtc_threshold: 0.05, xtc_probability: 1 },
    "sent as a group at certainty; a stack that applies XTC only under sampling would read as ignored here",
  );
  await argmaxProbe(
    "mirostat_*",
    { mirostat_mode: 2, mirostat_tau: 1, mirostat_eta: 0.1 },
    "sent as a group; mirostat overrides the decode, so an unchanged greedy call is evidence",
  );

  // `repetition_penalty_range` is only separable from `repetition_penalty` by holding the
  // penalty fixed and moving the window. A changed completion proves the window was read; an
  // unchanged one cannot distinguish "ignored" from "a window too wide to bite inside 48
  // tokens", so that outcome is unmeasured rather than ignored.
  if (wanted("repetition_penalty_range")) {
    const fields = { repetition_penalty: 2, repetition_penalty_range: 8 };
    const result = await call(token, GREEDY_BASE, fields);
    if (rejected(result)) {
      record("repetition_penalty_range", short(fields), result, "rejected", result.errorMessage ?? "4xx");
    } else if (result.status !== 200) {
      record("repetition_penalty_range", short(fields), result, "call-failed", result.errorMessage ?? `status ${result.status}`);
    } else if (penalty === null || penalty.status !== 200 || verdicts.get("repetition_penalty")?.verdict !== "accepted+effective") {
      record(
        "repetition_penalty_range",
        short(fields),
        result,
        "accepted+unmeasured",
        "not separable: repetition_penalty itself was not measurably effective here, so a window over it cannot be read",
      );
    } else {
      // Every completion the same penalty produced WITHOUT a window, so "differs" means
      // differs from all of them rather than from whichever one came back first.
      const penaltyHashes = new Set(
        rows
          .filter((row) => row.field === "repetition_penalty")
          .map((row) => row.result.textHash)
          .filter((hash): hash is string => hash !== null),
      );
      const outside = result.textHash !== null && !penaltyHashes.has(result.textHash);
      if (!outside) {
        record(
          "repetition_penalty_range",
          short(fields),
          result,
          "accepted+unmeasured",
          "identical to the same penalty with no window; an 8-token window may simply not bite inside a 48-token completion, so this cannot prove it was ignored",
        );
      } else {
        // Same standard as the argmax family: one divergence is a candidate, not a result.
        const confirm = await call(token, GREEDY_BASE, fields);
        record("repetition_penalty_range", short(fields), confirm, null, "confirmation call");
        const confirmedOutside =
          confirm.status === 200 && confirm.textHash !== null && !penaltyHashes.has(confirm.textHash);
        record(
          "repetition_penalty_range",
          short(fields),
          confirm,
          confirmedOutside ? "accepted+effective" : "accepted+unmeasured",
          confirmedOutside
            ? "both windowed calls differ from every completion the same penalty produced unwindowed — the window was read"
            : "the first windowed call differed but the confirmation matched an unwindowed completion — pool variation, not the window",
        );
      }
    }
  }

  // ---- Truncation samplers ----------------------------------------------------------
  await collapseProbe("top_k", { top_k: 1 }, "top_k 1 is argmax-only if honored");
  await collapseProbe("top_p", { top_p: 0.01 }, "a 1% nucleus is argmax-only if honored");
  await collapseProbe("min_p", { min_p: 1 }, "min_p 1 keeps only tokens as likely as the argmax");
  await collapseProbe("typical_p", { typical_p: 0.01 }, "most restrictive typical mass");
  await collapseProbe("tfs", { tfs: 0.01 }, "most restrictive tail-free value");
  await collapseProbe("top_a", { top_a: 1 }, "top_a 1 is a hard threshold relative to the argmax");
  await collapseProbe("top_nsigma", { top_nsigma: 0 }, "0 sigma keeps only the maximum-logit tokens");
  await collapseProbe(
    "smoothing_*",
    { smoothing_factor: 10, smoothing_curve: 1 },
    "sent as a group; heavy smoothing sharpens toward the argmax",
  );
  await collapseProbe(
    "dynatemp_*",
    { dynatemp_min: 0, dynatemp_max: 0, dynatemp_exponent: 1 },
    "sent as a group pinned to 0 — an honored dynamic temperature overrides temperature 5 and decodes greedily",
  );

  // ---- seed --------------------------------------------------------------------------
  // Featherless documents seed as unreliable because it serves from multiple machines. What
  // is measured here is what this model did on these two calls, not a promise.
  if (wanted("seed")) {
    const fields = { seed: 12345 };
    const first = await call(token, SAMPLING_BASE, fields);
    if (rejected(first)) {
      record("seed", short(fields), first, "rejected", first.errorMessage ?? "4xx");
    } else if (first.status !== 200) {
      record("seed", short(fields), first, "call-failed", first.errorMessage ?? `status ${first.status}`);
    } else {
      record("seed", short(fields), first, null, "same-seed pair call 1");
      const second = await call(token, SAMPLING_BASE, fields);
      if (second.status !== 200) {
        record("seed", short(fields), second, "call-failed", second.errorMessage ?? `status ${second.status}`);
      } else if (!samplingVaries) {
        record("seed", short(fields), second, "accepted+unmeasured", "the temperature-1 control did not vary, so a repeat cannot be attributed to the seed");
      } else {
        const same = first.textHash !== null && first.textHash === second.textHash;
        record(
          "seed",
          short(fields),
          second,
          same ? "accepted+effective" : "accepted+ignored",
          same
            ? "identical text for the same seed at temperature 1 on these two calls"
            : "different text for the same seed at temperature 1 — not reproducible on these two calls",
        );
      }
    }
  }

  // ---- chat_template_kwargs -----------------------------------------------------------
  // Status is the whole question. This model is not a thinking model, so there is no chain
  // to suppress and no effect to measure; a 200 says the template accepted the kwarg.
  if (wanted("chat_template_kwargs")) {
    const fields = { chat_template_kwargs: { enable_thinking: false } };
    const result = await call(token, GREEDY_BASE, fields);
    record(
      "chat_template_kwargs",
      short(fields),
      result,
      rejected(result) ? "rejected" : result.status === 200 ? "accepted+unmeasured" : "call-failed",
      rejected(result)
        ? (result.errorMessage ?? "4xx")
        : result.status === 200
          ? "accepted; no effect is expected or measurable on a non-thinking chat template"
          : (result.errorMessage ?? `status ${result.status}`),
    );
  }

  // ---- logit_bias ----------------------------------------------------------------------
  // A real bias needs a token id from this model's tokenizer, which this harness has no way
  // to obtain. Status is therefore the only honest reading.
  if (wanted("logit_bias")) {
    const fields = { logit_bias: { "1000": -100 } };
    const result = await call(token, GREEDY_BASE, fields);
    record(
      "logit_bias",
      short(fields),
      result,
      rejected(result) ? "rejected" : result.status === 200 ? "accepted+unmeasured" : "call-failed",
      rejected(result)
        ? (result.errorMessage ?? "4xx")
        : result.status === 200
          ? `accepted${result.textHash !== null && greedyHashes.has(result.textHash) ? ", and returned a byte-identical greedy completion" : ""}; a real effect needs a known token id from this model's tokenizer, which this harness cannot obtain, so a null result cannot separate ignored from never-sampled`
          : (result.errorMessage ?? `status ${result.status}`),
    );
  }

  // ---- Output ---------------------------------------------------------------------------
  console.log("");
  console.log(
    ["field", "valueSent", "status", "finish", "promptTok", "completionTok", "hash8", "clean", "pfxVsGreedy", "verdict", "note"].join("\t"),
  );
  for (const row of rows) {
    console.log(
      [
        row.field,
        row.value,
        row.result.status,
        row.result.finishReason,
        n(row.result.promptTokens),
        n(row.result.completionTokens),
        hash8(row.result),
        n(row.result.cleanRatio),
        n(row.result.prefixVsGreedy),
        row.verdict ?? "—",
        row.note,
      ].join("\t"),
    );
  }

  console.log("");
  console.log("verdict summary");
  for (const [field, entry] of verdicts) console.log(`  ${field}\t${entry.verdict}\t${entry.note}`);

  const colds = rows.reduce((total, row) => total + row.result.coldStarts, 0);
  const failed = rows.filter((row) => row.result.status === 0 || row.result.status >= 500).length;
  console.log("");
  console.log(`${rows.length} calls, ${colds} cold-start retries slept through, ${failed} that never returned a completion.`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
