import type { Metadata } from "next";
import { ImageLabPage } from "@/components/settings/image-lab-page";

export const metadata: Metadata = { title: "Image lab" };

/**
 * The admin-only Advanced Image Lab
 * (docs/developer-notes/qwen-advanced-image-subsystem.spec.md). The
 * `/api/admin/self/image-lab` family is role-gated server-side and 404s for
 * everyone else; the client gate is only so a non-admin gets an explanation
 * rather than a page of failed requests.
 */
export default function ImageLabRoute() {
  return <ImageLabPage />;
}
