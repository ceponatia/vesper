# Editor scaffold and shared UI primitives

Status: draft (`ConfirmDialog` was approved 2026-07-30 to ship early and ahead of
the rest of this plan; as of 2026-08-07 it has not been built and the
dismiss-mid-delete defect is still live. The full scaffold still requires a
second go/no-go after that fix)

Outcome: A player can press Delete and then Cancel in any library editor and have
the dialog stay put until the delete settles, so that backing out of a deletion
stops quietly deleting the thing anyway.

## Why

There is a real bug in here, and it is why this batch is worth scheduling rather
than filing as tidying.

**A delete confirmation can be dismissed while the delete is already running.**
The confirm-dialog pattern is hand-built at eleven places (**D5**). Six get it
right: once you press the destructive button, Cancel greys out and clicking the
backdrop or pressing Escape does nothing until the request settles. The five
library editor pages — character, item, location, persona, social card — guard only
the Delete button. Cancel stays live, as do backdrop-click and Escape. Press
Delete, then Cancel, and the dialog closes while the server is still deleting: the
page looks like you backed out, and a moment later the entity is gone anyway. On a
slow connection that window is wide enough to hit by accident, and all five sites
are destructive actions on something the player authored.

That inconsistency is a symptom of the batch's larger shape. Those same five pages
are **near-copies of each other** (**D1**) — each independently re-implementing the
same ~140 lines of draft state, one-time seeding, generation-guarded save, clone,
delete, autosave wiring, loading and error branches, the read-only preview for
someone else's published entity, and the header row. About 685 lines of the same
paragraph written five times. The per-entity differences are real but tiny, two to
five lines each, scattered *through* the shared body rather than collected at the
edges. That interleaving is why the duplication gate never flagged it: `jscpd`
needs roughly seventy identical tokens to call something a clone, and a two-line
difference every twenty lines keeps every stretch under the floor (**F1**). The
gate is not broken; this pattern is invisible to it, which is how it reached five
copies unremarked. The cost is not the line count — it is that a fix or a new rule
has to be applied five times and is routinely applied three or four, which is
literally what happened with the busy-guard.

This plan **completes prior-art item E-U1**, whose autosave half shipped 2026-07-13
as the shared `useAutosave` hook (alongside the shared draft-seeding helper); the
state, save/clone/delete and shell halves were left in place. Two smaller
duplications ride along because they live in the same files and idiom — the two
wardrobe editors (**D6**) and the async loading/error shell (**D7**) — and one dead
hook gets an adopt-or-delete ruling (**D8**).

A second, independent pass reached the same conclusion:
[codebase-modularity.audit.md](codebase-modularity.audit.md) (2026-08-06) names
the entity-editor shell its top components-domain item, verifies the five pages'
skeleton as identical step for step, and lists the four divergences it considers
parameterizable — persona's 409-to-field-error mapping, the forge and staged
pauses, and tab slots. Read it before designing the hook; it is the closest thing
to a spec this plan has. It also records that the shell extraction should precede
splitting the item and character editor pages, which is the same ordering as
slice 4.

## Scope

- **D5 — one shared confirm dialog**, busy behaviour built in, adopted at all
  eleven sites. Fixes the dismiss-mid-delete inconsistency in one place and makes it
  unrepeatable.
- **D1 — the editor scaffold, extracted.** One hook owning editor state and
  save/clone/delete; one shell component owning the loading, error,
  foreign-public-preview and header rendering. The five pages keep their fields,
  tabs and per-entity quirks and lose the ceremony. Completes **E-U1**.
- **D6 — the wardrobe slot picker, actually shared.** The character outfit tab and
  the chat Character sheet's wardrobe editor share ~110 copied lines of slot-picking
  and worn-item-row logic. The chat one's doc comment already claims it reuses the
  outfit tab's primitives — it shares the category map and picker dialog, but the
  logic around them is a copy. Extract a shared hook and row component, and make the
  comment true.
- **D7 — one async section wrapper.** The loading / error / data three-way branch is
  written out 21 times over the existing shared data hook (error state referenced at
  25 places). One wrapper renders the right branch.
- **D8 — adopt or delete the debounce hook.** `useDebouncedValue` has **zero
  importers** while three places hand-roll the same timer, including the library
  grid's search box and the new-chat dialog's filter. Either way, `docs/ui.md` line
  49 credits the hook to the new-chat dialog, which does not use it; that line gets
  corrected in the same change (part of **F4**).

**Optional, owner's call — the E-U3 primitives.** The 2026-07-02 review also named
small shared primitives: a section title (the same class stack ~41 times), a chip
toggle and a collapsible section (the attribute picker repeats each three or four
times), and a segmented control with real arrow-key focus movement — that last is a
genuine accessibility gap, since the markup announces keyboard semantics it does not
implement. E-U3's `ModelSelect` half has shipped. **This slice is not required by
anything above and can be dropped without weakening the batch**; it is listed so the
decision is deliberate rather than forgotten.

## Non-goals

