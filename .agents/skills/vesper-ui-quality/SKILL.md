---
name: vesper-ui-quality
description: Review rendered Vesper UI quality and accessibility on Fly. Use after a substantial UI change or for requested visual QA; source-only code review and workflow design belong elsewhere.
---

# Review Vesper UI quality

Rendered behavior is the evidence. Read `docs/ui/README.md`, the relevant page
doc, `docs/ui/conventions.md`, `docs/ui/mobile.md` when responsive behavior is in
scope, `apps/web/src/app/globals.css`, and the owning primitives under
`apps/web/src/components/ui/`. Do not read every UI page for a bounded surface.

Use `verify`'s observation route and the supported browser workflow. Establish
the deployed commit or release before judging it. Do not deploy merely to make a
review possible; if the target change is absent from Fly, report visual proof as
unverified. `verify` owns authentication and any authorized live state changes.

Inspect the relevant states at desktop and phone viewports, including long or
narrow content when it can change layout. Judge:

- the quiet dark reading-room hierarchy, restrained warm accents, serif narrative
  type, spacing rhythm, density, and clear primary action;
- use of the owned tokens and primitives rather than parallel visual conventions;
- text and control contrast, visible focus, keyboard order, labels, and dialogs;
- coarse-pointer touch targets, hover-only actions, safe areas, and overflow;
- empty, loading, error, disabled, and partial-content states;
- wrapping, clipping, scrolling, truncation, and layout stability with long data.

Report material findings with the viewport, state, observable impact, screenshot
or browser evidence, and owning source when known. Keep source inference separate
from what the rendered deployment proves. Code inspection, a successful browser
navigation, or a green CI check is not visual proof.

Keep screenshots and review artifacts only in root `eval-images/`. Do not edit
application code, add tests, run local application gates, or mutate live state
without existing authorization. Hand UX structure questions to `vesper-ux-review`,
test decisions to `vesper-testing`, and implementation to its assigned owner.

Finish when the requested surface and material responsive/accessibility states
have concrete evidence, with unavailable states and deployment mismatch called
out as unverified.
