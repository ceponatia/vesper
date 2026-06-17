"use client";

import { useEffect, useState } from "react";
import { z } from "zod";
import { apiGet } from "@/lib/client/api";

/** Forgiving: anything but an explicit admin role means "not admin" (mirrors /api/dev/me). */
const devMeSchema = z.preprocess(
  (raw) => (raw && typeof raw === "object" ? raw : {}),
  z.object({
    user: z.object({ role: z.enum(["user", "admin"]).catch("user") }).catch({ role: "user" }),
  }),
);

// One in-flight fetch per page load, shared across every caller (a page may mount
// several admin-gated affordances — the lightbox, the Inspector tab — at once).
let cached: Promise<boolean> | null = null;
function fetchIsAdmin(): Promise<boolean> {
  cached ??= apiGet(devMeSchema, "/api/dev/me").then((r) => (r.ok ? r.data.user.role === "admin" : false));
  return cached;
}

/**
 * Whether the current user is an admin/dev — the gate for dev-only affordances
 * (the lightbox generation-prompt panel, the play-screen Inspector tab). Resolves
 * to `false` until the role is known, so a gated affordance stays hidden by
 * default and only appears once admin is confirmed.
 */
export function useIsAdmin(): boolean {
  const [isAdmin, setIsAdmin] = useState(false);
  useEffect(() => {
    let active = true;
    void fetchIsAdmin().then((value) => {
      if (active) setIsAdmin(value);
    });
    return () => {
      active = false;
    };
  }, []);
  return isAdmin;
}
