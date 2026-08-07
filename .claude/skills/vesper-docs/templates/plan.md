# <Topic title — plain English, no internal vocabulary>

Status: draft | next | active | awaiting acceptance — <what> | shipped — <date> | parked

Outcome: <A player | The owner | A developer> can <do something concrete> so
that <observable consequence>.

## Why

What is wrong or missing today, in plain English, for a reader who has never
seen the code. Name the situation a person hits, not the module that handles it.

## What the owner gets

The changed experience, as a short list of bolded capabilities with a sentence
or two each. Describe what appears on screen or in the workflow — not how it is
computed.

## Boundaries

### In scope

What this plan commits to delivering.

### Non-goals

What this plan deliberately does not do, and where that work lives instead
(another plan, `deferred.plan.md`, or nowhere yet).

## Slices

Delivery order, each slice independently shippable and independently reviewable.
Name what a slice makes true, not which files it edits. This is the plan's
*intent* and it does not change when code lands — whether a slice is built is
the spec's to say (the progress ladder).

- **Slice 1 — <what becomes true>.** One or two sentences.
- **Slice 2 — <what becomes true>.** One or two sentences.

## Where the work stands

One line per spec, not per slice — slice-level status lives in the spec itself.
A plan with no spec keeps its own slice status here until it grows one.

- **[<topic>.spec.md](<topic>.spec.md)** — complete <date> | in progress | not
  started. When it is waiting on acceptance rather than on code, say what it
  waits on.

## Success criteria

How we will know it worked, stated so that someone could check it without
reading code. For behavior claims, name the trial that will produce the evidence.

## Open questions

Every unresolved question for this topic, wherever it was raised. Each line
links to the detail doc that holds the discussion. Resolving one removes it from
here and records the ruling in that detail doc.

- **<Question>** — <what the answer would change> ([detail](<topic>.spec.md)).

## Technical companion

[<topic>.spec.md](<topic>.spec.md) — contracts, types, algorithms, persistence,
diagnostics.
