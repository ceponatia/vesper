# [Feature / Subsystem Name]

Status: draft | next | active | awaiting acceptance — <what> | shipped — <date> | parked

Outcome: <A player | The owner | A developer> can <do something concrete> so
that <observable consequence>.

**Proposed package/component:** `[package, subsystem, or major code area]`  
**Primary owner:** `[package / application / subsystem]`  
**Primary integration:** `[existing system this plugs into]`  
**Provider/dependency:** `[provider or key dependency — N/A with the reason when none]`

> Template rule: every numbered section below appears in the finished plan, in
> this order, under these headings. When a section does not apply, keep the
> heading and write `N/A — <why it does not apply>`; the reason matters more
> than the label. Never delete a section, and never add a section this template
> does not define — if the template is missing something the plan needs, ask
> the project owner to upgrade the template instead of deviating.

## 1. Goal

State plainly what this work is intended to accomplish.

The goal should describe the **user-visible or architectural outcome**, not the implementation.

Examples:

- improve character identity consistency across generated images;
- add a reusable subsystem for model-specific prompting;
- allow a new provider to participate in existing image routes;
- extract shared simulation logic into a reusable package.

Include the important quality bar.

Example:

> The feature should behave like a native part of Vesper rather than a parallel system. Existing callers should continue using the same routes and abstractions wherever possible.

---

## 2. Core architectural rule

State the single most important architectural constraint for the work.

Examples:

> `[new package]` extends the existing system. It does not replace `[existing package]`.

> The application remains the orchestration layer; reusable packages must not import application code.

> This feature must enter Vesper through existing render intent and profile resolution rather than adding feature-specific branches to every caller.

Show the dependency relationship when useful:

```text
[lowest-level shared package]
        ▲
        │
[existing reusable package]
        ▲
        │
[new subsystem/package]
        ▲
        │
[application]
```

Explicitly state:

- what the new component may depend on;
- what it must not depend on;
- whether the dependency direction changes;
- which existing boundary checks must recognize it.

If the current architecture does not support the desired dependency cleanly, call that out rather than bypassing the boundary.

---

## 3. What the new component owns

List the responsibilities that belong specifically to this package/subsystem.

For each responsibility, explain **why it belongs here**.

Typical examples:

- model-family-specific configuration;
- pure planning logic;
- reusable contracts;
- transformation rules;
- recipes;
- provider-independent calculations;
- evaluation fixtures;
- model-specific prompt strategy;
- package-local tests.

Prefer responsibilities over file names.

The section should answer:

> If this package disappeared, what coherent body of knowledge or behavior would disappear with it?

---

## 4. What remains outside the component

This section is mandatory.

Explicitly identify functionality that may seem related but should continue to be owned elsewhere.

Example:

**The application continues to own:**

- authorization;
- database access;
- user and character lookup;
- jobs;
- persistence;
- provider credentials;
- UI state.

**Existing shared package X continues to own:**

- normalized contracts;
- common planning;
- shared failure vocabulary.

**Provider package Y continues to own:**

- external API calls;
- provider schema probing;
- response normalization.

This section exists specifically to prevent scope creep and duplicate implementations.

---

## 5. Existing system integration

Describe the **current path through Vesper** that this work should join.

Prefer a diagram:

```text
Web UI
   │
   ▼
existing route
   │
   ▼
existing resolver/service
   │
   ▼
shared intent/contract
   │
   ▼
[new behavior]
   │
   ▼
existing provider/persistence path
```

Name the existing systems that should remain authoritative.

State explicitly whether this proposal requires:

- a new route;
- a new database table;
- a new UI;
- a new provider;
- a new job type;
- a new package;
- a new normalized capability.

If one is **not** required, say so.

Example:

> Do not create `/api/[feature]/*` routes. The feature should appear through the existing profile route.

---

## 6. Data and contract changes

Describe the new data concepts required.

For each new concept, answer:

- What does it represent?
- Who owns it?
- Is it persisted?
- Is it runtime-only?
- Is it provider-neutral or implementation-specific?
- Does an existing schema already represent it?

Prefer extending existing vocabulary over creating near-duplicates.

Conceptual examples are useful:

```text
existing entity
      │
      ▼
new association
      │
      ▼
existing resource
```

Avoid committing to database column names unless the plan genuinely needs that level of precision.

---

## 7. Model / provider / implementation strategy

This section applies when the work involves external models, APIs, providers, or interchangeable implementations. When it does not, keep the heading and record `N/A — <why>`.

