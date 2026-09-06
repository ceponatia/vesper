# Durable documents

A reference page states **what the system currently guarantees** — boring,
present-tense law an agent can check code against. It tells no story of how the
feature was built, lists no alternatives, and records no progress. Template:
[reference template](../templates/reference-doc.md).

`docs/README.md` is the index and owns the tree itself: the reading-order table
of top-level areas, the one-doc-per-system rule, and the ~400-line
file-to-folder promotion rule. Read it before adding a page, and index the new
page in the same change — in the index for its tier. A **new top-level system**
gets its row in `docs/README.md`'s reading-order table, which indexes areas and
nothing finer. A **new part file inside a promoted folder** gets its row in that
folder's own `README.md` index instead; the root table keeps pointing at the
folder's `README.md`, so a nested page never earns a root row.

- **Shape:** one paragraph of orientation; an "Owns / does not own" section
  naming the boundary and the owning page for what it excludes; then laws as
  short declarative bullets grouped by aspect. Target 100–200 lines, well
  inside the promotion threshold.
- **One canonical owner per fact.** If two pages define the same thing, stop
  and designate the owner — delete the other side and link to the owner. Never
  resolve a conflict by making both sides agree.
- **Docs do not link into work state.** No issue or PR references as content —
  git blame is the provenance. Issues point at docs, not the reverse.

### The no-dynamic-state rule

A durable doc may **never** contain: `Status:` lines · "next" / "remaining
work" / "not started" · slice or stage numbers · rollout checklists · roadmap
priority · current blockers · "awaiting owner" · PR or issue state. All of that
is board state.

The distinction that matters — an architectural **requirement** belongs in the
page; **project state** does not:

- Belongs: "A transfer requires an addressable body-surface owner on both
  participants."
- Does not: "Blocked because player body-surface ownership isn't implemented
  yet."

#### Dates: the three exceptions

A durable page is written in the present tense and carries no dates — a date on
a statement of current law is either history or a freshness claim the reader
cannot check. **Exactly three kinds of line may carry one**, and this list is
canonical: `docs/README.md` and `docs/decisions/README.md` point at it rather
than restate it, and no page under `docs/` may add a fourth.

1. **ADRs** under `docs/decisions/` — dated by design, because an ADR records
   what was believed when the call was made. `docs/decisions/README.md` owns
   why they exist and how they are written.
2. **Evidence records** — a dated *measurement*, where the date is what makes
   the measurement reproducible rather than a status marker, and it pairs with
   the thing measured. Two shapes: the model catalog's dated `**Provenance:**`
   line, which ties a probe date to the pinned provider version it read
   (`docs/image-models/models/README.md` owns that line's exact form), and the
   text-only record a measured trial or benchmark earns under the research rule
   in [issue authoring](issues.md), dated with the build, model version, or dataset it ran against. A
   date pinned to nothing is not an evidence record.
3. **Owner rulings** stated in a reference page, dated at the attribution —
   an `Owner ruling <YYYY-MM-DD>:` line, or an inline `(owner ruling
   <YYYY-MM-DD>)`. The date attributes the decision; the law it produced is
   still written in the present tense around it.

Every other date is banned: when work happened, when it will happen, when a
page was last reviewed, or how current its contents are.

### Style guards

- **No conversation in the record:** no "as discussed" / "you said" / "let me
  know", no agent narration, no standing `TBD` — an undecided thing is a
  `decision-needed` issue, not a placeholder. Owner rulings appear as dated
  ruling lines, not remembered dialogue.
- **Tables are read raw:** 2–4 columns, short cells, every row one physical
  line, pipes padded so the source aligns, literal pipes escaped `\|`. If
  several cells need prose, it is a list, not a table.

## ADRs — sparingly

`docs/decisions/NNN-<slug>.md`, template [ADR template](../templates/adr.md): Decision, Context,
Alternatives considered, Why this choice, Consequences — 30–100 lines.

An ADR exists to **prevent re-litigation**, not to record history. "Touch,
smell and taste are sibling owners; do not collapse them into one sensory
system" earns one, because someone will propose collapsing them again. "Use 30
days instead of 60" does not — that number belongs in the relevant reference
page. Most owner rulings never become ADRs.

## Validation

Before finishing any change this skill governed:

- **Run the documentation gate — `pnpm lint:docs`** (`scripts/check-docs.mjs`,
  Node built-ins only, no install needed). It is the one owner of the three
  mechanical checks; CI runs the same script in its `documentation checks` job
  on every change that touches a documentation path, and `verify` fails when it
  fails. It prints one line per finding naming the file and the target, and
  proves:

  - **Every relative link in `docs/` resolves.** A `BROKEN LINK` hit names a
    target that no longer exists at that path — repoint it, or delete it.
  - **Every `<file>.md §<Heading>` citation names a file that exists and a
    heading that file actually has.** A `NO DOCUMENT` hit cites a file no
    reader can open. The link check proves only that a linked file exists,
    which is exactly how a citation survives the section it names moving to a
    sibling page. A cited
    heading has no closing delimiter in prose, so the check takes the text after
    `§` up to the first `)`, `.`, `,`, `;`, `:` or backtick and accepts a heading
    that is a prefix of it, or it of a heading. A `NO SECTION` hit is real:
    repoint the citation at the page that owns the section, or drop the `§` and
    name the file alone.
  - **No reference to a retired working document survives, in any form**, in
    `apps`, `packages`, `scripts` or `docs` — the rule, its rationale, and the
    `§N` clause it carries are stated once, in `docs/README.md`'s documentation
    rules. A `RETIRED DOCUMENT` hit names a `<name>.{plan,spec,trial,audit,
    deferred,research,followups}.md` that does not exist under `docs/`: state
    the rule it carried instead of naming it. A `RETIRED SECTION` hit is a bare
    `§N` whose line names no still-existing document under `docs/` with a
    numbered section N (a doc citing its own numbered section is allowed): put
    the document's path on the same line, as in `docs/resilience.md §2`, or
    write the section out in words.

- **No dynamic state in any durable doc you touched** — check against the
  banned list above, and search touched files for `Status:`, `slice`,
  `remaining`, `awaiting`, `blocked on`.
- **Issues you filed are complete:** on the board with fields set, sub-issues
  linked to their parent, dependencies wired as relations, labels applied.
- Tables you touched are aligned or converted to lists; no residue phrases in
  anything you wrote.

For repository documentation changes, run `pnpm lint:docs` and review the
changed Markdown for consistency. Do not run application gates locally.
Issue-only work does not need repository documentation validation.
