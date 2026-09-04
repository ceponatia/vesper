# `@vesper/text-models`

`@vesper/text-models` is Vesper's text-model behavior package: the place where narrators are allowed to differ without leaking exact-model branches into the transport that serves them all.

It owns five things:

1. a semantic **feature vocabulary** for the decoding knobs a call can carry;
2. per-host **dialects** that say how, or whether, each knob travels;
3. the `defineTextModel` **composer** that turns features, values and quirks into an adapter;
4. **execution hints and quirks** for how a model behaves rather than what it accepts; and
5. the **adapter registry** that resolves an exact model id to the behavior Vesper has measured.

It owns none of the call itself. Which upstream serves a model id, what credential reaches it, and how a lane assembles its prompt are the application's, and this package never opens a socket, holds a credential, or reads an environment variable. Prompt wording is not here either: what a narrator is told belongs to the lane that tells it, and no adapter touches prompt text.

Source: [`packages/text-models`](../../packages/text-models/README.md). The image system's equivalent, and the pattern this package mirrors, is [image-models](../image-models/README.md).

## Feature vocabulary

A feature is one semantic decoding knob. Ids are spelled in Vesper's normalized vocabulary — `topK`, never `top_k` — because the same knob is spelled differently on every upstream, and a feature carrying a wire name would have to be duplicated the first time a second host served it. Wire spellings live in the dialects alone.

A feature owns its **value band**: the range outside which a number means nothing to any sampler, whatever host is asked. A value outside the band is refused when the adapter is defined. Absence is never the same as a neutral value — a knob a profile omits is one the lane's default governs.

The vocabulary is grown as needed. It is not an enumeration of every sampler a language model could expose, and it deliberately includes knobs no host Vesper reaches serves: an author tunes a model in a local runtime and publishes a whole profile, and the adapter carries the whole profile so the record of how the model was meant to be asked survives in one reviewable place.

| Feature                  | Meaning                                                            | Accepted values                          |
| ------------------------ | ------------------------------------------------------------------ | ---------------------------------------- |
| `temperature`            | Flattens or sharpens the distribution before truncation            | 0 through 2                              |
| `topP`                   | Keeps the smallest set of tokens reaching this probability mass    | above 0 through 1                        |
| `topK`                   | Keeps this many of the most probable tokens                        | whole numbers, -1 or above               |
| `minP`                   | Drops tokens below this fraction of the top token's probability    | 0 through 1                              |
| `seed`                   | Asks for a reproducible draw rather than a fresh one               | whole numbers, 0 or above                |
| `repetitionPenalty`      | Scales down tokens that already appeared                           | 0 through 2                              |
| `repetitionPenaltyRange` | Limits that penalty to the most recent tokens                      | whole numbers, 0 or above                |
| `presencePenalty`        | One flat penalty per token that has appeared at all                | -2 through 2                             |
| `frequencyPenalty`       | A penalty proportional to how often a token appeared               | -2 through 2                             |
| `stop`                   | Ends the completion at one of these literal strings                | one or more non-blank strings            |
| `minTokens`              | Refuses to stop before this many tokens                            | whole numbers, 0 or above                |
| `maxTokens`              | Caps how many tokens the completion may generate                   | whole numbers, 1 or above                |
| `thinking`               | Turns the chat template's thinking mode on or off                  | `true` or `false`                        |
| `topNsigma`              | Keeps tokens within this many standard deviations of the top logit | 0 or above                               |
| `dryMultiplier`          | Scales DRY's penalty on a repeated sequence, and switches DRY on   | 0 or above                               |
| `dryBase`                | How steeply DRY's penalty grows with sequence length               | 1 or above                               |
| `dryAllowedLength`       | How long a repeat may be before DRY charges for it                 | whole numbers, 0 or above                |
| `drySequenceBreakers`    | Literal strings that end a sequence DRY is tracking                | one or more non-blank strings            |
| `xtcThreshold`           | Marks tokens above this probability as excludable top choices      | 0 through 1                              |
| `xtcProbability`         | How often XTC drops the marked top choices                         | 0 through 1                              |
| `typicalP`               | Keeps tokens whose surprise is closest to the average              | above 0 through 1                        |
| `tfs`                    | Cuts the tail where the distribution's curvature flattens          | 0 through 1                              |
| `topA`                   | Drops tokens below a cutoff scaled by the top probability squared  | 0 through 1                              |
| `smoothingFactor`        | Applies quadratic smoothing to the logits                          | 0 or above                               |
| `smoothingCurve`         | Shapes that smoothing gentler or sharper than quadratic            | 1 or above                               |
| `dynatempMin`            | Lowest temperature dynamic temperature may fall to                 | 0 through 2                              |
| `dynatempMax`            | Highest temperature dynamic temperature may rise to                | 0 through 2                              |
| `dynatempExponent`       | How sharply dynamic temperature moves across its band              | above 0                                  |
| `mirostatMode`           | Which mirostat algorithm runs, or none                             | whole numbers, 0 through 2               |
| `mirostatTau`            | The target perplexity mirostat steers toward                       | above 0                                  |
| `mirostatEta`            | How quickly mirostat corrects toward that target                   | above 0                                  |
| `logitBias`              | Shifts named token ids up or down, up to banning them              | decimal token ids, each -100 through 100 |

