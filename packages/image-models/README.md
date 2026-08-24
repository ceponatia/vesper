# @vesper/image-models

The place model families are allowed to be weird.

Every image model Vesper runs is reached through the same normalized render
path, and almost every one of them has something about it that path should not
have to know: an endpoint that wants its references addressed by number, an
endpoint that queues for eight minutes before it starts, an endpoint whose
negative-prompt field is accepted and then ignored. Before this package existed,
that knowledge lived as slug checks inside shared code — which is how a fact
about one model becomes a branch every model pays for.

**It is not a second capability system.** The probed registry row stays the
authority on provider wire fields: which key carries the prompt, whether the
reference input is one URI or a list, which optional controls the active version
exposes. Adapters own **behavior**; the probe owns **field truth**. A model with
no adapter renders exactly as it does today — `adapterForImageModel` returning
nothing is the ordinary answer, not an error.

Plan and rationale:
[image-model-adapters.plan.md](../../docs/developer-notes/image-model-adapters.plan.md)
and its [spec](../../docs/developer-notes/image-model-adapters.spec.md).
How the application uses the image system: [docs/images/](../../docs/images/README.md).

## The three pieces

### Features — what a model expresses

A feature is one semantic capability, stated once and reused: a prompt, several
numbered references, a seed, a LoRA, a requested output shape. Families
**compose** features rather than reimplementing them.

Features ask the **probed model record** their questions, and the rule that
follows is short: a feature never names a provider input field. It reads the
record's own vocabulary — control bindings, reference capacity, offered shapes —
and answers in Vesper's terms. A feature that carried a field name would be a
second, staler copy of a row an operator edits on the admin page, and the first
time a version moved a field the two copies would disagree in silence.

Where the record cannot honestly answer, a feature simply has no `isBound` hook,
and says so in its own doc comment. That is a legitimate state, not a gap.

The vocabulary is grown as needed. There is deliberately no master enum of every
capability an image model could conceivably have: an unused member is an
unproven claim.

### The composer — how a family binds them

`defineImageModel({ family, features, quirks })` produces an
`ImageModelAdapter`: a family name, the composed capability ids, and the
optional hooks — a prompt preparer, a request validator, execution hints.

Quirks are the small modules that contribute those optional hooks, and **each
hook may be claimed by exactly one quirk**. There is no last-wins: two dialects
quietly cancelling each other reads, from outside, as a prompt that was never
rewritten, so a second claim throws at definition time. That refusal is a
deliberate exception to this repository's prefer-degradation rule, which governs
runtime data; a definition is code, evaluated at module load, with no player and
no turn to protect.

Validation is the one place several contributors are legitimate. There the
feature refusals **accumulate**, so a caller sees every reason a pairing cannot
work rather than the first one somebody happened to list.

### The registry — which model gets which adapter

`adapterForImageModel(slug)` resolves through the model's **base** slug, so a
row pinned to `owner/name:version` for reproducibility keeps its family
behavior. Only the Qwen family is registered today; Flux, Wan, SDXL and Seedream
stay on the legacy path and migrate when their behavior is next touched.

## The Qwen family

The reference implementation, and a worked example of why per-endpoint detail
needs a home:

| Adapter                            | What it is                                                        |
| ---------------------------------- | ----------------------------------------------------------------- |
| `qwen/qwen-image-edit-2511`        | Current instruction editor. Numbered references, **no loadable LoRA**. |
| `qwen/qwen-image-edit-plus-lora`   | Older 2509-generation wrapper. The only Qwen edit endpoint that loads a LoRA. |
| `qwen/qwen-image-2512`             | Text-to-image generator arm. Takes guidance; **ignores its negative field**. |

All three share the family's numbered-reference conventions; the two editors
share its prompt dialect, which rewrites Vesper's provider-neutral identity
sentence into Qwen's numbered form. The rewrite is **idempotent**, and that is
load-bearing: the render plan hashes the prepared prompt and the transport
prepares again on the way out, so a second pass that changed the text would make
a render refuse against its own compiled prompt.

The LoRA wrapper is also the family's one carrier of execution hints — an eight
minute startup budget and a single startup retry, because a bench run sat in a
cold start past its whole five-minute budget and was aborted before it began.
Its render budget is deliberately unset: nobody has measured one, and the lane's
default beats an invented number.

## Boundary

**May import:** `@vesper/image-core` and `@vesper/contracts`, each by package
name and each declared in this package's manifest.

**May never import:** the web application (no `@/` at all, and no relative path
that climbs out of this package), Next.js, anything database-shaped, Vesper's
character or chat contracts, ambient environment variables — and its two peers,
`@vesper/image-replicate` and `@vesper/image-sd`.

```text
                    @vesper/contracts
                           ▲
                   @vesper/image-core
              ▲            ▲            ▲
 @vesper/image-models  @vesper/image-sd  @vesper/image-replicate
              ▲            ▲            ▲
              └────────────┼────────────┘
                     @vesper/web
```

Equal rank means neither peer may import the other. This package says what a
family needs, the SD package defines recipes, the transport package knows how to
reach `api.replicate.com`; the application holds the credential, resolves the
model, and puts them together. `@vesper/image-core` sits **below** and may not
import this package either — model behavior reaches the render kernel through a
hook the application injects, never through an upward import.

**Universal runtime.** This package is browser/server portable, so its runtime
source evaluates no `process`, `Buffer`, `window` or `document`, imports no Node
built-in, and pulls in no server-only module. Its TypeScript project declares
`"lib": ["ES2022"]` and an empty `types` list, so a file that reached for one of
those would fail to compile before any lint gate saw it. Everything here is pure
data and pure functions: no persistence, no network, no clock, no randomness.
