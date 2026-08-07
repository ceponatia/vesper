# <System name>

One paragraph: what this system does in the running app, and where its code
lives. Present tense. No dates, no slice numbers, no future tense — if you are
writing "will" or "planned", that sentence belongs in a plan.

## How it works

The shape of the system: its stages, its inputs, and what it produces. Describe
patterns and invariants, not a line-by-line walkthrough of the code. A reader
should be able to predict what the code does without having read it.

## Invariants

The rules this system guarantees, stated so a reviewer can check a change
against them. These are the most valuable lines in the document — a reference
doc that lists only capabilities cannot catch a regression.

## Extending it

The supported way to add to this system — which registry file to edit, which
contract to implement, what must be updated alongside it. Vocabulary changes
should be data edits in one file, never schema migrations.

## Degradation

What happens when a dependency fails or input does not parse: the degraded
default at each trust boundary and the diagnostic code emitted, per
[resilience.md](resilience.md).

## Related

- [<other system>.md](<other-system>.md) — how the two connect.

<!--
Reminders for this tier:
- Keep the file under ~400 lines. Past that, promote it to docs/<system>/ with a
  README.md index plus one file per sub-topic (docs/README.md).
- Update this doc in the same change that changes the behavior it describes.
- Tables are allowed here (unlike docs/developer-notes/) and are used for
  reading-order indexes and field references.
-->
