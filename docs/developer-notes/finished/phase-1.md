# Improvements After Initial Design

## Worls

- When I filled out the Premise and clicked Forge, I got numerous errors on the UI:

```
structured output needed one repair round-trip — regenerate that section or write it manually.
dropped link "North Farmlands" → "West Farmlands": no such location — regenerate that section or write it manually.
dropped link "North Farmlands" → "South Farmlands": no such location — regenerate that section or write it manually.
dropped link "Old Lighthouse Point" → "South Farmlands": no such location — regenerate that section or write it manually.
structured output failed after repair: No object generated: could not parse the response. — regenerate that section or write it manually.
structured output needed one repair round-trip — regenerate that section or write it manually.
structured output needed one repair round-trip — regenerate that section or write it manually.
```

It looks like it was trying to generate the link before it had created one of the two locations. Maybe a better way would be to have it generate all the locations first, and then try to link them? I'm not sure what the structured output needed one repair round-trip errors mean.

- In the Cast tab, adding a cast member brings up a new entry with "Name" as a free text field. There's no way to add a character that was already saved that I can see.
- Same with items, you can manually create new items but you can't import existing ones? The AI also doesn't automatically fill out "With Cast" or "Worn", even when the name, such as "dr. thorne's lab coat" obviously links to a character in the cast tab.
- Clicking new world saves the world but then it erases all the cast and items that the AI had filled out, so if we're going to allow procedurally created cast and items this way, we need a pipeline to actually _generate_ those items when save is clicked. I prefer that, as well as allowing imports of existing items. It should not try to generate existing items.

## New Session

- In the New session screen, it shows two big buttons, Play a character and Observer. There's no visual indication which one is clicked. The selected one should become slightly brighter or otherwise stand out visually in style.
- Because the Worlds Forge doesn't actually create the characters it puts in the cast section and there's no way to include an existing character, the session isn't testable currently because there's never a companion.

## Characters

- Would it be possible to have the AI that builds the character draft from a prompt try to assign default attributes as well? For example, the test character Maya is a Cuban American. It would be interesting if the AI could give her appropriate hair color (a type of brown), skin tone, eye color, height, etc. These would be baseline values and the user could of course override them.
- When the AI creates a character, it assigns a starter outfit. Since none of the items in the outfit exist yet, when you save the character they disappear. How difficult would it be to create a flow that automatically creates new clothing items when a character is saved with an outfit that contains items that don't exist yet? This would be a nice way to quickly populate the clothing item database with items that are actually being used by characters.
- The "Variants" section of the Portrait studio currently shows a 405 error. Is this because there are no variants yet? If so, we need to handle this error so it shows the blank variants section instead of an error message. If not, we need to fix the error so the variants section works as intended.

## Items

### Clothing

- In the coverage section, there are extra spaces between the checkbox and eyes, fingers, and toes. I think this is done to show that eyes are a subset of face and fingers are a subset of hands. I like this, but it needs to be thought about and designed better. The same could be said for the 'head' and 'torso' fields (as well as the others). Everything under 'head' is a subitem and 'head' includes all of them when selected. How could we visually show this without ugly indentation?
- I think we should reintroduce types to clothing which define basic coverage checkboxes. This would not only make creating them quicker for people, but would improve the system mentioned above in which the AI that builds a character and assigns a temporary outfit could easily create new clothing procedurally instead of having to manually fill every field. For example, if the AI determined a medical worker wore "scrubs top" it would be defined as a shirt that covers torso, arms, forearms, and potentilly wrists.

### Object

- We will need more subtypes for objects such as "furniture", "vehicle", "weapon", etc. We should create a list of subtypes we want to support and add them to the database. They will function differently so will need associated backend code and state agent / narrator logic. Vehicles will need to be able to move characters around the world, weapons will need to be able to be used in combat, etc. This is a big task but we should start by creating the list of subtypes and adding them to the database so we can start using them in character outfits and world building.

### Container

- Currently "Capacity Note" is a free text field but we will eventually need a way to quantify a maximum capacity, not just in item count but in item size. For example, a vehicle cannot fit inside a bookcase, and 1,000 books cannot fit either even though they are the right size. We should create a system for categorizing item sizes and item dimensions and then configure containers to have a maximum capacity based on these categories.
  For example: The bookcase could have 4 shelves, each with a maximum dimension of 6 'units' (we can define what a 'unit' is later). It could fit one 6 unit item or 3 2 unit items per shelf. This is just an initial idea and would need to be expanded upon. This would also help us design container inventories to be visual once we move to a more graphical interface.
