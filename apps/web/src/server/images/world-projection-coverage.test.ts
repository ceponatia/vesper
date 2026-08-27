import { getTableColumns } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { ambientSchema } from "@/contracts/world/location";
import { itemDefinitionSchema, itemSensorySchema } from "@/contracts/items/item";
import {
  IMAGE_ITEM_PROJECTION_OWNER,
  IMAGE_LOCATION_PROJECTION_OWNER,
  unclassifiedImageFields,
} from "@/contracts/images/world-projection";
import { items, locations } from "../db/schema";

/**
 * The projection-coverage tripwire: "all information" means all image-eligible
 * truth, so CI must fail when a new
 * image-relevant contract member has no projection decision.
 *
 * This is the one guarantee that a new world field cannot vanish from every
 * render in silence. Before it, adding a column to `items` was invisible to the
 * prompt path — three builders kept working, no test failed, and the field simply
 * never appeared in an image. There was no question anyone could have asked.
 *
 * The failure this kills is therefore an OMISSION, which is why the field list is
 * derived from the table and the schema rather than typed out here. A hand-listed
 * expectation would be the same oversight wearing a test's clothes: the developer
 * who forgot to classify the column would forget to add it to the list too.
 *
 * Pure despite reaching into `db/schema`: Drizzle table definitions are plain
 * objects, and `getTableColumns` reads metadata. No connection is opened.
 */

/**
 * `definition.sensory` is expanded because its three members have different
 * answers — one is visual and two are not — so the registry classifies the
 * leaves. Every other blob member is classified whole, and
 * `unclassifiedImageFields` treats a container as covered once its members are.
 */
const itemFields = [
  ...Object.keys(getTableColumns(items)),
  ...Object.keys(itemDefinitionSchema.shape).map((key) => `definition.${key}`),
  ...Object.keys(itemSensorySchema.shape).map((key) => `definition.sensory.${key}`),
];

const locationFields = [
  ...Object.keys(getTableColumns(locations)),
  ...Object.keys(ambientSchema.shape).map((key) => `ambient.${key}`),
];

describe("every image-eligible source field carries a projection decision", () => {
  it.each([
    { owner: IMAGE_ITEM_PROJECTION_OWNER, fields: itemFields },
    { owner: IMAGE_LOCATION_PROJECTION_OWNER, fields: locationFields },
  ])("$owner", ({ owner, fields }) => {
    // A non-empty result names exactly the fields somebody has to decide about.
    // `nonvisual` and `restricted` are perfectly good answers — the registry only
    // insists that an answer exists.
    expect(unclassifiedImageFields(owner, fields)).toEqual([]);
  });
});
