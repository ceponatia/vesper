import type { Metadata } from "next";
import { EngineComparisonIndexPage } from "@/components/admin/shadow-parity-page";

export const metadata: Metadata = { title: "Engine Comparison" };

/**
 * Owner-admin Engine Comparison index. The `/api/admin/self/sim/shadow` family
 * retains its historical internal route name; it is both role-gated and
 * owner-filtered server-side, while the client gate is only UX.
 */
export default function EngineComparisonIndexRoute() {
  return <EngineComparisonIndexPage />;
}
