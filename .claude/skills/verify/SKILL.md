---
name: verify
description: Verify a vesper change end-to-end against the Fly deploy (the repo's only UI-testing surface). Use when confirming a change actually works in the running app.
---

# Verifying vesper changes

Runtime verification happens against the **Fly deploy** — never a local
`pnpm dev` + Postgres for UI work (CLAUDE.md).

**Do NOT run tests, lint, or typecheck as part of verification.** They are code
gates, not observation, and CI on the PR owns them (the root `CLAUDE.md`); local
gate runs tell you nothing about whether the deployed app behaves.

## Recipe

1. **Deploy the working tree**: `fly deploy -a vesper --yes` (~4 min; remote
   Docker build, runs `pnpm db:migrate` against Neon, cuts the Machine over).
   The output pipes nothing until done — run in background and wait.
2. **Sign in** at `https://vesper.fly.dev/sign-in` as the QA account
   `uxtest-main@vesper.local`. The password is the Fly `DEV_PASSWORD` secret —
   read it off the machine: `fly ssh console -a vesper -C "printenv DEV_PASSWORD"`.
   (`/api/dev/impersonate` 404s on Fly — production build.)
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

## Gotchas

- `useIsMobile` flips at 768px; the chat standing-portrait column needs ≥1024px
  (`lg`). Test desktop at ~1440×900, phone at 390×844.
- The session cookie is `better-auth.session_token`, set by the sign-in form
  submit; it persists across `browser_navigate` calls in one browser session.