- **Not a redesign.** Every editor looks and behaves exactly as today, except that
  Cancel stops working mid-delete. No new tabs, fields or flows.
- **Not the conversation page.** Decomposing `chat-conversation.tsx` is parked as
  stub **G25**
  ([deferred/chat-conversation-refactor.plan.md](deferred/chat-conversation-refactor.plan.md)),
  and the transcript's streaming-render work (**D12**) belongs with it — cite, do not
  absorb.
- **Not a client data layer.** `docs/ui.md` rules out react-query and that stands.
  The async wrapper is a rendering convenience over the hook that already exists, not
  a caching layer; the list-refetch caching idea (**D14**) stays in its own batch.
- **Not the route side.** The clone routes, list endpoints and owner-lookup helpers
  behind these editors (**D2 · D3 · D4**) are a separate batch, as is typing the
  client request path (**D11**).

## Review rulings and scope adjustments — 2026-07-30

- Ship **`ConfirmDialog` first** as a focused correctness fix. Its busy guard
  closes the dismiss-mid-delete defect independently of the larger editor rewrite.
- Re-measure the five pages after that fix before committing to the full
  `useEntityEditor` / shell extraction. Repeated structure is real, but the
  abstraction earns its size only if the pages remain simpler to read and change.
- D7's generic async wrapper is optional. Drop it if render-prop indirection makes
  page states less direct.
- From E-U3, approve only the segmented-control keyboard behavior now. Other shared
  primitives wait for demonstrated behavioral drift rather than visual similarity.

## Delivery slices

1. **The confirm dialog (D5).** Adopt at the five editor pages first — that is where
   the bug is — then the remaining six. Can ship on its own the same day.
2. **The async section wrapper (D7).** Mechanical, and it removes a branch the editor
   shell would otherwise hand-write.
3. **The wardrobe slot picker (D6).** Self-contained; makes a lying doc comment honest.
4. **The editor scaffold (D1).** The big one. Extract hook and shell, then convert the
   five pages **one at a time**, simplest first: persona, social card, location,
   character, item — the item editor is largest and has the most per-entity behaviour,
   so it converts last with the pattern proven four times.
5. **The debounce ruling (D8) and the doc fix.** Trivial; folds into the last slice.
6. **Optional — the E-U3 primitives**, only if the owner wants them.

Slices 1, 2, 3 and 5 are independent of each other and of slice 4.

## Success criteria

- Pressing Delete and then Cancel — or the backdrop, or Escape — in all five library
  editors does nothing until the delete settles. Verified by hand on the Fly deploy,
  not only in tests.
- Only one confirmation component exists, and it cannot be constructed without the
  busy behaviour.
- Adding a field, a header action or an editor-wide rule is a change in one place, not
  five, and each editor page reads as *that entity's* editor rather than a copy of a
  general one.
- The wardrobe slot logic exists once and its doc comment is accurate;
  `useDebouncedValue` either has importers or does not exist, and `docs/ui.md`
  describes reality.
- No behaviour change elsewhere: same tabs, same autosave timing, same
  save-first-then-clone ordering, same foreign-public preview.
- **The pull request's `verify` check is green.** Validation is CI-only (root
  `CLAUDE.md`) — never invoke a gate locally.

## Risks and coordination

**The scaffold could flatten differences that matter.** The per-entity bits sit
scattered through the shared body, so absorbing one into the shared path by mistake
is how this slice breaks something quietly. Mitigation: convert one page at a time,
and treat any page needing to *opt out* of shared behaviour as a signal to leave that
behaviour in the page rather than adding a flag to the hook. Three places want extra
care — the item editor's reference lookup before delete, the character editor's
forge-draft interaction with autosave, and the persona editor's inline
title-collision handling, which must keep pausing autosave until the title changes
rather than retrying a conflicting title every 1.5 seconds.

**Dialog width regressions.** `docs/ui.md` records a past bug here: overriding a
dialog's width through a class name silently loses to the base cap, because the
class-name joiner does not merge Tailwind classes. The shared confirm dialog must set
width through the existing size prop and default to the confirmation size.

**The batch is mostly invisible.** Nothing but the D5 fix changes what a player sees,
so there is no natural moment where a reviewer notices a regression — which is what
the one-page-at-a-time ordering and the Fly playtest are for.

**Coordination.** None of these files sit in the affordance work that
[narrator-physical-guidance.plan.md](narrator-physical-guidance.plan.md) and
[romantic-contact-affordances.plan.md](romantic-contact-affordances.plan.md) are
still editing; the areas do not overlap. The batch does touch files the
client-typing and route-factory batches will also touch, so those should not run
concurrently with slice 4.

## Open questions

- After `ConfirmDialog` lands, does the remaining five-page duplication still
  justify the full scaffold, or should only smaller helpers be extracted?
- Adopt or delete `useDebouncedValue`? Either is acceptable, but the decision
  must also correct `docs/ui.md`.
- What targeted clone-detector setting catches interleaved editor scaffolds
  without turning ordinary form/test similarity into noise?
