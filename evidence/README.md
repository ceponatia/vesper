# evidence/

Render evidence that a decision rests on — tracked, because grading it from
another workstation is the point.

A doc that records an owner verdict ("the LoRA drew all four acceptance beats,
4/4") is only checkable if the renders it graded are here. That is the whole
test for this folder: **would someone re-reading the verdict need to see the
image?** If yes, it belongs here and gets committed with the doc that cites it.

## What goes where

- **Here (tracked):** probe and A/B renders an owner graded, and the one render
  that proves a route fires end to end. Group them per probe run or per topic —
  `intimate-model-ab-<run>/<beat>/<arm>-<n>.webp`,
  `intimate-scene-lora/<what-it-shows>.png`.
- **`screenshots/` (untracked, gitignored):** everything else a UI session
  produces — Playwright captures, panel shots, a page you looked at once while
  finding a button. Ephemeral by default; nothing cites it later.

The split exists because those two have opposite lifetimes. Working screenshots
are noise a week later and would bloat history forever; graded renders are the
only thing standing behind a verdict, and a verdict whose evidence lives on one
laptop cannot be reviewed by anyone else.

Promotion is deliberate: a screenshot becomes evidence when a doc cites it, and
that is the moment to `git mv` it here.

## Keep it small

These are generated binaries in git history, permanently. Commit the renders a
verdict actually rests on — not every frame of a sweep. Prefer `webp`, and
prefer the two or three images that show the finding over the twenty that
produced it.
