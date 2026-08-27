import type { ImageConceptId, ImageProjectionDisposition } from "@vesper/image-core";

/**
 * What every image-eligible source field means to an image, decided once — "all
 * information" means all image-eligible truth.
 *
 * The failure this exists to prevent is quiet and slow: somebody adds a column to
 * `items`, three prompt builders keep working, and nobody notices for months that
 * the new field never reaches a render. Under the old arrangement there was no
 * question anyone could have asked to find out. Here there is one — "what is this
 * field's disposition?" — and a source that gains a field with no answer fails the
 * coverage tripwire rather than silently rendering without it.
 *
 * The negative dispositions are the point as much as the positive ones. Marking a
 * scent `nonvisual` and a category id `nonvisual` are DECISIONS, recorded with
 * their reasons, not a fallback bucket. Anything unlisted is an oversight by
 * definition.
 *
 * This registry does not project anything. It classifies. The projections that
 * read it live beside it and produce facts only for the three dispositions that
 * produce facts at all — which is what makes it structurally impossible for a
 * `restricted` field to reach a prompt.
 */

/** One source field's classification, and why. */
export interface ImageFieldProjection {
  /** The projection that owns the field — matches the digest's `ImageSourceRef.owner`. */
  readonly owner: string;
  /** The field's path within its owner: a column name, or a dotted path into a JSON blob. */
  readonly field: string;
  readonly disposition: ImageProjectionDisposition;
  /** The concept this field becomes, for the three dispositions that produce facts. */
  readonly concept?: ImageConceptId;
  /** Why, in one line. Load-bearing for the negative dispositions especially. */
  readonly note: string;
}

export const IMAGE_ITEM_PROJECTION_OWNER = "item.library";
export const IMAGE_LOCATION_PROJECTION_OWNER = "location.library";

/**
 * `items` and its `definition` blob.
 *
 * The two `nonvisual` calls worth reading twice: `definition.category` is the
 * authoring template an item started from, which the item contract already
 * forbids serializing into prompts, and `definition.sensory.tactile` is a touch
 * note. Texture genuinely does read visually, but "cool to the touch" is not a
 * picture, and promoting the field wholesale would have this projection inventing
 * visual claims out of prose about a different sense. It stays `nonvisual` until
 * an owner splits the field or a trial shows the prose is safe.
 */
