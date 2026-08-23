import type { Metadata } from "next";
import { ImageGeneratorPage } from "@/components/settings/image-generator-page";

export const metadata: Metadata = { title: "Image generator" };

/**
 * The admin-only Image Generator
 * (docs/developer-notes/image-lab-general-model-trials.spec.md). The
 * `/api/admin/self/image-generator` family is role-gated server-side and 404s
 * for everyone else; the client gate is only so a non-admin gets an
 * explanation rather than a page of failed requests.
 *
 * `?run=<id>` opens that run's detail directly, so a run can be linked to by
 * the id its result is cited under — read here server-side and passed down so
 * the client component needs no useSearchParams/Suspense plumbing.
 */
export default async function ImageGeneratorRoute({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const runParam = params["run"];
  return <ImageGeneratorPage initialRunId={typeof runParam === "string" && runParam !== "" ? runParam : undefined} />;
}
