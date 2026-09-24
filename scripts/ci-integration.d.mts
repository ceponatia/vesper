import type { CiIntegrationMode, IntegrationMode } from "./integration-policy.mjs";

export interface Shard {
  index: number;
  count: number;
}

export interface LauncherOptions {
  mode: CiIntegrationMode;
  shard: Shard;
  out: string;
}

export interface DatabaseTarget {
  adminUrl: string;
  url: string;
  name: string;
  host: string;
}

export interface IntegrationPlan {
  mode: IntegrationMode;
  files: string[];
  shardFiles: string[];
}

export interface RecordedEnvironment {
  integrationMode: string | null;
  legacyCapability: "absent" | "enabled" | "malformed";
  requireIntegrationDb: boolean;
}

export const EVIDENCE_SCHEMA: "vesper.integration-evidence";
export const EVIDENCE_VERSION: number;
export const MAX_SHARDS: number;
export const DEFAULT_OUT_DIR: string;
export const DEFAULT_DATABASE_SERVER: string;

export function parseShard(text: string | undefined): Shard;
export function parseLauncherArgs(argv: string[]): LauncherOptions;
export function databaseNameForMode(mode: CiIntegrationMode): string;
export function databaseTarget(serverUrl: string, name: string): DatabaseTarget;
export function buildVitestArgs(input: { shard: Shard; reportFile: string; passWithNoTests: boolean }): string[];
export function buildChildEnv(
  baseEnv: Record<string, string | undefined>,
  input: { mode: CiIntegrationMode; databaseUrl: string },
): Record<string, string | undefined>;
export function describeEnvironment(env: Record<string, string | undefined>): RecordedEnvironment;
export function listDifference(expected: readonly string[], actual: readonly string[]): { missing: string[]; unexpected: string[] };
export function checkPlan(input: {
  mode: CiIntegrationMode;
  census: { universe: string[]; strict: string[]; legacy: string[] };
  universePlan: IntegrationPlan;
  modePlan: IntegrationPlan;
  shard: Shard;
}): string[];
