import { buildRegistry } from "./registry";
import { attributeGroups } from "./categories";

export * from "./category-ids";
export * from "./types";
export * from "./registry";
export * from "./value";
export * from "./shared-values";
export { attributeGroups } from "./categories";

export const attributeRegistry = buildRegistry(attributeGroups);
