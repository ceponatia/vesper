# Narrator model test bench — technical spec

Status: companion to [narrator-model-bench.plan.md](narrator-model-bench.plan.md)

The implementation contract for coding agents. Product scope, priority, and open
questions live in the plan; this document is how the decisions in it get built.

## Scope

This spec governs the curated narrator roster in `apps/web/src/lib/narrative-models.ts`
and the evidence behind it. It deliberately leaves alone the in-session agent list
(`lib/agent-models.ts`), the scene composer list (`lib/composer-models.ts`), and the
image model registry — each keeps its own curated list and its own resolver.

## Implementation status

- **Slice 1 — the bench is pickable** — built 2026-08-17. Eleven ids added to
  `NARRATIVE_MODELS`; a label-uniqueness guard added to `narrative-models.test.ts`.
  No other file changed: the dropdown, the resolver, the persistence column and the
  provider options all read the list already.
- **Slice 2 — a recorded comparison** — not started.
- **Slice 3 — a default ruling** — not started, blocked on slice 2.

### Ruling 2026-08-17 — the bench is a list edit, not a provider seam

The search that motivated this work assumed a provider-neutral narrator seam would
be needed, because the models of interest live on Hugging Face. The probes below
found the opposite: the narration fine-tunes worth testing are hosted on OpenRouter
already, and the alternative providers are each disqualified on measurements. So no
seam was built. `NARRATIVE_MODELS` stays a list of OpenRouter slugs, and adding a
narrator stays a one-line change.

This ruling is about **today's candidates**, not about provider neutrality forever.
If a model that exists nowhere hosted becomes the one worth having, packaging it
onto Replicate GPU infrastructure is the escape hatch — and that would be the point
at which a seam earns its complexity.

## The bench roster

Every id is an OpenRouter slug, verified present in the live catalog and called once
to confirm it narrates. Prices are dollars per million tokens, prompt/completion, as
quoted by the catalog on 2026-08-17.

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
- **Not hosted anywhere reachable.** Midnight-Miqu-70B, Magnum-v4-SE,
  Slimaki-Tavern-24B, Novelist-Eclipse-31B, Qwythos, Goetia, and the DavidAU,
  nightmedia, huihui-ai and HauhauCS families are published as weights only. None is
  served by OpenRouter, and Hugging Face's router serves none of them either.
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

All three alternatives were probed against live endpoints on 2026-08-17 rather than
assessed from documentation. Each is rejected, and each rejection has a number
behind it.

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

Unchanged. `NarrativeModelOption` stays `{ id, label }` in `lib/narrative-models.ts`
(pure, no IO). The bench adds rows; it adds no field and no type.

A `description` field was considered, mirroring `SceneComposerModelOption`, and
rejected: the narrator dropdown renders through the shared `ModelSelect`
(`components/ui/model-select.tsx`), which shows the label only, so a description
would have required a second bespoke select for no decision the label cannot carry.
The per-model rationale lives in code comments and in this spec instead.

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

## Resilience

No new trust boundary. The bench rides the existing narrator path, so a bench model
that errors, refuses, or returns nothing degrades exactly as any narrator does today
(`components/chat/reply-failure.ts`).

One known-untested boundary is recorded as an open question in the plan: a 32K row
overflowing its context on a long chat. OpenRouter returns an error rather than
silently truncating, which should surface as an ordinary reply failure, but this has
not been observed.

## Fixtures and tests

`narrative-models.test.ts` (pure suite) covers the list's shape: OpenRouter slug
form, unique ids, unique labels, both defaults present and curated, and
`resolveChatModelId` passing every curated id through. The label-uniqueness case is
new with this work — the dropdown renders the label and nothing else, so two rows
sharing one would be an unpickable option, and the bench's same-family rows (two
Euryale versions, four TheDrummer tunes) are where that would bite.

Slice 2's comparison fixtures are not started. The machinery it should use already
exists: `scripts/eval/narrator-comparison/harness.ts` runs independent per-arm
histories through the production `streamCharacterChat`, with deterministic blinding
and strict quote verification for judges. It is campaign-neutral by design, so the
bench needs fixtures and a judge, not a new runner.
