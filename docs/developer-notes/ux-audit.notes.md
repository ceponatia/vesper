# UX-Audit Notes

1. We need more fields on the world forge intake page. Currently it is just a prompt box to describe the world. Adding a few more fields will help the agents and users.

- Player: have the player choose the character they want to play as in this world up front. If they leave it blank it will default to observer mode. This can be changed after the world is generated, but the benefit of defining this field in the world is that we can fill in the {{player}} placeholder text (a bug that was identified in the ux-audit in P2).
  - This coincides with the note in section 6 of `ux-audit.intake.md`: Player character setup in the session wizard. Building a new player character should also be an option. Slight amendment, unembodied players do not need a persona they are an observer who only adds narrative direction to the world. We should allow the generation of embodied players this way too though.
- Number of Locations / Number of Characters: A dropdown list from 0-5 for each (for now) that tells the forge how many of each to auto-generate. We want to allow 0 because players may want to import a full set of existing locations.
