import type { Metadata } from "next";
import { ShadowParityIndexPage } from "@/components/admin/shadow-parity-page";

export const metadata: Metadata = { title: "Shadow parity" };

/**
 * Owner-admin shadow-parity index. The `/api/admin/self/sim/shadow` family is
 * both role-gated and owner-filtered server-side; the client gate is only UX.
 */
export default function ShadowParityIndexRoute() {
  return <ShadowParityIndexPage />;
}
