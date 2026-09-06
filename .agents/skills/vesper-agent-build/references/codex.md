# Codex collaboration

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
