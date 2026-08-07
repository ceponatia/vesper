import {
  buildGarmentHandleTable,
  characterProfileSchema,
  emptyChatSceneMemory,
  type ChatGarmentStore,
  type GarmentHandleTable,
  type GarmentOperationProposal,
} from "@/contracts";
import {
  buildCharacterChatSystemPrompt,
  buildChatGarmentNarration,
  chatGarmentNarrationActors,
  narrationShapeId,
  type CharacterChatPromptInput,
} from "@/server/engine";
import type { NarratorComparisonTurn } from "../narrator-comparison/harness";
import {
  CHARACTER_ACTOR,
  CHARACTER_ID,
  CHARACTER_NAME,
  GARMENT_EXTRACTION_FIXTURES,
  GARMENT_NARRATOR_FIXTURES,
  PLAYER_NAME,
  type GarmentExtractionExpectation,
  type GarmentExtractionFixture,
  type GarmentNarratorFixture,
} from "./fixtures";

export type GarmentArm = "garment" | "control";

export interface PlannedGarmentTurn extends NarratorComparisonTurn<GarmentArm> {
  id: string;
  digest: string;
  cues: readonly string[];
  groundTruth: string;
  expectedDigest: readonly string[];
  expectedCues: readonly string[];
}

export interface PlannedGarmentScenario {
  fixture: GarmentNarratorFixture;
  characterName: string;
  turns: PlannedGarmentTurn[];
}

const PROFILE = characterProfileSchema.parse({
  bio: "Wren restores old books and tends to turn practical tasks into quiet competitions.",
  attributes: [
    { id: "identity.gender", value: "female", source: "creation" },
    { id: "identity.apparent_age", value: 31, source: "creation" },
    { id: "hair.color", value: "dark_brown", source: "creation" },
  ],
});

const PLAYER_PERSONA = "A bookbinder helping Wren finish the day's work.";

function storyMoment(minutes: number): string {
  const normalized = ((minutes % 1_440) + 1_440) % 1_440;
  const hour24 = Math.floor(normalized / 60);
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  const suffix = hour24 < 12 ? "am" : "pm";
  const band = hour24 < 5 ? "night" : hour24 < 12 ? "morning" : hour24 < 17 ? "afternoon" : hour24 < 22 ? "evening" : "night";
  return `${hour12}:${String(normalized % 60).padStart(2, "0")}${suffix} (${band})`;
}

function sceneMemory(fixture: GarmentNarratorFixture) {
  return {
    ...emptyChatSceneMemory(),
    current: fixture.place,
    places: [{ name: fixture.place, details: [fixture.placeDetail], connections: [] }],
  };
}

function promptFor(input: {
  fixture: GarmentNarratorFixture;
  turnIndex: number;
  legacyOutfit: string;
  atMinutes: number;
  digest?: string;
  cues?: readonly string[];
}): string {
  const state: NonNullable<CharacterChatPromptInput["state"]> = {
    meters: {},
    regard: 6_400,
    familiarity: 6_000,
    conditions: [],
    premise: input.fixture.premise,
    outfit: input.legacyOutfit,
    outfitExposed: false,
    sceneMemory: sceneMemory(input.fixture),
    storyMoment: storyMoment(input.atMinutes),
    ...(input.digest ? { garmentDigest: input.digest } : {}),
    ...(input.cues && input.cues.length > 0 ? { garmentCues: [...input.cues] } : {}),
  };
  return buildCharacterChatSystemPrompt({
    name: CHARACTER_NAME,
    profile: PROFILE,
    player: { name: PLAYER_NAME, persona: PLAYER_PERSONA },
    state,
    narrationShape: narrationShapeId("chat"),
    firstExchange: input.turnIndex === 0,
  });
}

function groundTruth(fixture: GarmentNarratorFixture, turnIndex: number, digest: string): string {
  const turn = fixture.turns[turnIndex];
  if (!turn) return "";
  return [
    `Scene: ${fixture.place}.`,
    "Authoritative wardrobe digest:",
    digest,
    "",
    "Facts the reply must not contradict:",
    ...turn.facts.map((fact) => `- ${fact}`),
  ].join("\n");
}

/**
 * Build both prompt arms from the real garment projection and real character-chat
 * prompt builder. Cue memory advances only in the treatment plan, exactly as it
 * does when the flag is on; the control arm never reads or writes it.
 */
