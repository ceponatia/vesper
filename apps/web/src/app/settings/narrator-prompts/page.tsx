import type { Metadata } from "next";
import { NarratorPromptsPage } from "@/components/narrator-prompts/narrator-prompts-page";

export const metadata: Metadata = { title: "Narrator prompts" };

/**
 * The owner-admin Narrator Prompt Lab (narrator-prompt-lab.plan.md, slice 3).
 * The `/api/admin/self/narrator-prompts` family is role-gated server-side and
 * 404s for everyone else; the client gate is only so a non-admin gets an
 * explanation rather than a page of failed requests.
 *
 * `?prompt=<id>` opens that prompt's editor directly — the target the in-chat
 * "test prompt active" badge links to, so an override is one click from the
 * text that caused it. Read here server-side and passed down, so the client
 * component needs no useSearchParams/Suspense plumbing (the Image Generator's
 * `?run=` precedent).
 */
export default async function NarratorPromptsRoute({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const promptParam = params["prompt"];
  return (
    <NarratorPromptsPage
      initialPromptId={typeof promptParam === "string" && promptParam !== "" ? promptParam : undefined}
    />
  );
}
