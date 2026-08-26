"use client";

import Link from "next/link";
import type { NarratorPromptTemplateSummary } from "@/contracts/narrator-prompts/template";
import { NARRATOR_PROMPT_LAB_PATH } from "@/components/chat/narrator-prompt-select";

/**
 * The persistent active-test badge (narrator-prompt-lab.plan.md §"Conversation
 * control"): `TEST PROMPT · Player Agency Minimal v4`, shown in the conversation
 * header whenever an admin has this chat on a handwritten narrator prompt.
 *
 * It sits OUTSIDE the menu on purpose. An override the owner has forgotten about
 * is how prompt-specific behavior becomes a false production bug report, so the
 * fact that this conversation is not narrating with Vesper's production
 * instructions has to be visible with the menu closed, in every reply's company.
 *
 * Renders nothing for the production prompt (`template === null`) — ordinary play
 * and every non-admin header are untouched.
 */
export function NarratorPromptBadge({ template }: { template: NarratorPromptTemplateSummary | null }) {
  if (!template) return null;
  const name = template.name || "Untitled prompt";
  return (
    <Link
      href={`${NARRATOR_PROMPT_LAB_PATH}?prompt=${encodeURIComponent(template.id)}`}
      target="_blank"
      rel="noopener noreferrer"
      prefetch={false}
      title={`This conversation narrates with the test prompt “${name}” (revision ${template.currentRevision}), not Vesper's production instructions. Opens in the Prompt Lab.`}
      className="mt-0.5 inline-flex max-w-full items-center gap-1 rounded-sm border border-accent-500/60 bg-accent-500/15 px-1.5 py-0.5 text-[10px] leading-4 text-accent-300 transition-colors hover:border-accent-400 hover:text-accent-200"
    >
      <span className="shrink-0 font-medium tracking-wide uppercase">Test prompt</span>
      <span aria-hidden className="shrink-0 text-accent-500">
        ·
      </span>
      <span className="truncate">{`${name} v${template.currentRevision}`}</span>
    </Link>
  );
}
