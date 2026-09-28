# Asmodeus 24B v3

**Exact id:** `DarkArtsForge/Asmodeus-24B-v3`
**Host:** Featherless, over its OpenAI-compatible `/v1/chat/completions`
**Adapter:** `packages/text-models/src/families/mistral-24b/asmodeus-24b-v3.ts`
**Provenance:** probed 2026-09-04 against `featherless` model record `DarkArtsForge/Asmodeus-24B-v3`.

A Mistral-Small-24B narrator merge, published by its author as fully uncensored, and the first model Vesper asks with its author's **whole** published profile rather than a trimmed subset. Featherless carries seven of those values; the rest are declared and withheld. Everything below the provenance line was read from that model record, from a field sweep against that exact id, or from the production narrator seam on that date — except the turn-reliability and latency record, which dates each probe it reports.

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

| Field                        | Verdict                 | Note                                                                         |
| ---------------------------- | ----------------------- | ---------------------------------------------------------------------------- |
| `temperature`                | accepted+effective      | 5 degrades the ratio to 0.85–0.88 and runs to the cap; 0 sits at 1.0         |
| `top_p`                      | accepted+effective      | 0.01 restores a ratio of 1.0 without reproducing the argmax exactly          |
| `top_k`                      | accepted+effective      | 1 restores 1.0 and stops on its own; byte-identical to `min_p`               |
| `min_p`                      | accepted+effective      | 1 restores 1.0 and stops on its own                                          |
| `repetition_penalty`         | accepted+effective      | 2 produces a completion outside the greedy anchor set, twice                 |
| `presence_penalty`           | accepted+effective      | same standard                                                                |
| `frequency_penalty`          | accepted+effective      | same standard                                                                |
| `seed`                       | accepted+effective      | identical text for one seed at temperature 1; see determinism below          |
| `max_tokens`                 | accepted+effective      | `finish_reason: length` at exactly the requested count                       |
| `min_tokens`                 | accepted+effective      | 47 produced 48 completion tokens against anchors that stopped at 20          |
| `stop`                       | accepted+effective      | `["."]` produced 4 completion tokens                                         |
| `include_stop_str_in_output` | accepted+ignored        | documented, and the stop string is not retained                              |
| `top_nsigma`                 | accepted+ignored        | ratio inside the temperature-5 control band                                  |
| `typical_p`                  | accepted+ignored        | ratio inside the control band                                                |
| `tfs`                        | accepted+ignored        | ratio inside the control band                                                |
| `top_a`                      | accepted+ignored        | ratio inside the control band                                                |
| `smoothing_*`                | accepted+ignored        | ratio inside the control band                                                |
| `dynatemp_*`                 | accepted+ignored        | pinned to 0 it would have decoded greedily if honoured                       |
| `dry_*`                      | accepted+ignored        | byte-identical to a plain greedy completion; sent as a group                 |
| `xtc_*`                      | accepted+ignored        | byte-identical at XTC certainty                                              |
| `mirostat_*`                 | accepted+ignored        | byte-identical; mirostat overrides a decode when honoured                    |
| `stop_token_ids`             | accepted+unmeasured     | a null result cannot separate ignored from never-sampled                     |
| `logit_bias`                 | accepted+unmeasured     | needs a token id from this checkpoint's tokenizer                            |
| `repetition_penalty_range`   | accepted+unmeasured     | an 8-token window may not bite inside a 48-token completion                  |
| `chat_template_kwargs`       | **rejected**            | 400 on this Mistral tokenizer, empty object included                         |

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

| Feature                                                       | Value                |
| ------------------------------------------------------------- | -------------------- |
| `topNsigma`                                                   | 1.25                 |
| `repetitionPenaltyRange` / `repetitionPenaltySlope`           | 360 / 0.7            |
| `dryMultiplier` / `dryBase` / `dryAllowedLength` / `dryRange` | 0.8 / 1.75 / 2 / 320 |
| `xtcProbability` / `xtcThreshold`                             | 0.1 / 0.08           |
| `dynatempMin` / `dynatempMax`                                 | 0.65 / 1.35          |

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