export function planGarmentScenario(fixture: GarmentNarratorFixture): PlannedGarmentScenario {
  const actors = chatGarmentNarrationActors({
    characterId: CHARACTER_ID,
    characterName: CHARACTER_NAME,
    playerName: PLAYER_NAME,
  });
  let previousCues: ChatGarmentStore["cues"] | undefined;
  const turns: PlannedGarmentTurn[] = [];

  for (let index = 0; index < fixture.turns.length; index += 1) {
    const turn = fixture.turns[index];
    if (!turn) continue;
    const store: ChatGarmentStore = previousCues ? { ...turn.store, cues: previousCues } : turn.store;
    const narration = buildChatGarmentNarration({
      store,
      actors,
      atMinutes: turn.atMinutes,
      placeName: fixture.place,
    });
    previousCues = narration.nextCues;
    turns.push({
      id: turn.id,
      player: turn.player,
      digest: narration.digest,
      cues: narration.cues,
      groundTruth: groundTruth(fixture, index, narration.digest),
      expectedDigest: turn.expectedDigest,
      expectedCues: turn.expectedCues,
      prompts: {
        garment: promptFor({
          fixture,
          turnIndex: index,
          legacyOutfit: turn.legacyOutfit,
          atMinutes: turn.atMinutes,
          digest: narration.digest,
          cues: narration.cues,
        }),
        control: promptFor({
          fixture,
          turnIndex: index,
          legacyOutfit: turn.legacyOutfit,
          atMinutes: turn.atMinutes,
        }),
      },
    });
  }

  return { fixture, characterName: CHARACTER_NAME, turns };
}

export function planGarmentCorpus(): PlannedGarmentScenario[] {
  return GARMENT_NARRATOR_FIXTURES.map(planGarmentScenario);
}

export interface GarmentHarnessCheck {
  id: string;
  ok: boolean;
  detail: string;
}

/** Model-free checks that fail before the runner is allowed to spend anything. */
export function garmentHarnessChecks(plans: readonly PlannedGarmentScenario[]): GarmentHarnessCheck[] {
  const checks: GarmentHarnessCheck[] = [];
  for (const plan of plans) {
    for (const turn of plan.turns) {
      const missingDigest = turn.expectedDigest.filter((fragment) => !turn.digest.includes(fragment));
      checks.push({
        id: `${plan.fixture.id}:${turn.id}:digest`,
        ok: missingDigest.length === 0,
        detail: missingDigest.length === 0 ? "expected digest fragments present" : `missing: ${missingDigest.join(" | ")}`,
      });
      checks.push({
        id: `${plan.fixture.id}:${turn.id}:cues`,
        ok: JSON.stringify(turn.cues) === JSON.stringify(turn.expectedCues),
        detail: `expected [${turn.expectedCues.join(" | ")}], got [${turn.cues.join(" | ")}]`,
      });
      checks.push({
        id: `${plan.fixture.id}:${turn.id}:prompt-treatment`,
        ok:
          turn.prompts.garment.includes("Wardrobe right now") &&
          turn.prompts.garment.includes(turn.digest) &&
          !turn.prompts.control.includes("Wardrobe right now"),
        detail: "only the garment arm carries the authoritative digest",
      });
      if (turn.cues.length > 0) {
        checks.push({
          id: `${plan.fixture.id}:${turn.id}:prompt-cues`,
          ok:
            turn.prompts.garment.includes("Worth noticing about the clothes") &&
            turn.cues.every((cue) => turn.prompts.garment.includes(cue)) &&
            !turn.prompts.control.includes("Worth noticing about the clothes"),
          detail: "only the garment arm carries the bounded cue block",
        });
      }
    }
  }
  return checks;
}

/** Build the production handle table the continuity extractor sees. */
export function extractionHandles(fixture: GarmentExtractionFixture): GarmentHandleTable {
  return buildGarmentHandleTable({
    store: fixture.store,
    actors: [
      { actorId: CHARACTER_ACTOR, label: CHARACTER_NAME, slug: "wren" },
      { actorId: "player", label: PLAYER_NAME, slug: "you" },
    ],
    placeName: fixture.place,
  });
}

function fieldEquals(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && expected.every((entry) => actual.includes(entry));
  }
  return actual === expected;
}

/** Partial, order-independent extraction scoring over the fields each fixture owns. */
export function extractionExpectationMatches(
  actual: readonly GarmentOperationProposal[],
  expected: GarmentExtractionExpectation,
): boolean {
  return actual.some((candidate) => {
    if (candidate.op !== expected.op) return false;
    for (const [key, value] of Object.entries(expected)) {
      if (key === "op" || value === undefined) continue;
      if (!fieldEquals((candidate as unknown as Record<string, unknown>)[key], value)) return false;
    }
    return true;
  });
}

export function extractionFixtures(): readonly GarmentExtractionFixture[] {
  return GARMENT_EXTRACTION_FIXTURES;
}
