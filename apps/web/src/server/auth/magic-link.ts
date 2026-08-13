import { log } from "@/server/log";

/**
 * Magic-link delivery policy (security-authz.plan.md slice 1). A magic link is a
 * temporary password, so no production process may ever write one into log
 * retention: the plugin registers only where delivery actually works, and the
 * production diagnostic carries the email and nothing else. Split out of
 * `auth.ts` so the policy is unit-testable without constructing the Better Auth
 * instance (which opens a DB connection at import).
 *
 * Every gate in this module hangs off one fact — a **resolved transport object**,
 * never the presence of an env var. An env name proves a value was set, not that
 * anything can send mail; gating on presence would let `RESEND_API_KEY=x` enable
 * the plugin and the `/api/auth-config` flag while delivering nothing, which is a
 * silently broken production sign-in method.
 */

/** Somewhere that can actually deliver a link. The only thing the gates trust. */
export type MagicLinkTransport = { send(email: string, url: string): Promise<void> };

/**
 * The concrete transports, each a factory that reads its **own** env and returns
 * `null` when unconfigured. **Empty in v1** — no sender is implemented (Resend/SMTP
 * are out of scope), so production magic-link is off unconditionally.
 *
 * Adding one is a single entry, e.g.
 * `() => { const key = process.env.RESEND_API_KEY; return key ? resendTransport(key) : null; }`
 * — registering it is what turns production magic-link on; nothing else changes.
 */
const MAGIC_LINK_TRANSPORTS: readonly (() => MagicLinkTransport | null)[] = [];

/** The first registered transport whose own configuration resolves; `null` ⇒ no delivery exists. */
export function configuredMagicLinkTransport(): MagicLinkTransport | null {
  for (const resolve of MAGIC_LINK_TRANSPORTS) {
    const transport = resolve();
    if (transport) return transport;
  }
  return null;
}

/** The deployment facts the policy branches on — injectable so tests stay pure. */
export type MagicLinkEnv = { production: boolean; transport: MagicLinkTransport | null };

export function magicLinkEnv(): MagicLinkEnv {
  return { production: process.env.NODE_ENV === "production", transport: configuredMagicLinkTransport() };
}

/**
 * Whether the `magicLink` plugin registers at all. Dev always (the logged link is
 * the only way to finish a local magic-link sign-in); production only behind a
 * resolved transport — mirroring `configuredSocialProviders()`, where a method
 * whose delivery isn't configured is simply absent rather than broken.
 */
export function magicLinkPluginEnabled(env: MagicLinkEnv = magicLinkEnv()): boolean {
  return !env.production || env.transport !== null;
}

/** A delivery attempt's diagnostic, built separately from emission so it is assertable. */
export type MagicLinkEvent = { level: "info" | "warn" | "error"; message: string; data: Record<string, unknown> };

/**
 * The diagnostic for one *successful* delivery attempt. Dev keeps the URL in the
 * payload — with no transport, server output is how a local sign-in completes.
 * Production carries the email only: never the url, token, or callback query
 * string. The no-transport production branch is unreachable as a delivery attempt
 * (the plugin doesn't register there) but is kept as the safe default — a `warn`
 * saying the link was dropped, never a success claim (docs/resilience.md: degrade
 * with a diagnostic, never leak).
 */
export function magicLinkEvent(
  link: { email: string; url: string },
  env: MagicLinkEnv = magicLinkEnv(),
): MagicLinkEvent {
  if (!env.production) {
    return {
      level: "info",
      message: "magic-link sign-in requested (dev: link logged)",
      data: { email: link.email, url: link.url },
    };
  }
  if (env.transport) {
    return { level: "info", message: "magic-link sign-in sent", data: { email: link.email } };
  }
  return {
    level: "warn",
    message: "magic-link sign-in dropped — no email transport configured",
    data: { email: link.email },
  };
}

/**
 * The error's class name only. A transport's message routinely quotes the request
 * it failed on — which contains the link — so the message never enters the payload;
 * full detail rides the rethrow to Better Auth's own handler.
 */
function errorName(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}

/**
 * The diagnostic for a *failed* send. Same key discipline as the success payload
 * plus a class-name-only `error`, and a message that never claims delivery: a
 * failed send reported as sent is exactly the flaw this module exists to prevent.
 */
export function magicLinkFailureEvent(link: { email: string }, err: unknown): MagicLinkEvent {
  return {
    level: "error",
    message: "magic-link sign-in failed — transport rejected the send",
    data: { email: link.email, error: errorName(err) },
  };
}

/**
 * Better Auth's delivery hook. When a transport resolves it does the send and the
 * failure propagates (docs/resilience.md — a trust-boundary failure surfaces as a
 * failure; Better Auth must not report an undelivered link as sent). With no
 * transport this is dev-only by construction, since the plugin is then absent in
 * production.
 *
 * `env` is injectable for tests, which is why `auth.ts` must wrap this rather than
 * hand the reference to Better Auth directly: Better Auth calls the hook as
 * `send(data, request)`, and a `Request` landing in `env` would read as a
 * non-production environment and log the URL.
 */
export async function sendMagicLink(
  link: { email: string; url: string },
  env: MagicLinkEnv = magicLinkEnv(),
): Promise<void> {
  const { transport } = env;
  if (transport) {
    try {
      await transport.send(link.email, link.url);
    } catch (err) {
      const failure = magicLinkFailureEvent(link, err);
      log[failure.level]("auth.magic_link", failure.message, failure.data);
      throw err;
    }
  }
  const event = magicLinkEvent(link, env);
  log[event.level]("auth.magic_link", event.message, event.data);
}
