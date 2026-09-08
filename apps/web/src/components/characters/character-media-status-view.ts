import type { CharacterMediaJob } from "@/lib/client/api";

export interface CharacterMediaStatusView {
  title: string;
  detail: string;
  tone: "default" | "ok" | "danger";
  active: boolean;
  retryLabel: string | null;
}

const retryPlace: Record<CharacterMediaJob["operation"], string> = {
  portrait: "Portrait Studio",
  variant: "Portrait Studio → New variant",
  identity_pack: "Portrait Studio → Identity reference",
  reference_views: "Portrait Studio → Reference views",
};

/** Pure player copy for the persistent status component. */
export function characterMediaStatusView(job: CharacterMediaJob): CharacterMediaStatusView {
  const progress = job.progress.total > 1 ? ` ${job.progress.completed} of ${job.progress.total} settled.` : "";
  switch (job.lifecycle) {
    case "queued":
      return {
        title: `${job.label} queued`,
        detail: "Waiting for an image worker.",
        tone: "default",
        active: true,
        retryLabel: null,
      };
    case "running":
      return {
        title: `${job.label} in progress`,
        detail: `You can leave this tab and return.${progress}`,
        tone: "default",
        active: true,
        retryLabel: null,
      };
    case "succeeded":
      return {
        title: `${job.label} complete`,
        detail: `The result is ready.${progress}`,
        tone: "ok",
        active: false,
        retryLabel: null,
      };
    case "partial":
      return { title: `${job.label} needs attention`, detail: job.error?.message ?? `Some targets failed.${progress}`, tone: "danger", active: false, retryLabel: `Retry from ${retryPlace[job.operation]}` };
    case "interrupted":
      return { title: `${job.label} was interrupted`, detail: job.error?.message ?? "The worker did not finish.", tone: "danger", active: false, retryLabel: `Retry from ${retryPlace[job.operation]}` };
    case "failed":
      return { title: `${job.label} failed`, detail: job.error?.message ?? "The operation did not finish.", tone: "danger", active: false, retryLabel: `Retry from ${retryPlace[job.operation]}` };
  }
}
