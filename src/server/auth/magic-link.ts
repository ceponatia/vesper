import { log } from "@/server/log";

/**
 * Magic-link delivery policy (security-authz.plan.md slice 1). A magic link is a
 * temporary password, so no production process may ever write one into log
 * retention: the plugin registers only where delivery actually works, and the
 * production diagnostic carries the email and nothing else. Split out of
 * `auth.ts` so the policy is unit-testable without constructing the Better Auth
 * instance (which opens a DB connection at import).
 */

/**
 * Whether a real email transport is configured. v1 ships none; these are the two
 * env names a Resend/SMTP sender would use (both listed in `.env.example`), and
 * their presence is the single fact that promotes magic-link from dev-only to
 * production-eligible (plan OQ3). A new transport adds its var here.
 */
export function magicLinkTransportConfigured(): boolean {
  return [process.env.RESEND_API_KEY, process.env.SMTP_URL].some((value) => (value ?? "").trim().length > 0);
}

/** The deployment facts the policy branches on — injectable so tests stay pure. */
export type MagicLinkEnv = { production: boolean; transportConfigured: boolean };

export function magicLinkEnv(): MagicLinkEnv {
  return {
    production: process.env.NODE_ENV === "production",
    transportConfigured: magicLinkTransportConfigured(),
  };
}

/**
 * Whether the `magicLink` plugin registers at all. Dev always (the logged link is
 * the only way to finish a local magic-link sign-in); production only behind a
 * configured transport — mirroring `configuredSocialProviders()`, where a method
 * whose delivery isn't configured is simply absent rather than broken.
 */
export function magicLinkPluginEnabled(env: MagicLinkEnv = magicLinkEnv()): boolean {
  return !env.production || env.transportConfigured;
}

/** A delivery attempt's diagnostic, built separately from emission so it is assertable. */
export type MagicLinkEvent = { level: "info" | "warn"; message: string; data: Record<string, unknown> };

/**
 * The diagnostic for one delivery attempt. Dev keeps the URL in the payload — with
 * no transport, server output is how a local sign-in completes. Production carries
 * the email only: never the url, token, or callback query string. The no-transport
 * production branch is a `warn` because the link is dropped, not delivered
 * (docs/resilience.md — degrade with a diagnostic, never leak).
 */
export function magicLinkEvent(
  link: { email: string; url: string },
  env: MagicLinkEnv = magicLinkEnv(),
): MagicLinkEvent {
  if (!env.production) {
    return {
      level: "info",
      message: "magic-link sign-in requested (dev fallback: link logged)",
      data: { email: link.email, url: link.url },
    };
  }
  if (env.transportConfigured) {
    return { level: "info", message: "magic-link sign-in sent", data: { email: link.email } };
  }
  return {
    level: "warn",
    message: "magic-link sign-in dropped — no email transport configured",
    data: { email: link.email },
  };
}

/**
 * Better Auth's delivery hook. v1 emits the diagnostic and nothing else; a real
 * sender (Resend/SMTP) awaits its send here, gated on the same
 * `transportConfigured` fact that decides whether the plugin registers at all.
 */
export async function sendMagicLink(link: { email: string; url: string }): Promise<void> {
  const event = magicLinkEvent(link);
  log[event.level]("auth.magic_link", event.message, event.data);
}
