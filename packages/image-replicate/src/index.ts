/**
 * `@vesper/image-replicate` — the Replicate transport.
 *
 * Everything exported here is about talking to `api.replicate.com`: creating a
 * prediction and polling it, uploading and deleting the short-lived files a
 * reference travels as, downloading the produced image from an allow-listed
 * host, and reading a model's published input schema. Nothing here knows that
 * Vesper has characters, chats, a database, or a Next.js app.
 *
 * This package is deliberately **server-only** — it performs network IO and
 * handles bytes — but it owns no ambient configuration: it reads no environment
 * and holds no Vesper state. The application resolves the deployment's
 * `ReplicateConfig` once and builds one `ReplicateClient` from it; every
 * credentialed call goes through that object.
 *
 * **This list is the package's entire public API, and it is deliberately
 * explicit.** Private polling and parsing helpers stay private; `export *` in a
 * package root barrel is rejected by `pnpm lint:package-boundaries`.
 */

export { createReplicateClient } from "./client";
export type { ReplicateClient } from "./client";
export {
  DEFAULT_PREDICTION_TIMEOUT_MS,
  MAX_PREDICTION_TIMEOUT_MS,
  MIN_PREDICTION_TIMEOUT_MS,
  OUTPUT_TIMEOUT_MS,
  REPLICATE_DEFAULT_EDIT_MODEL,
  REQUEST_TIMEOUT_MS,
} from "./config";
export type { ReplicateConfig } from "./config";
export { DATA_URL_BUDGET_BYTES, referenceDataUrl, transportReplicateReferences, withinDataUrlBudget } from "./files";
export type { PreparedReferenceBytes, TransportReferencesResult } from "./files";
export { buildRegistryModelInput, overlayControlInput, previewRegistryModelInput } from "./payload";
export type { RegistryModelRequest, RenderControlReference } from "./payload";
export { replicatePredictionTarget } from "./prediction";
export type { ReplicateImageResult } from "./prediction";
export type { ReplicatePreprocessorRequest } from "./preprocessor";
export type { ProbeResult, ReplicateModelProbe } from "./probe";
export { providerInputViolations, unsentReferenceReports } from "./strict-request";
export type { ProviderInputViolation, UnsentReferenceReport } from "./strict-request";
