import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import type { ChatArchivist, ChatPersonalNotes } from "@/contracts/turns/chat-archivist";
import { characterProfileSchema } from "@/contracts/world/profile";
import { characters, chatParticipants, db } from "@/server/db";
import { newId } from "@/lib/ids";

/**
 * The SETTLE half of design #298: `settleChatTurnMembers` (chat-turn-settle.ts)
 * is where a present member's `finalized.ensembleWardrobe` projection actually
 * lands on their PERSISTED `worn_item_ids`, and where their personal pass's own
 * free-text outfit fold is (or is not) skipped. `chat-garment-ops.int.test.ts`
 * proves the shared continuity leg's half of the design (the store, the
 * enumerated handles, `outcome.ensembleWardrobe`) by calling `finalizeChatState`
 * directly; this file proves the OTHER half by driving the real settle path —
 * a full `submitChatMessage` exchange with a second, present roster member —
 * because that is the only place `settleChatTurnMembers` runs.
 */

const mock = vi.hoisted(() => ({ archivist: { value: null as ChatArchivist | null, degraded: false } }));
const personalNotes = vi.hoisted(() => ({ value: null as ChatPersonalNotes | null }));
const scripted = vi.hoisted(() => ({ reply: "" }));

vi.mock("./chat-memory", async () => {
  const { chatMemoryMockModule } = await import("../test-support/chat-archivist-mock");
  return {
    ...chatMemoryMockModule(mock),
    // The member settle's personal pass, under this suite's own control —
    // `chatMemoryMockModule` never stubs it (a suite that needs one says so).
    runChatPersonalNotes: () =>
      Promise.resolve(
        personalNotes.value ? { value: personalNotes.value, degraded: false } : { value: null, degraded: false },
      ),
  };
});

vi.mock("./character-chat", async () => {
  const actual = await vi.importActual<typeof import("./character-chat")>("./character-chat");
  return {
    ...actual,
    streamCharacterChat: () =>
      (async function* () {
        yield scripted.reply;
      })(),
  };
});

import { submitChatMessage } from "@/server/engine";
import { editChatState } from "./chat-state/edit";
import { loadChatState } from "./chat-state/store";
import {
  dropChatFixture,
  emptyChatFixture,
  GARMENT_SEEDS,
  itemId,
  newChat,
  probeIntegrationDb,
  seedChatFixture,
  withOps,
  type ChatFixture,
} from "@/server/test-support";

const ready = await probeIntegrationDb("chat-turn-settle.int.test", "character_chat_state");

let fixture: ChatFixture = emptyChatFixture();

beforeAll(async () => {
  if (!ready) return;
  fixture = await seedChatFixture({
    slug: "chat-turn-settle-int",
    userName: "Turn Settle Int",
    garments: [GARMENT_SEEDS.cottonShirt, GARMENT_SEEDS.denimJacket],
  });
});

afterAll(async () => {
  await dropChatFixture(fixture);
});

const shirtDef = () => itemId(fixture, "cottonShirt");
const jacketDef = () => itemId(fixture, "denimJacket");

describe.runIf(ready)("settleChatTurnMembers threads the shared lane onto a present member (design #298)", () => {
  it("the typed-op projection lands on the member's persisted worn_item_ids, and their own personal-pass outfit fold is skipped", async () => {
    const chat = await newChat(fixture);

    // A second, real seat in the same conversation (items are owner-scoped —
    // Mara can wear the same library garments Wren's fixture already owns).
    const [second] = await db()
      .insert(characters)
      .values({ ownerId: fixture.userId, name: "Mara", profile: {} })
      .returning({ id: characters.id });
    if (!second) throw new Error("failed to create second character");
    const memberId = second.id;
    const memberMemoryGroupId = newId();
    await db()
      .insert(chatParticipants)
      .values({ chatId: chat.chatId, characterId: memberId, memoryGroupId: memberMemoryGroupId, sort: 1 });

    // An authored preset ("Cozy") on Mara's profile — the personal pass's
    // free-text rung will name it, which (if NOT neutralized) reaches rung 1
    // unconditionally: no evidence gate to second-guess, so a wrongly-folded
    // proposal is unambiguous rather than depending on the change-evidence
    // classifier's exact behavior.
    const maraProfile = { outfits: [{ id: "cozy", name: "Cozy", items: [jacketDef()] }] };

    // Mara starts dressed and MODELLED in two garments — the jacket the typed
    // op below will move, and the shirt that must survive untouched.
    //
    // `editChatState` seeds a missing row with `seedChatState(profile)` first,
    // which sets `outfitPresetId` to the profile's DEFAULT preset ("cozy",
    // outfits[0]) before the patch below even applies — an unset
    // `outfitPresetId` here would already read "cozy" whether or not the
    // personal pass's preset proposal ever folds, so the patch explicitly
    // clears it to make the later assertion discriminate the two outcomes.
    await editChatState({
      chatId: chat.chatId,
      characterId: memberId,
      ownerId: fixture.userId,
      profile: characterProfileSchema.parse(maraProfile),
      patch: { wornItemIds: [jacketDef(), shirtDef()], outfitPresetId: "", mindNote: "start" },
    });

    // The shared continuity leg proposes a typed op over Mara's ENUMERATED
    // handle (moving her jacket off her worn set). Her own personal pass ALSO
    // proposes a whole-look preset swap — which must NOT land, because the
    // typed lane already enumerated her this exchange.
    mock.archivist = { value: withOps([{ op: "move", garment: "mara.jacket", to: "held" }]), degraded: false };
    personalNotes.value = {
      openLoops: [],
      attributeChanges: [],
      driveUpdates: [],
      outfit: { description: "Cozy", changeEvidence: "", exposed: false, removed: [], added: [] },
    };
    scripted.reply = "She glances at you and says nothing.";

    const sink = new DiagnosticCollector();
    const result = await submitChatMessage({
      chatId: chat.chatId,
      memoryGroupId: chat.memoryGroupId,
      character: { id: fixture.characterId, name: fixture.characterName, profile: fixture.profile },
      roster: [
        {
          characterId: fixture.characterId,
          memoryGroupId: chat.memoryGroupId,
          name: fixture.characterName,
          profile: fixture.profile,
        },
        { characterId: memberId, memoryGroupId: memberMemoryGroupId, name: "Mara", profile: maraProfile },
      ],
      kind: "send",
      content: "I look around the room.",
      sink,
    });
    if (!result.ok) throw new Error(`exchange rejected: ${result.code}`);
    // Draining is what settles the exchange — settleChatTurnMembers included.
    for await (const chunk of result.stream) void chunk;

    const memberState = await loadChatState(chat.chatId, memberId, sink);
    if (!memberState) throw new Error("member state missing after settle");

    // The typed op's projection landed on the PERSISTED row: the jacket moved
    // to held, so only the shirt remains worn — NOT the preset's `[jacket]`,
    // which is what an unneutralized personal pass would have written instead.
    expect(memberState.wornItemIds).toEqual([shirtDef()]);
    // The personal pass's own preset proposal never folded.
    expect(memberState.outfitPresetId).toBe("");

    expect(
      sink.items.some((d) => d.code === "chat_garments.ensemble_outfit_typed_lane" && d.message.includes("Mara")),
    ).toBe(true);
  });
});
