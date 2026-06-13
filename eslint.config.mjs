import { defineConfig, globalIgnores } from "eslint/config";
import nextPlugin from "eslint-config-next";

export default defineConfig([
  globalIgnores([".next/**", "node_modules/**", "drizzle/**"]),
  ...nextPlugin,
]);
