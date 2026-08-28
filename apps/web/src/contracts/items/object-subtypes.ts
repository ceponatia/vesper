/**
 * Object subtypes (docs/contracts/items/README.md §Object subtypes):
 * vocabulary for kind="object" items. This is the extension point for subtype behavior —
 * vehicles moving characters, weapons in combat — each of which gets its own
 * design doc before any engine code. For now the only capability is
 * `holdable`.
 *
 * `holdable` means the item CAN be held in a hand (umbrella, TV remote, mug).
 * It is a capability, never a slot binding: where a holdable item currently
 * sits — a character's hand, a container, a location — is session state, so
 * holdables stay container-storable by construction.
 */
export interface ObjectSubtype {
  id: string;
  label: string;
  holdable: boolean;
}

export const objectSubtypes: readonly ObjectSubtype[] = [
  { id: "furniture", label: "Furniture", holdable: false },
  { id: "vehicle", label: "Vehicle", holdable: false },
  { id: "weapon", label: "Weapon", holdable: true },
  { id: "tool", label: "Tool", holdable: true },
  { id: "device", label: "Device", holdable: true },
  { id: "book", label: "Book", holdable: true },
  { id: "food", label: "Food", holdable: true },
  { id: "beverage", label: "Beverage", holdable: true },
  { id: "decoration", label: "Decoration", holdable: false },
  { id: "instrument", label: "Instrument", holdable: true },
];

const byId = new Map(objectSubtypes.map((s) => [s.id, s]));

export function objectSubtypeById(id: string): ObjectSubtype | undefined {
  return byId.get(id.trim().toLowerCase());
}

export const objectSubtypeIds = objectSubtypes.map((s) => s.id);
