# Client type-safety and bundle weight

Status: draft (D10/D11/D12 approved; the image consolidation they were sequenced
behind shipped 2026-08-02, so that dependency is clear. Bundle work remains an
experiment and D14 is dropped. Findings re-verified unfixed 2026-08-07)

Outcome: A developer can add a location size class by editing one file, and gets
a compile error the moment a form sends a field the route will not accept, so
that a dropdown short one option — or a "something went wrong" message in front
of a player — stops being the way that mistake is discovered.

## Why

The browser half of Vesper is where the repo's own rules reach last. Four
findings from audit batch 8 say the same thing from four angles: the client
duplicates what contracts already own, describes its requests in prose instead
of types, ships code no page uses, and does avoidable work on the one screen a
player watches for minutes at a time.

- **The vocabulary rule stops at the server door (D10).** A location's five size
  classes — intimate / room / hall / open / expanse — are written out
  independently in **five** places, all five still standing on 2026-08-07: the
  database column, the server request schema, the client's list parser, the
  location editor's dropdown, and the library's browse chips. Clothing-layer
  labels are written out **three** times.
  CLAUDE.md's core promise is that "vocabulary changes are data edits in one
  file"; today adding one size class is a five-file hunt, and missing a site
  doesn't fail loudly — it produces a dropdown short one option, or a browse chip
  that silently matches nothing.
- **Nothing checks what the client sends (D11).** Twelve client API methods
  accept an untyped request body, and twenty-two call sites hand them whatever
  local form shape that component happens to define. Rename or tighten a field
  server-side and the compiler stays quiet; the drift surfaces as a runtime
  rejection the player reads as "something went wrong". The fix is unusually
  cheap because the server's request schemas already depend on nothing but zod
  and contracts — they can simply live in contracts, and the client can derive
  its types from the same schemas the server validates against.
- **Every page pays for vocabulary no page uses (D13).** The shared contracts
  barrel pulls roughly **39.7k lines** into 41-plus client modules, of which
  about **17.5k** is affordance and simulation vocabulary that no component
  references at all. Nothing in `package.json` tells the bundler this code is
  free of side effects, so it cannot prove any of it is safe to drop. The bill
  lands on first paint, on phones — the platform docs/ui.md treats as primary.
- **The transcript gets heavier the longer a reply streams (D12).** Each token
  chunk re-renders the whole visible page of messages, and each row re-runs the
  full speaker/markup parsing pipeline from scratch — around a hundred parses per
  chunk. Memoization is already attempted but defeated by props that get a fresh
  identity on every render. This is the only item here a player can feel.

Two smaller items ride along: the dashboard imports an entire chats-page module
to render one small "has something to say" dot (**D15**), and identical library
lists are refetched from scratch as the player moves between pages (**D14**,
optional).

## Scope

- **D10** — location scales and clothing-layer labels become contract-owned
  vocabulary; all eight sites import instead of restating. The database column
  keeps its own enum (schema is its own trust boundary) but is checked against the
  contract so the two can't diverge unnoticed.
- **D11** — request schemas move into contracts; the client's request methods and
  their call sites take types derived from those schemas.
- **D13** — declare the package side-effect-free, measure, and only if that
  doesn't move enough, narrow the contracts barrel so server-only vocabulary is
  reached by direct import (already the established pattern).
- **D15** — the say-marker gets its own file; the dashboard imports that.
- **D12** — the streaming transcript stops re-parsing settled messages.
- **D14 (optional, droppable)** — a small time-limited cache behind the client's
  GET helper for repeated identical list fetches.

## Non-goals

- **No new client data layer.** docs/ui.md rules out react-query; D14 stays a few
  dozen lines behind the existing helper or it doesn't happen.
- **No decomposition of the conversation component** — parked as **G25**
  ([deferred/chat-conversation-refactor.plan.md](deferred/chat-conversation-refactor.plan.md));
  see Risks.
- **No visible redesign.** No layout, label, flow, or narration changes.
- **No contracts deletions.** The test fixtures shipping in the public contracts
  surface (**E8**) compound the bundle problem and should be cited when measuring,
  but that deletion belongs to the audit's contracts-hygiene batch, not here.
- **No server route consolidation.** Moving request schemas is not the route
  factory work (D2/D3, the library-kind batch).
- **No vocabulary changes while relocating vocabulary.** Same values, one home.

## Review rulings and scope adjustments — 2026-07-30

- D10, D11, and D12 are the approved work: one contract-owned vocabulary, typed
  request bodies, and stable transcript props/parsing.
- D13 is an experiment, not an established bundle defect. Reachable source lines
  do not equal shipped bytes; `sideEffects` metadata and used-export tree shaking
  are separate mechanisms. Capture a Next 16/Turbopack analyzer baseline before
  changing either the package flag or barrel.
- Drop D14. Do not add a client cache without measured repeated-refetch latency and
  an explicit invalidation story.
