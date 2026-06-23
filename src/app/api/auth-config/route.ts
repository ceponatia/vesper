import { enabledSocialProviders } from "@/server/auth";
import { jsonOk, withRoute } from "@/server/api";

/**
 * Public auth-method config for the sign-in UI (auth.plan.md): which OAuth
 * providers are env-enabled, so the form only renders buttons that work.
 * Email+password and magic-link are always available. No session required.
 */
export const GET = withRoute(async () =>
  jsonOk({ providers: enabledSocialProviders(), emailPassword: true, magicLink: true }),
);
