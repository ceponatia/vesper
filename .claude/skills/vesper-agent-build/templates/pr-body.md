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

## Material decisions

- <Settled owner ruling or material implementation decision a reviewer needs
  to assess, with its reason and location. Do not ask the owner to reconfirm
  settled rulings or routine implementation choices.>

## Owner action still required

- <Only an unresolved material decision, missing authorization, credentialed
  action, or other owner-only step. State `None` when the existing request
  authorizes every remaining action the agent can perform.>

## Not in this PR

- <Scope deliberately left out, with the issue that still owns it — e.g. the
  paid graded trial, the live smoke test, the follow-up retirement.>

## Verification

No local application gates run. <Name the current-head CI jobs and exact suites
that actually ran; an unselected suite remains unverified even if aggregate
`verify` is green.> <Name live Fly evidence, or the specific authorization,
credential, cost, or owner-only action that prevented it. Complete authorized
verification instead of handing it back generically.>

<!-- If something WAS verified live: say what, on which image version, and where
     the evidence sits (eval-images/…, never docs/, never git). -->

## Review corrections

<!-- Append one line per round: "Round 1 (Codex, 2026-09-02): P1 avatars orphaned
     on delete → b3586768; P2 replay liveness → 87250c1f. Threads replied + resolved." -->
