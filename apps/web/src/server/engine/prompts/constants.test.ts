import { afterEach, describe, expect, it } from "vitest";
import {
  chatContactActionsEnabled,
  chatNpcSceneDecisionsEnabled,
  chatPhysicalConstraintsEnabled,
  chatRomanticPermissionDevOverrideEnabled,
  chatRomanticPermissionEnabled,
  chatVisualStateShadowEnabled,
} from "./constants";

const FLAGS = [
  "CHAT_CONTACT_ACTIONS",
  "CHAT_PHYSICAL_CONSTRAINTS",
  "CHAT_ROMANTIC_PERMISSION",
  "CHAT_ROMANTIC_PERMISSION_DEV_OVERRIDE",
  "CHAT_NPC_SCENE_DECISIONS",
] as const;
const COMPOSED = ["CHAT_ROMANTIC_PERMISSION", "CHAT_CONTACT_ACTIONS", "CHAT_PHYSICAL_CONSTRAINTS"] as const;

function setFlags(enabled: readonly (typeof FLAGS)[number][]): void {
  for (const flag of FLAGS) delete process.env[flag];
  for (const flag of enabled) process.env[flag] = "on";
}

afterEach(() => setFlags([]));

/**
 * FLAG COMPOSITION — authority composes only with the lane whose state it owns.
 *
 * Permission decisions and revocations remain authoritative whenever the
 * permission owner and contact lane are on. Mandatory stop transitions use the
 * shared guidance renderer even when the optional general-constraints
 * experiment is off.
 */
describe("the romantic-permission owner composes over the contact lane", () => {
  it("stays authoritative when the optional constraints experiment is off", () => {
    setFlags(["CHAT_ROMANTIC_PERMISSION", "CHAT_CONTACT_ACTIONS"]);
    expect(chatContactActionsEnabled()).toBe(true);
    expect(chatPhysicalConstraintsEnabled()).toBe(false);
    expect(chatRomanticPermissionEnabled()).toBe(true);
  });

  it("also remains on when the constraints block is enabled", () => {
    setFlags(COMPOSED);
    expect(chatRomanticPermissionEnabled()).toBe(true);
  });

  it("is OFF with the contact lane off — permission answers are contact-lane authority", () => {
    setFlags(["CHAT_ROMANTIC_PERMISSION", "CHAT_PHYSICAL_CONSTRAINTS"]);
    expect(chatRomanticPermissionEnabled()).toBe(false);
  });

  it("is OFF on its own, and on anything other than the literal `on`", () => {
    setFlags(["CHAT_CONTACT_ACTIONS", "CHAT_PHYSICAL_CONSTRAINTS"]);
    expect(chatRomanticPermissionEnabled()).toBe(false);
    process.env.CHAT_ROMANTIC_PERMISSION = "true";
    expect(chatRomanticPermissionEnabled()).toBe(false);
    process.env.CHAT_ROMANTIC_PERMISSION = "on";
    expect(chatRomanticPermissionEnabled()).toBe(true);
  });

  it("never composes the developer override — fixtures are seeded before the feature runs", () => {
    // Deliberately independent: the override is how permission state is seeded
    // BEFORE the runtime flag goes on, so gating it on the runtime read would
    // make "seed the fixture, then enable the feature" impossible.
    setFlags([]);
    process.env.CHAT_ROMANTIC_PERMISSION_DEV_OVERRIDE = "on";
    expect(chatRomanticPermissionEnabled()).toBe(false);
    expect(chatRomanticPermissionDevOverrideEnabled()).toBe(true);
    delete process.env.CHAT_ROMANTIC_PERMISSION_DEV_OVERRIDE;
  });

  it("leaves the sibling composed flag alone — the constraints block is not its business", () => {
    // `CHAT_NPC_SCENE_DECISIONS` composes over the contact lane only: its
    // decisions change state, and none of them owes the narrator a mandatory
    // line, so it must not have picked up this flag's extra composition.
    setFlags(["CHAT_CONTACT_ACTIONS"]);
    process.env.CHAT_NPC_SCENE_DECISIONS = "on";
    expect(chatNpcSceneDecisionsEnabled()).toBe(true);
    delete process.env.CHAT_NPC_SCENE_DECISIONS;
  });
});

/**
 * The visual-state shadow (visual-state.plan.md slice 6) defaults OFF: with the
 * env unset — the deployed default — production behavior is untouched to the
 * byte, which is the plan's own success criterion.
 */
describe("the visual-state shadow flag", () => {
  it("is OFF by default, and on anything other than the literal `on`", () => {
    delete process.env.CHAT_VISUAL_STATE_SHADOW;
    expect(chatVisualStateShadowEnabled()).toBe(false);
    process.env.CHAT_VISUAL_STATE_SHADOW = "true";
    expect(chatVisualStateShadowEnabled()).toBe(false);
    process.env.CHAT_VISUAL_STATE_SHADOW = "on";
    expect(chatVisualStateShadowEnabled()).toBe(true);
    delete process.env.CHAT_VISUAL_STATE_SHADOW;
  });
});
