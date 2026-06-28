import { traitDefinitions } from "./definitions";
import { buildTraitRegistry } from "./registry";

export * from "./category-ids";
export * from "./types";
export * from "./value";
export * from "./registry";
export * from "./disposition";
export { traitDefinitions } from "./definitions";

/** The live personality trait registry (the starter vocabulary). */
export const traitRegistry = buildTraitRegistry(traitDefinitions);
