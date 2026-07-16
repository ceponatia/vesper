import { describe, expect, it } from "vitest";
import { emptyCharacterProfile } from "@/contracts/world/profile";
import {
  itemTransferNarrativeCutSchema,
  type ItemTransferNarrativeCut,
} from "@/contracts/simulation/item-transfer";
import { buildCharacterChatPromptForNarrativeCut } from "./world-engine";

describe("buildCharacterChatPromptForNarrativeCut", () => {
  it("adds an immutable authority cut to the existing character-chat narrator", () => {
    const cut: ItemTransferNarrativeCut = itemTransferNarrativeCutSchema.parse({
      id: "cut_gate1",
      semanticHash: "abc12345",
      worldId: "world_gate1",
      branchId: "branch_gate1",
      branchVersion: 1,
      fromSequence: 1,
      throughSequence: 1,
      fromStorySecond: 57_600,
      throughStorySecond: 57_600,
      viewpointActorId: "actor_mara",
      mustEnact: [
        {
          kind: "item_transferred",
          eventId: "event_gate1",
          sequence: 1,
          actorId: "actor_mara",
          actorName: "Mara",
          itemId: "item_ring",
          itemName: "gold ring",
          fromContainerId: "bag_mara",
          fromContainerName: "Mara's bag",
          toContainerId: "table_cafe",
          toContainerName: "the cafe table",
        },
      ],
      perceptibleNow: [],
      allowedTransitions: [],
      forbiddenClaims: [
        { kind: "additional_item_transfer", publicText: "Do not invent another inventory change." },
      ],
      provenance: [{ eventId: "event_gate1", observationId: "observation_gate1" }],
    });

    const prompt = buildCharacterChatPromptForNarrativeCut(
      { name: "Mara", profile: emptyCharacterProfile() },
      cut,
    );

    expect(prompt).toContain("You are Mara");
    expect(prompt).toContain("## Simulation authority — immutable NarrativeCut");
    expect(prompt).toContain("gold ring");
    expect(prompt).toContain("Allowed additional hard transitions: none.");
  });
});
