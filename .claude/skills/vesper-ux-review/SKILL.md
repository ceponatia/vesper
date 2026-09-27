---
name: vesper-ux-review
description: Review a substantial Vesper workflow for friction, defaults, disclosure, and recovery. Use for new or redesigned multi-step user flows; ordinary label, copy, and isolated-control changes do not need it.
---

# Review Vesper UX

Start from one user goal, the people allowed to perform it, and the state they
already have. Read `docs/ui/README.md`, only the relevant routed UI docs, the
owning source, and the closest existing flow. Do not broaden the review into a
general product redesign.

Walk the flow as a user would and account for:

- steps, decisions, repeated inputs, and controls before useful progress;
- whether the default is safe and useful for the common case;
- progressive disclosure of advanced, destructive, or rare choices;
- navigation, orientation, cancellation, drafts, resumption, and recovery;
- empty/loading/error feedback and whether the next action is clear;
- desktop and mobile constraints that materially change the workflow.

Challenge a premise when repository or flow evidence shows needless complexity,
avoidable risk, or a smaller design that meets the goal. State the concrete cost,
the evidence, the smaller alternative, and its tradeoff. Do not manufacture an
objection or reopen a settled choice without new evidence.

Separate source-backed behavior from an untested UX hypothesis. Rank findings by
user cost and frequency, show the affected step or source path, and recommend the
smallest change that removes the friction. A bounded review with no material
finding is valid. Small wording or styling nits do not justify invoking this
workflow on their own.

`vesper-scenario-review` owns adversarial correctness across state transitions.
`vesper-ui-quality` owns rendered visual quality. `vesper-testing` owns test
admission and CI evidence. Do not add tests, edit product code, run local
application gates, or call live/external services as part of this review.

When handing off a hypothesis for live verification, use `verify` and its
[live-test retention rule](../verify/SKILL.md). Require the handoff to retain
characters and all other test-created entities, generated images, and supporting
records for owner review, with names and review URLs or IDs. Do not prescribe
deleting test-created state as cleanup.

Finish when the substantial flow's common path, meaningful alternatives, and
recovery cost are clear enough for an owner to accept, reject, or implement each
recommendation without replaying the analysis.
