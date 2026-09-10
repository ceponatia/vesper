import { defineAttributeGroup } from "../types";

export const browsGroup = defineAttributeGroup("brows", [
  {
    id: "brows.shape",
    label: "Brow shape",
    kind: "physical",
    category: "brows",
    valueType: "enum",
    description: "Eyebrow shape.",
    mutability: "inherent",
    renderVisual: true,
    allowedValues: ["straight", "softly_arched", "arched", "high_arch", "angled", "rounded", "flat"],
    bodyLocationId: "face",
    aliases: ["eyebrows", "brow shape"],
    imageAppearance: { class: "reinforcement", maximumFraming: "portrait" },
  },
  {
    id: "brows.thickness",
    label: "Brow thickness",
    kind: "physical",
    category: "brows",
    valueType: "enum",
    description: "Eyebrow density; grooming can change it.",
    mutability: "mutable",
    renderVisual: true,
    allowedValues: ["sparse", "thin", "medium", "full", "thick", "bushy"],
    bodyLocationId: "face",
    aliases: ["brow thickness", "bushy brows"],
    // Tighter than brow SHAPE on purpose (#544 D7): an arch reads at portrait
    // distance, brow density does not — at anything wider it is a word the
    // model spends on a few pixels. `maximumFraming` is the widest band an
    // `imageAppearance` fact still contributes at, so `close_up` is what drops
    // it from portrait, waist-up and wider shots.
    imageAppearance: { class: "reinforcement", maximumFraming: "close_up" },
  },
]);
