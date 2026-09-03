// Types for `ci-safe-followup.mjs`. The script is plain ESM so CI can run it
// without an install, and the root tsconfig has no `allowJs`; this declaration
// is what lets its test import the decision function directly.

export interface SafeFollowupEvent {
  name: string;
  action: string;
  baseRef: string;
  beforeSha: string;
  headSha: string;
  baseSha: string;
  prNumber: number;
}

export interface SafeFollowupGit {
  isAncestor(ancestor: string, descendant: string): boolean;
  changedFiles(from: string, to: string): string[];
}

/** The fields of a GitHub Actions workflow-run object the decision reads. */
export interface WorkflowRunLike {
  id?: number;
  status?: string;
  conclusion?: string | null;
  check_suite_id?: number;
  pull_requests?: Array<{ number?: number; base?: { sha?: string; ref?: string } }>;
}

/** The fields of a GitHub check-run object the decision reads. */
export interface CheckRunLike {
  name?: string;
  status?: string;
  conclusion?: string | null;
  app?: { slug?: string };
  check_suite?: { id?: number };
}

export interface SafeFollowupApi {
  workflowRuns(headSha: string): Promise<unknown>;
  checkRuns(headSha: string): Promise<unknown>;
}

export interface SafeFollowupVerdict {
  safe: boolean;
  reason: string;
}

export function isDocumentationPath(file: string): boolean;

export function decideSafeFollowup(input: {
  event: SafeFollowupEvent;
  git: SafeFollowupGit;
  api: SafeFollowupApi;
}): Promise<SafeFollowupVerdict>;
