import "dotenv/config";
import { eq } from "drizzle-orm";
import { emptyCharacterProfile, regardBandForValue } from "@/contracts";
import { newId } from "@/lib/ids";
import { resolveChatModelId } from "@/lib/narrative-models";
import { analyzeShadowParity } from "@/lib/simulation/shadow-parity";
import {
  characterChats,
  characters,
  chatParticipants,
  db,
  simShadowDivergences,
  users,
} from "@/server/db";
import {
  ROLLOUT_ACTORS,
  ROLLOUT_BRANCH_ID,
  applyTimeSkipToScenario,
  loadChatScenario,
  mirrorShadowTimeSkip,
  runShadowChatExchange,
  saveChatScenario,
  seedChatScenario,
  seedRolloutTestWorld,
  setChatEngineAuthority,
  submitChatMessage,
} from "@/server/engine";

/**
 * R4 slice 2 — the FIXED comparison corpus: a scripted
 * exchange set run through the real legacy pipeline on a fresh
 * `successor_shadow` chat, with each detached shadow leg awaited so the run is
 * deterministic and complete when it prints. Ends with the computed parity
 * report. Runs locally (AI_FAKE=1 for zero model calls) or on Fly over SSH
 * (real narrator + shadow renders — one of each per exchange).
 *
 * The corpus is versioned here in code: changing it is a corpus revision, not
 * a tweak — the exit's "agreed report" is over THIS set plus played sessions.
 */

const CORPUS_VERSION = "shadow-corpus-v1";
const CORPUS_USER_EMAIL = "shadow-corpus@vesper.local";

/** The scripted set: four plain sends with one mid-corpus "hours" skip. */
const CORPUS: ({ kind: "send"; content: string } | { kind: "skip"; amount: "hours" })[] = [
  { kind: "send", content: "I set two mugs on the table and slide one across to you." },
  { kind: "send", content: "I ask what the plan is for the rest of the day." },
  { kind: "skip", amount: "hours" },
  { kind: "send", content: "I come back in and ask if anything happened while I was out." },
  { kind: "send", content: "I sit down next to you and put my feet up." },
];

async function main() {
  const args = process.argv.slice(2);
  const modelFlag = args.indexOf("--model");
  const modelId = resolveChatModelId(modelFlag === -1 ? undefined : args[modelFlag + 1]);

  await seedRolloutTestWorld();

  // A dedicated corpus user + character + fresh chat per run: the transcript
  // starts clean so every run compares the same conversation shape.
  const [existingUser] = await db().select().from(users).where(eq(users.email, CORPUS_USER_EMAIL));
  const user =
    existingUser ??
    (await db().insert(users).values({ email: CORPUS_USER_EMAIL, name: "Shadow Corpus" }).returning())[0];
  if (!user) throw new Error("corpus user could not be ensured");
  const [character] = await db()
    .insert(characters)
    .values({ ownerId: user.id, name: "Ana", profile: {} })
    .returning();
  if (!character) throw new Error("corpus character insert failed");
  const chatId = newId();
  const memoryGroupId = newId();
  await db().insert(characterChats).values({ id: chatId, ownerId: user.id, title: `${CORPUS_VERSION} ${new Date().toISOString()}` });
  await db().insert(chatParticipants).values({ chatId, characterId: character.id, memoryGroupId, sort: 0 });
  await setChatEngineAuthority({
    chatId,
    byUserId: user.id,
    authority: "successor_shadow",
    simBranchId: ROLLOUT_BRANCH_ID,
    simPlayerActorId: ROLLOUT_ACTORS.mara,
    simPrimaryActorId: ROLLOUT_ACTORS.ana,
  });

  for (const [index, step] of CORPUS.entries()) {
    if (step.kind === "skip") {
      // The legacy half of a skip, minimally: the scenario clock moves and the
      // mirror follows (awaited — the corpus is deterministic). The full route
      // extras (meanwhile pass, per-member expiry) are exercised by played
      // sessions, not the scripted corpus.
      const scenario = (await loadChatScenario(chatId)) ?? seedChatScenario(emptyCharacterProfile());
      const next = applyTimeSkipToScenario(scenario, step.amount, regardBandForValue(0).id, new Date());
      await saveChatScenario(chatId, next);
      await mirrorShadowTimeSkip(chatId, next.clockMinutes - scenario.clockMinutes);
      console.log(`[${index + 1}/${CORPUS.length}] skip ${step.amount}: clock ${scenario.clockMinutes} → ${next.clockMinutes}`);
      continue;
    }
    let settled: { assistantMessageId: string; content: string } | null = null;
    const result = await submitChatMessage({
      chatId,
      memoryGroupId,
      character: { id: character.id, name: character.name, profile: character.profile },
      roster: [{ characterId: character.id, memoryGroupId, name: character.name, profile: character.profile }],
      kind: "send",
      content: step.content,
      inputMode: "player",
      model: modelId,
      onSettled: (info) => {
        settled = info;
      },
    });
    if (!result.ok) throw new Error(`exchange ${index + 1} refused: ${result.code}`);
    let reply = "";
    for await (const delta of result.stream) reply += delta;
    // The settle (persist + onSettled) completes as the stream closes; a short
    // poll absorbs the tail of that same tick.
    for (let attempt = 0; settled === null && attempt < 50; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const anchor = settled as { assistantMessageId: string; content: string } | null;
    if (anchor === null) throw new Error(`exchange ${index + 1} never settled`);
    const shadow = await runShadowChatExchange({
      chatId,
      userId: user.id,
      assistantMessageId: anchor.assistantMessageId,
      content: step.content,
    });
    console.log(
      `[${index + 1}/${CORPUS.length}] send: legacy ${reply.length} chars; shadow ran=${String(shadow.ran)} rows=${shadow.rows}`,
    );
  }

  const rows = await db().select().from(simShadowDivergences).where(eq(simShadowDivergences.chatId, chatId));
  const report = analyzeShadowParity(rows);
  console.log(JSON.stringify({ corpus: CORPUS_VERSION, chatId, report }, null, 2));
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
