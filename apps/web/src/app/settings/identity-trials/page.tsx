import type { Metadata } from "next";
import { IdentityTrialsPage } from "@/components/settings/identity-trials-page";

export const metadata: Metadata = { title: "Identity trials" };

/**
 * Admin-only identity-reference trial harness
 * (image-identity-packs.spec.trial.md). The `/api/admin/self/identity-packs/trial`
 * family is role-gated server-side and 404s for everyone else; the client gate is
 * only so a non-admin gets an explanation rather than a page of failed requests.
 */
export default function IdentityTrialsRoute() {
  return <IdentityTrialsPage />;
}
