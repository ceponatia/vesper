# Codex delegation

Read this only when the active host is Codex.

- Use the available collaboration tools, typically `spawn_agent`,
  `send_message`, `followup_task`, and bounded waits. Call them according to
  their current schemas; they are not shell commands or Claude `Agent` calls.
- Inherit the configured model by default. If the user requests a model, use
  its exact supported ID. Follow the tool's context-fork restrictions when
  providing a model override; give a context-free agent a self-contained brief.
- A worktree path in the brief binds the worker's commands and file ownership;
  do not assume spawning automatically changes its working directory.
- Use `send_message` for an active agent and `followup_task` to restart a
  completed/idle agent when those tools have those semantics. Reuse agents for
  corrections and related slices, including when the host reaches its limit.
- Ask missing material questions with the host's available user-input tool or
  a concise direct question. Do not invent `AskUserQuestion` or exceed the
  current tool's question limits. Continue independent work while waiting.
- Use event-driven/bounded waits and keep the user informed. An execution tool
  yielding a session ID does not imply support for `run_in_background` or
  `notify_on_output`; use its actual resume/wait interface.
- For work that must resume in a future turn, use the host's native automation
  capability when requested. A shell loop alone does not schedule agent turns.
