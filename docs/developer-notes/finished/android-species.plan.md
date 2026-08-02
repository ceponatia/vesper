# Android species — plan

Status: **shipped — 2026-08-02.**

Technical design: [android-species.spec.md](android-species.spec.md).

## Goal

Add humanoid artificial people as a first-class character species without
inventing a second anatomy system. Authors can choose **Android**, then choose
between two body subtypes:

- **Synthetic Android** — a fully constructed humanoid body. It has every
  physical attribute available to a human-shaped character plus artificial
  sensory choices for skin and intimate surfaces, scent, taste, sensitivity,
  feet, and voice.
- **Organic Android** — a cloned human body with integrated cybernetics that
  connect and sustain the AI mind. Its ordinary warmth, scent, taste, texture,
  sensitivity, and voice use the same vocabulary as a Human.

## What shipped

- Android in the species picker and deterministic forge inference.
- A **Subtype** picker rather than the misleading Heritage label for Android.
- Synthetic as the safe default when an old/corrupt profile has no valid
  subtype; Organic remains an explicit choice.
- The complete humanoid body plan and all human physical attribute categories
  for both subtypes.
- Synthetic-only sensory vocabulary with narrator glosses. Existing biological
  humanoids are explicitly fenced to their original values.
- Pure contract/editor/forge tests and updated body, attribute, and authoring
  reference docs. No database migration or backfill is required.

## Product boundaries

This slice defines bodies and authoring vocabulary, not android simulation.
Power/charging, sleep and hunger differences, repair versus healing, detachable
parts, chassis damage, built-in tools, reproduction, and mind transfer are
future systems. Cybernetics are part of the Organic subtype's identity for now,
not individually modeled components.
