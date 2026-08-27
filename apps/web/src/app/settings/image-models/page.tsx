import type { Metadata } from "next";
import { ImageModelsPage } from "@/components/settings/image-models-page";

export const metadata: Metadata = { title: "Image models" };

/**
 * Admin-only image-model registry. The `/api/admin/self/image-models` family is
 * role-gated server-side and 404s for everyone else; the client gate is only so
 * a non-admin gets an explanation rather than a page of failed requests.
 */
export default function ImageModelsRoute() {
  return <ImageModelsPage />;
}
