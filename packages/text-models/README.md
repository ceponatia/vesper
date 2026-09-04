# @vesper/text-models

The place text models are allowed to be weird.

Every narrator Vesper runs is reached through the same gateway, and almost every
one of them has something about it that gateway should not have to know: a
sampler baseline its author tuned and published, a chat template that returns
nothing at all unless it is told not to think, a context small enough that a
long history and a useful reply cannot both fit. Before this package existed
that knowledge lived as one exact-id table inside the transport — which is how a
fact about one model becomes a branch every lane pays for.

**It is not a provider client.** Nothing here opens a socket, holds a
credential, or reads an environment variable. An adapter is a description; the
application decides which host is in force and makes the call. A model with no
adapter is asked exactly as it is today — `adapterForTextModel` returning
nothing is the ordinary answer, not an error.

Model behavior reference: [docs/text-models/](../../docs/text-models/README.md).

## The three pieces

### Features — what a model is asked for

A feature is one semantic decoding knob, stated once and reused: a temperature,
a nucleus cutoff, a repetition penalty, a thinking toggle. Ids are spelled in
Vesper's normalized vocabulary — `topK`, never `top_k` — because the same knob
is spelled differently on every upstream, and a feature that carried a wire name
would have to be duplicated the first time a second host served it.

What a feature owns is the **value band**: the range outside which a number
means nothing to any sampler, whatever host is asked. It answers in plain
English, and an empty answer is the normal one.

The vocabulary includes samplers no host Vesper reaches serves — top-n-sigma,
DRY, XTC, typical, tail-free, top-a, smoothing, dynamic temperature, mirostat,
token bias. That is deliberate. An author tunes a model in a local runtime and
publishes the whole profile; the adapter carries the whole profile, so the
record of how the model was meant to be asked survives in one reviewable place.

### Host dialects — how a knob travels

A dialect maps each feature to exactly one of three answers on one host: an SDK
**call setting**, a raw **body field** with an optional encoder, or
**unsupported**. The split between the first two is a property of the transport
rather than the host — a generic OpenAI-compatible client drops `top_k` with a
warning, so on that host the knob rides the raw body while the host that models
it takes it as a setting.

`hostsServing(featureId)` is derived from the tables rather than declared beside
them, because a hand-maintained availability list is a second copy that will
eventually be believed over the tables it contradicts. It counts only hosts that
have a transport.

The self-hosted dialect is a **placeholder — a spelling, not a serving host**.
No transport reaches it, so it serves nothing and `hostsServing` leaves it out.
It exists so that a knob the hosted tables both withhold still has one place
that names it, which is exactly why such a knob's availability is the empty
list: present in the vocabulary, off everywhere, and turned on later by one
dialect row. Binding a profile for it still works, because serving and spelling
are different questions.

### The composer — how a model binds them

`defineTextModel({ id, family, host, chatTemplate, features, profile, quirks })`
produces a `TextModelAdapter`: the exact model id, the composed capability ids,
the whole declared profile, and the optional hooks — a raw-body preparer, a
request validator, execution hints.

At definition time it refuses a feature composed twice, a profile key naming no
composed feature, and a value outside its band. Those refusals **throw**, which
is a deliberate exception to this repository's prefer-degradation rule: that
rule governs runtime data, where refusing costs a player their turn, and a
definition is code evaluated at module load with no player to protect.

Quirks contribute the optional hooks. `prepareRequest` and `executionHints` may
each be claimed by exactly one quirk — a second claim throws naming both,
because a silent override reads from outside as a hook that was never written.
Refusals are the one place several contributors are legitimate, so
`validateRequest` **accumulates**: a caller sees every reason a call cannot
proceed, not the first one somebody listed.

`bindTextModelProfile(adapter, host)` is pure and takes the host as an argument.
It returns the settings, the body fields, and a **withheld** list naming every
declared value the host does not serve, with a reason. It withholds; it does not
throw. The value stays on the adapter, so a later host makes the same profile
carry more by adding one dialect row.

`mergeTextCallSettings` states the merge law once: the lane's default, then the
adapter's profile, then any explicit per-call option.

### The registry — which model gets which adapter

`adapterForTextModel(id)` resolves the **exact** model id, with no normalization
of any kind (owner ruling 2026-08-17). Two checkpoints from one author differing
only in a suffix are asked differently the moment either is measured, so a
lookup that fell back to a shared prefix would hand a model somebody else's
measurements and report nothing.

The registry is empty. A registered adapter is a claim that a specific model has
been measured, and an entry added without that measurement is exactly the
model-card guessing that exact-id keying exists to prevent.

## Boundary

**May import:** nothing in the workspace. The package has no runtime dependency
at all; `@vesper/contracts` is the only workspace package it would be allowed to
reach, and it does not need it.

**May never import:** the web application (no `@/` at all, and no relative path
that climbs out of this package), Next.js, anything database-shaped, the `ai`
SDK, a provider client — and its peers, `@vesper/image-core` and
`@vesper/simulation-core`.

```text
                    @vesper/contracts
              ▲            ▲            ▲
 @vesper/text-models  @vesper/image-core  @vesper/simulation-core
              ▲            ▲            ▲
              └────────────┼────────────┘
                     @vesper/web
```

Equal rank means no peer may import another. This package says how a model is
asked, the image engine says what a render should be, the simulation owns world
state; the application holds the credentials, resolves the model, and puts them
together.

The `ai` SDK's call-setting names are stated here as a small string union rather
than imported, on purpose: a provider-neutral description of a model must not
pin the application's SDK version.

**Universal runtime.** This package is browser/server portable, so its runtime
source evaluates no `process`, `Buffer`, `window` or `document`, imports no Node
built-in, and pulls in no server-only module. Its TypeScript project declares
`"lib": ["ES2022"]` and an empty `types` list, so a quirk that reached for the
environment to pick a host would fail to compile before any lint gate saw it —
which is also why the host is a parameter. Everything here is pure data and pure
functions: no persistence, no network, no clock, no randomness.
