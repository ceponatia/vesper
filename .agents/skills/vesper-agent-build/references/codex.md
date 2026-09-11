# Codex collaboration

Choose a focused project role when it materially helps the task:

| Role | Bounded responsibility |
| --- | --- |
| `vesper-context-scout` | Gather the minimum verified context for a fresh worker or handoff. |
| `vesper-ux-reviewer` | Assess substantial flows, defaults, unnecessary steps, and simpler alternatives. |
| `vesper-ui-reviewer` | Inspect the deployed desktop/mobile UI and record rendered evidence. |
| `vesper-scenario-reviewer` | Trace meaningful state transitions, failure recovery, and access boundaries. |
| `vesper-test-keeper` | Bring every test that owns a finished change up to date and report the CI evidence. |

These profiles inherit the selected model. Claude-side roles under
`.claude/agents/` pin their model instead, and `AGENTS.md` §Subagent model
policy (Claude) owns that table. Do not run every role for every change.
Context, UX, and scenario roles inspect without editing; the UI role may record
evaluation artifacts; the test keeper edits tests only. They do not implement
fixes or spawn further agents. Run the test keeper after an implementation slice
lands and before reporting it complete — it is the one role every coding task
ends with.
Check the current spawn tool's available role names. New `.codex/agents` files may
require a fresh session before they appear. If a role is unavailable, give an
available agent its profile and matching skill, and report the fallback honestly.

Profile sandbox defaults support these boundaries, but parent permission overrides
can take precedence; do not describe role instructions as a complete security boundary.

- Use `spawn_agent` for a concrete, bounded subtask that can proceed independently.
  Give code-changing workers explicit path or module ownership and tell them
  other agents share the codebase and their edits must be preserved.
- A worktree path in the brief binds the worker's commands and ownership; spawning
  does not change its working directory. Use the brief template so a worker with
  limited inherited context still receives the issue, decisions, restrictions,
  paths, and required report.
- Inherit the configured model. Override it only when the user requests a
  supported model, and follow `spawn_agent`'s context-fork restrictions.
- Use `send_message` to steer a running agent. Use `followup_task` to trigger a
  correction turn for an idle agent. Send findings back to the original worker
  when possible so it retains its implementation context.
- Use `wait_agent` for event-driven mailbox updates. Cap each wait at 60 seconds
  so progress updates remain possible; repeat bounded waits when work is still
  running instead of using an unbounded read. User steering ends the wait; answer
  it and continue the authorized task unless the user cancels or replaces it.
- Call collaboration tools directly in the commentary channel according to their
  current schemas. They are not shell commands and are not available through an
  execution-tool wrapper.
- Use the available user-input tool only for unresolved material choices. Existing
  authorization and settled rulings remain in force while delegated work runs.
