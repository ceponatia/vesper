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

| Model                                     | Context | $/M in–out | Lane                    |
| ----------------------------------------- | ------: | ---------: | ----------------------- |
| `DavidAU/Qwen3.6-27B-Fable-Fusion-711-…`  |     32K |  1.06–2.60 | Uncensored Qwen3.6 merge |

The row's full id is
`DavidAU/Qwen3.6-27B-Fable-Fusion-711-Uncensored-Heretic-NM-DAU-MTP`, added on owner
request as the first model from this provider. Measured against the live endpoint the
day it was added:

- **It reasons before it narrates.** The response carries a `reasoning` field of
  roughly 1,300 tokens ahead of any prose. The transport routes that to reasoning
  parts, so none of it reaches the bubble or the transcript — it is paid for and it
  delays the first visible token.
- **First visible token at ~61s** on a 46-token prompt, ~10s more for a
  two-paragraph reply (~22 tok/s). See
  [The first-token problem](#the-first-token-problem) — this is the one thing about
  the row that is not just a bench observation.
- **Cold start ~25s.** The first call to an idle model answers `503`
  `capacity_exhausted` while Featherless loads the weights.
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
  `code: "capacity_exhausted"` for roughly 25 seconds while its weights load, then
  serves normally. It is a warm-up, not an outage, but it is a real first-call failure.
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

### The first-token problem

The chat lane aborts a reply that produces no visible token within
`CHAT_STREAM_FIRST_TOKEN_MS` (50s), and that ceiling is not tunable upward: it is
deliberately under Fly's ~60s proxy idle timeout, past which the proxy kills a
response that has sent zero bytes.

A model that reasons before it narrates spends that budget invisibly. The first
Featherless row measured **~61s to first visible token** on a 46-token prompt through
the app's own gateway — over the watchdog before Vesper's real ~17K-token prompt adds
any prefill. **On the deployed app this row is expected to trip the first-token
watchdog and settle as a `timeout` reply failure rather than narrate.**

This is recorded as an open question in the plan rather than fixed here, because every
available answer is a product decision: suppress the model's thinking if its provider
accepts a knob for it, restrict thinking narrators to a lane without a proxy idle
ceiling, or drop the row. Nothing about the seam depends on the answer — a
non-reasoning Featherless model would run inside the existing budget today.

## Ownership rules

- `lib/narrative-models.ts` is the single source of narrator options. The client
  dropdown and the server resolver both read it; neither may hold its own list.
- `narrativeModelId` (`server/ai/provider.ts`) stays **strict**. A stored or
  over-the-wire id that is not on the list coerces to the default and logs
  `ai.narrative_model`. This is a billing boundary, not a tidiness rule: without it
  an authenticated user could bill arbitrary OpenRouter slugs to the deployment key
  through a chat PATCH. Bench rows are cheap, but the rule is what makes adding them
  safe.
- Per-model call policy stays out of the list. `NARRATOR_REASONING` and
  `PROVIDER_IGNORE`/`PROVIDER_ORDER` in `server/ai/provider.ts` are keyed by model id
  and are empty for every bench row, so each is asked with plain defaults —
  temperature `NARRATIVE_TEMPERATURE` (0.85) and nothing else. That is deliberate for
  a comparison: a knob set on one arm and not another would confound it.
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
- **Cold start surfaces as a provider error.** Featherless answers `503` with
  `code: "capacity_exhausted"` for ~25s while an idle model loads.
  `classifyProviderError` reads the status, not the vendor, so this lands as
  `provider_error` with the vendor's own words as `detail` — an accurate, attributable
  failure. There is no warm-up retry: the reply fails, and the player's next send
  usually lands on a warm model. A retry would be a real design decision (it doubles a
  slow leg's worst case) and is not one this work took.
- **A reasoning model's chain is never mistaken for prose.** The transport routes
  `reasoning` deltas to reasoning parts, so `textStream` carries prose only.

Two known-untested boundaries are recorded as open questions in the plan: a 32K row
overflowing its context on a long chat (the provider returns an error rather than
silently truncating, which should surface as an ordinary reply failure, but this has
not been observed), and [the first-token problem](#the-first-token-problem).

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

Slice 2's comparison fixtures are not started. The machinery it should use already
exists: `scripts/eval/narrator-comparison/harness.ts` runs independent per-arm
histories through the production `streamCharacterChat`, with deterministic blinding
and strict quote verification for judges. It is campaign-neutral by design, so the
bench needs fixtures and a judge, not a new runner.
