# <Topic title> — technical spec

Status: companion to [<topic>.plan.md](<topic>.plan.md)

The implementation contract for coding agents. Product scope, priority, and open
questions live in the plan; this document is how the decisions in it get built.

## Scope

One paragraph: which part of the system this spec governs, and which adjacent
parts it deliberately leaves alone.

## Implementation status

**This spec owns slice-level progress** (the progress ladder). Every slice it
governs appears here with one of three states, updated in the change that lands
the code — never as a follow-up:

- **built <date>** — landed and in use.
- **built <date>, awaiting <what>** — code complete, waiting on a trial verdict,
  an owner review, or a flag enable. Name the thing being waited on.
- **not started** — with its blocker if it has one.

State it as a short list, or as a two-column table if there are many slices
(pipes aligned, one physical line per row). Keep it to the state; the reasoning
that produced it belongs in the sections below, and the delivery order belongs
to the plan.

Rulings the build settled go under their own heading here, dated, so a later
reader can see why an implementation deviates from what this spec describes.

## Contracts

Type shapes, schemas, and the module that owns each one. State where each type
lives (`src/contracts/…`) and which layers may import it. Remember the boundary
rules: `src/contracts` and `src/lib` are pure; server modules cross only through
`index.ts` barrels; components never import `server/*`.

## Ownership rules

Which module is authoritative for each piece of state, and what every other
module is allowed to do with it. Write these as invariants a reviewer can check.

## Algorithms

The computation, in enough detail to reimplement. Order of operations, tie-break
rules, and the exact inputs each step is allowed to read.

## Persistence

Tables, columns, indexes, and the migration path. Follow the DB workflow: edit
`src/server/db/schema.ts`, `pnpm db:generate`, review the SQL, `pnpm db:migrate`.

## Resilience

Trust boundaries and their `parseOr` calls, the degraded default at each one,
and the diagnostic code emitted. Per `docs/resilience.md`, every fallback path
names its diagnostic and every degradation test asserts both the fallback and
the code.

## Code organization

Where the new modules live, what each exports, and which barrel re-exports them.

## Fixtures and tests

The fixtures this work needs, what each one pins, and which suite runs them
(`test` pure, `test:int` / `test:engine` against Postgres).
