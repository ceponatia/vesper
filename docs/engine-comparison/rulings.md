# Engine Comparison rulings

A **ruling** is the human decision recorded after reviewing one Engine Comparison row. It answers a narrower question than the automated analyzer:

> After looking at both lanes and the relevant world state, does this row require a fix?

The system deliberately keeps the durable status set small. The database values are historical internal names; use the UI meanings below when deciding what to record.

## Vocabulary

These terms are different and should not be used interchangeably:

| Term | Meaning |
| --- | --- |
| **Comparison row** | One stored legacy-versus-successor observation for one domain on one exchange. |
| **Finding** | A problem candidate surfaced by the analyzer or recorder, such as clock drift, a meter difference beyond tolerance, a presence mismatch, or a successor render failure. |
| **Unreviewed row** | A row whose durable status is still `open`. This does not imply a finding exists. |
| **Ruling / review status** | The human decision recorded after review: Unreviewed, Accepted / no fix needed, or Fixed & verified. |

This distinction matters because every row starts Unreviewed, including rows whose automated comparisons are clean.

## The three review statuses

### Unreviewed

Stored value: `open`.

Use **Unreviewed** when any of the following is true:

- nobody has reviewed the row yet;
- you are unsure whether the difference matters;
- the row appears to expose a defect but the fix has not landed;
- a fix has landed but the result has not been re-tested;
- more state/context is needed before making the decision.

Unreviewed is therefore both the initial state and the correct holding state for unresolved work.

### Accepted / no fix needed

Stored value: `intentional`.

Use **Accepted / no fix needed** when you have reviewed the row and no implementation change is required.

That includes more than deliberate divergences. Examples:

- the two lanes agree closely enough and the row is simply clean;
- prose differs stylistically but both versions faithfully represent the world;
- successor presence disagrees with stale legacy presence and successor is the intended authority;
- a meter difference follows an intentional successor-domain rule;
- legacy behavior is being retired and the successor correctly behaves differently.

The old label `intentional` made a clean row awkward to classify because there may be no difference to call intentional. The UI label is deliberately broader while the stored value remains unchanged for compatibility.

### Fixed & verified

Stored value: `fixed`.

Use **Fixed & verified** only when all three statements are true:

1. the row exposed a real defect or missing migration behavior;
2. the implementation has been changed to correct it; and
3. a follow-up corpus run or played comparison confirms the corrected behavior.

Do **not** use this status to mean "we have decided to fix it." Until verification happens, leave the row Unreviewed.

## Decision process

Use this order when reviewing a row:

1. **Understand the comparison.** Read the legacy value, successor value, system detail, and surrounding exchange.
2. **Determine intended authority.** Ask what Vesper should do, not merely what legacy currently does.
3. **Decide whether code/data must change.**
   - No change required → **Accepted / no fix needed**.
   - Change required or still uncertain → leave **Unreviewed**.
4. **If a change is required, fix it outside the comparison record.** Track implementation in the appropriate issue, plan, PR, or commit.
5. **Re-test.** Reproduce the scenario or run the fixed corpus where applicable.
6. **Only after verification** change the original row to **Fixed & verified**.

## Examples

### Clean prose pair

Legacy and successor use different wording, but both preserve character voice, player agency, current location, and world state.

**Ruling:** Accepted / no fix needed.

Why: the system is not trying to achieve textual parity.

### Successor corrects stale legacy presence

Legacy says the character is present, but the successor simulation places the character in another zone and the surrounding events confirm that departure.

**Ruling:** Accepted / no fix needed, assuming the successor location is the intended world truth.

Why: legacy is the comparison baseline, not the authority to copy blindly.

### Missing successor meter

Legacy tracks a body meter that does not exist on the mirror actor, and the missing meter is still part of the intended successor body model.

**Ruling while outstanding:** Unreviewed.

After the meter registry/initialization is corrected and a follow-up comparison shows the meter on both sides:

**Final ruling:** Fixed & verified.

This is the pattern used by the original comparison corpus when `stress`, `intoxication`, and `mood` were missing from the mirror actor.

### Different meter semantics by design

The same logical meter exists on both sides, but successor intentionally uses a new drift law and the difference is within the accepted successor design.

**Ruling:** Accepted / no fix needed.

Record the reasoning as a dated ruling comment on the issue the review belongs to. Add an ADR under [../decisions/](../decisions/README.md) only when the same difference will be re-proposed as a defect; otherwise the resulting behavior belongs in the reference page that owns that meter.

### Wrong time advancement

Legacy advances an hour while successor advances only a few minutes for the same mirrored skip, producing a clock finding.

**Ruling while broken:** Unreviewed.

After the clock-mirroring defect is corrected and a follow-up run confirms matching deltas:

**Final ruling:** Fixed & verified.

### Successor prose invents a player action

The structured state is otherwise clean, but the successor prose says the player stands up or speaks words the player never supplied.

**Ruling while broken:** Unreviewed.

Why: prose quality is human-reviewed and this is a player-agency violation even if the automated report did not create a finding.

Fix and re-run before changing the row to Fixed & verified.

## Automatic findings vs human prose review

The analyzer can identify several structured problems automatically, but it deliberately does not decide whether successful prose is good or correct. A report with `findings: []` therefore means:

> No currently unruled problem was detected by the automated structured checks.

It does **not** mean:

> Every prose pair has been reviewed and approved.

Use the unreviewed-row count to track human review coverage, and the findings list to locate automatically detected problem candidates.

## Rationale and provenance

The current comparison row persists the lane payloads, system-generated detail, and review status. It does **not** have a freeform human ruling-note field.

For a simple clean/accepted row, the status is sufficient. For a real defect or an important intentional design difference, record the rationale and implementation provenance in the issue, PR, plan, spec, or commit that owns the decision. A useful note contains:

- the chat/exchange or corpus case;
- the affected domain;
- what each lane did;
- which behavior is intended and why;
- the fix or design decision;
- how the result was verified.

If reviewer rationale later needs to be searchable directly from the Engine Comparison UI, add it as a separate durable field rather than overloading the system-generated `detail` text or changing the meaning of the three status values.