Identify:

- the primary implementation;
- secondary or fallback implementations;
- why the primary is preferred;
- what remains experimental;
- licensing or provider concerns;
- what should be pinned/versioned.

Do not treat every technically possible implementation as equal.

Make a recommendation.

Example:

> Use A as the production target. Keep B as an evaluation lane. Do not design the common abstraction around B unless trials prove it necessary.

---

## 8. Starting configuration

This section applies when there are settings that must be experimentally tuned. When there are none, keep the heading and record `N/A — <why>`.

Clearly label values as **starting points**, not final answers.

| Setting     | Initial target           |
| ----------- | ------------------------ |
| `[setting]` | `[starting value/range]` |
| `[setting]` | `[starting value/range]` |
| `[setting]` | `[starting value/range]` |

State the tuning rule.

Recommended default:

> Change one meaningful variable at a time during the initial controlled trials. Winning values become versioned configuration only after evaluation.

Avoid hardcoding folklore as architecture.

---

## 9. State / identity / source-of-truth strategy

This section applies when the feature transforms or renders existing Vesper state. When it does not, keep the heading and record `N/A — <why>`.

Identify the authoritative source.

Examples:

- visual state;
- simulation projection;
- identity pack;
- character record;
- location state;
- item state;
- prompt contract.

The new subsystem should generally consume a **resolved representation** rather than independently reconstructing Vesper state.

Example:

```text
canonical Vesper state
        │
        ▼
existing projection/resolution
        │
        ▼
[new subsystem]
```

Explicitly prevent competing sources of truth.

---

## 10. Storage and association

If new resources are generated or trained, explain how they relate to existing entities.

Examples:

```text
character
   │
identity pack
   │
trained resource
```

Record sufficient provenance to tell whether a generated resource is stale.

Possible provenance:

- source ID;
- source fingerprint;
- model/version;
- recipe version;
- creation date;
- configuration;
- active/retired state.

Reuse existing libraries and tables where they already represent the concept.

Do not create a second registry for the same kind of resource.

---

## 11. Current limitations that must remain limitations

Identify relevant constraints in today's architecture.

Examples:

- one LoRA per render;
- one reference image;
- no multi-subject support;
- one provider;
- synchronous job model;
- fixed output aspect.

Then decide explicitly whether this project:

1. works within the limitation; or
2. deliberately expands the common system.

Do not expand a generic contract merely because the new subsystem *could* use the extra flexibility.

Example:

> Keep the one-LoRA limit for the first implementation. Revisit multi-LoRA only if the initial trials demonstrate a concrete need.

---

## 12. Specialized behavior

Break down any major feature-specific mechanisms.

Examples:

### [Mechanism A]

Explain:

- purpose;
- inputs;
- outputs;
- where it lives;
- how it interacts with existing systems.

### [Mechanism B]

Same.

### [Mechanism C]

Same.

Avoid turning this into low-level pseudocode unless the implementation genuinely depends on a specific algorithm.

---

## 13. Failure and degradation behavior

Explain what happens when the ideal path is unavailable.

Examples:

- required input missing;
- optional reference unavailable;
- model capability absent;
- trained resource missing;
- provider failure;
- unsupported number of subjects;
- stale configuration.

Prefer existing Vesper degradation/failure mechanisms.

Specify whether each case should:

- refuse before spend;
- fall back;
- omit an optional capability;
- surface a diagnostic;
- mark a job failed;
- use another profile.

Do not silently produce materially different behavior.

---

## 14. Web UI integration

Identify exactly where users interact with the feature.

Prefer existing UI surfaces.

Example table:

| Web feature | Existing mechanism  | New behavior     |
| ----------- | ------------------- | ---------------- |
| `[feature]` | `[picker/route/…]`  | `[what appears]` |
| `[feature]` | `[picker/route/…]`  | `[what appears]` |

State whether new UI is actually necessary.

A strong default is:

> If existing model/profile selectors can represent the feature, use them. Do not create a model-family-specific UI.

Admin-only experimental controls should generally remain in an admin or lab surface until promoted.

---

## 15. Normal production path

Show the complete expected path after promotion.

```text
user action
   │
   ▼
existing UI
   │
   ▼
existing route
   │
   ▼
existing resolver
   │
   ▼
shared intent
   │
   ▼
[new package / behavior]
   │
   ▼
existing provider/service
   │
   ▼
existing persistence
```

