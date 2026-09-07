---
name: vesper-agent-build
description: Implement Vesper issues using delegated agents and isolated worktrees. Use when assigning implementation slices, building issues in parallel, or resuming an agent's corrections. Read-only exploration alone does not need this workflow.
---

# Build Vesper with agents

This skill owns implementation and integration. `vesper-board` owns issue,
branch, PR, and board operations; `vesper-pr-review` owns CI and review after
delivery. Use the user's existing scope, model choice, and authorization.
An explicit instruction to work directly in a shared checkout overrides the
default worktree procedure; assign disjoint paths and one integrator there.

## Establish the slice

1. Read the issue, its parent when needed, the relevant system reference, and
   the actual code. Carry settled owner rulings into the brief. Resolve routine
   implementation choices from that evidence.
2. Ask only about unresolved choices that materially change product behavior,
   architecture, cost, or irreversible actions. Hold the affected slice while
   continuing independent work. Do not re-ask a settled question or infer that
   every implementation choice needs an owner ruling.
3. Give independent agents disjoint file/module ownership. Put dependent
   slices in sequence. Tell every worker that others share the codebase and
   that they must preserve concurrent edits.

## Track the issue checklist

Treat the issue's checklist as working acceptance criteria. Read both checked
and unchecked items, preserving their exact text and order so partial updates
do not shift item identities. Before editing,
account for its inventory and move-map requirements. At implementation handoff,
review completion, and CI completion, reconcile each item with actual evidence.
A merged PR or a green aggregate alone does not complete every checkbox.

The parent owns issue-body updates unless the brief delegates one writer.
Workers report the exact checklist item, completed action, and evidence as they
reach each milestone; they distinguish pending parent-owned review/CI from their
completed implementation. Keep issue text and unrelated checkboxes intact: read
its latest body, change only evidence-supported items, and read the saved body
back. Use `vesper-docs` for issue content and `vesper-board` for lifecycle.

Leave unverified, blocked, or inapplicable requirements unchecked with a concise
reason and any remaining action. Link evidence already in the PR or CI run
instead of duplicating an inventory. Before the final handoff, reconcile the
saved checklist with the report, including when recovering old work or finishing
a previously merged issue. Never check a before-edit requirement retroactively
unless the recorded evidence proves it occurred before those edits.

## Prepare and delegate

- Use [the brief template](templates/agent-brief.md), filling the outcome,
  ownership, known decisions, allowed operations, and required report.
- Use `vesper-task-context` when a substantial slice needs focused source discovery
  or a fresh context handoff. The parent owns any optional context/evidence record.
- For ordinary issue implementation, read [worktrees and integration](references/integration.md).
  Helpers are beside this file; run them from the repository root:

  ```bash
  .agents/skills/vesper-agent-build/worktree-up.sh 284 gallery-cascade
  .agents/skills/vesper-agent-build/worktree-up.sh 256 dialect-2511 --slice
  ```

- Read [Codex collaboration](references/codex.md) before delegating. Use the
  collaboration tools and parameter schemas available in the current session.
- The parent owns push, external messages, board changes, and delivery unless
  explicitly delegated. Do not ask the user again for actions already authorized.

## Review and correct

Review each completed diff before integrating it. Run
`.agents/skills/vesper-agent-build/scan-diff.sh <worktree>` for control
characters and other mechanical hazards, then inspect:

- Scope and ownership: all promised behavior is present and extra work is absent.
- Resilience: schema-legal failures degrade with diagnostics (`docs/resilience.md`).
- Tests: the owning layer protects the defect; read `vesper-testing` before
  creating or reviewing tests. No local application gates, including Vitest.
- Docs: `vesper-docs` owns the durable-doc rules and their date exceptions.
- Migrations: generated SQL matches the schema change; no automated answers to
  Drizzle's ambiguous create-versus-rename prompt.
- Client/server seams: update the client's parsing contract when new server
  fields must survive it; zod can otherwise strip the field.

Send corrections to the same agent. If it is no longer available, give its
replacement the original brief, branch, and concrete findings. Continue the
correction loop inside the authorized task.

## Integrate and finish

Integrate in dependency order and review the combined diff; a merge can
reintroduce a defect fixed in a slice. Keep edits, inspection, and commits
sequential so they cannot race. Follow [integration and delivery](references/integration.md)
when combining branches or preparing a PR.

Report the delivered commits, behavior, actual validation, and any remaining
scope accurately. Remove completed worktrees with
`.agents/skills/vesper-agent-build/worktree-down.sh` after integration; it keeps
branches by default. Work state and acceptance belong on GitHub, according to
`vesper-docs` and `vesper-board`.
