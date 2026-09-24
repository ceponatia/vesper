export type IntegrationMode = "strict" | "legacy" | "all";
export type CiIntegrationMode = "strict" | "legacy";

export interface LegacyIntegrationException {
  readonly file: string;
  readonly reason: string;
}

export interface IntegrationSelection {
  include: string[];
  exclude: string[];
}

export interface IntegrationPartition {
  strict: string[];
  legacy: string[];
  problems: string[];
}

export interface IntegrationCensus {
  universe: string[];
  strict: string[];
  legacy: string[];
  misplaced: string[];
  problems: string[];
  policyHash: string;
  universeHash: string;
}

export declare const POLICY_VERSION: number;
export declare const INTEGRATION_MODE_ENV: "VESPER_INTEGRATION_MODE";
export declare const INTEGRATION_LEGACY_FILES_ENV: "VESPER_INTEGRATION_LEGACY_FILES";
export declare const INTEGRATION_MODES: readonly IntegrationMode[];
export declare const CI_INTEGRATION_MODES: readonly CiIntegrationMode[];
export declare const LEGACY_CAPABILITY_ENV: "VESPER_ALLOW_LEGACY_ENGINE_TEST_PLAYER";
export declare const APPLICATION_INTEGRATION_ROOTS: readonly string[];
export declare const APPLICATION_INTEGRATION_SUFFIX: string;
export declare const APPLICATION_INTEGRATION_INCLUDE: readonly string[];
export declare const LEGACY_INTEGRATION_EXCEPTIONS: readonly LegacyIntegrationException[];

export function isApplicationIntegrationPath(file: string): boolean;
export function looksLikeIntegrationTest(file: string): boolean;
export function isPackageOwnedPath(file: string): boolean;
export function resolveIntegrationMode(env: Record<string, string | undefined>): IntegrationMode;
export function literalGlob(file: string): string;
export function integrationSelectionForMode(
  mode: IntegrationMode,
  exceptions?: readonly { file: string }[],
): IntegrationSelection;
export function validateLegacyExceptions(exceptions: readonly { file: unknown; reason: unknown }[]): string[];
export function reconcileTrackedIntegrationFiles(tracked: readonly string[]): { universe: string[]; misplaced: string[] };
export function partitionIntegrationInventory(
  universe: readonly string[],
  exceptions?: readonly { file: string; reason: string }[],
): IntegrationPartition;
export function inventoryForMode(mode: IntegrationMode, partition: { strict: string[]; legacy: string[] }): string[];
export function policyHash(exceptions?: readonly { file: string }[]): string;
export function inventoryHash(files: readonly string[]): string;
export function trackedFiles(cwd: string): string[];
export function integrationCensus(
  tracked: readonly string[],
  exceptions?: readonly { file: string; reason: string }[],
): IntegrationCensus;
export function repositoryRoot(): string;
