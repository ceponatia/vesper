import { enabledSocialProviders, magicLinkPluginEnabled } from "@/server/auth";
import { jsonOk, withRoute } from "@/server/api";

/**
 * Public auth-method config for the sign-in UI (auth.plan.md): which OAuth
 * providers are env-enabled, so the form only renders buttons that work.
 * Email+password is always available; magic-link only where the plugin is
 * registered — dev, or a production with a real transport (security-authz.plan.md
 * slice 1) — so the form never offers a request the server can't route.
 * No session required.
 */
export const GET = withRoute(async () =>
  jsonOk({ providers: enabledSocialProviders(), emailPassword: true, magicLink: magicLinkPluginEnabled() }),
);