This diagram should make obvious whether the feature is integrated cleanly or has accidentally created a parallel architecture.

---

## 16. Shared abstractions versus implementation-specific controls

Explicitly decide which new concepts deserve to enter common Vesper contracts.

Use this rule:

Promote a concept into a shared abstraction when:

1. multiple implementations need the same semantic concept; or
2. Vesper itself needs to reason about it dynamically.

Otherwise leave the setting inside the implementation-specific recipe/configuration.

Do not make a provider-neutral core mirror the entire configuration surface of one provider or library.

---

## 17. Multi-entity / complex-case behavior

If the simple case and complex case are materially different, separate them.

Examples:

- one character versus several;
- one reference versus many;
- normal chat versus group chat;
- one item versus inventory;
- single model versus ensemble.

Do not assume success on the simplest case proves the general case.

State what remains experimental until separately validated.

---

## 18. Prompting / policy / rule interaction

This section applies when the subsystem consumes prompts or other authored instructions. When it does not, keep the heading and record `N/A — <why>`.

Identify which layer owns:

- positive instructions;
- negative instructions;
- model-specific syntax;
- state-derived facts;
- safety/provider constraints;
- prompt fitting.

Do not let model-specific configuration override canonical Vesper state accidentally.

Generic rules must account for legitimate exceptions.

---

## 19. Development stages

Implementation should be divided into **small independently reviewable stages**.

Each stage should have:

- one clear purpose;
- a bounded scope;
- an observable result;
- no unnecessary future work.

Each stage carries its one-line stage-status marker directly under its heading
(`complete — <date>` | `built <date> — awaiting <what>` | `in progress` |
`next` | `queued` | `blocked on <what>` | `void — <why>`).

### Stage 0 — Establish the baseline

Record current behavior before changing production.

Use fixed inputs where possible.

Capture enough evidence to compare later results.

**Production behavior changes:** none.

---

### Stage 1 — Establish contracts/boundaries

Create only the package/contracts/boundaries required for later work.

Include:

- package setup;
- public exports;
- typecheck;
- tests;
- dependency policy;
- documentation.

**Production behavior changes:** none.

---

### Stage 2 — Minimal functional implementation

Build the smallest end-to-end version capable of proving the architecture.

Avoid optional enhancements.

Keep it experimental or admin-only where possible.

---

### Stage 3 — Validate the primary mechanism

Run controlled comparisons.

Change one major variable at a time.

Do not add additional complexity until the main mechanism proves valuable.

---

### Stage 4 — Add the first multiplier

Add the next capability that should materially improve the result.

Re-run the fixed comparison matrix.

Promote only if it provides measured improvement.

---

### Stage 5 — Add secondary capability

Repeat the same pattern.

Do not bundle unrelated enhancements together.

---

### Stage 6 — Finishing / reliability

Address:

- repair;
- performance;
- reproducibility;
- diagnostics;
- retry behavior;
- provenance;
- quality consistency.

---

### Stage 7 — First production integration

Connect the feature to the smallest appropriate ordinary Vesper surface.

Keep it non-default initially.

Smoke-test through the actual production path, not only an isolated harness.

---

### Stage 8 — Complex cases

Test the cases the initial integration deliberately excluded.

Examples:

- multiple characters;
- long-running state;
- large inputs;
- conflicting references;
- degradation paths.

---

### Stage 9 — Promotion decision

Compare the final candidate against the current production behavior.

Evaluate the metrics that matter to Vesper.

Promote only what the evidence supports.

Do not treat implementation completion as proof that the feature should become a default.

---

## 20. Evaluation criteria

Define success before implementation begins.

Use a fixed set of criteria appropriate to the subsystem.

Example:

| Dimension       | What is being evaluated                                        |
| --------------- | -------------------------------------------------------------- |
| Correctness     | Does it obey authoritative Vesper state?                        |
| Fidelity        | Does it preserve required identity/state?                       |
| Quality         | Is the output materially better?                                |
| Reliability     | Does it work consistently?                                      |
| Degradation     | Does missing optional data fail safely?                         |
| Performance     | Is latency acceptable?                                          |
| Cost            | Is the improvement worth the provider/compute cost?             |
| Maintainability | Does it avoid duplicated or model-specific application logic?   |
| Reproducibility | Can the same configuration be replayed and inspected?           |

Where appropriate, include a fixed comparison against current production.

---

## 21. First proof before substantial implementation

