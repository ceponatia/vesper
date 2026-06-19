import type { AttributeGroup } from "../types";
import { identityGroup } from "./identity";
import { buildGroup } from "./build";
import { skinGroup } from "./skin";
import { hairGroup } from "./hair";
import { eyesGroup } from "./eyes";
import { faceGroup } from "./face";
import { browsGroup } from "./brows";
import { lipsGroup } from "./lips";
import { teethGroup } from "./teeth";
import { earsGroup } from "./ears";
import { neckGroup } from "./neck";
import { shouldersGroup } from "./shoulders";
import { chestGroup } from "./chest";
import { waistGroup } from "./waist";
import { hipsGroup } from "./hips";
import { armsGroup } from "./arms";
import { handsGroup } from "./hands";
import { legsGroup } from "./legs";
import { feetGroup } from "./feet";
import { voiceGroup } from "./voice";
import { presentationGroup } from "./presentation";
import { movementGroup } from "./movement";
import { intimateGroups } from "./intimate";
import { morphologyGroups } from "./morphology";

/**
 * Central group list — the single registration point for attribute vocabulary.
 * Add a group file in this folder and list it here; the registry derives
 * everything else (docs/contracts/attributes.md §Groups and the central registry).
 */
export const attributeGroups: readonly AttributeGroup[] = [
  identityGroup,
  buildGroup,
  skinGroup,
  hairGroup,
  eyesGroup,
  faceGroup,
  browsGroup,
  lipsGroup,
  teethGroup,
  earsGroup,
  neckGroup,
  shouldersGroup,
  chestGroup,
  waistGroup,
  hipsGroup,
  armsGroup,
  handsGroup,
  legsGroup,
  feetGroup,
  voiceGroup,
  presentationGroup,
  movementGroup,
  ...morphologyGroups,
  ...intimateGroups,
];