## Host dialects

A dialect maps each feature to exactly one binding on one host: an SDK **call setting**, a raw request **body field**, or nothing at all. A feature absent from a dialect's table and a feature bound to `unsupported` mean the same thing — that host does not serve it.

The split between settings and body fields is a property of the **transport**, not of the host. A generic OpenAI-compatible client drops `top_k` with an unsupported-setting warning and models no `min_p`, `repetition_penalty` or `min_tokens` at all, so on Featherless those four ride the raw body even though the host documents every one of them. The provider that does model top-k takes it as a setting. Reading a value in a body column means "the host serves it and the SDK does not model it", and it never means anything else.

Two features in one dialect never claim the same wire field. Nothing enforces it at runtime; the tables are constants a reviewer reads whole, and a new row's field name is checked against its neighbours when it is added.

The table below is the authoritative record of how each knob is spelled on each host. `hostsServing` derives availability from these same tables rather than from a second list, so a later host makes a knob travel by adding one row here and nothing else — but it counts only hosts that **have a transport**, and the self-hosted column is not one of them.

**self-hosted is a placeholder: a spelling, not a serving host.** No transport reaches it, so it serves nothing and `hostsServing` leaves it out. A knob that only this column names is present in the vocabulary and off everywhere, which is what makes `hostsServing` able to answer with an empty list. The column exists so that such a knob still has one place that names it, and its spellings are a record of the vocabulary author profiles are written in rather than a verified wire contract — the lane that adds a transport checks each one against the endpoint it targets.

Binding a profile for `self-hosted` nevertheless works, and that is deliberate: serving and spelling are different questions, and asking what a profile would look like on a lane that does not exist yet is worth answering.

| Feature                  | featherless                 | openrouter                 | self-hosted                  |
| ------------------------ | --------------------------- | -------------------------- | ---------------------------- |
| `temperature`            | setting `temperature`       | setting `temperature`      | body `temperature`           |
| `topP`                   | setting `topP`              | setting `topP`             | body `top_p`                 |
| `topK`                   | body `top_k`                | setting `topK`             | body `top_k`                 |
| `minP`                   | body `min_p`                | body `min_p`               | body `min_p`                 |
| `seed`                   | setting `seed`              | setting `seed`             | body `sampler_seed`          |
| `repetitionPenalty`      | body `repetition_penalty`   | body `repetition_penalty`  | body `rep_pen`               |
| `repetitionPenaltyRange` | —                           | —                          | body `rep_pen_range`         |
| `presencePenalty`        | setting `presencePenalty`   | setting `presencePenalty`  | body `presence_penalty`      |
| `frequencyPenalty`       | setting `frequencyPenalty`  | setting `frequencyPenalty` | body `frequency_penalty`     |
| `stop`                   | setting `stopSequences`     | setting `stopSequences`    | body `stop_sequence`         |
| `minTokens`              | body `min_tokens`           | —                          | body `min_tokens`            |
| `maxTokens`              | setting `maxOutputTokens`   | setting `maxOutputTokens`  | body `max_length`            |
| `thinking`               | body `chat_template_kwargs` | —                          | body `chat_template_kwargs`  |
| `topNsigma`              | —                           | —                          | body `nsigma`                |
| `dryMultiplier`          | —                           | —                          | body `dry_multiplier`        |
| `dryBase`                | —                           | —                          | body `dry_base`              |
| `dryAllowedLength`       | —                           | —                          | body `dry_allowed_length`    |
| `drySequenceBreakers`    | —                           | —                          | body `dry_sequence_breakers` |
| `xtcThreshold`           | —                           | —                          | body `xtc_threshold`         |
| `xtcProbability`         | —                           | —                          | body `xtc_probability`       |
| `typicalP`               | —                           | —                          | body `typical`               |
| `tfs`                    | —                           | —                          | body `tfs`                   |
| `topA`                   | —                           | body `top_a`               | body `top_a`                 |
| `smoothingFactor`        | —                           | —                          | body `smoothing_factor`      |
| `smoothingCurve`         | —                           | —                          | body `smoothing_curve`       |
| `dynatempMin`            | —                           | —                          | body `dynatemp_min`          |
| `dynatempMax`            | —                           | —                          | body `dynatemp_max`          |
| `dynatempExponent`       | —                           | —                          | body `dynatemp_exponent`     |
| `mirostatMode`           | —                           | —                          | body `mirostat`              |
| `mirostatTau`            | —                           | —                          | body `mirostat_tau`          |
| `mirostatEta`            | —                           | —                          | body `mirostat_eta`          |
| `logitBias`              | —                           | body `logit_bias`          | body `logit_bias`            |

