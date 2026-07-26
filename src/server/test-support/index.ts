// Test-only support module. Most consumers are `.int.test.ts` suites; the
// simulation authorization seam also reads the explicitly opted-in legacy
// engine fixture so old domain tests can remain unanchored without weakening
// production or ordinary integration behavior. Always import through this barrel
// (eslint.config.mjs no-restricted-imports).
export * from "./int-db";
export * from "./simulation-fixtures";
export * from "./image-fixtures";