const ITEM_FIELDS: readonly ImageFieldProjection[] = [
  { owner: IMAGE_ITEM_PROJECTION_OWNER, field: "name", disposition: "required_visual", concept: "item.identity", note: "what the object IS; a product shot without it has no subject" },
  { owner: IMAGE_ITEM_PROJECTION_OWNER, field: "kind", disposition: "required_visual", concept: "item.presentation", note: "clothing hangs in its own shape naming no support, an object isolated on seamless ground" },
  { owner: IMAGE_ITEM_PROJECTION_OWNER, field: "description", disposition: "optional_visual", concept: "item.form", note: "the authored look, first to go under a budget squeeze" },
  { owner: IMAGE_ITEM_PROJECTION_OWNER, field: "definition.sensory.appearance", disposition: "optional_visual", concept: "item.material", note: "the surface note an author wrote for the eye" },
  { owner: IMAGE_ITEM_PROJECTION_OWNER, field: "definition.color", disposition: "optional_visual", concept: "item.color", note: "shade is prompt-bearing free text; family and accent are filter vocabulary" },
  { owner: IMAGE_ITEM_PROJECTION_OWNER, field: "definition.subtype", disposition: "optional_visual", concept: "item.form", note: "accessory subtype labels are deliberately prompt-bearing, unlike category ids" },
  { owner: IMAGE_ITEM_PROJECTION_OWNER, field: "definition.opacity", disposition: "optional_visual", concept: "item.material", note: "sheer against opaque is a visible material fact" },
  { owner: IMAGE_ITEM_PROJECTION_OWNER, field: "definition.coverage", disposition: "relational", note: "which body locations it covers — a fact about wearing, not about the object alone" },
  { owner: IMAGE_ITEM_PROJECTION_OWNER, field: "definition.layer", disposition: "relational", note: "layering order only means something on a wearer" },
  { owner: IMAGE_ITEM_PROJECTION_OWNER, field: "definition.wearer", disposition: "nonvisual", note: "a wardrobe filter target, not an appearance" },
  { owner: IMAGE_ITEM_PROJECTION_OWNER, field: "definition.category", disposition: "nonvisual", note: "authoring template id; the item contract forbids serializing it into prompts" },
  { owner: IMAGE_ITEM_PROJECTION_OWNER, field: "definition.sensory.scent", disposition: "nonvisual", note: "a picture cannot show a smell" },
  { owner: IMAGE_ITEM_PROJECTION_OWNER, field: "definition.sensory.tactile", disposition: "nonvisual", note: "a touch note; promoting it would invent visual claims from another sense" },
  { owner: IMAGE_ITEM_PROJECTION_OWNER, field: "definition.attentionHint", disposition: "nonvisual", note: "shapes a character's attention, never the object's look" },
  { owner: IMAGE_ITEM_PROJECTION_OWNER, field: "definition.fields", disposition: "nonvisual", note: "kind-specific mechanics — capacity, wearable-container flags" },
  { owner: IMAGE_ITEM_PROJECTION_OWNER, field: "definition.kind", disposition: "nonvisual", note: "the column is authoritative; the blob's copy is authoring residue" },
  { owner: IMAGE_ITEM_PROJECTION_OWNER, field: "definition.name", disposition: "nonvisual", note: "the column is authoritative" },
  { owner: IMAGE_ITEM_PROJECTION_OWNER, field: "definition.description", disposition: "nonvisual", note: "the column is authoritative" },
  { owner: IMAGE_ITEM_PROJECTION_OWNER, field: "definition.tags", disposition: "nonvisual", note: "search and filter vocabulary" },
  { owner: IMAGE_ITEM_PROJECTION_OWNER, field: "tags", disposition: "nonvisual", note: "search and filter vocabulary" },
  { owner: IMAGE_ITEM_PROJECTION_OWNER, field: "imageId", disposition: "reference_only", note: "the render's own output, or a reference — never words" },
  { owner: IMAGE_ITEM_PROJECTION_OWNER, field: "id", disposition: "nonvisual", note: "identifier; travels as provenance, never as prompt text" },
  { owner: IMAGE_ITEM_PROJECTION_OWNER, field: "ownerId", disposition: "restricted", note: "account data; never reaches a provider" },
  { owner: IMAGE_ITEM_PROJECTION_OWNER, field: "visibility", disposition: "nonvisual", note: "a sharing scope" },
  { owner: IMAGE_ITEM_PROJECTION_OWNER, field: "clonedFromId", disposition: "nonvisual", note: "clone provenance" },
  { owner: IMAGE_ITEM_PROJECTION_OWNER, field: "searchEmbedding", disposition: "nonvisual", note: "retrieval vector" },
  { owner: IMAGE_ITEM_PROJECTION_OWNER, field: "embedder", disposition: "nonvisual", note: "retrieval bookkeeping" },
  { owner: IMAGE_ITEM_PROJECTION_OWNER, field: "createdAt", disposition: "nonvisual", note: "bookkeeping" },
  { owner: IMAGE_ITEM_PROJECTION_OWNER, field: "updatedAt", disposition: "nonvisual", note: "bookkeeping — but the read token's revision input" },
];

/**
 * `locations` and its `ambient` blob.
 *
 * `scale` is `required_visual` because it decides the shot: `open` and `expanse`
 * are outdoor establishing views and everything else is an architectural
 * interior. That was already true of the prose builder this replaces; stating it
 * as a required fact is what makes it survive a budget squeeze.
 */
