# Asmodeus 24B v3

**Exact id:** `DarkArtsForge/Asmodeus-24B-v3`
**Host:** Featherless, over its OpenAI-compatible `/v1/chat/completions`
**Adapter:** `packages/text-models/src/families/mistral-24b/asmodeus-24b-v3.ts`
**Provenance:** probed 2026-09-04 against `featherless` model record `DarkArtsForge/Asmodeus-24B-v3`.

A Mistral-Small-24B narrator merge, published by its author as fully uncensored, and the first model Vesper asks with its author's **whole** published profile rather than a trimmed subset. Featherless carries seven of those values; the rest are declared and withheld. Everything below the provenance line was read from that model record, from a field sweep against that exact id, or from the production narrator seam on that date.

## Owns / does not own

- **Owns:** this checkpoint's host facts, field verdicts, template and tokenizer behavior, measured runtime behavior, and the request body Vesper actually sends it.
- **Does not own:** the feature vocabulary and dialect tables — [text-models](../README.md). Verdict definitions and how hosts disagree in general — [the catalog index](README.md). Which surfaces offer this row — the narrator catalog. How an empty or failed reply reaches a player — [reply failures](../../character-chat/reply-failures.md).

## Capabilities and cost

| Fact                    | Value                                                          |
| ----------------------- | -------------------------------------------------------------- |
| `model_class`           | `mistral-24b`                                                  |
| `context_length`        | 32,768 tokens                                                  |
| `concurrency_cost`      | 2                                                              |
| `availability.tier`     | `warm`                                                         |
| `status`                | `active`                                                       |
| `max_completion_tokens` | unreported — absent from the host's record                     |
| Chat template           | the repository's own `chat_template.jinja`, Mistral Tekken     |
| Thinking model          | no                                                             |
| Licence                 | Apache-2.0                                                     |
| Price                   | $0.70 per M prompt tokens, $1.16 per M completion tokens       |

The per-model record is readable unauthenticated at `GET /v1/models/DarkArtsForge/Asmodeus-24B-v3` with an explicit `User-Agent`; the `/v1/models` list is not.

## The chat template

Featherless applies the model repository's own template and renders `<s>[SYSTEM_PROMPT]{system}[/SYSTEM_PROMPT][INST]{user}[/INST]{assistant}[INST]{user}[/INST]` — Tekken-shaped, with a dedicated system block. An empty system message emits no block; a system message placed last renders inline where it sits. The adapter therefore declares `mistral-tekken` and sends no template of its own: declaring one here is a record of which template the host applies, never a second copy of it.

Two properties of that template matter to anything that writes prompts for this row.

**The `/think` substring trap.** The template tests `"/think" in system_message` as a plain substring on the **initial** system message, and on a hit injects a thinking preamble and a `[THINK]…[/THINK]` scaffold. The test is case-sensitive and not word-bounded, so incidental text such as `over/thinking` triggers it. Later inline system messages do not take that branch. A hit requests a scratchpad; it does not change the model's architecture and does not guarantee a reasoning budget or the loss of the final prose — but since `chat_template_kwargs` is rejected on this tokenizer, no request field can switch the scaffold off once it is triggered. Check assembled initial-system text when changing this row's prompts.

**The assistant terminator is not stably rendered.** The published template appends `eos_token` after an assistant message and the tokenizer defines that token as `</s>`, so the intended format ends an assistant turn with it. In 32 identical debug renders, 4 closed the assistant turn with `</s>` and 28 did not. The following `[INST]` still marks an instruction boundary where it is missing. Neither the cause of the discrepancy nor any effect on the model's output is established, and formatting variability is a separate question from sampling variability. Matching 4,980-token counts between the debug render and the completions API's `prompt_tokens` support the debug endpoint's relevance; they do not prove identical token sequences, nor that the omission exists in the input to actual inference. Vesper adds no second template, appends no terminator by hand, and treats the observation as recorded rather than acted on.

## Measured field acceptance