## Composer and adapter contract

`defineTextModel({ id, family, host, chatTemplate, features, profile, quirks })` produces a `TextModelAdapter` with:

- `id` — the exact model id its host serves it under;
- `family` — the checkpoint family, for reading and grouping only;
- `host` — the upstream this model is served from, and the default a bind uses;
- `chatTemplate` — the template the model was tuned against, such as `mistral-tekken`; the host applies it and this package only records which one;
- `capabilities` — feature ids in declaration order;
- `profile` — every declared value; and
- optional `prepareRequest`, `validateRequest` and `executionHints`.

Four things are refused when the definition is evaluated: a feature composed twice, a profile key that names no composed feature, a profile value outside its feature's band, and two quirks claiming the same overriding hook. Those refusals **throw**, which is a deliberate exception to [the resilience rules](../resilience.md). Those rules govern runtime data, where refusing costs a player their turn; a definition is code, evaluated at module load, with inputs somebody typed and no turn to protect.

`profile` carries **every declared value**, including values for knobs the model's own host does not serve. A profile is one artefact, and what travels is decided per call by the host in force rather than at the moment the values are written down.

That structure has a dated origin. Owner ruling (2026-09-04), given for the first adapted narrator: fields its host turns out not to honour are deactivated by host selection, never by deleting the values. It does not make an author's published settings anyone's default — the standing rule (owner ruling 2026-08-17) is that no model receives model-card sampling settings automatically, and a profile with values in it is a claim that this exact model was measured.

## Binding a profile for a host

`bindTextModelProfile(adapter, host)` is pure, takes the host as an argument, and returns three things:

- `settings` — keyed by SDK call-setting name;
- `body` — keyed by the host's wire field name, with any encoder applied; and
- `withheld` — one `{ feature, reason }` entry for every declared value this host does not serve.

It **withholds; it does not throw**. A withheld value never appears in `settings` or `body`, so it never reaches the wire, and it stays on the adapter, so the record of how the model was meant to be asked survives a host that cannot honour it. A later host makes the same profile carry more by adding a dialect row.

Taking the host as an argument is what makes host selection an application decision. Binding for a host other than the adapter's own answers "what would this profile look like over there?", so moving a model between upstreams is one argument rather than a second table.

Iteration follows `capabilities`, so a bound profile's key order is the definition's declaration order and two binds of one adapter are identical.

## Execution hints

An adapter may state provider-neutral knowledge about how its model behaves rather than what it accepts:

| Hint                  | What earns it                                                         |
| --------------------- | --------------------------------------------------------------------- |
| `contextLength`       | The host's own model record                                           |
| `maxCompletionTokens` | The host's record, or a call truncated below what the context implies |
| `concurrencyCost`     | The host's published concurrency cost for the model                   |
| `startupBudgetMs`     | A measured cold start a lane's default budget would have abandoned    |
| `hiddenEmptyRetry`    | A measured intermittent empty reply on this exact model               |
| `retryMinTokens`      | Proof the host honours a minimum-token floor on this model            |

Every field is optional, and an absent field means the lane's own default governs — never zero, never unlimited. A hint is a claim about a real endpoint, so an adapter states one only where a measurement earns it.

Two of them carry policy as well as measurement. `hiddenEmptyRetry` is exact-model because a retry, and its latency, must not spread to models that never returned an empty reply. `retryMinTokens` applies to that retry alone: a minimum response length applied to every call is how narrator padding gets resurrected.

## Quirks and the merge law

A quirk contributes an adapter's optional members and is the only thing that does. Features and the profile say what a model is asked for; quirks say how this particular model misbehaves while being asked.

`prepareRequest` and `executionHints` may each be claimed by exactly **one** quirk in a definition. A second claim throws naming both, because a last-wins merge produces an adapter that looks composed and behaves as if one of its quirks was never written. `validateRequest` **accumulates** across every quirk that defines one, in declaration order, so a caller sees every reason a call cannot proceed rather than the first one somebody listed. An overriding hook that vanishes is invisible; a refusal that vanishes is a call that should not have been made.