const LOCATION_FIELDS: readonly ImageFieldProjection[] = [
  { owner: IMAGE_LOCATION_PROJECTION_OWNER, field: "name", disposition: "required_visual", concept: "location.identity", note: "what the place IS" },
  { owner: IMAGE_LOCATION_PROJECTION_OWNER, field: "scale", disposition: "required_visual", concept: "location.presentation", note: "open and expanse are outdoor views; every other scale is an interior" },
  { owner: IMAGE_LOCATION_PROJECTION_OWNER, field: "description", disposition: "optional_visual", concept: "location.contents", note: "the authored look of the space" },
  { owner: IMAGE_LOCATION_PROJECTION_OWNER, field: "ambient.light", disposition: "optional_visual", concept: "location.lighting", note: "the only ambient channel a picture can carry" },
  { owner: IMAGE_LOCATION_PROJECTION_OWNER, field: "ambient.scent", disposition: "nonvisual", note: "a picture cannot show a smell" },
  { owner: IMAGE_LOCATION_PROJECTION_OWNER, field: "ambient.sound", disposition: "nonvisual", note: "a picture cannot show a sound" },
  { owner: IMAGE_LOCATION_PROJECTION_OWNER, field: "affordances", disposition: "relational", note: "what characters can do here, not what the room looks like" },
  { owner: IMAGE_LOCATION_PROJECTION_OWNER, field: "area", disposition: "nonvisual", note: "a map-grouping label driving travel times" },
  { owner: IMAGE_LOCATION_PROJECTION_OWNER, field: "tags", disposition: "nonvisual", note: "search and filter vocabulary" },
  { owner: IMAGE_LOCATION_PROJECTION_OWNER, field: "imageId", disposition: "reference_only", note: "the render's own output, or a reference — never words" },
  { owner: IMAGE_LOCATION_PROJECTION_OWNER, field: "id", disposition: "nonvisual", note: "identifier; travels as provenance, never as prompt text" },
  { owner: IMAGE_LOCATION_PROJECTION_OWNER, field: "ownerId", disposition: "restricted", note: "account data; never reaches a provider" },
  { owner: IMAGE_LOCATION_PROJECTION_OWNER, field: "visibility", disposition: "nonvisual", note: "a sharing scope" },
  { owner: IMAGE_LOCATION_PROJECTION_OWNER, field: "clonedFromId", disposition: "nonvisual", note: "clone provenance" },
  { owner: IMAGE_LOCATION_PROJECTION_OWNER, field: "searchEmbedding", disposition: "nonvisual", note: "retrieval vector" },
  { owner: IMAGE_LOCATION_PROJECTION_OWNER, field: "embedder", disposition: "nonvisual", note: "retrieval bookkeeping" },
  { owner: IMAGE_LOCATION_PROJECTION_OWNER, field: "createdAt", disposition: "nonvisual", note: "bookkeeping" },
  { owner: IMAGE_LOCATION_PROJECTION_OWNER, field: "updatedAt", disposition: "nonvisual", note: "bookkeeping — but the read token's revision input" },
];

/** Every classified field, across every projection this registry covers. */
export const imageFieldProjections: readonly ImageFieldProjection[] = [...ITEM_FIELDS, ...LOCATION_FIELDS];

const byOwnerField = new Map<string, ImageFieldProjection>(
  imageFieldProjections.map((entry) => [`${entry.owner}::${entry.field}`, entry]),
);

/** One field's classification, or null when nobody has decided about it. */
export function imageFieldProjection(owner: string, field: string): ImageFieldProjection | null {
  return byOwnerField.get(`${owner}::${field}`) ?? null;
}

/**
 * The fields of one owner that this registry has not classified.
 *
 * The coverage tripwire's whole implementation: hand it the field names an owner
 * actually has — derived from the table columns and the definition schema, never
 * hand-listed — and anything it returns is a decision nobody has made.
 *
 * A CONTAINER counts as classified when its members are. `definition.sensory`
 * holds one visual member and two non-visual ones, so classifying the blob as a
 * whole would have to pick one answer for all three; classifying the leaves and
 * treating the container as covered is both more precise and self-maintaining —
 * adding a fourth sensory member still fails this check.
 */
export function unclassifiedImageFields(owner: string, fields: readonly string[]): readonly string[] {
  const classified = imageFieldProjections.filter((entry) => entry.owner === owner);
  return fields
    .filter(
      (field) =>
        imageFieldProjection(owner, field) === null &&
        !classified.some((entry) => entry.field.startsWith(`${field}.`)),
    )
    .sort();
}