Verdicts use [the catalog's vocabulary](README.md). Truncation samplers cannot move the argmax, so each was sent at its most restrictive value on top of `temperature: 5` — measured to degrade this model to an ordinary-character ratio of 0.75–0.91 — and judged by whether it restored coherent text.

| Field                       | Verdict                 | Note                                                                         |
| --------------------------- | ----------------------- | ---------------------------------------------------------------------------- |
| `temperature`               | accepted+effective      | 5 degrades the ratio to 0.85–0.88 and runs to the cap; 0 sits at 1.0          |
| `top_p`                     | accepted+effective      | 0.01 restores a ratio of 1.0 without reproducing the argmax exactly           |
| `top_k`                     | accepted+effective      | 1 restores 1.0 and stops on its own; byte-identical to `min_p`               |
| `min_p`                     | accepted+effective      | 1 restores 1.0 and stops on its own                                          |
| `repetition_penalty`        | accepted+effective      | 2 produces a completion outside the greedy anchor set, twice                 |
| `presence_penalty`          | accepted+effective      | same standard                                                                |
| `frequency_penalty`         | accepted+effective      | same standard                                                                |
| `seed`                      | accepted+effective      | identical text for one seed at temperature 1; see determinism below          |
| `max_tokens`                | accepted+effective      | `finish_reason: length` at exactly the requested count                       |
| `min_tokens`                | accepted+effective      | 47 produced 48 completion tokens against anchors that stopped at 20          |
| `stop`                      | accepted+effective      | `["."]` produced 4 completion tokens                                         |
| `include_stop_str_in_output` | accepted+ignored       | documented, and the stop string is not retained                              |
| `top_nsigma`                | accepted+ignored        | ratio inside the temperature-5 control band                                  |
| `typical_p`                 | accepted+ignored        | ratio inside the control band                                                |
| `tfs`                       | accepted+ignored        | ratio inside the control band                                                |
| `top_a`                     | accepted+ignored        | ratio inside the control band                                                |
| `smoothing_*`               | accepted+ignored        | ratio inside the control band                                                |
| `dynatemp_*`                | accepted+ignored        | pinned to 0 it would have decoded greedily if honoured                       |
| `dry_*`                     | accepted+ignored        | byte-identical to a plain greedy completion; sent as a group                 |
| `xtc_*`                     | accepted+ignored        | byte-identical at XTC certainty                                              |
| `mirostat_*`                | accepted+ignored        | byte-identical; mirostat overrides a decode when honoured                    |
| `stop_token_ids`            | accepted+unmeasured     | a null result cannot separate ignored from never-sampled                     |
| `logit_bias`                | accepted+unmeasured     | needs a token id from this checkpoint's tokenizer                            |
| `repetition_penalty_range`  | accepted+unmeasured     | an 8-token window may not bite inside a 48-token completion                  |
| `chat_template_kwargs`      | **rejected**            | 400 on this Mistral tokenizer, empty object included                         |

The pattern is exact: the host honours its documented parameter set and silently drops every undocumented one. Both exceptions sit inside the documented set — one documented field is ignored, and `chat_template_kwargs` is refused outright.

## The author's profile, and what ships

The author publishes a KoboldCpp profile. Its headline is a temperature and top-n-sigma **pair** tuned together; Featherless does not implement top-n-sigma, so that pairing cannot ship whole on this host. Owner ruling 2026-09-04: ship the author's recommended profile and let host selection deactivate the fields the host does not honour, rather than deleting their values or falling back to lane defaults.

Carried on Featherless:

| Feature             | Value | Wire field           |
| ------------------- | ----- | -------------------- |
| `temperature`       | 1.0   | `temperature`        |
| `topP`              | 1.0   | `top_p`              |
| `topK`              | 100   | `top_k`              |
| `minP`              | 0.1   | `min_p`              |
| `repetitionPenalty` | 1.08  | `repetition_penalty` |
| `presencePenalty`   | 0     | `presence_penalty`   |
| `maxTokens`         | 1024  | `max_tokens`         |

Declared and withheld — the local-runtime half, kept so the record of how the model was meant to be asked survives a host that serves less than its author tuned against:

| Feature                                                      | Value                |
| ------------------------------------------------------------ | -------------------- |
| `topNsigma`                                                  | 1.25                 |
| `repetitionPenaltyRange` / `repetitionPenaltySlope`          | 360 / 0.7            |
| `dryMultiplier` / `dryBase` / `dryAllowedLength` / `dryRange` | 0.8 / 1.75 / 2 / 320 |
| `xtcProbability` / `xtcThreshold`                            | 0.1 / 0.08           |
| `dynatempMin` / `dynatempMax`                                | 0.65 / 1.35          |

Two of the author's settings are recorded here and **not** declared in the adapter:

- **Em-dash and ellipsis token bans.** The author bans them by token id, and a bias map is keyed to a tokeniser: the same map moved to another checkpoint bans different text, silently. Nobody has read those ids off this checkpoint, so the guidance is recorded and no `logitBias` is declared. Inventing ids would be a measurement Vesper did not make.
- **`presencePenalty: 0` is a value, not an omission.** Zero is this penalty's neutral point, and stating it is what keeps a reader from seeing an absent key and assuming a default was inherited.

The dynamic-temperature band and the static temperature coexist deliberately: a runtime that honours the band moves within it per token, and a host without it uses the static value instead.

## The request Vesper sends

Both narrator lanes build this call through one model gateway, so the body is the same in character chat and successor chat apart from the messages and the streaming flag:

```json
{
  "model": "DarkArtsForge/Asmodeus-24B-v3",
  "max_tokens": 1024,
  "temperature": 1,
  "top_p": 1,
  "presence_penalty": 0,
  "top_k": 100,
  "min_p": 0.1,
  "repetition_penalty": 1.08,
  "messages": []
}
```

`chat_template_kwargs` is **absent**, and its absence is a requirement rather than an omission: the field 400s this model. The four settings the SDK models travel as call settings; `top_k`, `min_p` and `repetition_penalty` ride the raw body because the OpenAI-compatible client does not model them.

The adapter's 1,024-token cap outranks a lane's own output budget, so the successor lane's generic 2,000 becomes 1,024 on this row. That is the point of an exact-model profile: the cap is this checkpoint's context arithmetic, not a lane's preference.

## Context, and the cap that buys it

The model ends its own turns — every short probe call finished on `stop` with prose — so the cap is not a stop condition. It is an **admission** control. With no `max_tokens` the host reserves a 4,096-token output budget inside the same 32,768-token window and refuses a request that does not leave room for it:

| Request                                  | Result                                                         |
| ---------------------------------------- | -------------------------------------------------------------- |
| 31,594-token prompt, no `max_tokens`     | 400 — 4,096 requested output plus 31,594 input exceeds 32,768   |
| identical prompt, `max_tokens: 256`      | 200 — 31,594 prompt tokens, 27 completion tokens               |

Owner ruling 2026-09-14: send an explicit cap of 1,024. Usable prompt is therefore **31,744 tokens**, against ~28,672 for a caller that sends none, and the longest reply measured on this row was 404 completion tokens.

**It errors at the edge; it does not silently truncate.** A prompt over the window is refused with the host's own `context_too_long` message quoting both counts, and a prompt under the window but over the admission budget is refused as a generic bad request. Through the streaming seam the second case surfaces only as "The request was rejected as invalid", so a player hitting it gets a reply-failure popup that cannot say why; the informative wording comes from a direct non-streaming call. Neither case returns a 200 with a reduced input count.

## Measured runtime behavior

- **No thinking.** Reasoning tokens are 0 on every call, and raw text length equals visible text length everywhere — no normalizer had to act.
- **No empty replies.** Nine of nine short calls returned prose on `finish_reason: stop`. The row therefore earns **no hidden empty retry** and no minimum-token retry floor: there is no empty-reply failure to cover, and a retry would be latency spent against a hazard the evidence does not show.
- **No cold start observed.** The tier is `warm`, the first call of each session answered in 0.8–2.2s to first token, and no `503 capacity_exhausted` appeared across roughly 90 calls. The row carries no startup-budget override, and that absence is a measurement.
- **Latency.** First token in 0.7–2.5s on small and Vesper-sized prompts. A one-word "terse invite" prompt is the outlier at up to 22.2s to first token and 36s total — inside the chat lane's 50s first-token budget, and the shape most likely to be slow because there is nothing to anchor on.
- **Speaker tags.** The line-start `[Name]` grammar held on 6 of 6 calls whose system prompt carried the instruction close by, and on 0 of 3 for a fixture that buried the instruction under ~8,800 tokens of filler. Stray bracketed spans were 0 everywhere, and one asterisk-action span appeared across nine calls, so this row does not insist on asterisk-action syntax.
- **Determinism is per server, not per host.** The model is served from a pool: each server decodes deterministically, but repeated greedy calls do not all land on the same server, and greedy returned completions of 20, 35, 36 and 38 tokens across runs. A seed reproduced two calls, and the host documents seeds as unreliable across its pool. Nothing may be built on determinism from this host, and a probe comparing completions by hash needs an anchor set.
