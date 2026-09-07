# Brief: <issue or task> — <outcome>

## Goal and acceptance

- User goal: <observable outcome, in the user's terms>.
- Acceptance: <conditions that finish this assigned slice>.
- Issue and settled decisions: <links/rulings when relevant; distinguish facts from assumptions>.

## Checkout and ownership

- Checkout: <absolute path>; mode: <isolated worktree | shared checkout>.
- Baseline: <full SHA>; relevant existing dirty state: <paths/delta or none>.
- Owned writable paths: <exact files/modules>.
- Adjacent owners: <other agents and paths>.
- Other agents share this codebase. Preserve their edits; do not switch branches,
  stage, commit, reset, stash, or clean unless that operation is assigned below.
  A checkout path in this brief does not change the spawned agent's cwd.

## Minimum context

- Read the root `AGENTS.md`, relevant nested instructions, and `docs/README.md`.
- Owning system reference: <specific page(s)>.
- Closest implementation or fixture: <path/symbol and why it matters>.
- Relevant skills: <only the matching workflow owners>.
- Open material questions: <unknowns and which work depends on them>.

Use the existing evidence to resolve routine choices. Challenge a material
unsupported premise with its impact and a smaller alternative. Do not reopen
settled choices without new evidence or expand this slice into adjacent work.

## Allowed operations and validation

- External/live operations: <explicit authorized scope or none>.
- Commit/push/PR/board ownership: <parent or explicitly delegated actions>.
- Validation route: <exact permitted offline check, CI job/suite, or live verifier>.
- Unavailable validation: <what remains unverified and why>.
- Optional shared context/evidence record: <path supplied by parent, or none>.

Root policy and matching skills govern local application gates, test admission,
Drizzle ambiguity, docs placement, and delivery. A green aggregate does not prove
an unselected suite ran. An optional record grants no authorization; the parent
owns updating it. Continue independent work while a material question is pending.

## Return to parent

Report changed behavior and owned paths, commits or parent-owned commit status,
material decisions, actual validation with evidence, and anything incomplete.
Include actionable findings with paths and user impact. Inspect the scoped diff
for unrelated edits and unexpected control characters before reporting. Preserve
preexisting work and distinguish it from your contribution.