The model ends its own turns — every short call of the provenance probe finished on `stop` with prose, and the one-token `length` stub recorded below is not the cap being reached — so the cap is not a stop condition. It is an **admission** control. With no `max_tokens` the host reserves a 4,096-token output budget inside the same 32,768-token window and refuses a request that does not leave room for it:

| Request                                  | Result                                                         |
| ---------------------------------------- | -------------------------------------------------------------- |
| 31,594-token prompt, no `max_tokens`     | 400 — 4,096 requested output plus 31,594 input exceeds 32,768  |
| identical prompt, `max_tokens: 256`      | 200 — 31,594 prompt tokens, 27 completion tokens               |

Owner ruling 2026-09-14: send an explicit cap of 1,024. Usable prompt is therefore **31,744 tokens**, against ~28,672 for a caller that sends none, and the longest reply measured on this row was 404 completion tokens.

**It errors at the edge; it does not silently truncate.** A prompt over the window is refused with the host's own `context_too_long` message quoting both counts, and a prompt under the window but over the admission budget is refused as a generic bad request. Through the streaming seam the second case surfaces only as "The request was rejected as invalid", so a player hitting it gets a reply-failure popup that cannot say why; the informative wording comes from a direct non-streaming call. Neither case returns a 200 with a reduced input count.

## Measured runtime behavior

- **No thinking.** Reasoning tokens are 0 on every call, and raw text length equals visible text length everywhere — no normalizer had to act.
- **No measured empty reply, so no hidden retry.** The provenance probe recorded no empty completion on this row, so it earns **no hidden empty retry** and no minimum-token retry floor: a retry would be latency spent against a hazard the evidence does not show. The one-token `length` stub below is not an empty reply, and a retry could not cover it — its fragment has already streamed, so a second attempt would append a new answer after it.
- **It does not reliably hold a turn.** The row intermittently answers with a completion reporting `finish_reason: length` after a single output token and a single character. Vesper withholds that shape on every narrator instead of keeping it as a turn — it never persists and never enters history, and the player gets a reply-failure popup ([reply failures](../../character-chat/reply-failures.md)). The profile this page describes is not required for it: the same result appears with the adapter removed. The one-token stub is the extreme of a wider shape: the row also ends replies on `length` far below any budget in force, after 8 to 200 tokens in the record below, and those settle as ordinary replies because only the one-token case is withheld. Neither shape's cause is established; the dated records below are the evidence.
- **No cold start observed.** The tier is `warm`, the first call of each session answered in 0.8–2.2s to first token, and no `503 capacity_exhausted` appeared across roughly 90 calls. The row carries no startup-budget override, and that absence is a measurement.
- **Speaker tags.** The line-start `[Name]` grammar held on 6 of 6 calls whose system prompt carried the instruction close by, and on 0 of 3 for a fixture that buried the instruction under ~8,800 tokens of filler. Stray bracketed spans were 0 everywhere, and one asterisk-action span appeared across nine calls, so this row does not insist on asterisk-action syntax.
- **Determinism is per server, not per host.** The model is served from a pool: each server decodes deterministically, but repeated greedy calls do not all land on the same server, and greedy returned completions of 20, 35, 36 and 38 tokens across runs. A seed reproduced two calls, and the host documents seeds as unreliable across its pool. Nothing may be built on determinism from this host, and a probe comparing completions by hash needs an anchor set.

### Turn reliability and first-token latency

Recorded per probe, each with the date it was measured, because the later probes contradict the earlier one. The 2026-09-04 and 2026-09-14 runs went through `streamCharacterChat`, the production narrator seam, so model selection, the adapter binding and the output normalizers were all in force. The 2026-09-28 record names which layers each of its arms bypasses. No record establishes a production rate.

**2026-09-04, the provenance probe.** Nine of nine short calls returned prose on `finish_reason: stop`. First token arrived in 0.7–2.5s on small and Vesper-sized prompts; a one-word "terse invite" prompt was the outlier at up to 22.2s to first token and 36s total. Nine successes are too few to show that an intermittent failure was absent.

**2026-09-14, four nine-call runs.** Asmodeus completions reported `finish_reason: length` after exactly one output token and one visible character, with and without the adapter; the neighbouring Featherless row `DavidAU/Qwen3.6-27B-Fable-Fusion-711-Uncensored-Heretic-NM-DAU-MTP` ran clean on the same fixtures:

