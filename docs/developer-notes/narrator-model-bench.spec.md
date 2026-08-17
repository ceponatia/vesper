# Narrator model test bench — technical spec

Status: companion to [narrator-model-bench.plan.md](narrator-model-bench.plan.md)

The implementation contract for coding agents. Product scope, priority, and open
questions live in the plan; this document is how the decisions in it get built.

## Scope

This spec governs the curated narrator roster in `apps/web/src/lib/narrative-models.ts`,
the evidence behind it, and the model-gateway seam that routes a narrator id to whichever
provider serves it. It deliberately leaves alone the in-session agent list
(`lib/agent-models.ts`), the scene composer list (`lib/composer-models.ts`), and the
image model registry — each keeps its own curated list and its own resolver, and none of
them may name a provider.

## Implementation status

- **Slice 1 — the bench is pickable** — built 2026-08-17. Eleven ids added to
  `NARRATIVE_MODELS`; a label-uniqueness guard added to `narrative-models.test.ts`.
  No other file changed: the dropdown, the resolver, the persistence column and the
  provider options all read the list already.
- **Slice 1b — the narrator list is multi-provider** — built 2026-08-17, awaiting an
  owner run of the first Featherless row on the deployed app. Adds the `provider`
  field, the Featherless transport, the `textModel` routing seam and the
  provider-key gate described below.
