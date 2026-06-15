# Attribute mutability and design

Status: **analysis / proposal**

## Design

There is currently some inconsistency in design because the intiial attribute schema was created from inspiration provided by the aionchat repo, which meant the developers were allowed to redesign them a bit, while later actual fields were pulled in directly from that repo.

I prefer the stronger organization and less complicated grouping from reverie, but we do need all of the attributes provided by aionchat. This could require us to refactor our grouping but is undetermined.

## What we're looking for in the end

1. A full anatomical representation of a body. We've started with humanoids but this will extend to nonhumanoid creatures later, so we need to be mindful of that when designing how the fields nest and relate.
2. Body groups that contain attributes which will allow the game to target either the section as a whole or explicit attributes. See how clothing items use Head, face, eyes, etc. as an example of how we started to do this.
   Since the body schema was built a bit haphazardly we missed many groups initially.
3. Species templates will be designed so that creators will choose groups to use and then which attributes in those groups to use.
   As an example, say a succubus character pulls in a humanoid `torso` section. This section could have all sorts of attributes that aren't relevant to succubi such as `exoskeleton`, `tentacles`, etc. (these are just examples for illustration). The `torso` would also have `wings` which would be deactivated on plain human species but we would activate for succubus.
4. We should reduce the number of free-text fields on attributes as much as possible, but we _do_ still want to allow some free text when it is useful (the current hairstyle field is a good example). The reason we want to reduce free-text is so that we can programmatically send prompt hints to the narrator and agents which would be better designed than a player's free text.
5. Attributes themselves should be able to activate and deactivate other attributes when creating a character. For example, setting `gender` to `male` deactivates `vulva`, `vagina`, `breasts`, etc. We may allow players to override this in the future but at this stage, do _not_ allow this. Deactivated fields should not show up at all on the ui. We may still want them in the database with a field like `null` or `this character does not have x because they are male` so if the models _do_ query that attribute, they know not to use it.
6. We prefer the reverie style of writing schemas inline in files that specify the main attribute and its sub-attributes in one clean file. As an example, here is arms.ts:

```typescript
import { defineAttributeGroup } from "../types";

export const armsGroup = defineAttributeGroup("arms", [
  {
    id: "arms.build",
    label: "Arm build",
    kind: "physical",
    category: "arms",
    valueType: "enum",
    description: "Arm build and definition.",
    mutability: "mutable",
    allowedValues: [
      "slender",
      "wiry",
      "soft",
      "toned",
      "sinewy",
      "muscular",
      "heavy",
    ],
    bodyLocationId: "arms",
    aliases: ["arms", "arm build"],
  },
  {
    id: "arms.hair",
    label: "Arm hair",
    kind: "physical",
    category: "arms",
    valueType: "enum",
    description: "Arm hair density.",
    mutability: "mutable",
    allowedValues: ["none", "fine", "light", "moderate", "thick"],
    bodyLocationId: "arms",
    aliases: ["arm hair"],
  },
]);
```

7. The current `src/contracts/attributes/groups/` design seems to be a bit incorrect and thus misleading because a lot of those files aren't _groups_ in the sense we wanted to use them. We also have `src/contracts/body/locations/` which also seems poorly designed because these don't seem to be locations or groups explicitly.
   My gut instinct is to rename `groups` to something that more accurately refers to individual body parts and organs, and then use `locations` to refer to groups, where we have `head`, `torso`, `pelvis`, `arms`, `legs`, `feet`, etc.
8. Ignoring these schema level groups, we should also be able to colloquially group attributes for the game to use. For example, a player might say `I look at her face` but face in this context usually would mean `face`, `eyes`, `mouth`, `cheeks`, and `chin` in our game. When a player says that action, the agent responsible for getting attribute data would know that `face` actually means all those fields and would send their values to the narrator instead of just `face`.

## Species Definitions for Agents

Species we define should have an LLM-focused description that helps the character Forge build them and the narrator and agents play as them.
Our species may (and probably will) differ from the understanding of them the LLM has in its training, so we will need to steer it with these descriptions.
As an example: in our lore, mermaids have legs. If we didn't put this in a field the LLM could easily access and understand, images of a character would have a tail, and in narration the character would likely behave as if they had a tail.
Image-wise this would be wired into the character portrait studio as well as the scene generator.
