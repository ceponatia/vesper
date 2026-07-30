# Tooling gates — the checks that should have found the audit

Status: draft (F2 shipped in 66ecd3b; eval-harness and targeted duplication work remain sequenced late)

## Why

The 2026-07-30 efficiency audit was found by six agents reading code for an afternoon.
The gates that run on every change found none of it and stayed green throughout. Other
audit batches each fix a pile of copied code; this one fixes the reason nobody was told.
Nothing here is user-visible, and all of it decides whether the *next* audit is needed.

**The duplication gate looks in the wrong places, at the wrong grain.** `pnpm jscpd`
scans `src` only, ignores anything under 70 tokens, and passes against one repo-wide 3%
budget (**F1**). A repo-wide budget lets a hot spot be egregious locally and still
average away — eleven byte-identical replay loops (**A3**) and forty-six copies of the
same command boilerplate (**A1**) sat under it. The token floor misses copies
*interleaved* with two-line differences, exactly the five library editor pages sharing
~140 lines of scaffolding each (**D1**). And `scripts/` is not scanned at all, so the
worst-proportioned duplication in the repo (**C11**) was invisible by construction.

**One mandated gate is never run.** `package.json`'s `verify` chain includes
`lint:authz`, the check that every API route declares its authorization. Agents are told
(correctly, for memory reasons) never to run `verify` and to work the gate list in the
root `CLAUDE.md` one command at a time — and that list omits `lint:authz` (**F2**). So
the check runs for nobody who follows the instructions.

**The eval scripts are where the unscanned duplication lives.** Six runners under
`scripts/eval/` share a harness nobody wrote (**C11**), and the copies disagree: three
close their database pool on exit, two leave a finished run hung on an open handle.

## Scope

- **F1 — jscpd config.** Add `scripts` to the scanned path, then settle the budget
  grain: per-folder thresholds, a lower token floor on targeted paths, or a second
  narrow invocation. The trade-off is the whole question (slice 3).
- **F2 — the gate list.** Add `lint:authz` to the sequential list in the root
  `CLAUDE.md`, in the position `verify` uses (after `lint:cycles`).
- **C11 — one eval harness.** A shared `scripts/eval/harness.ts` owning flag parsing
  (copied four times today), the output-directory default (four rival spellings), JSON
  result writing, the exit footer (seven copies; pool cleanup always), and the image
  edit-and-save call (five copies). Normalize the two import styles
  (`../../../src/...` vs `@/...`), and move the scene-image output off `docs/`.
- **F4 — doc drift found in passing.** `unconsumed-character-prose.md` describes the
  deleted session lane and belongs in `finished/` or the bin. The other two sites are
  **claimed elsewhere, not here**: `docs/ui.md:49` rides
  [editor-scaffold.plan.md](editor-scaffold.plan.md) (**D8**), `docs/database.md:24`
  rides [dead-export-sweep.plan.md](dead-export-sweep.plan.md) (**C19**).

## Non-goals

- **No new lint rules** (the config is already type-aware and expensive) and **no CI
  changes** beyond the jscpd config file and the one `CLAUDE.md` line — no new gate
  command, no reordering, no hooks.
- **No test-framework changes**, and no change to what any eval *measures*; if a
  runner's verdict moves, the extraction is wrong.
- **Not fixing the duplication the gate should have caught** — A1/A3/D1 are their own
  batches. This plan only makes them visible.
- **No roadmap edit.** OQ1 is recorded, not acted on.

## Review rulings and scope adjustments — 2026-07-30

- F2 is already closed: commit `66ecd3b` added `pnpm lint:authz` to the
  sequential gate list. Do not re-implement it.
- Extract the eval harness before widening clone detection to `scripts/`. Give
  the shared harness a name distinct from the existing affordance-cue rig.
- Prefer targeted folder thresholds or a second narrow invocation over globally
  lowering `minTokens`. A noisy gate that reports ordinary fixtures will be
  ignored and is worse than today's blind spot.
- Moving scene-image output also changes a tracked review page. Treat the output
  and page move as one documentation change, or retain a documented exception.
- The stale roadmap follow-on line is resolved by the reviewed sequencing update;
  this plan no longer owns that decision.

## Delivery slices

**Slice 1 — the missing gate line (F2).** One line in the root `CLAUDE.md`. Land it
first: it costs nothing and closes a hole that is open right now.

**Slice 2 — the eval harness (C11).** Extract the harness, migrate the six runners,
settle the import style, give every pool-opening runner a footer that closes it.
Deliberately before slice 3: widening the gate to `scripts/` while the eval duplication
is still there turns it red on its first run.

**Slice 3 — widen the gate, then choose its grain (F1).** Add `scripts` to the path,
confirm green, then measure before committing to a budget shape. The governing
constraint: the gate uses the threshold reporter so it prints **nothing** when clean,
which keeps it readable at the tail of a five-gate run. Anything chatty — or that flags
every legitimately similar test fixture — gets ignored and then disabled, strictly worse
than today's blind spot. So prefer a few narrow entries with tighter budgets over a
global floor drop, count false positives against today's tree first, and fall back to a
second narrow invocation behind the same `pnpm jscpd` if per-folder budgets won't
express cleanly.

**Slice 4 — the drift this plan owns (F4).** Resolve `unconsumed-character-prose.md` per
OQ3; cross-reference the other two sites rather than fixing them twice.

## Success criteria

- The `CLAUDE.md` gate list and the `verify` chain diff clean.
- `pnpm jscpd` covers `scripts/` and prints nothing on a clean tree.
- Across the six runners: one flag parser, one output default, one exit footer, one
  import style — and every runner that opens a pool closes it.
- Re-running an eval that needs no model call gives byte-identical results before and
  after the extraction, and no eval writes generated output under `docs/`.
- Each F4 site is fixed here or claimed by a named plan.

## Risks & coordination

- **Sequencing is the main risk.** Slice 3 before slice 2 fails the gate on a tree
  nobody broke, which is how gates lose trust. And a noisy gate is worse than a blind
  one: if the measurement says a tighter budget can't stay quiet, widen the path only.
- **Name collision, plus active churn.** `scripts/eval/affordance-cues/harness.ts`
  already exists and is a different thing (the affordance trial's prompt rig) — the
  shared file needs a name that can't be mistaken for it, or the local one gets renamed.
  That runner also sits inside the live narrator-physical-guidance work (the audit's
  [WIP] caveat), so coordinate or migrate it last.
- **The output move is not mechanical.** `docs/scene-image-eval/index.md` is a tracked
  review page embedding the generated images by relative path, so moving the output
  breaks the page it exists to serve — and the images are already gitignored, making this
  a convention violation rather than git pollution (lower urgency, real decision: OQ4).
- **Import normalization** touches the module graph `pnpm lint:cycles` scans; run it.

## Open questions

- What targeted duplication-gate grain remains silent on the current tree while
  catching the known replay, editor, and script clones?
- Archive or delete `unconsumed-character-prose.md`? Preserve it only if the
  reasoning still applies to the live chat lane.
- Does scene-image eval output move with its review index, or keep a documented
  `docs/` exception?