| Configuration                                                    | Calls | One-token `length` |
| ---------------------------------------------------------------- | ----: | -----------------: |
| Asmodeus, adapter in force — run 1                               |     9 |                  2 |
| Asmodeus, adapter in force — run 2                               |     9 |                  4 |
| Asmodeus, adapter removed — `temperature: 0.85`, no `max_tokens` |     9 |                  1 |
| Fable Fusion 711, adapter in force                               |     9 |                  0 |

First token, by configuration:

| Configuration                      | Calls | Median / max (ms) | ≥ 9,000 ms |
| ---------------------------------- | ----: | ----------------- | ---------: |
| Asmodeus, adapter in force         |    18 | ~6,100 / 26,583   |          7 |
| Asmodeus, adapter removed          |     9 | 1,451 / 46,749    |          2 |
| Fable Fusion 711, adapter in force |     9 | 3,573 / 9,968     |          1 |

What this record supports, and no more:

- The adapter is not required for the stub, because the unadapted control reproduced it. The samples are far too small to say whether the profile changes its rate.
- The clean neighbour row argues against one failure affecting every Featherless request. It does not rule out host load, scheduling, worker-specific behaviour, or a problem confined to this model's deployment.
- The clean provenance probe does not prove the stub was absent then, so this is not an established host regression.
- Failing calls tended to show slower first output, but slow calls also succeeded. The correlation is a lead, not a cause.
- Two Asmodeus calls on a 32-token prompt took 20.0s and 27.9s to first token, against the provenance probe's sub-three-second figures. The worst call of all four runs — 46,749 ms, on the unadapted control — sat 3.3s under the chat lane's 50s first-token watchdog, so a slower day turns a late reply into a `timeout` reply failure. The neighbour row was also slower than its own earlier 0.7–2.8s, so part of the latency is general host load.

**2026-09-28, an interleaved six-arm re-measure.** 300 calls to the probe harness's Vesper-sized fixture (8,873 prompt tokens), 50 per arm. The arms ran in rotating rounds, so changing host load was spread across the arms instead of landing on one. Each arm isolates one variable: the adapter's sampling fields, the output cap, the SDK, or streaming.

| Arm                | What it sends                                        | One-token `length` |
| ------------------ | ---------------------------------------------------- | -----------------: |
| `profile`          | the request this page describes                      |               2/50 |
| `lane-capped`      | lane defaults (temperature 0.85) plus the 1,024 cap  |               2/50 |
| `lane`             | lane defaults, no cap                                |               0/50 |
| `profile-uncapped` | the profile without `max_tokens`                     |               1/50 |
| `direct-stream`    | the profile body over raw HTTP, no SDK               |               1/50 |
| `direct-json`      | the same body, non-streaming                         |               0/50 |

What this record supports, and no more:

- **The host itself reports the stub.** The host's raw response and the SDK's completion record agreed on every one of the 200 production calls. The SDK-free `direct-stream` arm reproduced the stub.
- **The adapter is not required,** since `lane-capped` reproduced it. At 50 calls per arm every comparison's 95% interval overlaps, so this sample cannot say whether the profile, the cap or streaming changes the rate.
- **The stub is the extreme of a wider shape.** 14 of the 300 calls ended on `length` below their budget; 6 were one-token stubs and 8 stopped after 8 to 200 tokens.
  - Streaming calls among the 8 decoded at 0.2–5.9 tokens per second, against a median of 22.4 for ordinary replies.
  - 13 of the 14 fell in three short windows of the 61-minute run.
  - The neighbouring Fable Fusion 711 row, measured immediately afterwards rather than interleaved, finished 30 of 30 on `stop`.
  - The pattern points toward degraded serving, but the sample cannot rule out chance clustering.
- **First token.** The worst visible first token was 44,337 ms, 5.7 s under the chat lane's 50 s first-token watchdog. The median raw first content ran 626–792 ms by arm, and 27 of the 250 streaming calls took 9 s or more.
- **The same day on the deployed build,** a 20-turn live chat ended 4 turns without a settled reply, 3 of them recorded as the one-token stub. None entered history.