- **Slice 1c — the first Featherless row is reliable and its failures are truthful**
  — built 2026-08-17, **confirmed on the deployed app the same day**: the owner
  reports the common failure is now the model-busy (cold start) message, which is
  the misclassification this slice fixed presenting correctly. Adds narrator
  completion metadata, the zero-visible-text failure taxonomy, the exact-model
  sampler policy, and the one hidden retry. See
  [Why a reply read as empty](#why-a-reply-read-as-empty) for the root cause it
  fixes and [The exact-model request policy](#the-exact-model-request-policy) for
  what the model is now asked with.
- **Slice 1d — a second Featherless row for a matched comparison** — built
  2026-08-17, awaiting an owner run. Adds F451 Ultra Pro Writer under the same
  policy object as Fable Fusion, so the two differ only by merge recipe. Two further
  candidates were rejected as undeployed; see
  [Rejected candidates](#rejected-candidates-and-why).
- **Slice 2 — a recorded comparison** — not started.
- **Slice 3 — a default ruling** — not started, blocked on slice 2.

### Ruling 2026-08-17 — no seam is needed for these candidates

The search that motivated this work assumed a provider-neutral narrator seam would
be needed, because the models of interest live on Hugging Face. The probes below
found the opposite for the candidates then in hand: the narration fine-tunes worth
testing were hosted on OpenRouter already, and the three alternative providers
probed that day were each disqualified on measurements. So slice 1 built no seam.

### Ruling 2026-08-17 (later) — Featherless is a second narrator provider

The owner obtained a Featherless account, which changes the input to the ruling
above rather than contradicting its reasoning. Featherless hosts the community
Hugging Face merges that were previously "weights, not endpoints" — including the
DavidAU family the earlier probe recorded as unreachable — behind an
OpenAI-compatible endpoint fast enough to answer a chat turn.

So the seam the first ruling declined now exists, scoped as narrowly as it can be:

- **Narrator ids only.** `NARRATIVE_MODELS` rows may name a provider. The agent,
  scene-composer, embedding and vision lists stay OpenRouter-only and are not given
  the field. Narration is the one leg whose quality is worth a second credential;
  a state agent that answers on a different vendor is a debugging cost with no
  matching upside.
- **One generic transport, no bespoke client.** Featherless speaks OpenAI-compatible
  `/v1/chat/completions`, so `@ai-sdk/openai-compatible` is the whole integration.
- **No shared call policy.** OpenRouter's routing block and reasoning knob are that
  vendor's API surface and are withheld from any non-OpenRouter model.

The Replicate escape hatch is unchanged and still unused: packaging chosen weights
onto GPU infrastructure remains the answer if a model no host serves ever wins.

## The bench roster

Every id is verified present in its provider's live catalog and called once to confirm
it narrates. Prices are dollars per million tokens, prompt/completion, as quoted by the
catalog on 2026-08-17. The OpenRouter rows come first; the Featherless rows have their
own table below, because their operating characteristics differ enough that mixing them
into one grid would hide the differences that matter.

| Model                                | Context | $/M in–out | Lane                        |
| ------------------------------------ | ------: | ---------: | --------------------------- |
| `sao10k/l3.3-euryale-70b`            |    131K |  0.65–0.75 | Large RP specialist         |
| `sao10k/l3.1-euryale-70b`            |    131K |  0.85–0.85 | Its predecessor, for A/B    |
| `anthracite-org/magnum-v4-72b`       |     32K |  3.00–5.00 | Claude-imitation prose      |
| `thedrummer/cydonia-24b-v4.1`        |    131K |  0.30–0.50 | Mid-size uncensored RP      |
| `thedrummer/skyfall-36b-v2`          |     32K |  0.55–0.80 | Mid-size storytelling       |
| `thedrummer/unslopnemo-12b`          |   1024K |  0.40–0.40 | Anti-repetition tuning      |
| `thedrummer/rocinante-12b`           |     65K |  0.25–0.50 | Small prose specialist      |
| `cognitivecomputations/dolphin-…`    |    128K |  0.20–0.90 | Low-refusal control         |
| `aion-labs/aion-rp-llama-3.1-8b`     |     32K |  0.80–1.60 | Small RP specialist         |
| `nousresearch/hermes-4-70b`          |    131K |  0.13–0.40 | Instruction-obedience control|
| `minimax/minimax-m2-her`             |     65K |  0.30–1.20 | Non-Llama RP backbone       |

The Dolphin row's full id is
`cognitivecomputations/dolphin-mistral-24b-venice-edition`.

### The Featherless rows

| Model                                    | Context | $/M in–out | Lane                     |
| ---------------------------------------- | ------: | ---------: | ------------------------ |
| `DavidAU/Qwen3.6-27B-Fable-Fusion-711-…` |     32K |  1.06–2.60 | Uncensored Qwen3.6 merge |
| `DavidAU/Qwen3.6-27B-F451-AND-TRI-…`     |     32K |  1.06–2.60 | Writer-tuned counterpart |

Full ids: `DavidAU/Qwen3.6-27B-Fable-Fusion-711-Uncensored-Heretic-NM-DAU-MTP` and
`DavidAU/Qwen3.6-27B-F451-AND-TRI-Polar-Ultra-Pro-Writer-Uncensored-Heretic`, both
added on owner request.

The two are a **matched pair on purpose**: same author, same Qwen3.6-27B base, same
FP8 quantization, same 32K window, same price, and the same request policy. They differ
by their merge recipe and nothing else, which is the only arrangement under which
comparing them answers anything. F451's card emphasizes instruction-following and
writer-oriented tuning where Fable Fusion emphasizes prose fusion.

Measured against the live endpoint (the Fable numbers below; F451's own probe is in
[the thinking-off ruling](#ruling-2026-08-17--a-thinking-narrator-is-asked-with-thinking-off)):

- **It is a thinking model, and it is asked not to be.** Left alone it emits ~1,300
  tokens of chain before any prose, which both breaks the lane's first-token budget
  and — under a bounded output budget — consumes the entire reply. See
  [the ruling](#ruling-2026-08-17--a-thinking-narrator-is-asked-with-thinking-off).
- **Warm, as configured: first token 0.7–2.8s, a full reply in 2.1–4.6s.** Nine
  consecutive warm calls through the production narrator seam on 2026-08-17 all
  finished `stop` with prose and **zero** reasoning tokens; the slowest first token
  in the set was 6.9s on the call that warmed it. Ordinary narrator latency, not a
  bench compromise.
- **Cold start.** The first call to an idle model fails while Featherless loads the
  weights — reproducibly, and it takes ~14s to surface. It is a warm-up, not an
  outage, and it is **not** an empty reply; see
  [Why a reply read as empty](#why-a-reply-read-as-empty).
- **Replies run short.** Warm calls produced 20–63 output tokens (79–303 characters).
  That is the lane-wide `aggressive_concise` shape this model was never selected for,
  which is exactly what the plan's slices 2–4 exist to correct — it is a prompt-shape
  observation, not a reliability one.
- **Prose quality is on-brief.** It honors the `[Name]` speaker tag, holds third
  person, and produces scene-like description rather than chat-length answers — which
  is the property the whole bench exists to find.

Two rows are controls rather than candidates, and are there to answer a question the
candidates cannot. **Hermes 4 70B** is not narration-tuned, so it measures how much
of the result comes from the fine-tune versus from Vesper's own prompt and state
contract. **Venice Uncensored 24B** is permissive without being roleplay-tuned, so it
separates "refuses less" from "narrates better".

### Rejected candidates, and why

The research pass that produced this bench proposed roughly thirty models. Those not
listed above were dropped for one of these reasons, all of them checkable:

- **Context too small to hold the prompt.** `sao10k/l3-lunaris-8b` and
  `gryphe/mythomax-l2-13b` (8,192), `mancer/weaver` (8,000) and
  `undi95/remm-slerp-l2-13b` (6,144) are all smaller than the built narrator system
  prompt. See the arithmetic below.
- **Not hosted anywhere reachable *at the time*.** Midnight-Miqu-70B, Magnum-v4-SE,
  Slimaki-Tavern-24B, Novelist-Eclipse-31B, Qwythos, Goetia, and the DavidAU,
  nightmedia, huihui-ai and HauhauCS families are published as weights only. None is
  served by OpenRouter, and Hugging Face's router serves none of them either.
  **Featherless reopened this bucket the same day** — its catalog runs to ~21,700
  Hugging Face models and includes these families. Reachability is no longer the
  reason to drop one; context window and speed still are.
- **Near-duplicate of a listed row.** `nousresearch/hermes-4-405b` and
  `hermes-3-llama-3.1-70b` add cost, not a lane, over Hermes 4 70B.
- **Published on Featherless but not served by it.**
  `nightmedia/Qwen3.6-27B-Architect-Polaris2-Fable-B-F451` and
  `gorbatjovy/Qwen3.6-27B-Architect-Polaris2-Fable-B-F451-heretic` were requested on
  2026-08-17 and both refused: `400 invalid_request_error`,
  `code: "model_not_deployed"` — "is not available for inference". Neither appears in
  the 21,704-entry `GET /v1/models` catalog; there is no `gorbatjovy` owner in it at
  all, and no id anywhere matching `Architect-Polaris2` or `Fable-B-F451`. Both have
  ordinary-looking model pages on the website.

  That gap is the lesson, and it generalizes: **a Featherless model page is not
  evidence the inference API serves the model.** The website catalogs Hugging Face
  repos; `/v1/models` lists what is deployed and on-plan. Listing an undeployed id
  would not degrade — it would pass curation, route to Featherless, and 400 on every
  single turn, because the provider-key gate checks that a *credential* exists, not
  that a *model* is deployed. So the check before adding any row is the catalog, and
  it is `available_on_current_plan` that has to be true.

Stheno v3.2 deserves its own note, because it was ranked a top candidate and it *is*
reachable — Hugging Face's router serves it. It is disqualified anyway on context: it
is an 8,192-token Llama-3 8B, and the system prompt alone does not fit. Its
CC-BY-NC-4.0 license would have been the second problem.

## The context arithmetic

This is the constraint that decided most of the roster, so it is worth stating
exactly.

The built narrator system prompt measures **~36,000 characters, roughly 9,000
tokens** (the `sim-render` prompt snapshot, `apps/web/src/server/engine/prompts/__snapshots__/`).
On top of that the chat lane sends `CHARACTER_CHAT_HISTORY_TURNS` (40) exchanges of
verbatim history — up to 80 messages, `engine/constants.ts`.

A typical chat therefore presents somewhere near **17,000 tokens** per narrator call,
and a verbose long-running one materially more. That yields three bands:

- **Under ~16K** — cannot work. The system prompt alone crowds out the conversation.
- **32K** — works in the typical case, can overflow a verbose long chat. The three
  rows in this band carry a `(32K)` marker in their dropdown label so the constraint
  is visible at the point of choosing.
- **65K and above** — comfortable.

## Providers investigated

All four alternatives were probed against live endpoints on 2026-08-17 rather than
assessed from documentation. Featherless is adopted; the other three are rejected, and
each rejection has a number behind it.

### Featherless — adopted, narrator-only

`https://api.featherless.ai/v1`, authenticated with `FEATHERLESS_API_TOKEN`, speaking
ordinary OpenAI-compatible `/v1/chat/completions` including SSE streaming. `GET
/v1/models` returns the whole catalog — ~21,700 Hugging Face repos — with
`context_length`, `max_completion_tokens`, per-model pricing, and an
`available_on_current_plan` flag, so a candidate can be checked before it is added.

This is the provider that makes the community merges reachable: the models the earlier
probes could only find as downloadable weights are served here behind a normal chat
endpoint. Two operational facts shape how it is used:

- **Serverless cold start.** An idle model answers `503` with
  `code: "capacity_exhausted"` — or HTTP 200 with the same envelope in an SSE frame —
  while its weights load, then serves normally. It is a warm-up, not an outage, but it
  is a real first-call failure; see [Resilience](#resilience) for how it now surfaces.
- **Slower than the hosted commercial endpoints**, and with no endpoint choice to make.
  There is no routing block, no provider preference, no reasoning knob — which is why
  `providerRouting` and `narrativeProviderOptions` return nothing for these ids rather
  than translating OpenRouter's.

### Civitai — an OpenRouter proxy

Civitai's orchestrator exposes `POST https://orchestration.civitai.com/v1/chat/completions`,
and the existing `CIVITAI_API_TOKEN` authenticates against it: the route returns 401
without the token and proceeds with it.

It is not an independent provider. Asked for `sao10k/l3.3-euryale-70b` — a model
Civitai does not host — it answered normally and returned an OpenRouter generation id
(`gen-…`). Asked for its own first-party `urn:air:` models, in three id spellings, it
returned `500 Chat completion failed` every time; the same 500 comes back for a
deliberately bogus model name, so the error distinguishes nothing. There is no model
discovery route (`GET /v1/models` is a 404).

Routing narration through Civitai would therefore add a network hop in front of the
same OpenRouter models Vesper already calls directly, while making failures less
legible. The Civitai-hosted abliterated Qwen builds that motivated the investigation
are not reachable with our token.

### Replicate — works, too slow to narrate

The roleplay deployments are real, live, and not abandoned:
`spuuntries/flatdolphinmaid-8x7b-gguf` has over 416,000 runs. A prediction against it
with a 12,000-token prompt succeeded and produced coherent prose.

The timings are the problem. From that model's own llama.cpp log:

- **Prefill: 31.4 seconds** for 11,988 prompt tokens (382 tok/s).
- **Generation: 40.9 tok/s.**
- **Cold boot: ~57 seconds** on top (91s total wall clock against 33.5s of compute).

Extrapolated to a real narrator turn — the ~17K-token prompt above, a few hundred
tokens of reply — that is **45 to 70 seconds before the first token**, against the
1–2 seconds the hosted models measured. The chat lane budgets its legs in seconds
(`chat-reply-latency.plan.md`), so this is not a tuning gap.

There is a second, smaller obstacle: these are raw-prompt llama.cpp cogs. Their input
is a `prompt` string plus a `system_prompt` and an Alpaca-style `prompt_template`, not
a message array, so the narrator's messages would have to be flattened into a
per-model template. Streaming is supported (the output schema is an iterator), so
that part would have worked.

Replicate's real value here is unchanged and stated in the plan's non-goals:
deploying **arbitrary chosen weights** onto GPU infrastructure, which is the escape
hatch if an unhosted model wins.

### Hugging Face — weights, not endpoints

HF's router serves 136 models. Of the ~30 candidates, it serves two:
`Sao10K/L3-8B-Stheno-v3.2` and `Sao10K/L3-8B-Lunaris-v1`. Both are 8,192-token
Llama-3 8Bs, which the context arithmetic above disqualifies. Everything else —
Midnight-Miqu, Euryale, Magnum, and the whole modern abliterated/heretic wave — is
published as downloadable weights with no hosted endpoint.

Using them means hosting them, which is the Replicate escape hatch, not a provider
integration. It would also need an `HF_TOKEN`, which this repo does not have.

## Contracts

`NarrativeModelOption` is `{ id, label, provider? }` in `lib/narrative-models.ts`
(pure, no IO). `provider` is `"openrouter" | "featherless"` and is **omitted on every
OpenRouter row** — `narrativeModelProvider(id)` reads it with `"openrouter"` as the
default, so adding an OpenRouter narrator stays a one-line change and the field is
carried only by rows that need it.

`id` is the model id as its own upstream spells it, with no provider prefix: an
OpenRouter slug or a Hugging Face repo path. That works because ids are unique across
providers, which `narrative-models.test.ts` asserts. The alternative — namespacing ids
as `featherless:owner/name` — was rejected because the id is the persisted value on
`characters.chat_model` and `character_chats.chat_model`, and a prefix would have to be
stripped at every boundary that hands the id to a provider or compares it to a stored
row.

A `description` field was considered, mirroring `SceneComposerModelOption`, and
rejected: the narrator dropdown renders through the shared `ModelSelect`
(`components/ui/model-select.tsx`), which shows the label only, so a description
would have required a second bespoke select for no decision the label cannot carry.
The per-model rationale lives in code comments and in this spec instead.

### The routing seam

`textModel(modelId)` in `server/ai/provider.ts` is the single place a model id becomes
a callable model. It reads `narrativeModelProvider` and returns either
`openrouter().chat(id)` or `featherless().chatModel(id)`. Both narrator call sites go
through it — `streamCharacterChat` for the chat lane and `generateChecked` for every
structured call including the successor renderer — so no call site knows about
providers, and there is no second path a Featherless id could take to the wrong vendor.

Featherless needs no bespoke transport. `createOpenAICompatible` from
`@ai-sdk/openai-compatible` is the whole client; the ESLint provider restriction that
already confined `createOpenRouter` to the model gateway now covers it too, so the
routing decision cannot be bypassed by a call site building its own provider.

The AI SDK maps the endpoint's `reasoning` delta to reasoning parts, not text, which is
what keeps a thinking model's chain out of `textStream` — and therefore out of the
bubble, the persisted reply, and the narrator artifact/speaker-tag/repeat normalizers
that run over that stream.

### The provider-key gate

`chatNarrativeModelId(requested)` is the server-side chat/successor resolver:
`resolveChatModelId`'s curation, then a check that the resolved id's provider has a
configured key. `narrativeModelId` applies the same check with the session default.

Curation and the key check are deliberately separate gates with different meanings. A
dropped row is a stale **choice** and coerces permanently. A missing token is a stale
**deployment**: the pick stays valid and stored, the turn degrades to a narrator that
can answer, and setting the secret restores the pick with no re-choosing. Only
Featherless can fail this gate — OpenRouter's absence is demo mode, which every
generation path already branches on.

### Ruling 2026-08-17 — a thinking narrator is asked with thinking off

The chat lane aborts a reply that produces no visible token within
`CHAT_STREAM_FIRST_TOKEN_MS` (50s), and that ceiling is not tunable upward: it is
deliberately under Fly's ~60s proxy idle timeout, past which the proxy kills a response
that has sent zero bytes.

A model that reasons before it narrates fails that budget on two independent counts,
both measured against the live endpoint:

- **First prose at ~61s**, behind ~1,300 tokens of chain — over the watchdog before
  Vesper's real prompt adds any prefill.
- **An empty reply.** Asked with a bounded output budget, the model spent the whole
  budget thinking and returned `finish_reason: "length"` with no content at all. This
  one is not a latency problem and no timeout change would fix it.

So thinking is **switched off for those models rather than budgeted for**, per exact
model id, in `FEATHERLESS_MODEL_POLICY`. Measured on a ~10.7K-token prompt with the flag
set: first token **~1.2s**, a complete two-paragraph reply in **~11s** — the same league
as the hosted commercial narrators, and comfortably inside every existing budget.

Only one mechanism works. `chat_template_kwargs: {enable_thinking: false}` suppresses the
chain completely; `reasoning_effort: "none"` and a `/no_think` token in the prompt were
both probed on this model and both **silently ignored**, still producing a full chain and
no prose. That is why the flag rides `transformRequestBody` on the Featherless client
rather than the transport's own `reasoningEffort` option, and why it is keyed to exact
model ids: a model whose template spells the flag differently would ignore it just as
quietly.

The switch is per-model and opt-in, the same rule `NARRATOR_REASONING` follows for
OpenRouter. A Featherless model that does not use a thinking template is unaffected, and
`featherlessRequestBody` leaves its body byte-identical.

Re-verified 2026-08-17 with a 34-token synthetic prompt and `max_tokens: 300`:

| Request                        | Finish   | Content chars | Reasoning chars |
| ------------------------------ | -------- | ------------: | --------------: |
| no flag (template default)     | `length` |             0 |           1,081 |
| `enable_thinking: false`       | `stop`   |           144 |               0 |
| `thinking: false`              | `stop`   |           172 |               0 |
| `do_reasoning: false`          | `stop`   |           112 |               0 |
| all three `false`              | `stop`   |           116 |               0 |

**Probed per model, never inherited from the family.** Featherless documents reasoning
as on by default across the whole Qwen3 / 3.5 / 3.6 line, but "the family reasons" is
not evidence that a given merge honors this particular key — the entire premise of the
flag is that a template spelling it differently ignores it silently. F451 Ultra Pro
Writer was therefore probed the same way before it was listed, and failed identically:

| Model, 34-token prompt | No flag                        | `enable_thinking: false` |
| ---------------------- | ------------------------------ | ------------------------ |
| Fable Fusion 711       | `length`, 0 chars, 1,081 chain | `stop`, 144 chars, 2.4s  |
| F451 Ultra Pro Writer  | `length`, 0 chars, 1,096 chain | `stop`, 236 chars, 5.7s  |

A Qwen3.6 row that has not been probed gets no policy entry, and is therefore unusable
rather than quietly mediocre — which is the correct failure, because it is loud.

### Ruling 2026-08-17 — one disable key, not three

Featherless documents `enable_thinking`, `thinking` and `do_reasoning` as normalized
synonyms of one toggle, with a `false` value winning any conflict. The table above
probed each alias **alone** on this exact model: all three work identically. So the
request sends the one confirmed-sufficient key. Sending all three would be redundancy
against a hazard the evidence says does not exist, and it would leave a reader unable
to tell which key the model actually honors.

The provider's `POST /models/{owner}/{model}/debug/chat-format` endpoint would have
shown the rendered template directly, and it was tried. It is **not reachable with an
API token**: the path exists (it is `https://api.featherless.ai/models/…`, outside the
`/v1` prefix — the `/v1` spelling is a 404) but answers
`401 unauthorized — "You must be signed in to access this resource"`, i.e. it wants a
web session rather than a bearer key. The behavioral table above is the substitute, and
is arguably the better evidence anyway: it measures what the model did, not what the
template said.

## Why a reply read as empty

The symptom that motivated slice 1c: selecting this narrator frequently produced the
chat lane's "The narrator model finished without saying anything" popup. The cause was
not the model.

**`streamText`'s `textStream` never throws.** In AI SDK 6 an error part is *dropped* by
the `textStream` transform and the failure is delivered to the `onError` callback
instead, while `finishReason` / `rawFinishReason` / `totalUsage` are rejected. The chat
lane consumed only `textStream`, so a provider failure arrived as a clean stream of zero
deltas with no exception — and `streamExchange`'s `catch`, which
[pipeline.md](../character-chat/pipeline.md) describes as the classifier for provider
errors, never fired. Every such failure fell through to the one remaining verdict:
`empty_reply`, whose copy asserted the model had said nothing.

Confirmed for each status by driving the real provider stack against stubbed responses
on 2026-08-17. All four produced **zero visible characters and no thrown exception**:

| Upstream status          | SDK hands `onError`         | Now recorded as  |
| ------------------------ | --------------------------- | ---------------- |
| 503 `capacity_exhausted` | `RetryError` → APICallError | `provider_error` |
| 401 bad key              | `APICallError`              | `auth_failed`    |
| 402 out of credits       | `APICallError`              | `no_credits`     |
| 429 rate limited         | `RetryError` → APICallError | `rate_limited`   |

There is a second failure shape, and it is the one the live cold start actually takes:
Featherless answers **HTTP 200** and puts `{"error": {...}}` in an SSE frame. The
openai-compatible transport forwards that raw JSON object as the error part's payload —
a plain record, not an `Error`, with no status code. Read as an error it stringified to
`"[object Object]"` and classified as `unknown`. `classifyProviderError` now recognizes
a provider error envelope (a record carrying a string `message` or `code`) and reports
it as `provider_error` with the vendor's own words, while an unrelated object still
classifies as `unknown` rather than being dressed up as an upstream failure.

This correction is **diagnostic only**. No generation option, prompt, sampler setting or
retry behavior changes for any other model; what changes is that a failure which used to
be described as an empty reply is now described as what it was. Every proven OpenRouter
narrator benefits from the same correction for free.

### The completion record

`server/ai/narrator-completion.ts` owns `NarratorCompletion` — how a narrator generation
actually ended, read off the AI SDK's supported finish metadata: `provider`, `modelId`,
`finishReason`, `rawFinishReason`, `inputTokens`, `outputTokens`, `textTokens`,
`reasoningTokens`, `rawTextLength`, `visibleTextLength`, `visibleTextChars`, `attempts`,
and the classified `providerError` when one was reported in-stream.

Three properties matter:

- **Counts and finish state only.** No prompt, player text, prose, reasoning content,
  system prompt or private character state. The record is written to the chat row and to
  the server log, and a diagnostic carrying content would turn both into transcripts.
- **Every token field is optional.** Providers disagree about what they report —
  Featherless returns no `completion_tokens_details` on a non-streaming call — and
  unknown is never recorded as zero.
- **Raw and visible lengths are measured separately.** `rawTextLength` is counted
  UPSTREAM of the artifact/speaker-tag/repeat normalizers, `visibleTextLength`
  downstream. That difference is the only way to tell "the model said nothing" apart
  from "Vesper deleted everything the model said", and nothing is buffered to get it —
  each delta is counted as it is yielded.

The stream is consumed exactly once: `result.textStream` feeds a counting tap, the tap
feeds the normalizers, and the finish promises are awaited afterwards with
`Promise.allSettled` so one unavailable field costs neither the others nor the reply.

### The zero-visible-text taxonomy

`classifyEmptyNarratorCompletion` (pure) turns the record into a reply-failure verdict.
It is only reached for an exchange that produced no visible reply, was not stopped by the
player, did not trip a watchdog and threw nothing — those all outrank it, unchanged.

| Evidence                                     | Recorded as                           |
| -------------------------------------------- | ------------------------------------- |
| `content-filter` finish                      | `moderation_blocked`                  |
| `error` finish                               | the provider error's own class        |
| raw text > 0, nothing survived normalizing   | `empty_reply` / `normalizer_erased`   |
| `length` finish, or billed-but-unseen tokens | `empty_reply` / `reasoning_or_length` |
| `stop` finish with no such evidence          | `empty_reply` / `model_silent`        |
| none of the above                            | `empty_reply`, no cause               |

The normalizer check comes first among the empty causes deliberately: if the model
produced prose and Vesper discarded it, that is this repo's bug, and a record blaming the
model would point every future investigation at the wrong system.

"Billed-but-unseen tokens" needs a floor, because a stop sequence or a lone
end-of-turn token can be billed on a genuinely silent completion. The rule is
`reasoningTokens > 0`, or **8+ output tokens with zero characters of text**.

No new failure code was added. `ChatReplyFailureCause` is an optional refinement of
`empty_reply` on the same jsonb record (`character_chats.last_reply_failure`), so no
migration, and a record written before the field existed simply carries no cause. The
top-level `ChatReplyFailureCode` vocabulary is unchanged, and every reader that branches
on `code` keeps working.

## The exact-model request policy

### Ruling 2026-08-17 — this row ships its author's sampling baseline

The plan's standing non-goal is that published model-card settings are hypotheses, not
production defaults, and that a knob set on one bench arm would confound a comparison.
The owner ruled an exception for this exact model on reliability grounds: it is a
non-thinking/instruct merge being asked with its thinking template off, which is the
configuration its author's recommended sampling baseline describes, and asking it with
the repo's generic defaults instead is not a neutral control — it is a different
configuration from the one the weights were tuned for.

So `FEATHERLESS_MODEL_POLICY` in `server/ai/provider.ts` keys the following to the two
probed DavidAU ids, and to nothing else. They share ONE policy object
(`DAVIDAU_QWEN36_NON_THINKING`) rather than two copies of the same numbers, because the
pair exists to be compared: a sampler difference between them would confound the only
question the comparison asks. If a later probe rules a different baseline for one, that
object is split rather than edited.

| Field                | Value | Why not the default                             |
| -------------------- | ----: | ----------------------------------------------- |
| `temperature`        |   0.7 | `NARRATIVE_TEMPERATURE` is 0.85, repo-wide      |
| `top_p`              |   0.8 | tighter nucleus than the transport default      |
| `top_k`              |    20 | no AI SDK equivalent — dropped as "unsupported" |
| `presence_penalty`   |   1.5 | the instruct template's expected pressure       |
| `repetition_penalty` |   1.0 | not in the AI SDK's standard call settings      |

`NARRATIVE_TEMPERATURE` itself is untouched, and every other narrator — OpenRouter and
Featherless alike, including any unprobed Featherless row — is asked exactly as before.
Two of these fields have no AI SDK call-setting equivalent at all, which is the second
reason the policy rides `transformRequestBody` rather than the call sites.

**Riding the transport is what gives the successor narrator parity for free.** Both
narrator paths reach Featherless through `textModel` — `streamCharacterChat` for the
chat lane, `generateChecked` for the successor renderer — so a policy applied in the
transport's request-body hook is applied to both, and neither call site learns a model's
name. The successor deliberator and every structured agent are unreachable from here by
construction: the narrator list is the only model list that may name a provider.

### The hidden retry

The chat lane gives these two models a **second attempt** when the first produced no
visible text at all. `hiddenEmptyRetry` in the policy above is the exact-model gate;
`narratorHiddenRetryModel` returns false for every other id, including any unprobed
Featherless row.

Conditions, all required:

- zero user-visible text was emitted (whitespace does not count — the stream uses the
  same non-whitespace test the pipeline's `full.trim()` applies);
- the finish was neither `content-filter` (the same ask is refused again) nor `error`
  (the provider says the generation itself failed, and a 503 must not be hidden inside
  empty-reply logic);
- the player has not aborted;
- nothing was thrown. Auth, credit, context-window, network and ordinary provider
  exceptions all propagate on the first attempt and are never retried.

It is safe precisely because it is conditioned on zero emission: nothing reached the
player, so nothing can be duplicated. A partial reply is never retried.

The retry lives **inside `streamCharacterChat`**, not in the pipeline, so it inherits the
existing ownership instead of competing with it: both attempts carry the caller's abort
signal (a player Stop stops the retry) and the first-token/overall watchdogs wrap the
whole generator, so two attempts share one budget rather than doubling it. A normalizer
erasure IS retried — it is a zero-visible-text completion by definition, and a fresh
sample usually lands outside whatever the collapse rules matched.

`retryMinTokens: 48` applies a `min_tokens` floor to the **retry only**, and only when
the first attempt was a genuinely silent stop. Featherless accepts `min_tokens` (probed
2026-08-17); it is passed per-call as `providerOptions.featherless`, which the
openai-compatible transport spreads into the body — that is what scopes it to one call
rather than the transport-wide policy. A length/reasoning empty deliberately does **not**
get the floor: that model already generated plenty, just not prose, and forcing more
tokens would treat a configuration failure as a length problem. There is no global
minimum response length, and there must not be — that is how narrator padding gets
resurrected.

### The successor narrator keeps its own retry

`renderCommittedCut` and `renderSoloNarration` already run two attempts with
audit-driven and empty-prose retries respectively, on top of `generateChecked`'s own
repair round-trip and degraded fallback. No hidden retry was added there, and their retry
semantics are unchanged. They also need none of the chat lane's stream forensics:
`generateChecked` calls `generateText`, which **does** throw, so its existing transport
classification already sees a cold start as the provider failure it is.

## Ownership rules

- `lib/narrative-models.ts` is the single source of narrator options. The client
  dropdown and the server resolver both read it; neither may hold its own list.
- `narrativeModelId` (`server/ai/provider.ts`) stays **strict**. A stored or
  over-the-wire id that is not on the list coerces to the default and logs
  `ai.narrative_model`. This is a billing boundary, not a tidiness rule: without it
  an authenticated user could bill arbitrary OpenRouter slugs to the deployment key
  through a chat PATCH. Bench rows are cheap, but the rule is what makes adding them
  safe.
- Per-model call policy stays out of the list. `NARRATOR_REASONING`,
  `PROVIDER_IGNORE`/`PROVIDER_ORDER` and `FEATHERLESS_MODEL_POLICY` in
  `server/ai/provider.ts` are all keyed by exact model id. Every bench row **except
  Fable Fusion 711** is absent from all of them and is therefore asked with plain
  defaults — temperature `NARRATIVE_TEMPERATURE` (0.85) and nothing else. That is
  deliberate for a comparison: a knob set on one arm and not another would confound it.
  The two DavidAU Qwen3.6 rows are the recorded exception, on reliability grounds and
  by owner ruling — see
  [The exact-model request policy](#the-exact-model-request-policy). They share one
  profile so they stay comparable with each other; any comparison including either
  must read that profile as part of the arm.
- **The narrator list is the only model list that may name a provider.**
  `lib/agent-models.ts`, `lib/composer-models.ts`, the embedding model and the vision
  model are OpenRouter-only and are not given the field. `textModel` still routes them,
  because routing every text call through one function is what stops a second path
  existing — but for those lists it always answers OpenRouter.
- **OpenRouter's call knobs never leave OpenRouter.** `providerRouting` and
  `narrativeProviderOptions` return `undefined` for any non-OpenRouter id. The routing
  block, the endpoint ignore/order lists and the reasoning knob are that vendor's API
  surface; forwarding them would be asking one provider to honor another's parameters.

## Resilience

The bench rides the existing narrator path, so a bench model that errors, refuses, or
returns nothing degrades exactly as any narrator does today
(`components/chat/reply-failure.ts`).

The second provider adds one new degraded default and inherits the rest:

- **Missing credential ⇒ the lane default, not a failed turn.** See
  [The provider-key gate](#the-provider-key-gate). Logged as
  `ai.chat_narrative_model` / `ai.narrative_model`.
- **Cold start surfaces as a provider error naming the capacity warm-up.** Featherless
  answers `503` `capacity_exhausted` — or HTTP 200 with an error frame in the SSE
  stream — while an idle model loads. Measured on 2026-08-17 it surfaces after **~14s**
  through the AI SDK's own three-attempt retry budget, comfortably inside
  `CHAT_STREAM_FIRST_TOKEN_MS` (50s). The reply failure records `provider_error` with
  the vendor's own "temporarily at capacity" wording, which the popup quotes.

  A previous revision of this document claimed those retries ran ~191s and presented as
  a `timeout`. That is superseded: the retry budget is three attempts, and the failure
  presented as an **empty reply**, not a timeout — see
  [Why a reply read as empty](#why-a-reply-read-as-empty).

  This is survivable rather than fixed: the lock releases, the failure is attributable
  and legible, and the player's next send usually lands on a warm model. Making that
  first send after an idle period succeed rather than fail is recorded as an open
  question on the plan — it is a warm-up strategy, not a classification bug, and the
  classification is now correct.
- **A reasoning model's chain is never mistaken for prose.** The transport routes
  `reasoning` deltas to reasoning parts, so `textStream` carries prose only.
- **A zero-visible-text completion is classified from evidence, not from silence.** See
  [The zero-visible-text taxonomy](#the-zero-visible-text-taxonomy).
- **A transient zero-text completion costs the player nothing.** This one row retries
  once, invisibly — see [The hidden retry](#the-hidden-retry).

One known-untested boundary is recorded as an open question in the plan: a 32K row
overflowing its context on a long chat. The provider returns an error rather than
silently truncating, which should surface as an ordinary reply failure, but this has not
been observed.

## Fixtures and tests

`narrative-models.test.ts` (pure suite) covers the list's shape: id form **per
provider** (OpenRouter slug or Hugging Face repo path), unique ids, unique labels, both
defaults present and curated, `resolveChatModelId` passing every curated id through,
and `narrativeModelProvider` agreeing with each row while defaulting an unlisted id to
OpenRouter. The label-uniqueness case came in with slice 1 — the dropdown renders the
label and nothing else, so two rows sharing one would be an unpickable option, and the
bench's same-family rows (two Euryale versions, four TheDrummer tunes) are where that
would bite.

`provider.test.ts` covers the seam: `textModel` routing each id to the transport that
serves it (asserted on the built model's `provider`, so no network call is involved),
`providerRouting`/`narrativeProviderOptions` staying silent for a Featherless id even
when latency sort is requested, and the provider-key gate in both directions —
pass-through with the token set, lane default with it missing or blank, OpenRouter rows
unaffected either way. The Featherless id is read off `NARRATIVE_MODELS` rather than
written out, so relabelling or replacing the row cannot rot the file.

`test/setup.ts` deletes `FEATHERLESS_API_TOKEN` alongside the other provider
credentials. Demo mode keys off `OPENROUTER_API_KEY`, but the key gate reads the
Featherless token directly, so a developer with the secret exported would otherwise get
different resolver results than a clean checkout.

Slice 1c adds four test surfaces, all in the pure suite and none of them
network-dependent:

- **`provider.test.ts`** additionally covers the exact-model policy: the thinking flag,
  exactly one disable key, the sampler profile applied over the call site's temperature,
  and the retry gate. Its isolation cases assert the inverse for a second Featherless id,
  for the proven OpenRouter narrators by name, and for the resolved state-agent and
  scene-composer models — plus that `narrativeProviderOptions` and `providerRouting`
  still answer exactly what they answered before for each of them.
- **`narrator-completion.test.ts`** covers the taxonomy case by case, including the
  billed-but-unseen floor, the normalizer-over-length precedence, and that a log payload
  omits every count the provider did not report.
- **`character-chat.test.ts`** scripts `streamText` attempt by attempt to cover the
  completion record and the retry: retry-then-succeed, exactly two attempts, the
  retry-only `min_tokens` floor and its withholding on a length empty, no retry on
  moderation / generation error / thrown exception / player abort / partial reply, and no
  retry at all for a non-Fable narrator. Its last block re-asserts that an OpenRouter
  narrator's request options are byte-identical.
- **`featherless-wire.test.ts`** proves the link a pure unit test cannot: that the
  transport really is built with the policy as its `transformRequestBody` hook. It stubs
  `globalThis.fetch` and asserts the serialized body for the successor lane
  (`generateChecked` → `generateText`) and the chat lane (`streamText`) separately,
  because the AI SDK applies the hook in `doGenerate` and `doStream` independently. It
  also pins the cold start end-to-end through the real provider stack: an error finish,
  the vendor's own words, one attempt, and the SDK's three-request retry budget.

`pnpm probe:featherless-narrator` (`scripts/eval/featherless-narrator/probe.ts`) is the
opt-in live probe behind the measurements above. It is in no suite and `pnpm verify` never
runs it — it makes real, billed calls — and without `FEATHERLESS_API_TOKEN` it prints why
it skipped and exits 0. It runs through `streamCharacterChat` rather than calling the
provider itself, so what it measures is the production path; it prints counts, finish
state, TTFT and the outgoing sampler fields, and never prose or reasoning content.

Slice 2's comparison fixtures are not started. The machinery it should use already
exists: `scripts/eval/narrator-comparison/harness.ts` runs independent per-arm
histories through the production `streamCharacterChat`, with deterministic blinding
and strict quote verification for judges. It is campaign-neutral by design, so the
bench needs fixtures and a judge, not a new runner.
