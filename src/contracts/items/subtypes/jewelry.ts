import type { ClothingSubtype } from "./types";

/**
 * Jewelry subtypes (category `jewelry`). Face piercings anchor to the `lips` /
 * `nose` body locations so image prompts can place them precisely; the
 * piercing HOLES are attributes (`lips.piercings`, `nose.piercings`,
 * `ears.piercings`) — the jewelry worn in them lives here.
 */
export const jewelrySubtypes: readonly ClothingSubtype[] = [
  { id: "earring", label: "Earring", coverage: ["ears"] },
  { id: "nose_ring", label: "Nose ring", coverage: ["nose"] },
  { id: "nose_stud", label: "Nose stud", coverage: ["nose"] },
  { id: "septum_ring", label: "Septum ring", coverage: ["nose"] },
  { id: "lip_ring", label: "Lip ring", coverage: ["lips"] },
  { id: "lip_stud", label: "Lip stud", coverage: ["lips"] },
  { id: "eyebrow_ring", label: "Eyebrow ring", coverage: ["face"] },
  { id: "necklace", label: "Necklace", coverage: ["neck"] },
  { id: "choker", label: "Choker", coverage: ["neck"] },
  { id: "bracelet", label: "Bracelet", coverage: ["wrists"] },
  { id: "ring", label: "Ring", coverage: ["fingers"] },
  { id: "anklet", label: "Anklet", coverage: ["ankles"] },
  { id: "belly_ring", label: "Belly ring", coverage: ["waist"] },
  { id: "brooch", label: "Brooch" }, // pins to clothing — no body coverage
];
