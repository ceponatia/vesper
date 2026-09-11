---
name: vesper-pr-review
description: Handle Vesper PR CI failures, review comments, review freshness, and authorized merges. Use after a push or when checking CI or closing review threads, including on merged PRs.
---

# Vesper PR review

Start by reading the PR's current state. Preserve authorization already given
in the session: do not ask again for an action the user already approved. The
owner marks drafts ready and merges by default, while an explicit user
instruction to do either action overrides that default.

Use the helpers from this skill directory:

| Need | Command |
| --- | --- |
| Wait for required CI | `wait-ci.sh <pr>` |
| Read failed CI logs | `ci-failure.sh <pr>` |
| Classify review state | `review-status.sh <pr>` |
| Read review threads | `threads.sh <pr> [--all]` |
| Reply and resolve | `reply-resolve.sh <pr> <id> --body "…"` |

Only `reply-resolve.sh` mutates GitHub. Use a skill-relative path such as
`.agents/skills/vesper-pr-review/wait-ci.sh 477`.

## Required CI rule

`wait-ci.sh` succeeds only when every required check is successful and the
required `CI / verify` aggregate reports `SUCCESS` for one unchanged, full PR
head SHA. Pending exit 8 and failing exit 1 from `gh pr checks` can contain
valid JSON and are parsed. Missing checks, unrelated successful checks,
stale-head results, drafts, conflicts, timeouts, and repeated API errors never
become green.

Run the helper with Codex `exec_command`. When it yields a `session_id`, continue
that same session with `write_stdin` until it exits. Keep the user updated during
a long wait. Do not create a separate monitor around the probe.

Never run Vesper's pnpm, Vitest, lint, typecheck, build, or verification gates
locally. CI is the gate. When it fails, use `ci-failure.sh`, read the code, fix,
push, and wait on the new full head.

## Review rule

Run `review-status.sh` after CI. It paginates review data and distinguishes
`unrequested`, `pending`, `findings`, `clean`, and `unverified` using the exact
reviewer identity and current full head. Read open threads for findings.

For every finding you implement, reply on that thread after pushing, name the
fix commit and location, then resolve it. Never silently fix a thread and never
resolve one you did not address. Reply with reasoning and leave it open when
owner judgment is still needed.

Correction rounds are capped per finding: two on the default worker (Sonnet
on Claude, the default worker on Codex), then one on the escalation role.
When that round does not close the finding, stop the loop — leave the thread
open with the escalation record and hand the PR to the owner for review and
next steps instead of requesting another review pass. The root instructions'
subagent model policy owns the cap.

Read [references/operations.md](references/operations.md) when CI fails, review
findings exist, Codex needs another pass, the branch moved concurrently, or a
merge is authorized.

## Completion

A PR is ready for owner acceptance when the current head is mergeable,
`wait-ci.sh` exits 0, review status has no unresolved actionable result, and
every addressed thread carries a commit-naming reply and is resolved. If the
user authorized merging, recheck those conditions immediately before the
squash merge and verify GitHub reports the PR merged.
