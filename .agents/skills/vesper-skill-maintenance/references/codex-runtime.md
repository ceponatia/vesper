# Vesper Codex runtime configuration

Project roles live in `.codex/agents/*.toml`; optional task-context and evidence
hooks live in `.codex/hooks.json` with handlers under `.codex/hooks/`. The existing
PreToolUse preflight remains separate. `.claude/hooks/preflight.py` links to its
canonical Codex implementation so compatibility callers do not drift.

## What the hooks do

- `SessionStart` and `SubagentStart` report the actual checkout, committed HEAD,
  branch, and a checkout-local shared-session record pointer. A cross-worktree
  assignment supplies the parent's absolute record path. Hooks add no brief contents
  or transcript excerpts to developer context. Assignment scope stays in the
  parent's brief; a hook does not infer owned files from the subagent type.
- `Stop` checks an optional record only when one exists. It warns once for each
  incomplete or malformed record content, never blocks, starts another turn,
  runs application gates, or interprets proposed shell commands.
- A declared check can be verified with an evidence reference, or explicitly
  failed, unverified, or not applicable with a reason. Presence is self-reported
  evidence bookkeeping, not proof of correctness, freshness, or visual quality.

`vesper-task-context` owns the optional record format and when to use it. Keep
records under gitignored `eval-images/`; update/reset them when task scope changes.
They are task artifacts, not memories or another source of GitHub work state.

## Validate each boundary

1. Parse project TOML/JSON and check role names, required fields, metadata, and
   handler paths. Preserve unrelated settings and avoid duplicate hook sources.
2. Run the dependency-free fixtures:

   ```bash
   python3 -B -m unittest discover -s .codex/hooks -p 'test_*.py'
   ```

3. Use the current host's `hooks/list` API or CLI `/hooks` to inspect effective
   definitions, parse errors, enablement, and trust. Read-only discovery does
   not grant trust or execute a handler. Match shell/exec preflight as `Bash`.
4. Complete the host's supported trust review for changed hook definitions before
   claiming activation. Do not bypass trust checks or edit private trust storage.
5. In a fresh session, select each required custom role and use harmless startup,
   spawn, and completion events to verify runtime behavior. If that stage is not
   available, report structural/fixture/discovery results separately from activation.

Consult the current [hook documentation](https://learn.chatgpt.com/docs/hooks)
and [custom-agent documentation](https://learn.chatgpt.com/docs/agent-configuration/subagents)
for the active host's schema. The project does not pin models, raise concurrency,
change global approval policy, or use model-driven review hooks after each edit.
