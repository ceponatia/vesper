// Test-only support module — no production code may import this barrel (the
// authorization seam's legacy-mode read lives in the engine's
// simulation/legacy-test-mode.ts precisely so this stays true; several modules
// here import vitest, which must never enter the production build graph).
// Always import through this barrel (eslint.config.mjs no-restricted-imports).
export * from "./int-db";
export * from "./simulation-fixtures";
export * from "./image-fixtures";
export * from "./symlink-support";
export * from "./auth-mock";
export * from "./route-request";
export * from "./route-assertions";
export * from "./db-fixtures";
export * from "./tmp-data-root";
export * from "./memory-fixtures";
export * from "./png-fixtures";
export * from "./source-scan";
export * from "./sim-harness";
export * from "./sim-seed";
export * from "./sim-events";
export * from "./sim-assertions";
export * from "./sim-rhythms";
export * from "./chat-fixtures";
export * from "./chat-archivist-mock";
export * from "./profile-fixtures";
export * from "./prompt-assertions";
export * from "./sim-chat-fixtures";
export * from "./authoring-fixtures";
export * from "./ai-fixtures";
