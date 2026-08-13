import type { Metadata } from "next";
import { ImageLabPage } from "@/components/settings/image-lab-page";

export const metadata: Metadata = { title: "Image lab" };

/**
 * The admin-only Advanced Image Lab
 * (docs/developer-notes/qwen-advanced-image-subsystem.spec.md). The
 * `/api/admin/self/image-lab` family is role-gated server-side and 404s for
 * everyone else; the client gate is only so a non-admin gets an explanation
 * rather than a page of failed requests.
 *
 * `?experiment=<id>` opens that experiment's detail directly, so a run can be
 * linked to by the id its ruling is cited under — read here server-side and
 * passed down so the client component needs no useSearchParams/Suspense
 * plumbing.
 */
export default async function ImageLabRoute({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const experimentParam = params["experiment"];
  return (
    <ImageLabPage
      initialExperimentId={typeof experimentParam === "string" && experimentParam !== "" ? experimentParam : undefined}
    />
  );
}
