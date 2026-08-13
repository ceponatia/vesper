import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/server/auth";

/**
 * Better Auth's full HTTP surface (sign-in/up/out, OAuth callbacks, magic-link,
 * admin, session) under /api/auth/* (auth.plan.md). All auth endpoints are
 * owned by the library; our own route handlers only read the resolved session.
 */
export const { GET, POST } = toNextJsHandler(auth);
