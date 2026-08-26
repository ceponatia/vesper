import { defineSpecies } from "../types";
import { DEFAULT_BODY_PLAN_ID } from "../../body/plans";
import { organicHumanoidSensoryRules } from "./humanoid-sensory";

export const faerie = defineSpecies({
  id: "faerie",
  label: "Faerie",
  aliases: ["faeries", "faery", "fae", "fairy", "fairies", "fair folk"],
  bodyPlanId: DEFAULT_BODY_PLAN_ID,
  description:
    "A humanoid fantasy species whose default morphology includes wings. These are defaults, not hard requirements; bodyFeatures may override them per character.",
  appearance:
    "Small and delicate, roughly the height of an adolescent human, with brightly colored, delicate wings and a nimble, weightless grace.",
  lore: "Faerie is the root species designation for a variety of winged humanoids. Pixies, Sprites, and True Faeries differ wildly in appearance and personality. Faeries themselves have brightly colored butterfly-like wings and are roughly the height of an adolescent human. They are nimble and lithe, with hollow bones that make them light as a feather. Even with their light weight, flight would ordinarily be impossible, but this is augmented by an inborn magical aura that allows them to be light as air when in flight.",
  intimacy:
    "Ethereal and weightless about it — a faerie takes to intimacy the way she takes to flight, playful and unhurried, delighting in touch for its own sake more than any destination.",
  defaultFeatureGroups: ["wings"],
  attributeRules: [
    ...organicHumanoidSensoryRules,
    // The species' signature wing shape, carried structurally so a heritage
    // (e.g. Sprite) can override it without the prose contradicting the image.
    // Locked to its one value — butterfly wings are faerie-specific.
    {
      attributeId: "wings.shape",
      applicability: "required",
      defaultValue: "butterfly",
      allowedValues: ["butterfly"],
    },
  ],
  heritages: [
    {
      id: "sprite",
      label: "Sprite",
      aliases: ["sprites"],
      appearance:
        "Slightly smaller than a true faerie, with bright, mischievous eyes and a wiry, restless frame.",
      lore: "Sprites are the mischievous, more feral offshoot of the Faerie species. They prefer the outdoors, dislike wearing shoes, and are known for getting into trouble and pulling pranks. They're a little smaller than true Faeries and have pointed ears.",
      // The originating example for the species/heritage `intimacy` note (narrator-only,
      // surfaced at the intimate exposure tier).
      // Replaces the faerie species note for sprite characters (heritage-replaces-species).
      intimacy:
        "Mischievous and devious by nature; those who enjoy sass and very animated, playful lovemaking find this makes them exciting, unpredictable lovers.",
      attributeRules: [
        // Heritage-only rule (the faerie species sets no ears rule): sprites are
        // marked by their points.
        {
          attributeId: "ears.shape",
          applicability: "required",
          defaultValue: "pointed",
          allowedValues: ["pointed", "long_pointed"],
          notes: "Sprites are identifiable by their pointed ears.",
        },
        // Heritage-only rule — the outdoor tan the base species never constrains.
        // defaultValue must be one of allowedValues.
        {
          attributeId: "skin.tone",
          applicability: "optional",
          defaultValue: "tan",
          allowedValues: ["tan", "light_olive", "olive", "bronze"],
          notes:
            "Sprites spend a great deal of time outdoors and are naturally darker-skinned than Faeries.",
        },
        // Overrides the faerie species wing shape (butterfly → dragonfly) and
        // carries the sprite's red wing colour, so the look reaches the image
        // model structurally instead of via contradictory appearance prose.
        // Locked to its one value — dragonfly wings are sprite-specific.
        {
          attributeId: "wings.shape",
          applicability: "required",
          defaultValue: "dragonfly",
          allowedValues: ["dragonfly"],
          notes: "Dragonfly-like — sheerer and sharper than a faerie's.",
        },
        {
          attributeId: "wings.color",
          applicability: "optional",
          // enum_list over the shared MATERIAL_COLORS palette — sprites read red-winged.
          defaultValue: ["crimson"],
        },
      ],
    },
  ],
});
