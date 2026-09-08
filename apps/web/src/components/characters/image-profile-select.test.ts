import { describe, expect, it } from "vitest";
import type { ImageProfileOption } from "@/lib/client/api";
import { resolveProfileSelection } from "./image-profile-select";

const option = (overrides: Partial<ImageProfileOption> = {}): ImageProfileOption => ({
  id: "profile-default",
  label: "Portrait Standard",
  task: "portrait",
  isDefault: true,
  modelId: "model-default",
  modelLabel: "Default Model",
  tier: "standard",
  purpose: "Create the character's main portrait.",
  tradeoff: "Balances detail and wait time.",
  operatorWarning: null,
  ...overrides,
});

describe("image profile selection disclosure", () => {
  const profiles = [option(), option({ id: "profile-fast", label: "Portrait Fast", isDefault: false, tier: "fast" })];

  it("resolves Task default to the actual profile and model", () => {
    expect(resolveProfileSelection("", profiles)).toMatchObject({
      displayedId: "",
      profile: { id: "profile-default", modelId: "model-default" },
      substituted: false,
    });
  });

  it("shows an unavailable saved pick as an honest default substitution", () => {
    expect(resolveProfileSelection("deleted-profile", profiles)).toMatchObject({
      displayedId: "",
      profile: { id: "profile-default" },
      substituted: true,
    });
  });

  it("maps a legacy model id to that model's offered profile", () => {
    expect(resolveProfileSelection("model-default", profiles)).toMatchObject({
      displayedId: "profile-default",
      profile: { id: "profile-default" },
      substituted: false,
    });
  });
});
