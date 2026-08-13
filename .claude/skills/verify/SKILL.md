---
name: verify
description: Verify a vesper change end-to-end against the Fly deploy (the repo's only UI-testing surface). Use when confirming a change actually works in the running app.
---

# Verifying vesper changes

Runtime verification happens against the **Fly deploy** — never a local
`pnpm dev` + Postgres for UI work (CLAUDE.md).

**Do NOT run `pnpm verify`, tests, lint, or typecheck as part of verification.**
They are code gates, not observation. `pnpm verify` belongs to landing the
change — `.husky/pre-push` runs it automatically before a code push — and it is
a slow serial run that tells you nothing about whether the deployed app behaves.

## Recipe

1. **Deploy the working tree**: `fly deploy -a vesper --yes` (~4 min; remote
   Docker build, runs `pnpm db:migrate` against Neon, cuts the Machine over).
   The output pipes nothing until done — run in background and wait.
2. **Sign in** at `https://vesper.fly.dev/sign-in` as the QA account
   `uxtest-main@vesper.local`. The password is the Fly `DEV_PASSWORD` secret —
   read it off the machine: `fly ssh console -a vesper -C "printenv DEV_PASSWORD"`.
   (`/api/dev/impersonate` 404s on Fly — production build.)
3. **Drive it with Playwright MCP** (`browser_navigate`, `browser_snapshot`,
   `browser_click`, `browser_resize` for mobile widths). The QA account owns
   the Tsukikage Onsen world/cast and the Lysandra Vane character with existing
   chats under `/chat`.
4. **Screenshots** go in the untracked `screenshots/` folder at the repo root —
   never the repo root or `docs/`.

## Gotchas

- `useIsMobile` flips at 768px; the chat standing-portrait column needs ≥1024px
  (`lg`). Test desktop at ~1440×900, phone at 390×844.
- The session cookie is `better-auth.session_token`, set by the sign-in form
  submit; it persists across `browser_navigate` calls in one browser session.
