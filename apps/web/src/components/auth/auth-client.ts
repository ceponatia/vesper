"use client";

import { createAuthClient } from "better-auth/react";
import { adminClient, magicLinkClient } from "better-auth/client/plugins";

/**
 * Browser-side Better Auth client. Talks to /api/auth/* on the
 * same origin — no baseURL needed in dev. The magic-link + admin client plugins
 * mirror the server plugins so `signIn.magicLink` and the admin methods exist.
 */
export const authClient = createAuthClient({
  plugins: [magicLinkClient(), adminClient()],
});

export const { signIn, signUp, signOut, useSession } = authClient;
