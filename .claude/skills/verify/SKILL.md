---
name: verify
description: Verify a vesper change end-to-end against the Fly deploy (the repo's only UI-testing surface) — deploying safely, signing in as the QA account, driving the app with Playwright, calling the API or admin endpoints directly with the right cookie and Origin header, flipping a feature flag and proving the image carries the code it gates. Use when confirming a change actually works in the running app, when asked to "test it on Fly", "check it live", "reprobe a model", "flip CHAT_… on", or when a deploy, sign-in, or admin API call is the next step.
---

# Verifying vesper changes

Runtime verification happens against the **Fly deploy** — never a local
`pnpm dev` + Postgres for UI work (CLAUDE.md).

**Do NOT run tests, lint, or typecheck as part of verification.** They are code
gates, not observation, and CI on the PR owns them (the root `CLAUDE.md`); local
gate runs tell you nothing about whether the deployed app behaves, and the
project's permission deny list refuses them anyway.

## Recipe

1. **Preflight, then deploy the working tree**: `fly deploy -a vesper --yes`
   (~4 min; remote Docker build, runs `pnpm db:migrate` against Neon, cuts the
   Machine over). The output pipes nothing until done — run in background and
   wait; do not pipe through `tail`, or the build error you need is the part
   that gets cut. A PreToolUse hook (`.claude/hooks/preflight.py`) runs before
   every `fly deploy` and refuses a dirty tree — see below.
2. **Sign in** at `https://vesper.fly.dev/sign-in` as the QA account
   `uxtest-main@vesper.local`. The password is the Fly `DEV_PASSWORD` secret —
   read it off the machine: `fly ssh console -a vesper -C "printenv DEV_PASSWORD"`.
   It is not the local `.env` default, and it rotates with `fly secrets set`,
   so never store it. (`/api/dev/impersonate` 404s on Fly — production build.)
3. **Drive it with Playwright MCP** (`browser_navigate`, `browser_snapshot`,
   `browser_click`, `browser_resize` for mobile widths). **Reuse an existing
   conversation** rather than starting one — scenario, relationship, wardrobe
   and story clock are all editable in place, so a new chat is rarely the
   answer; if you must create one, delete it before you finish (the "UI/QA
   account" bullet under Testing in the root `CLAUDE.md`). Never assume a
   particular character or chat exists — list the account's rows in the app
   first. If they are missing entirely, seed over SSH:
   `fly ssh console -a vesper -C "pnpm db:seed"` (a bare `users` insert is not
   enough — the seed also provisions the credential).
4. **Renders stay local.** Every screenshot and generated image a run produces
   goes in the untracked root `eval-images/` — never the repo root, never
   `docs/`, and never into git (root `CLAUDE.md` owns this rule). That includes
   a render a verdict rests on: there is no tracked evidence folder to commit
   into, so keep the file local and write the verdict up on the issue the run
   was for, describing what the render showed well enough that the reader does
   not need the file.

## Deploy preflight

`fly deploy` ships the **working tree** of the directory it runs in, not a
committed ref. Three near-misses came from that: a session restart silently
dropped the worktree binding and the next deploy would have shipped another
session's half-done tree; an untracked migration in the main checkout would
have run against Neon; a deploy from a pre-merge tree made a flag flip look
broken. The hook makes the check unskippable:

- On every `fly deploy` it resolves the directory the command runs in (a
  leading `cd …` counts), and **refuses** when the tree has modified or
  untracked files, listing them. If you really mean to ship them, re-run with
  `VESPER_DEPLOY_DIRTY_OK=1` in front of the command.
- On a clean tree it lets the deploy through and tells you the branch, HEAD,
  and how it stands against `origin/main`, so a deploy from the wrong branch
  is visible in the transcript.
- The same hook refuses a bare `git commit` when the index already holds
  staged entries (another session's WIP shares this checkout) — commit by
  pathspec, or `VESPER_INDEX_OK=1` once you have looked.
- Ask for the report by hand any time: `python3 .claude/hooks/preflight.py --report [dir]`.

To deploy a specific commit while the checkout is dirty, deploy from a
scratch worktree: `git worktree add <scratchpad>/deploy-<sha> <sha>`, run
`fly deploy` there, then `git worktree remove` it.

## Talking to the API directly

Playwright is for what a player sees. For admin endpoints, reprobes, bulk
deletes, and anything JSON-shaped, `fly-api.sh` in this directory carries
the session cookie and the Origin header every hand-written curl forgets:

```bash
.claude/skills/verify/fly-api.sh login
.claude/skills/verify/fly-api.sh GET   /api/gallery | jq '.items | length'
.claude/skills/verify/fly-api.sh PATCH /api/admin/self/image-models/<id> '{"reprobe":true}'
.claude/skills/verify/fly-api.sh POST  /api/gallery/delete @ids.json
```

- Cookie-bearing `POST/PUT/PATCH/DELETE` without `Origin: https://vesper.fly.dev`
  → `403 csrf_origin`, before auth even runs (`server/api/csrf.ts`).
- `withOwnerAdmin` 404s any path outside `/api/admin/self` — a handler at a
  bare `/api/admin/…` type-checks, passes its tests, and 404s live.
- The Lab and admin surfaces are **owner-scoped**: the QA account cannot run
  experiments on the owner's characters. Identity-portrait lab testing is
  owner-account work.
- `fly-api.sh` auto-logs-in on a missing jar and once on a 401; `logout`
  removes the jar.

## Flipping a feature flag

Flags are Fly secrets; changing one restarts the Machine.

1. **Confirm the image carries the gated code.** A flag on an image that
   predates the code it gates does nothing and looks like a bug. Compare the
   deploy time (`fly releases -a vesper`) with the merge time, or grep the
   built app on the machine: `fly ssh console -a vesper -C "grep -c <symbol> apps/web/.next/server/…"`.
2. **The value is the literal string `on`.** The parsers are `=== "on"`, so
   `1` and `true` read as OFF.
   `fly secrets set CHAT_CONTACT_ACTIONS=on -a vesper`; check with
   `fly ssh console -a vesper -C "printenv CHAT_CONTACT_ACTIONS"`.
3. Revert after the trial unless the owner ruled it stays; note the flag
   state on the issue, not in `docs/`.
4. Settle diagnostics show in `fly logs -a vesper` as
   `engine.chat: chat-state diagnostics` lines — the buffer is short, read
   promptly.

## Noise you can ignore

- Better Auth's "You are using the default secret" line in `fly deploy`
  output comes from `next build` inside the Docker build (no env there), not
  from the running app; the production secret is real. Do not rotate it on
  the strength of that line (#460).
- One React #418 hydration error on the first hard load right after a
  deploy; it does not reproduce on reload.
- Replicate's 429 body blaming "less than $5.0 in credit" is erroneous
  (owner ruling 2026-08-12) — the rate limit (~6 creates/min, burst 1) is
  real, the credit claim is not. Never tell the owner to top up.

## Gotchas

- `useIsMobile` flips at 768px; the chat standing-portrait column needs ≥1024px
  (`lg`). Test desktop at ~1440×900, phone at 390×844.
- The session cookie is `better-auth.session_token`, set by the sign-in form
  submit; it persists across `browser_navigate` calls in one browser session.
- After any session restart, `pwd && git branch --show-current && git status --short`
  before trusting where you are — the worktree binding does not survive it.
