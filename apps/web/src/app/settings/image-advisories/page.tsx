import type { Metadata } from "next";
import { PageContainer } from "@/components/shell/app-shell";
import { ImageAdvisoriesSection } from "@/components/settings/image-advisories-section";

export const metadata: Metadata = { title: "Image advisories" };

/**
 * Admin-only comparison record for render advisories (issue #249):
 * `/api/admin/self/image-advisories/summary` is role-gated server-side and
 * 404s for everyone else; the page renders regardless so a non-admin gets an
 * explanation from the API's own refusal rather than a silent blank screen.
 */
export default function ImageAdvisoriesRoute() {
  return (
    <PageContainer>
      <header className="mb-6">
        <h1 className="prose-display text-2xl">Image advisories</h1>
        <p className="mt-1 text-sm text-paper-400">
          The measured signals beside render provenance, and how they compare with your own
          agree/disagree review — never a gate, never an automatic model swap.
        </p>
      </header>
      <ImageAdvisoriesSection />
    </PageContainer>
  );
}
