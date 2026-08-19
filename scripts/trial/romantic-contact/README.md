# Romantic contact rollout rerun

The instrument for the second romantic contact proof. The plan and the standing
verdict live in
`docs/developer-notes/romantic-contact-affordances.trial.romantic-proof.md`.

The first proof was run by hand through the UI and written up from what the
screen showed. It found the thing that matters — a refusal renders no narrator
line, so the prose described the caress as landing — but it could not SETTLE it,
because the record it left is a summary rather than the turns. This runner exists
so the rerun leaves the turns.

## What it captures, per case

| | |
| --- | --- |
| input | the player's line, verbatim as sent |
| rerun target | for a retake, the persisted message re-run, read back and checked |
| reply | the model's reply, verbatim |
| guidance | the physical-guidance lines handed to the narrator, captured **during** the turn |
| contacts | the player↔character pair, before setup, after setup, after the exchange |
| permission | the pair's standing, and whether a denial is bound to this attempt |
| outcome | resolver status, reason, result codes, durable commit, recorded material fact |

Guidance is captured through the pipeline's `onContactTurn` observer rather than
re-derived afterwards, which would read it against state the exchange has already
changed. Commit facts come from the persistence acknowledgment, so a ledger
mismatch — which rolls the scene back and writes nothing — is never reported as a
contact.

Contacts are counted for the tested pair only. Counting the whole scene would let
an unrelated surviving contact keep "still live" true and silently suppress the
withdrawal verdict.

## Grading — state first, prose second

**Both must pass.** `assertRequiredState` checks what the case required of the
world: the act built, resolver status and reason, durable commit count, live and
ended pair contacts, the permission standing, whether a denial is bound to this
attempt, the guidance kind, and — for the retake — that the surviving contact ids
are unchanged rather than merely the same in number.

Prose consistency alone cannot pass a case. It only asks whether narration
contradicts what happened, so on its own it passes a withdrawal that ended
nothing and a retake that left two contacts.

`gradeContactCase` then checks the narration against what was recorded, and is
pure — no model is involved in the verdict:

- **false_landing** — nothing was committed, and the reply wrote the touch as
  landing. The finding the whole rerun re-tests.
- **false_refusal** — the record says the contact landed, and the reply wrote it
  as blocked. Judged against the COMMIT, never against whether permission
  answered: on an unanswered attempt her refusing is legitimate — it is the only
  route by which `attempt_denied` ever reaches the ledger — and a withdrawal
  portraying itself is the correct reply.
- **material_contradiction** — the reply contradicts the recorded layer between
  hand and skin.
- **stale_continuation** — the exchange ended the contact and the reply wrote it
  as still in progress.

A single arm-blind model call reads each reply and reports what it depicts, with
a verbatim quote for every positive claim. It never sees the recorded state, and
every quote is checked against the reply before the oracle sees it.

## The cases, and why they run in this order

1. **no_grant** — against a verified clean ledger. It is the committing line with
   the grant removed, and closes its own distance, so the refusal cannot be
   attributed to reach or to a stale grant.
2. **explicit_denial** — sends, binds an `attempt_denied` to the action id the
   attempt actually produced, then reruns that exchange. The binding is the
   point: the policy read applies a denial only when it names the attempt being
   resolved, so an unbound one leaves the turn answering "nobody said" while the
   report claims a denial was tested.
3. **commit** — grant, then the same line.
4. **retake** — immediately after, rerunning that exchange's persisted user
   message. Anything in between would move the message it targets.
5. **withdrawal** — needs the live contact the retake leaves.
6. **natural_named** — last, on the clean slate the withdrawal produced, so the
   written name is the only thing under test.

## Running it

```bash
pnpm trial:romantic-contact --dry-run
```

Prints the plan, each case's required state, and all four flags. Safe anywhere;
no model calls, no state touched.

The real run must happen **on Fly**, over `fly ssh console`, with the proof flags
enabled for the window only and reverted afterwards. It refuses to start in demo
mode, or unless all four of `CHAT_CONTACT_ACTIONS`, `CHAT_ROMANTIC_PERMISSION`,
`CHAT_ROMANTIC_PERMISSION_DEV_OVERRIDE` and `CHAT_PHYSICAL_CONSTRAINTS` are
effective — each fails quietly and plausibly, and any one alone would produce an
entirely wrong report.

It needs a **fresh one-on-one** QA chat, named by `TRIAL_CHAT_ID`, with the
character as its only participant and no romantic-permission history. It never
creates one: building a chat correctly means a participant row, a resolved memory
group, a seeded scenario and a seeded relationship matrix. It refuses an ensemble
chat, because it drives the pipeline directly and does not reproduce the route's
roster assembly, model selection or authority resolution — in a one-on-one chat
those collapse to the single participant and the difference vanishes.

| variable | default |
| --- | --- |
| `TRIAL_CHAT_ID` | none — required |
| `TRIAL_CHARACTER` | `Sabrina Vale` |
| `TRIAL_USER_ID` | the QA account |
| `TRIAL_OUT_DIR` | `evidence/romantic-contact-rerun` |

It writes a JSON record and a Markdown report per run, and exits non-zero if any
case fails either check.

## What is tested

`oracle.test.ts` and `cases.test.ts` cover the grading rules, quote
verification, the required-state assertions, and the case list's ordering
invariants. `driver.int.test.ts` covers the database half against a real
Postgres — fixture resolution, pair-scoped snapshots, role-correct message
lookups, and that a bound denial is what the policy read actually applies.

Run the database half with a dev Postgres up:

```bash
pnpm vitest run --project=app-int --no-file-parallelism scripts/trial/romantic-contact/driver.int.test.ts
```

`run.ts` is the orchestration on top — the case loop, the report — and is not
itself covered; its `--dry-run` path is exercised by hand.
