# Security review follow-ups — ownership & auth hardening

Status: draft (stub — parked 2026-07-25 from an external static security review
of main (auth, authorization, cross-user access, public-library behavior,
destructive ops); every finding below re-verified against the code before
parking; promote per [CLAUDE.md](CLAUDE.md) before building)

## What — the findings, evaluated

The review's headline matches ours from the 2026-06-23 scan
([../finished/security-hardening.plan.md](../finished/security-hardening.plan.md)):
the ownership model is disciplined — signed Better Auth sessions, `ownerId`
in the same query as the read/write, 404 over existence leaks. Seven findings
survive verification; none is an exploitable hole **today** (single-owner
deployment, `ALLOW_SIGNUP` off, chats can't reference foreign characters), but
S1 is a genuine now-fix the moment magic-link is used on Fly, and S2/S3/S5 are
the classic "one future feature away from a breach" shape.

- **S1 — magic-link URLs written to production logs.** CONFIRMED
  (`src/server/auth/auth.ts:62-64`): `sendMagicLink` logs `{ email, url }`
  unconditionally — the documented v1 dev fallback (no email transport exists),
  but the `magicLink` plugin registers unconditionally, so on Fly a magic-link
  request writes a live sign-in URL (a temporary password) into log retention.
  Anyone with log access can authenticate as that user. **Highest priority;
  also the cheapest fix.**
- **S2 — public entities expose their complete DB row.** CONFIRMED:
  `findViewable` uses bare `.select()` for all four shareable kinds
  (`src/server/api/visibility.ts:33-63`) and routes return the row verbatim
  (`src/app/api/characters/[id]/route.ts:34`). "Public" currently means "every
  persisted column is public" — any future column (author notes, moderation
  metadata, provider config) leaks automatically. The portrait sub-query is the
  concrete case **today**: full `images` rows go to foreign viewers, including
  `path` (storage layout) and `prompt` — and `deleteChat` scrubs image prompts
  precisely because prompts embed chat lines, so the codebase already treats
  that column as sensitive.
- **S3 — character deletion traverses chats without an owner condition.**
  CONFIRMED (`src/app/api/characters/[id]/route.ts:77-84`): the traversal
  matches `chatParticipants.characterId` only, then calls `deleteChat(chat)`
  with the *chat row's* `ownerId` — and `deleteChat` trusts its caller-supplied
  `{ id, ownerId }` (`src/server/engine/chat-pipeline.ts:1972`). Today the
  invariant "chat owner == character owner" holds (chat creation rejects
  foreign character ids), so this is defense-in-depth — but the route's own
  comment anticipates multi-character chats, and shared/public characters or
  an import path would turn this into deleting another user's transcript and
  memories. Cheap to close now.
- **S4 — ownership enforced only in application queries.** ACCURATE as an
  architectural observation: no owner-aware repository layer, no RLS — one
  missed predicate is a full IDOR. The 2026-06-23 sweep came back clean, but
  the successor engine multiplies resources (branches, commands, projections,
  memories) faster than route-by-route sweeps scale. The pragmatic middle is
  guardrail-shaped, not RLS-shaped (see Sketch).
- **S5 — public image access keyed on unverified polymorphic metadata.**
  CONFIRMED (`src/server/api/visibility.ts:72-83`): `isPublicEntityImage`
  checks only "the named entity exists and is public" — no ownership
  relationship between image owner and entity owner. Today `entityKind`/
  `entityId` are assigned server-side at creation, so exploitability is low,
  but the check is one metadata-writing path away from cross-owner exposure.
  One extra predicate closes it.
- **S6 — email/password policy needs production hardening.** VALID as a
  pre-public-signup checklist, not now-work: no email verification, no
  password-strength policy, no MFA for admins, no session-revocation-on-reset
  configured; the rate limiter is deliberately process-local (recorded as a
  deferral in the 2026-06-23 plan). All fine while `ALLOW_SIGNUP` stays off
  and the app runs one instance; all mandatory before either changes.
- **S7 — no adversarial two-user authorization test matrix.** VALID coverage
  gap. Individual cross-user cases exist (e.g. the social-cards int tests
  around `findViewable`), but there's no reusable owner/other/admin matrix, so
  authorization regressions surface only if someone thinks to write the case.

## Why it matters

The current posture is safe because of *deployment facts* (one real user,
signup off), not because the latent gaps are closed. Every planned direction —
public library sharing, sign-up, multi-character chats, successor worlds
referencing library entities — flips one of the assumptions S1/S2/S3/S5 lean
on. Parking this batch keeps the review's evidence and fix sketches from
rotting until the owner schedules it.

## Sketch

Roughly in the review's priority order, which we agree with:

1. **S1:** gate the log line to dev (`NODE_ENV !== "production"`), and don't
   register the `magicLink` plugin in production unless a real transport env
   is configured — never log token/URL in production. (~10 lines + a test.)
2. **S2:** explicit public DTO projections in `findViewable` callers (or a
   `toPublic<Kind>` layer beside it): allow-listed columns only, portraits as
   `{ id, kind, createdAt }`-shaped refs — no `path`, no `prompt`, no provider
   internals. Add the review's best idea: a test that **enumerates the exact
   keys** of a foreign public entity response, so a new column can't leak
   silently.
3. **S3:** add `eq(characterChats.ownerId, user.id)` to the deletion
   traversal, and change `deleteChat` to take `(chatId, authenticatedUserId)`
   and re-verify ownership in its own query — destructive services stop
   trusting route-supplied ownership facts.
4. **S5:** pass `row.ownerId` into `isPublicEntityImage` and require
   `owner_id = :imageOwnerId` alongside `visibility = 'public'`.
5. **S7:** one reusable two-user int-test harness (owner 200 / other 404 /
   public-read sanitized) applied to every owned resource, chat + successor
   surfaces included; grows with each new route.
6. **S4:** guardrail first — an ESLint restriction (or arch test) flagging
   `db().update/delete` in `app/api/**` unless routed through an
   ownership-asserting helper; owner-aware repo methods where they fall out
   naturally. RLS stays an open question, not a commitment.
7. **S6:** written checklist gating any future `ALLOW_SIGNUP=true` on: email
   verification, shared rate limiting, admin MFA, session revocation on
   credential change, explicit session lifetimes.

## Open questions

- RLS (S4): worth the migration + connection-plumbing cost on Neon, or is the
  lint-rule + repo-helper layer enough for a single-tenant-per-row app? (The
  review itself calls RLS "more involved".)
- S2 DTO shape: sanitize `profile` too (it may carry narrator-only authoring
  data), or is profile fully public by design for shared characters? Needs an
  owner ruling on what "public character" is supposed to reveal.
- S6/S1 sequencing: is a real email transport (Resend/SMTP) coming before
  public signup? If yes, S1's production path becomes "transport or 500",
  never "log".
- Does the S7 matrix live in `test:int` per-route files or as one
  table-driven suite over a route registry?

## Slices

_(Defined at promotion. S1 is small enough to ride along with any auth-adjacent
work before then — flag it if auth.ts is touched for other reasons.)_
