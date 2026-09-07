# Optional workflow context record

Use this record only when the parent requests a receipt for a substantive task
with verification requirements. It is evaluation data, not GitHub work state,
durable documentation, or memory.

The parent resolves its record path from the repository root:

```bash
python3 .codex/hooks/workflow_context.py --record-path [--session <session-id>]
```

The helper defaults to the shared root-session `CODEX_SESSION_ID`, then
`CODEX_THREAD_ID`, and returns an
absolute gitignored path beneath
`eval-images/agent-context/<sha256(session_id)[:24]>/record.json`. A read-only
context scout may recommend a receipt or return its contents as text; the parent
owns writing and resetting the record.

The JSON shape is:

```json
{
  "version": 1,
  "session_id": "exact shared root-session id",
  "brief": "brief.md",
  "requirements": ["docs", "ui"],
  "results": [
    {
      "requirement": "docs",
      "status": "verified",
      "evidence": "local artifact or CI URL",
      "reason": ""
    },
    {
      "requirement": "ui",
      "status": "unverified",
      "reason": "not deployed"
    }
  ]
}
```

`brief` is optional. When present, it is a relative Markdown path confined to
the same record directory and the file must exist. Allowed result statuses are
`verified`, `failed`, `unverified`, and `not-applicable`. `verified` requires
nonempty evidence; every other status requires a reason. Match results to the
declared requirements and the shared root session. Hook execution uses
`CODEX_SESSION_ID` when present, falling back to the event's `session_id`.
Child thread IDs can differ from the shared session ID; do not substitute one
for the other when creating a record. If environment IDs are unavailable, use
the session ID and record path supplied by the startup hook.

Record paths are checkout-local. For work delegated to a different worktree,
include the parent's absolute record/brief path in the assignment rather than
assuming the other checkout contains the same evaluation files. The parent owns
completion evidence; a child does not overwrite the parent's receipt.

Update or reset the receipt when task scope changes. Record the checked full SHA
and relevant dirty delta in the brief or evidence when they affect a claim.
Evidence and brief text are self-reported pointers, not proof that the claim is
correct.

No record means no Stop warning. SessionStart and SubagentStart expose a stable
record pointer, checkout identity, and role-specific skill pointer; they do not
inject brief contents. Stop may warn once per malformed or incomplete record hash
using private local deduplication. It never blocks, continues work, or executes
proposed commands, application gates, or tests; its Git inspection is read-only.