Identify the **cheapest experiment that can disprove the architecture**.

This section is strongly recommended.

Example:

> Before implementing the training subsystem, enable the already-supported control input and compare it against the baseline.

A good proof:

- uses existing infrastructure;
- costs little engineering time;
- tests the central assumption;
- has a clear pass/fail interpretation.

If the proof fails, investigate before continuing into expensive downstream stages.

---

## 22. Explicit non-goals

This section is mandatory.

List tempting adjacent work that is deliberately outside scope.

Typical examples:

- replacing an existing shared package;
- adding another provider;
- redesigning unrelated UI;
- supporting arbitrary plugins/configuration;
- solving every complex case;
- migrating existing data unnecessarily;
- creating duplicate registries;
- making the new feature the default immediately;
- refactoring unrelated code discovered during implementation.

This is the primary scope-creep barrier.

If an agent discovers worthwhile adjacent work, it should document it separately rather than silently adding it to this project.

---

## 23. Risks and open questions

List unresolved questions that could materially change implementation.

For each one, state:

- what is unknown;
- why it matters;
- how it should be resolved.

Example:

| Question                          | Why it matters                 | Resolution       |
| --------------------------------- | ------------------------------ | ---------------- |
| Does X preserve identity?         | Determines scene eligibility   | Controlled trial |
| Is model Y licensed for hosted use? | Determines production eligibility | License review   |
| Can provider Z expose control A?  | Determines connector design    | Schema probe     |

Do not use this section for questions already answerable from the codebase.

Agents should investigate those before finalizing the plan.

---

## 24. Definition of done

Use concrete acceptance criteria.

Example:

The work is complete when:

1. `[package/component]` obeys repository boundaries.
2. The feature uses the existing `[route/intent/service]`.
3. No duplicate implementation exists in individual callers.
4. Required state flows from the authoritative source.
5. Experimental settings have measured values rather than guessed defaults.
6. Relevant failure/degradation paths are tested.
7. Production provenance/diagnostics remain intact.
8. The ordinary UI can select/use the feature through existing mechanisms.
9. Complex cases that were not validated remain explicitly gated.
10. Disabling the new feature restores previous behavior without code changes.

The definition of done should describe **working system behavior**, not merely that files or tests exist.

---

## 25. Documentation requirements

The implementation should leave behind enough documentation that a future agent does not have to rediscover why the system works this way.

Update or create:

- package README where appropriate;
- architecture/provider documentation;
- model- or subsystem-specific operational notes;
- relevant specs after implementation decisions are settled;
- trial/evaluation results;
- deferred-work documentation for intentionally postponed work.

Record **rulings and reasons**, not a chronological diary of implementation activity.

---

## Planning rules for agents

This section is template instruction for the plan's author. It is the one part
of the template that does **not** appear in the finished plan — remove it after
following it. Every numbered section above, however, must appear.

When creating a plan from this template:

1. **Inspect the current codebase first.** Do not design around assumptions that can be answered from the repository.
2. **Reuse existing abstractions before creating new ones.**
3. **Prefer integration over parallel systems.**
4. **State ownership boundaries explicitly.**
5. **Separate provider/model-specific behavior from Vesper-wide semantics.**
6. **Do not turn experimental capability into production architecture before it is validated.**
7. **Use small implementation stages with independently testable outcomes.**
8. **Put the cheapest architectural proof early.**
9. **Keep complex cases separate when they need separate validation.**
10. **Always include explicit non-goals.**
11. **Always include a definition of done.**
12. **Do not silently expand scope because nearby code could also be improved.**
13. **If implementation reveals unrelated problems, record them for separate work.**
14. **Call out migrations, API changes, package-boundary changes, or public-contract changes explicitly.**
15. **Do not invent a new route, table, package, abstraction, or UI unless the existing system genuinely cannot represent the feature.**
16. **Include every numbered section.** A section that does not apply is filled with `N/A — <why it does not apply>`, never deleted or omitted. A bare `N/A` is acceptable; the reason is better.
17. **Never add sections the template does not define.** If the template is missing a section the plan needs, ask the project owner to upgrade the template — the gap is fixed for every future plan or ruled out, never worked around in one document.
18. **Open with the repo-standard `Status:` and `Outcome:` lines** using the lifecycle vocabulary above; a new plan starts at `draft` or `next`.

The finished plan should be understandable by a technical product owner without reading the code, while containing enough architectural specificity that an implementation agent can proceed without inventing major design decisions.
