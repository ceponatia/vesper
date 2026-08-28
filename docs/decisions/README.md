[← Vesper docs](../README.md)

# Decisions

This directory holds architecture decision records (ADRs) — the record of a
choice made specifically to prevent it from being re-litigated. Most owner
rulings do not belong here: a dated ruling with no future re-litigation risk
stays where it was made, as a comment on the issue that raised it, or as a
line in the relevant reference page if it hardens into durable law. An ADR
is reserved for a decision where the rejected alternative is plausible
enough that someone will propose it again — the ADR exists so that proposal
can be answered by pointing at the document instead of re-arguing it.

## Format

Each ADR is `NNN-<slug>.md`, numbered sequentially, with a `Date:` line
under the title and five sections: Decision, Context, Alternatives
considered, Why this choice, Consequences. Target 30–100 lines. See
[`.claude/skills/vesper-docs/templates/adr.md`](../../.claude/skills/vesper-docs/templates/adr.md)
for the copyable skeleton and the full writing rules.

A decision that reverses an earlier ADR does not edit or delete it: it adds
a new numbered ADR and a `Superseded by <NNN>` line under the original's
date, leaving the rest of the original document intact as the record of
what was believed at the time and why it changed.

## The one exception to "no dates"

Every other document under `docs/` states what is true now, in present
tense, with no dates and no preserved alternatives — history lives in git,
not in prose. ADRs are the exception, alongside evidence records: they are
dated by design, and they exist specifically to preserve the alternatives
a reference page would otherwise omit.
