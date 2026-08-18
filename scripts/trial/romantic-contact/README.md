# Romantic contact rollout rerun

The instrument for the second romantic contact proof. The plan and the standing
verdict live in
`docs/developer-notes/romantic-contact-affordances.trial.romantic-proof.md`.

The first proof was run by hand through the UI and written up from what the
screen showed. It found the thing that matters — a refusal renders no narrator
line, so the prose described the caress as landing while nothing was committed —
but the record it left is a summary rather than the turns. This runner exists so
the rerun leaves the turns, and so the verdict can be re-derived from them
without running anything again.

## What it captures, per case

| | |
| --- | --- |
| input | the player's line, verbatim as sent |
| reply | the model's reply, verbatim |
| guidance | the physical-guidance lines handed to the narrator, captured **during** the turn |
| before / after | live player↔character contacts, read from the projection either side |
| outcome | resolver status, reason, result codes, commit, recorded material fact |

The guidance is captured through the pipeline's `onContactTurn` observer rather
than re-derived afterwards. Re-deriving would read it against state the exchange
has already changed, which is precisely wrong on the cases that commit.

## Grading

`oracle.ts` decides, and it is pure — no model call is involved in the verdict.
It rejects four contradictions between what the exchange recorded and what the
prose depicted:

- **false_landing** — nothing was committed, and the reply wrote the touch as
  landing. The finding the whole rerun re-tests.
- **false_refusal** — nothing refused it on the record, and the reply wrote the
  character refusing. Unknown is not denied, in the prose too.
- **material_contradiction** — the reply contradicts the recorded layer between
  hand and skin.
- **stale_continuation** — the exchange ended the contact and the reply wrote it
  as still in progress.

A single arm-blind model call reads each reply and reports what it depicts, with
a verbatim quote for every positive claim. It never sees the recorded state, and
every quote is checked against the reply before the oracle sees it — a
hallucinated quote is discarded with its claim.

**This oracle is stricter than the first proof's by-eye grading.** It treats a
depicted refusal on an *unresolved* outcome as an invented refusal. The first
proof accepted a reply where the character drew her arm back on an unresolved
reach outcome; this rerun will flag that.

## Running it

```bash
pnpm trial:romantic-contact --dry-run
```

Prints the plan and the flag state. Safe anywhere, makes no model calls, touches
no state.

The real run must happen **on Fly**, over `fly ssh console`, with
`CHAT_ROMANTIC_PERMISSION` and `CHAT_ROMANTIC_PERMISSION_DEV_OVERRIDE` enabled
for the proof window only — the same conditions as the first proof, and the same
obligation to revert both afterwards. It refuses to start in demo mode or with
the flag off, because a run that graded a lane which never executed would produce
a clean report about nothing.

It needs an **existing** QA chat, named by `TRIAL_CHAT_ID`, that already includes
the character. It never creates one: building a chat correctly means a
participant row, a resolved memory group, a seeded scenario and a seeded
relationship matrix, and a script reproducing that approximately would run the
trial against a conversation subtly unlike the ones players have.

| variable | default |
| --- | --- |
| `TRIAL_CHAT_ID` | none — required |
| `TRIAL_CHARACTER` | `Sabrina Vale` |
| `TRIAL_USER_ID` | the QA account |
| `TRIAL_OUT_DIR` | `evidence/romantic-contact-rerun` |

It writes a JSON record and a Markdown report per run, and exits non-zero if any
case fails or goes ungraded.

## What is tested and what is not

`oracle.test.ts` and `cases.test.ts` run in the pure suite and cover everything
that decides anything: the grading rules, quote verification, the derivation of
graded state from the turn, and — the cheap guard against the expensive mistake —
that each case line actually produces the act it claims to, through the real
detectors.

`run.ts` is the driver, and it is **unverified against a live database**. Its
`--dry-run` path is exercised; the DB and pipeline calls are not. Expect to debug
it on first use, and do that before the flag window rather than inside it.
