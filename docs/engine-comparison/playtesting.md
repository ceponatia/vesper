# Engine Comparison playtesting

This guide describes how to gather useful Engine Comparison data during normal play and with the fixed regression corpus.

## Before you play

Engine Comparison is currently an **admin-only, one-on-one** test surface.

For a **new** conversation, choose one character in the New conversation dialog and enable **Run Engine Comparison** before starting the chat.

For an **existing** legacy conversation:

1. open **Account menu → Engine Comparison**;
2. choose the active conversation under **Start or stop comparison**;
3. choose **Start comparison**.

Vesper creates a dedicated neutral successor mirror automatically. You do not need to choose an engine authority value, simulation branch, or actor ids yourself.

At setup time the mirror copies the current comparable legacy state: clock/calendar, primary presence, body meters known to the successor registry, and structured current wardrobe. It does not use the ordinary starter world, because the starter world's neighbor, lore, items, commitments, routines, and setting would add facts the legacy chat never had.

When setup is correct, the legacy conversation remains the player-visible authority. The successor comparison runs after each settled plain-send exchange and records its result separately.

If the Engine Comparison page says the conversation is ineligible, use the reason shown there. Common cases are a group chat, an archived chat, or a chat that is already successor-routed rather than legacy-authoritative.

## How much to play

For exploratory testing, prefer a meaningful run rather than reviewing after every line. A practical session is roughly **10–30 exchanges**, or long enough to cross at least one state boundary such as a time skip, presence change, or meter change.

The goal is not to make the two engines agree. Play naturally enough that each engine has opportunities to reveal its assumptions.

## What to exercise

A useful played session should cover several of these behaviors when they fit the scene:

- ordinary conversation with no special state changes;
- a character being present, leaving, returning, or being elsewhere;
- a time skip or enough turns for story time to advance;
- changes to body meters or state that should affect narration;
- physical actions whose plausibility depends on location or current activity;
- a scene transition or return to an earlier location;
- continuity questions that depend on what happened several exchanges earlier;
- narration where the successor could incorrectly invent player actions, NPC decisions, or world facts.

Do not force every test dimension into one scene. Multiple focused sessions are easier to diagnose than one synthetic conversation that does everything at once.

### Remember what initialization does — and does not — guarantee

Starting comparison gives the two lanes a sensible comparable baseline. It is **not** a continuous state synchronization system.

After the mirror is created, the successor world evolves according to successor rules and the compared player turns. Legacy time skips are explicitly mirrored so clock deltas remain useful. Other later differences are evidence to review, not values that the setup service silently copies back and forth.

Free-text-only clothing is also not compiled into successor garment objects during setup. Only structured worn wardrobe can be copied without guessing coverage and slots. If a clothing-specific test starts from free-text-only outfit state, either structure the wardrobe first or record that as a test limitation.

## What Vesper records automatically

Each compared exchange produces rows in four domains:

### Prose

The legacy reply and successor render are stored side by side. A successful render is **not** automatically considered good prose. Human review is required.

When reading a prose pair, check for:

- contradiction with the recorded world state;
- wrong time of day, location, presence, clothing, held items, or body state;
- lost conversational continuity;
- invented player dialogue, choices, feelings, or actions;
- an NPC action or decision that the successor world did not authorize;
- impossible movement or other physical inconsistency;
- a legacy behavior worth preserving that the successor has not yet acquired;
- a legacy mistake that the successor correctly avoids;
- a harmless stylistic difference where both outputs are valid.

Do **not** reduce prose review to "which paragraph sounds better." Engine Comparison is primarily checking whether the successor can faithfully render authoritative state while preserving the parts of the legacy experience that still matter.

### Presence

The recorder compares legacy roster presence with the successor pair's standing co-present engagement. A mismatch is surfaced as a finding.

If a mismatch appears, determine which lane reflects the intended world truth. Legacy is not automatically correct.

### Meters

The analyzer normalizes legacy `0..1` meter values against successor fixed-point body meters and compares shared keys. It also reports keys present on one side but missing on the other.

A meter finding can mean a missing successor meter, different initialization, different drift semantics, or a legitimate domain change. Inspect the underlying values before deciding.

### Clock

The two lanes do not share a directly comparable absolute clock representation in comparison mode. The analyzer therefore compares **movement between exchanges**. A finding means the lanes advanced by materially different amounts over the same step.

Legacy time skips are mirrored to the comparison branch so the delta remains meaningful.

## Review after play

Open **Account menu → Engine Comparison**, then select the conversation under **Recorded comparisons**.

Review in this order:

1. Read the report card's automatically detected unresolved findings.
2. Inspect the exchange where each finding occurred.
3. Review the prose pair even when the report shows no automatic finding.
4. Check the structured presence, meter, and clock payloads when the prose suggests a state disagreement.
5. Record a review status for rows you have actually reviewed; leave unresolved work Unreviewed.

The **unreviewed row count is not a bug count**. Every row starts Unreviewed, including clean rows.

## Stopping a played comparison

When you no longer want the detached successor leg to run:

1. return to **Account menu → Engine Comparison**;
2. choose the conversation;
3. choose **Stop comparison**.

The chat returns to normal legacy authority and the live mirror mapping is removed. **Comparison rows and rulings are never deleted by Stop.** If the session never produced a row, its service-created mirror can be deleted immediately. If it did produce evidence, the mirror world/branch is retained as inert provenance because those rows intentionally reference the branch they were measured against.

You can later start comparison again on the same legacy chat. That creates a **new mirror from the then-current legacy state**; historical rows remain attached to the conversation, so note the test session boundary when interpreting a long report.

## Fixed regression corpus

Run:

```bash
pnpm sim:shadow-corpus
```

The command retains the historical internal name. The corpus is versioned in `scripts/sim/shadow-corpus.ts`. It currently exercises four fixed plain sends with a mid-corpus hours skip, awaits every detached comparison leg, and prints the computed report at the end.

Use the fixed corpus when:

- changing comparison infrastructure;
- changing clock, presence, or body-meter migration behavior;
- changing the successor narrator boundary in a way that could affect the comparison render;
- verifying a fix for a finding that the corpus can reproduce;
- checking for regression after a domain migration.

Changing the corpus itself is a corpus revision. Do not casually rewrite prompts in the existing corpus simply to make a failure disappear.

## Played sessions vs the corpus

Use both forms of evidence:

| Evidence | Best at | Weakness |
| --- | --- | --- |
| Fixed corpus | repeatability, regression detection, before/after comparison | narrow scenario coverage |
| Played sessions | unexpected interactions, long continuity, natural prose problems | variable and harder to reproduce |

A clean corpus is not evidence that all played sessions are clean. A strange played-session result is not automatically a deterministic regression until it can be reproduced or its state inputs are understood.

## When you find a real defect

Do not mark the row **Fixed & verified** yet.

1. Leave the comparison row **Unreviewed** while the defect is outstanding.
2. Capture enough context to reproduce it: chat/exchange, domain, what legacy showed, what successor showed, and which behavior should be authoritative.
3. Track the implementation work in the relevant issue, plan, PR, or commit.
4. Re-run the fixed corpus if the affected behavior is covered there, and/or reproduce the played scenario.
5. Only after the corrected behavior is observed should the original row be marked **Fixed & verified**.

The current comparison row stores the raw lane payloads and durable review status, but not a freeform reviewer rationale. Put detailed defect reasoning and fix provenance in the issue/PR/plan that owns the change rather than trying to encode it into the status label.
