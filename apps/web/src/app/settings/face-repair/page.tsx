import type { Metadata } from "next";
import { FaceRepairSection } from "@/components/settings/face-repair-section";

export const metadata: Metadata = { title: "Face repair" };

/**
 * Admin-only face-repair action (issue #246). Both `/api/admin/self/face-repair`
 * endpoints are role- and flag-gated server-side and 404/refuse for everyone
 * else; the client checks here are only so a non-admin or a deployment with the
 * flag off gets an explanation rather than a page of failed requests.
 */
export default function FaceRepairRoute() {
  return <FaceRepairSection />;
}
