import type { AttributeGroup } from "../../types";
import { hornsGroup } from "./horns";
import { tailGroup } from "./tail";
import { wingsGroup } from "./wings";

/**
 * Visible non-human morphology. These are SFW appearance attributes, but they
 * are gated by bodyFeatures via their feature body locations.
 */
export const morphologyGroups: readonly AttributeGroup[] = [hornsGroup, wingsGroup, tailGroup];
