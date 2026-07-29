import { describe, expect, it } from "vitest";
import { chatCapabilitiesForLane, chatCapabilityManifestSchema } from "./chat-capabilities";

describe("chatCapabilitiesForLane", () => {
  it("keeps the legacy transcript controls available", () => {
    const capabilities = chatCapabilitiesForLane(false);
    expect(chatCapabilityManifestSchema.parse(capabilities)).toEqual(capabilities);
    expect(capabilities).toMatchObject({
      version: 1,
      canStop: true,
      canAttachPhotos: true,
      canEditHistory: true,
      canDeleteHistory: true,
      canRerunFromMessage: true,
      canRetakeLatest: true,
      canUseLegacyActionBeats: true,
      canUseWorldActions: false,
    });
  });

  it("advertises only operations the successor lane honors", () => {
    const capabilities = chatCapabilitiesForLane(true);
    expect(chatCapabilityManifestSchema.parse(capabilities)).toEqual(capabilities);
    expect(capabilities).toEqual({
      version: 1,
      canStop: false,
      canAttachPhotos: false,
      canEditHistory: false,
      canDeleteHistory: false,
      canRerunFromMessage: false,
      canRetakeLatest: false,
      canForkFromMessage: false,
      canUseLegacyActionBeats: false,
      canUseWorldActions: true,
    });
  });
});
