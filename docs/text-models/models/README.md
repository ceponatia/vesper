# Narrator model reference

This subfolder owns Vesper's per-model narrator reference. The parent [text-models documentation](../README.md) owns the feature vocabulary, the host dialects, the composer, and the adapter contract.

One file per model, recording what a **host** does with that exact checkpoint — its context and concurrency cost, which request fields it honours, ignores and rejects, what its chat template renders, and how it behaved when it was measured. Separately, and never mixed with it, each page records the profile **Vesper chooses to send**: the adapter's declared values, which of them the host carries, and the request body that actually leaves.

A model does not need a page here to be selectable. The [narrator catalog](../../../apps/web/src/lib/narrative-models.ts) is the runtime list of options and stays the source of truth for which rows exist; a page here is the difference between a model Vesper understands and one it merely calls.

## Owns / does not own

- **Owns:** per-model host facts, measured field acceptance, template and tokenizer behavior, licence and price, and the effective request body for that exact id.
- **Does not own:** the feature vocabulary, the dialect tables, the merge law, and the adapter contract — [text-models](../README.md). Which rows exist, what they are labelled, and which lane defaults to which — the narrator catalog. Credentials and configuration — [getting started](../../getting-started.md). How a failed or empty reply is classified — [reply failures](../../character-chat/reply-failures.md).

## The provenance line

Every page carries **exactly one dated line**, in the header block under the exact id:

```text
**Provenance:** probed <YYYY-MM-DD> against `<host>` model record `<exact model id>`.
```

That pairing is the whole claim: everything below it — the field table, the caps, the measured behavior — was read from that exact model on that host on that date. A date without a model record says nothing reproducible, and a record without a date cannot be aged, so the two only ever appear together.

A re-probe **replaces** the line rather than adding a second one, and a recheck that changed nothing leaves no trace — if a recheck established a fact, the fact is stated in prose. **No other date appears on a page**, with one exception: a dated `Owner ruling <YYYY-MM-DD>: …` line, which records a decision rather than a measurement. Dates here identify evidence; they never mark rollout state.

The header block is otherwise `**Exact id:**`, `**Host:**`, and an optional `**Adapter:**` naming the definition that carries the model's profile.

## Field verdicts are a vocabulary, not a judgement

A page's field table uses four verdicts and no others. The third is what keeps the tables honest:

| Verdict                 | Meaning                                                                        |
| ----------------------- | ------------------------------------------------------------------------------ |
| **accepted+effective**  | Sent, and a measurement shows it changed the completion                        |
| **accepted+ignored**    | Sent, answered 200, and measurably did nothing                                 |
| **accepted+unmeasured** | Sent and answered 200; the harness cannot observe the effect — with the reason |
| **rejected**            | Refused with an error, so it must never be sent                                |

An unmeasured field is never quietly written down as ignored. "Accepted and returned an identical completion" separates neither "the host dropped it" from "the sampler never bit", and a page that collapsed the two would be inventing a measurement.

## Ways hosts disagree

The differences below are why per-model pages exist at all, rather than one page per provider.

- **Documented is not honoured, and undocumented is not refused.** Featherless honours exactly its documented parameter set and silently drops every undocumented one — 200, no error, no effect — so a request carrying a local-runtime sampler is accepted and quietly stripped. Both exceptions sit inside the documented set: one documented field is ignored, and one is rejected outright on some tokenizers.
- **A rejection can be per-tokenizer rather than per-host.** `chat_template_kwargs` is documented by Featherless, works on its Qwen rows, and is refused with a 400 on a Mistral tokenizer — empty object included. That single fact is why the adapter registry keys on an exact model id rather than on a provider.
- **The SDK is a second filter.** A field the host serves can still fail to travel because the client does not model it: a generic OpenAI-compatible client drops `top_k` with an unsupported-setting warning and has no argument for `min_p`, `repetition_penalty` or `min_tokens`. Those ride the raw request body instead. The [dialect tables](../README.md) own which column each knob is in.
- **A context window is not a prompt budget.** A host may reserve a default output budget inside the same window when the request sends no cap, so the usable prompt is smaller than the advertised context until an explicit cap is sent.
- **Pooled serving breaks determinism.** A host that serves one model from a pool decodes deterministically per server but not across servers, so two greedy calls can legitimately differ. A probe comparing completions by hash needs an anchor set rather than a single baseline, and a seed is a request rather than a promise.
- **Featherless publishes a chat-format endpoint.** `POST https://api.featherless.ai/debug/chat-format` takes the model in the **body** (the path's model segments are ignored), accepts a bearer token, and returns the rendered prompt, a token count matching the completions API's `prompt_tokens`, and `template_info`. It is how a page's template claim becomes measured rather than quoted from a model card.

## The models

Curated narrator rows, grouped by the upstream that serves them. A row links to a page only where one exists; the rest are asked at lane defaults and have nothing model-specific recorded.

**Featherless** — community Hugging Face merges no OpenRouter vendor hosts:

- [Asmodeus 24B v3](asmodeus-24b-v3.md) — `DarkArtsForge/Asmodeus-24B-v3`. Mistral-Small-24B, 32K, Tekken template. Adapted: the author's whole profile, of which Featherless carries seven fields.
- `DavidAU/Qwen3.6-27B-Fable-Fusion-711-Uncensored-Heretic-NM-DAU-MTP` — adapted: thinking off, the author's non-thinking sampler baseline, and the chat lane's hidden empty-reply retry.
- `DavidAU/Qwen3.6-27B-F451-AND-TRI-Polar-Ultra-Pro-Writer-Uncensored-Heretic` — adapted from the same shared definition as its sibling above, so the two differ only by merge recipe.
- `aifeifei798/DarkIdol-Qwen3.8-27B-v1.1` — adapted: temperature and min-p, with its short reasoning pass kept **on** at medium effort.
- `Naphula/Slimaki-Tavern-24B-v1.3` — unadapted. Its probe found no chain to suppress and its card recommends no baseline, so lane defaults are the measured answer rather than a gap.

**OpenRouter** — every other curated row, none of them adapted, and none of them listed here: the catalog owns which rows exist, and a second copy of that list would be believed the first time the two disagreed. What those rows carry instead of a sampling profile is OpenRouter API surface — endpoint routing, per-model provider exclusions, the eval-ruled reasoning knob — and it lives in the provider gateway rather than in an adapter.

## Adding a page

1. Probe the exact model — the host's own model record, then the field sweep, then the production narrator seam. A page is written from measurements, not from a model card.
2. Write the provenance line first. Everything below it is claimed to come from that record on that date.
3. Record host facts and Vesper's chosen profile in separate sections. A reader must be able to tell "the host does this" from "Vesper asks for this".
4. Give every field a verdict from the vocabulary above, and give an unmeasured field its reason.
5. Record what the model was NOT given, and why — no hidden retry, no startup budget, no token bans — because an absent hint is a claim that a measurement did not earn it.
6. Index the page in "The models" above, and link it from the row's comment in the narrator catalog.
