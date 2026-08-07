# <Topic title> — audit

Status: reference (audit run <date>)

A snapshot of the code as it stood on the date above. It records findings; it
does not plan the fixes. A finding worth acting on becomes a plan or an entry in
[deferred.plan.md](deferred.plan.md) — link that destination from the finding.

## Scope

What was examined and what was deliberately left out.

## Method

How the findings were produced, in enough detail that someone could re-run the
audit and get a comparable result.

## Findings

One subsection per finding. State what is true, where, and why it matters. Do
not prescribe the fix beyond naming the shape of it.

### <Finding title>

- **What** — the observation, with the file or module it lives in.
- **Impact** — what it costs today, concretely.
- **Where it goes** — the plan or deferred entry that owns any follow-up, or
  "no action" with a reason.

## Nothing found

The checks that came back clean, listed briefly. An audit that only lists
problems cannot be used to show coverage later.
