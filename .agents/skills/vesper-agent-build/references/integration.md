# Worktrees, integration, and delivery

Read for worktree creation, branch integration, or delivery. The worktree
helpers run from any checkout; the remaining commands run from the main
checkout, and implementation runs in each assigned worktree.

## Worktree lifecycle

- `.agents/skills/vesper-agent-build/worktree-up.sh <issue> <slug>` creates an
  issue-linked branch and a worktree under the main checkout's
  `.codex/worktrees/`, from any checkout.
  A Development link can close the issue on merge: use it only for delivery of
  the whole issue. `--slice` creates an unlinked branch for partial delivery,
  whose PR says `Part of #N`. `vesper-board` owns this distinction.
- `--base`, `--dir`, and `--no-install` control base, location, and dependency
  linking. Reusing an existing branch resumes its tip; inspect it before reuse.
- The helper attempts an offline frozen-lockfile install from the main checkout's
  pnpm store, or the default store when none is recorded. If that fails, report
  that editor diagnostics may be incomplete; do not make speculative manifest
  changes or run local gates to compensate.
- A worktree must not start a competing compose container with the same name.
  Runtime UI verification belongs on Fly via `verify`.
- `.agents/skills/vesper-agent-build/worktree-down.sh <issue|path>` resolves a bare
  issue number under the main checkout, refuses dirty worktrees, and keeps the
  branch.
  Before requesting branch deletion, verify merged-PR containment and unique
  content, including squash merges. Being ahead of main proves neither safety
  nor a need to recover the branch. Do not discard unreported agent work.

## Combine slices

1. Use the parent issue's linked branch for a complete multi-slice delivery.
2. Merge dependencies first: schema/data, consuming code, then UI/docs.
3. Resolve shared registration/index conflicts deliberately and review the
   combined result with `scan-diff.sh`; do not run local application gates.
4. Before pushing a branch another session may own, fetch and compare its
   remote tip. Never overwrite concurrent work to make the push succeed.

## Deliver within the request

The default delegated build ends with a pushed branch and a report; if the
user authorized a PR, readying, merge, or direct-main delivery, perform that
authorized action without asking again. A skill does not authorize additional
external messages or a production deploy by itself.

For an authorized PR, use [the body template](../templates/pr-body.md), one
`Closes #N` line per completely delivered issue, or `Part of #N` for partial
scope. Keep it draft while iterating; `vesper-board` owns classification and
assignment, and `vesper-pr-review` owns the CI/review loop. Do not close or mark
accepted any scope still owed. Name actual validation rather than promising
that a green aggregate covers a suite that did not run.
