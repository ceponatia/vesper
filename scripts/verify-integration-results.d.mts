export interface EvidenceBatch {
  artifact: string;
  dir: string;
  envelope: unknown;
  envelopeError: string | null;
  report: unknown;
  reportError: string | null;
}

export interface VerificationIdentity {
  sha: string;
  runId: string;
  runAttempt: number;
  prHead?: string | null;
  prBase?: string | null;
}

export interface BatchSummary {
  mode: string;
  shard: string;
  attempt: number;
  artifact: string;
  planned: number;
  executed: number;
  passed: number;
  failed: number;
  skipped: number;
  status: string;
  durationMs: number | null;
}

export interface VerificationResult {
  ok: boolean;
  problems: string[];
  summary: {
    universe: number;
    strict: number;
    legacy: number;
    executedFiles: number;
    batches: BatchSummary[];
  };
}

export declare const INTEGRATION_JOB_NAME: RegExp;
export declare const ARTIFACT_NAME: RegExp;

export function loadEvidence(evidenceDir: string): EvidenceBatch[];
export function envelopeShapeProblems(envelope: unknown): string[];
export function argvProblems(envelope: { argv: string[]; shard: { index: number; count: number }; inventory: { files: string[] } }): string[];
export function verifyIntegrationEvidence(input: {
  batches: EvidenceBatch[];
  census: { universe: string[]; strict: string[]; legacy: string[]; problems: string[]; policyHash: string };
  identity: VerificationIdentity;
  shardCount: number;
  authoritativeAttempts: Map<number, number> | null;
}): VerificationResult;
export function authoritativeAttemptsFromJobs(
  jobs: ReadonlyArray<{
    id?: number;
    name?: string;
    run_attempt?: number;
    started_at?: string | null;
    completed_at?: string | null;
  }>,
  shardCount: number,
): Map<number, number>;
export function renderSummary(result: VerificationResult): string;