`prepareRequest` rewrites the raw body at the model boundary and must be **idempotent**: a caller may prepare while planning a call and again on the way out, and a preparer that appended on each pass would send a body no reviewer read.

`validateRequest` takes `TextModelRequestFacts` — `estimatedInputTokens` and `maxOutputTokens`, and nothing else. It grows only when a validator genuinely cannot answer without a new fact, because every field added is a field every future caller must be able to supply. A model whose context cannot hold a long history plus the requested completion is the case the shape is sized for.

**Merge order is law**: the lane's default, then the adapter's bound profile, then any explicit per-call option such as a retry's minimum-token floor. `mergeTextCallSettings` states it once. A key whose value is `undefined` in a later layer does not erase an earlier one, because an optional field spelled out as `undefined` is indistinguishable from an absent one in a plain object spread and would silently drop exact-model evidence.

## The registry

`adapterForTextModel(id)` resolves the **exact** model id, with no normalization of any kind. Owner ruling (2026-08-17): every setting is exact-model evidence and no model inherits another's profile by name. Two checkpoints from one author differing only in a suffix are asked differently the moment either is measured, so a lookup that fell back to a shared prefix would hand a model somebody else's measurements and report nothing.

**Null is the ordinary answer, never an error.** A model with no adapter is asked exactly as the lane asks every other model: no profile, no extra validation, no execution hints. The empty string resolves to null like any other miss — an unset selection is answered with lane defaults rather than a failed turn.

`TEXT_MODEL_ADAPTERS` registers no model. A registered adapter is a claim that a specific model has been measured, and an entry added without that measurement is exactly the model-card guessing that exact-id keying prevents.

## Package boundary

`@vesper/text-models` imports nothing in the workspace. `@vesper/contracts` is the only package it is permitted to reach. It must not import the web application, Next.js, database code, environment state, a generation SDK, a provider client, or its peers `@vesper/image-core` and `@vesper/simulation-core`.

```text
                    @vesper/contracts
              ▲            ▲            ▲
 @vesper/text-models  @vesper/image-core  @vesper/simulation-core
              ▲            ▲            ▲
              └────────────┼────────────┘
                     @vesper/web
```

Equal rank means no peer may import another. This package says how a model is asked, the image engine says what a render should be, the simulation owns world state; the application is the only workspace above all three and the only place they meet.

The generation SDK's call-setting names are stated inside the package as a small string union rather than imported. A provider-neutral description of a model must not pin the application's SDK version, and the union is small and slow-moving enough that restating it costs less than the coupling would.

The package is universal runtime code: pure data and pure functions, with no persistence, network access, clock, randomness, Node globals, or browser globals. Its TypeScript project declares `"lib": ["ES2022"]` and an empty `types` list, so a quirk reaching for the environment to pick a host fails to compile before any lint gate sees it — which is also why the host is a parameter rather than a lookup.

## Where an application joins it to a call

The package offers a join one contract, and a join that keeps it needs nothing else from here.

A join resolves the adapter for the model about to be called, binds its profile for the host in force, and applies the bound settings **over** the lane's default and **under** any explicit per-call option. It sends the bound body fields as raw request fields, applies `prepareRequest` at the model boundary if the adapter claims one, and treats a `null` adapter as "lane defaults throughout".

Three properties follow, and they are the reason the join is one place rather than several:

- **The host is the join's decision.** The package binds for whatever host it is handed, so an application that selects a host — behind a flag, a credential check, or a catalog row — changes an argument and nothing else. A profile's unhosted values are withheld for that host and remain declared.
- **`withheld` is diagnostic, not an error.** A withheld value is the expected result of asking a model through a host that serves less than its author's profile. A join reports it where operators can read it and proceeds with the call.
- **One join, or the lanes disagree.** Two call sites resolving adapters independently will eventually bind different hosts or different merge orders for the same model, and the difference shows up as a quality change nobody can attribute.

## Adding another model

1. Reuse the existing features wherever they describe the model's profile honestly.
2. Add a feature only when the vocabulary cannot state a knob the author actually set, and give it the widest band that is meaningful to a sampler.
3. Keep wire spellings in the dialects; a feature never names a wire field.
4. Add a dialect row when a measurement proves a host serves a knob it did not before. That is a data edit, and nothing else in the package changes.
5. Use quirks only for measured request rewriting, model-specific refusals, or observed execution behavior.
6. Compose the adapter with `defineTextModel`, declaring the author's whole profile.
7. Register the exact model id, and update this page.

A model does not need an adapter merely because it is selectable. Lane defaults are correct whenever Vesper has measured nothing model-specific to say.
