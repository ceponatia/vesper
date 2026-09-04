## Summary

<Three to six lines: what a player or operator gets, and the shape of the
change (new module, moved seam, migration number). Written for the owner
reading the diff cold.>

## Closes

Closes #<A>.
Closes #<B>.

<!-- One keyword per issue, each on its own line — `Closes #A, #B` links only #A.
     A slice that does not finish its issue says `Part of #N` instead, and names
     what is still owed under "Not in this PR". -->

## Owner decisions to confirm

- <Decision the build made that the owner may reverse, with the alternative
  and where it lives in the diff.>
- <…>

## Not in this PR

- <Scope deliberately left out, with the issue that still owns it — e.g. the
  paid graded trial, the live smoke test, the follow-up retirement.>

## Verification

Nothing run locally (owner ruling 2026-08-22: CodeBuild validates). CI runs
when this draft is flipped ready. Live verification on Fly is owner spend.

<!-- If something WAS verified live: say what, on which image version, and where
     the evidence sits (eval-images/…, never docs/, never git). -->

## Review corrections

<!-- Append one line per round: "Round 1 (Codex, 2026-09-02): P1 avatars orphaned
     on delete → b3586768; P2 replay liveness → 87250c1f. Threads replied + resolved." -->
