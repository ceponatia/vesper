# evidence/

Render evidence that a decision rests on. The **grading data is tracked; the
images are not** (owner ruling 2026-08-21: generated imagery stays out of git
history).

- **Tracked:** this README, per-run `README.md` notes, and `scores-*.csv`
  grading tables — the record of what was graded and how it scored.
- **Local-only (gitignored):** every image file. The renders stay on the
  workstation that produced them, grouped per probe run or per topic —
  `intimate-model-ab-<run>/<beat>/<arm>-<n>.webp`,
  `intimate-scene-lora/<what-it-shows>.png` — so a verdict doc can cite them
  by path even though git does not carry them.

A verdict doc therefore names its evidence paths as plain text. Re-checking a
verdict from another machine means re-rendering from the recorded settings
(model, seed, prompt hashes in the run's notes), not pulling images from the
repo.

## What goes where

- **Here:** probe and A/B renders an owner graded, and the one render that
  proves a route fires end to end — plus their scores and notes.
- **`screenshots/` (untracked, gitignored):** everything else a UI session
  produces — Playwright captures, panel shots, a page you looked at once while
  finding a button. Ephemeral by default; nothing cites it later.

The split exists because the two have opposite lifetimes: working screenshots
are noise a week later; graded renders stand behind a verdict and stay put in
this folder locally, with the tracked scores preserving the verdict itself.
