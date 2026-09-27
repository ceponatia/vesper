---
name: vesper-board
description: Create and classify Vesper issues, link branches and PRs, and update board status, assignment, iterations, or dependencies. Use for GitHub lifecycle operations; vesper-docs owns issue content and documentation placement.
---

# Vesper board operations

Board: Vesper Development, project `7`, owner `ceponatia`, project ID
`PVT_kwHOARzdw84BhlWR`. Inspect its live README and fields when classification
requires them. The helpers resolve option names and iteration IDs through small
direct GraphQL queries; do not copy static field IDs, option lists, or dates.

`vesper-docs` owns the body and structure of issues; this skill owns creating
and relating them and their board lifecycle. `vesper-pr-review` owns CI and
review after a PR exists. Existing user scope and authorization remain in force.

## Choose the operation

Run helpers beside this file from the repository root. Prefix examples with
`.agents/skills/vesper-board/`.

| Operation | Helper or procedure |
| --- | --- |
| Create, resume, and relate an issue | `file-issue.sh --title … --body-file … --parent N --blocked-by M …`; recover with `file-issue.sh --issue N …` |
| Set named fields or assignment | `board-set.sh N [--pr] [--assign or --unassign] Field Value …` |
| Preview field changes | `board-set.sh N --dry-run Field Value …` |
| Mirror issue classification to a PR | `link-pr.sh PR ISSUE` |
| Start a branch or manage PR lifecycle | [Issue and PR lifecycle](references/lifecycle.md) |
| Change iteration dates or recover assignments | [Iteration maintenance](references/iterations.md) |

For a complete issue, create its branch with `gh issue develop`; its Development
link can close the issue on merge. Partial delivery uses an unlinked slice branch
and `Part of #N`. Read the lifecycle reference before creating either. Explicit
user instructions for direct-main delivery override that default for the task.

## Assignment and truthful completion

Assigned to `ceponatia` means the next action is the owner's. Assign when built
work awaits owner review/acceptance, or an owner ruling is the only unblock.
Implementation and discovery remain unassigned. Remove the assignee when owner
action sends work back to implementation. Do not assign the owner for an action
the agent is already authorized to complete.

Built is not accepted. Name the remaining acceptance action on the issue and
use the appropriate board state. Close only the scope actually delivered and
accepted; a partial PR must not erase remaining work. Set PR status from its
own lifecycle, because issue linkage does not inherit fields or status.

## API and recovery rules

Use the provided direct GraphQL/REST helpers. `gh project` subcommands can report
rate limiting while direct calls work; inspect the actual error and budget and
use the direct path. Do not retry a failed mutation blindly or wait out a false
rate-limit report. Sub-issue and blocked-by REST endpoints take database IDs,
not issue numbers; the helpers resolve them.

Read saved fields and relations after mutations. If issue creation succeeded
before another step failed, the helper reports recovery instructions and prints
the created issue number last on stdout while retaining the failing exit status.
Rerun with `--issue N` and the same classification/relation options to complete
that issue instead of creating a duplicate. Query live labels and milestones
as needed; use milestones sparingly for a real multi-issue release or acceptance
boundary, not ordinary grouping. No new taxonomy or workflow is implied.
