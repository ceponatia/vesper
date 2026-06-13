import type { Metadata } from "next";
import { Suspense } from "react";
import { NewSessionWizard } from "@/components/sessions/new-session-wizard";
import { PageContainer } from "@/components/shell/app-shell";
import { SkeletonText } from "@/components/ui/skeleton";

export const metadata: Metadata = { title: "New session" };

// useSearchParams (worldId preselect) requires a Suspense boundary.
export default function NewSessionRoute() {
  return (
    <Suspense
      fallback={
        <PageContainer>
          <SkeletonText lines={4} />
        </PageContainer>
      }
    >
      <NewSessionWizard />
    </Suspense>
  );
}
