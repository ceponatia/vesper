# Tooling gates — the checks that should have found the audit

Status: draft (F2 and F4 are closed; F1 and C11 remain, sequenced late)

Outcome: A developer can read a green duplication check as proof that no new
copy-paste slipped into anywhere the repo actually keeps code, so that the next
pile of duplicated code is caught by CI before merge rather than by six agents
reading code for an afternoon.

## Why

The 2026-07-30 efficiency audit was found by six agents reading code for an afternoon.
The gates that run on every change found none of it and stayed green throughout. Other
audit batches each fix a pile of copied code; this one fixes the reason nobody was told.
Nothing here is user-visible, and all of it decides whether the *next* audit is needed.

**The duplication gate looks in the wrong places, at the wrong grain.** `pnpm jscpd`
scans `src` only, ignores anything under 70 tokens, and passes against one repo-wide 3%
budget (**F1** — `.jscpd.json` is unchanged since the audit). A repo-wide budget lets a
hot spot be egregious locally and still average away — eleven byte-identical replay
loops (**A3**) and forty-six copies of the same command boilerplate (**A1**) sit under
it today. The token floor misses copies *interleaved* with two-line differences, exactly
the five library editor pages sharing ~140 lines of scaffolding each (**D1**). And
`scripts/` is not scanned at all, so the worst-proportioned duplication in the repo
(**C11**) is invisible by construction.

**The eval scripts are where the unscanned duplication lives.** Six runners under
`scripts/eval/` — affordance-cues, engine-gate1, engine-gate2-soak, retrieval,
scene-images, schedule-kind — share a harness nobody wrote (**C11**), and the copies
disagree: three close their database pool on exit, two leave a finished run hung on an
open handle. The output-directory default is still spelled with `||` in one runner and
`??` in another, and the scene-image runners still write generated images under `docs/`.

## Scope

- **F1 — jscpd config.** Add `scripts` to the scanned path, then settle the budget
  grain: per-folder thresholds, a lower token floor on targeted paths, or a second
  narrow invocation. The trade-off is the whole question (slice 2).
- **C11 — one eval harness.** A shared `scripts/eval/harness.ts` owning flag parsing
  (copied four times today), the output-directory default (four rival spellings), JSON
  result writing, the exit footer (seven copies; pool cleanup always), and the image
  edit-and-save call (five copies). Normalize the two import styles
  (`../../../src/...` vs `@/...`), and move the scene-image output off `docs/`.

**Closed, retained only so nobody re-derives them:**

- **F2 — the gate list, closed twice over.** The audit found that the root
  `CLAUDE.md`'s sequential gate list omitted `lint:authz` while `package.json`'s
  `verify` chain required it. Commit `66ecd3b` (2026-07-30) added the line. That
  prose list was later removed. The temporary local-only arrangement that followed
  when GitHub Actions minutes ran out was itself retired on 2026-08-21/22: GitHub
  Actions on AWS CodeBuild is now the sole verification gate, the required order
  lives in `.github/workflows/ci.yml`, and there is no local pre-push hook or
  authoritative wrapper to drift from it.
- **F4 — doc drift.** `unconsumed-character-prose.md` was archived to `finished/`
  on 2026-08-02 (kept rather than deleted because four archived docs link it at
  that path). `docs/database.md`'s `travel_minutes` line now records the retain
  ruling, closing **C19**'s documentation half. One site remains and is
  **claimed elsewhere, not here**: `docs/ui.md` still credits
  `useDebouncedValue` to the new-chat dialog, which does not import it — that
  rides [editor-scaffold.plan.md](editor-scaffold.plan.md) (**D8**).

## Non-goals

- **No new lint rules** (the config is already type-aware and expensive) and **no changes
  to the gate runner** beyond the jscpd config file — no new gate command, no reordering,
  no hooks.
- **No test-framework changes**, and no change to what any eval *measures*; if a
  runner's verdict moves, the extraction is wrong.
- **Not fixing the duplication the gate should have caught** — A1/A3/D1 are their own
  batches. This plan only makes them visible.

## Review rulings and scope adjustments — 2026-07-30

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

**Slice 1 — the eval harness (C11).** Extract the harness, migrate the six runners,
settle the import style, give every pool-opening runner a footer that closes it.
Deliberately before slice 2: widening the gate to `scripts/` while the eval duplication
is still there turns it red on its first run.

**Slice 2 — widen the gate, then choose its grain (F1).** Add `scripts` to the path,
confirm green, then measure before committing to a budget shape. The governing
constraint: the gate uses the threshold reporter so it prints **nothing** when clean,
which keeps the CI static-check output readable. Anything chatty — or that flags every
legitimately similar test fixture — gets ignored and then disabled, strictly worse than
today's blind spot. So prefer a few narrow entries with tighter budgets over a global floor drop,
count false positives against today's tree first, and fall back to a second narrow
invocation behind the same `pnpm jscpd` if per-folder budgets won't express cleanly.

## Success criteria

- `pnpm jscpd` covers `scripts/` and prints nothing on a clean tree, proven by the
  ready PR's green CodeBuild `static checks` job and aggregate `verify` check.
- Across the six runners: one flag parser, one output default, one exit footer, one
  import style — and every runner that opens a pool closes it.
- Re-running an eval that needs no model call gives byte-identical results before and
  after the extraction, and no eval writes generated output under `docs/`.
- Validation is CI (root `CLAUDE.md` and `.github/workflows/ci.yml`): mark the PR ready
  and require the applicable CodeBuild jobs plus the aggregate `verify` check to pass.
  There is no local pre-push gate.

## Risks & coordination

- **Sequencing is the main risk.** Slice 2 before slice 1 fails the gate on a tree
  nobody broke, which is how gates lose trust. And a noisy gate is worse than a blind
  one: if the measurement says a tighter budget can't stay quiet, widen the path only.
- **Name collision, plus active churn.** `scripts/eval/affordance-cues/harness.ts`
  already exists and is a different thing (the affordance trial's prompt rig) — the
  shared file needs a name that can't be mistaken for it, or the local one gets renamed.
  That runner sits inside the affordance file set that
  [narrator-physical-guidance.plan.md](narrator-physical-guidance.plan.md) and
  [romantic-contact-affordances.plan.md](romantic-contact-affordances.plan.md) are both
  still editing, so coordinate or migrate it last.
- **The output move is mechanical now — closed 2026-08-10.** The tracked review page
  that embedded the generated images (`docs/scene-image-eval/index.md`) is deleted: it
  described the removed Venice provider and its dead model ids, its prompts predate the
  phantom-limb POV rewrite, and its images were already gitignored — nothing on it was
  still true. C11's output move therefore breaks no page, and OQ2 is resolved by the
  same deletion: eval output simply moves off `docs/`, no documented exception retained.
- **Import normalization** touches the module graph the cycles check scans, so this
  plan's ready PR must reach a green aggregate `verify` check before merging.

## Open questions

- **OQ1.** What targeted duplication-gate grain remains silent on the current tree
  while catching the known replay, editor, and script clones?
