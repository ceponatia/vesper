# Claude Code delegation

Read this only when the active host is Claude Code.

- Use `Agent`, messaging, questions, and background execution only when those
  capabilities are present in the session, with their currently accepted fields.
- Inherit the selected model unless the user specifies one. Where the owner
  requests Claude model tier selection, Opus suits kernel/store/integration and
  correction work; Sonnet suits mechanical edits. Resolve these to supported
  model IDs rather than copying a remembered version.
- If a model-access error contradicts the requested model, inspect the active
  `CLAUDE_CODE_SUBAGENT_MODEL` and local settings before retrying. Report a
  mismatch; do not silently rewrite the user's model configuration.
- Give each agent its absolute worktree path and ownership list. Background
  agents must still report completion and receive review before integration.
- Use the available question tool for unresolved material decisions only;
  existing user authorization and settled rulings remain in force.