- The Drizzle location-scale list should derive directly from the contract-owned
  readonly values. It is TypeScript schema metadata, not a separate database
  constraint, so a test-maintained duplicate would defeat the one-source rule.
- Narrow the contracts barrel only if the analyzer shows a material cost after the
  cheap, verified changes.

## Delivery slices

Ordered so each stands alone and can ship on its own.

1. **One home for shared vocabulary (D10).** Move the two lists into contracts,
   repoint all eight sites, and add the test that keeps the database enum and the
   contract in step. Small, mechanical, and it is the slice that restores the
   registry rule — so it goes first regardless of size.
2. **Typed request bodies (D11).** Relocate the server request schemas into
   contracts, then derive the client's request types from them. The compiler
   errors this surfaces **are the finding** — each is a real mismatch between what
   a form sends and what the route accepts, so expect genuine fixes rather than a
   clean rename. Landing this before slice 3 means the bundle measurement is taken
   against the final import graph.
3. **Measure, then shrink, the client payload (D13, D15).** Record a
   bundle-analyzer baseline first. Declare the package side-effect-free and measure
   again. Only if that doesn't account for the server-only vocabulary do we narrow
   the barrel — the more disruptive of the two options, so it stays contingent on
   evidence. D15's one-line move rides along.
4. **A responsive transcript while a reply streams (D12).** Fix in the order the
   audit specifies, because the order matters: first stop handing the message rows
   freshly-built props on every render (the roster name list, the last-line
   lookup, the scene anchor map, the inline callbacks), *then* memoize the row
   component and cache each message's parse against its text and known-speaker
   list. Memoizing first accomplishes nothing — the fresh props defeat it, which
   is exactly why the current attempt doesn't work. The parser stays pure and the
   in-progress tail keeps re-parsing; only settled lines are cached.
5. **A short-lived list cache (D14 — optional).** A tiny opt-in cache keyed by
   URL behind the existing GET helper, for the character and chat lists fetched
   repeatedly across pages. Explicitly droppable.

## Success criteria

- **No client-visible behavior change except transcript responsiveness.** Same
  pages, copy and flows; the only difference a player should notice is that a
  streaming reply no longer makes the transcript sluggish.
- **Bundle-size delta measured and reported** — a before/after analyzer figure
  recorded here when slice 3 lands, including the finding if the delta is small (a
  measured "barely moved" is a result, not a failure).
- Adding a sixth location size class touches **one** file plus its tests.
- Sending a request field the route does not accept fails at compile time, not as
  a 400 in front of a player.
- A streaming reply parses each settled message once, not once per token chunk;
  verified against a long transcript on the Fly deploy.
- **The ready PR's applicable CodeBuild jobs and aggregate `verify` check are green.**
  `.github/workflows/ci.yml` is the repository gate; there is no local pre-push
  gate or `pnpm verify` alias.

## Risks & coordination

- **G25 owns the same file as slice 4.** The conversation-component
  decomposition ([deferred/chat-conversation-refactor.plan.md](deferred/chat-conversation-refactor.plan.md))
  would restructure exactly the component slice 4 edits, so the two must not be
  built in parallel. If G25 is promoted and built first, **slice 4 folds into
  it** as a performance requirement of the extracted transcript hook rather than
  a separate change. If slice 4 goes first it stays surgical — memoization and
  prop identity only, no restructuring — so it doesn't pre-empt G25's design.
- **Narrowing the contracts barrel is a wide, shallow change** touching dozens of
  import lines. That is why it is gated behind measurement: if the cheap
  declaration suffices, the wide change never happens.
- **The contracts-hygiene batch overlaps the bundle measurement** (E8's fixtures
  reach 73 barrel importers). Whichever lands second re-measures rather than
  trusting the first one's number.
- **Slice 2 will surface real mismatches.** Budget for fixing forms, not just
  moving files, and keep each fix reviewable — a silently "corrected" request
  shape could change what gets saved.
- **Contracts is a pure module** (no IO, no env) and the request schemas already
  respect that, so the move does not weaken the enforced boundary.
- **`lib/client/api.ts` is a moving target.** It is the file slice 2 reshapes
  most, it has 66 importers, and the image-model registry and capabilities work
  keeps adding endpoints to it. It is also the subject of a separate, unplanned
  split proposal in
  [codebase-modularity.audit.md](codebase-modularity.audit.md) (layer the file,
  keep `api.ts` as a re-export barrel). Whichever change lands first should land
  in a shape the other can build on — typed request bodies do not conflict with a
  layered split, but doing both in one diff would be unreviewable.

## Open questions

- Is `"sideEffects": false` accurate for every imported client path? Answer with
  analyzer output plus a production smoke pass, not a source census.
- If the cheap declaration produces no meaningful change, is clarity alone worth
  the wide barrel-import churn? The default is no.
