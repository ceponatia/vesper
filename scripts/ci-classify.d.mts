export interface CiClassificationInput {
  files: string[];
  eventName?: string;
  baseRef?: string;
  safeFollowup?: boolean;
}

export interface CiClassification {
  docs_only: boolean;
  docs: boolean;
  code: boolean;
  integration: boolean;
  engine: boolean;
  build: boolean;
  docker: boolean;
  safe_followup: boolean;
}

export function isDocumentationPath(file: string): boolean;
export function classifyChanges(input: CiClassificationInput): CiClassification;
