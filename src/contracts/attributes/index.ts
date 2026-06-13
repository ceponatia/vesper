import { buildRegistry } from "./registry";
import { attributeGroups } from "./groups";

export * from "./categories";
export * from "./types";
export * from "./registry";
export * from "./value";
export { attributeGroups } from "./groups";

export const attributeRegistry = buildRegistry(attributeGroups);
