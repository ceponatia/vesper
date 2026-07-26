// Test-only support module. Imported exclusively by `.int.test.ts` suites, and
// through this barrel — route-tree suites (src/app/api/**) may only reach a
// server module at `@/server/<module>` (eslint.config.mjs no-restricted-imports).
export * from "./int-db";
