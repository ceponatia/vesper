import type { Metadata } from "next";
import { ShadowParityIndexPage } from "@/components/admin/shadow-parity-page";

export const metadata: Metadata = { title: "Shadow parity" };

/**
 * The shadow-parity index (R4, engine.rollout.plan.md) — admin-gated
 * client-side; the /api/admin/sim/shadow family it reads role-gates
 * server-side (404 for non-admins), so it works on the deployed build.
 */
export default function ShadowParityIndexRoute() {
  return <ShadowParityIndexPage />;
}
