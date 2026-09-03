import { describe, expect, it } from "vitest";
import { newId } from "@/lib/ids";
import { db, type Db } from "@/server/db";
import {
  readDurableActivities,
  seedDurableActionDefinitions,
  submitDurableStartActivity,
} from "./activity-store";
import { readDurableBodyReads } from "./body-reads";
import { readDurableBodies, submitDurableInitializeActorBody } from "./body-store";
import { readDurableBranchState } from "./branch-store";
import { readDurableCommitments, submitDurableCreateCommitment } from "./commitment-store";
import { readDurableEngagements, submitDurableOpenEngagement } from "./engagement-store";
import { readDurableKnowledge } from "./knowledge-recorder";
import { submitDurableMakeDisclosure } from "./knowledge-store";
import { readDurableSpaceBranch, submitDurableMoveActor } from "./space-store";
import {
  ADMIT_AT_LOCKED_VERSION,
  expectAccepted,
  gmPrincipal,
  playerPrincipal,
  seedSimBranch,
  simCommand,
  simulationSuiteHarness,
} from "@/server/test-support";

/**
 * `docs/database/indexes.md` §Transactional invariants: every public
 * multi-query simulation reader returns one committed database state — its
 * head (`version`/`headSequence`/`storySecond`) and every row describe the
 * same moment. The killed implementation issues its statements on the bare
 * `Db`, so a command committed between the head read and the row reads yields
 * a view that is neither the before nor the after state.
 *
 * The probe below hands each reader a `Db` whose statements pause exactly
 * once: after the first statement resolves, a real command commits on the
 * shared pool, then the reader continues. Statements on the bare database and
 * inside `transaction` are both instrumented, so a reader that skips the
 * snapshot mixes data (the equality assertion) and records no transaction
 * (the options assertion).
 */

const harness = await simulationSuiteHarness({ suite: "snapshot-reads.int.test", table: "sim_engagements" });

const SEED_SECOND = 60_000;
const WALK = 600;

interface Scene {
  branchId: string;
  mara: string;
  iris: string;
  zoneB: string;
  napActionId: string;
}

async function seedScene(): Promise<Scene> {
  const worldId = newId();
  const branchId = newId();
  const scene: Scene = {
    branchId,
    mara: newId(),
    iris: newId(),
    zoneB: `${branchId}-zone-b`,
    napActionId: `${branchId}-action-nap`,
  };
  const zoneA = `${branchId}-zone-a`;
  const locHome = `${worldId}-loc-home`;
  await seedSimBranch({
    worldId,
    branchId,
    worldTypeId: "snapshot-tests",
    rulesetVersion: "snapshot-test-v1",
    originStorySecond: SEED_SECOND,
    actors: [
      { id: scene.mara, name: "Mara" },
      { id: scene.iris, name: "Iris" },
    ],
    locations: [{ id: locHome, worldId, kind: "home", defaultAccessPolicy: "private" }],
    zones: [
      { id: zoneA, locationId: locHome, kind: "room", privacyPolicy: "semi_private" },
      { id: scene.zoneB, locationId: locHome, kind: "kitchen", privacyPolicy: "semi_private" },
    ],
    links: [
      {
        id: `${branchId}-link-ab`,
        fromZoneId: zoneA,
        toZoneId: scene.zoneB,
        modes: ["walk"],
        minimumDurationSeconds: WALK,
        accessPolicy: "public",
        state: "open",
      },
    ],
    placements: [
      { actorId: scene.mara, locationId: locHome, zoneId: zoneA },
      { actorId: scene.iris, locationId: locHome, zoneId: zoneA },
    ],
  });
  await seedDurableActionDefinitions({
    branchId,
    definitions: [
      {
        id: scene.napActionId,
        version: 1,
        controllerKinds: ["player"],
        duration: { kind: "fixed", seconds: 1_800 },
        preconditions: [],
        requiredClaims: [{ kind: "body" }],
        interruptibility: "pausable",
        noticeability: "obvious",
      },
    ],
  });
  harness.trackWorld(worldId);
  return scene;
}

type AnyFunction = (...args: unknown[]) => unknown;

/**
 * Wrap a Drizzle executor so every statement it issues runs `afterStatement`
 * once the statement resolves, before the awaiting caller continues. Builder
 * chains stay wrapped; awaiting a builder is the statement.
 */
function interceptStatements<T extends object>(
  target: T,
  afterStatement: () => Promise<void>,
  overrides: Record<string, unknown> = {},
): T {
  const wrap = (result: unknown): unknown =>
    typeof result === "object" && result !== null && !(result instanceof Promise)
      ? interceptStatements(result, afterStatement)
      : result;
  return new Proxy(target, {
    get(inner, property) {
      if (typeof property === "string" && property in overrides) return overrides[property];
      const value: unknown = Reflect.get(inner, property, inner);
      if (typeof value !== "function") return value;
      const method = value as AnyFunction;
      if (property === "then") {
        return (onFulfilled?: AnyFunction, onRejected?: AnyFunction) =>
          new Promise((resolve, reject) => method.call(inner, resolve, reject))
            .then(async (result) => {
              await afterStatement();
              return result;
            })
            .then(onFulfilled, onRejected);
      }
      return (...args: unknown[]) => wrap(method.apply(inner, args));
    },
  });
}

/** A `Db` that commits `concurrently` after the reader's first statement and records its transactions. */
function snapshotProbe(concurrently: () => Promise<void>) {
  const real = db();
  const state = { paused: false, transactions: [] as unknown[] };
  const afterStatement = async (): Promise<void> => {
    if (state.paused) return;
    state.paused = true;
    await concurrently();
  };
  const transaction: Db["transaction"] = (fn, options) => {
    state.transactions.push(options);
    return real.transaction((tx) => fn(interceptStatements(tx, afterStatement)), options);
  };
  return { probe: interceptStatements(real, afterStatement, { transaction }), state };
}

interface ReaderCase {
  reader: string;
  read: (branchId: string, database: Db) => Promise<unknown>;
  commit: (scene: Scene) => Promise<void>;
}

const command = (scene: Scene, name: string, type: string, payload: Record<string, unknown>, actor?: string) =>
  simCommand({
    branchId: scene.branchId,
    name,
    type,
    payload,
    principal: actor === undefined ? gmPrincipal : playerPrincipal(actor),
  });

const openEngagement = async (scene: Scene): Promise<void> => {
  const payload = { participantIds: [scene.mara, scene.iris].sort(), channel: "co_present" };
  const result = await submitDurableOpenEngagement(
    command(scene, "open", "open_engagement", payload, scene.mara),
    ADMIT_AT_LOCKED_VERSION,
  );
  expectAccepted(result, "open the co-present scene");
};

const initializeBody = async (scene: Scene): Promise<void> => {
  const payload = { actorId: scene.mara, registryVersion: "body-v1", baselineOverrides: {} };
  const result = await submitDurableInitializeActorBody(
    command(scene, "init", "initialize_actor_body", payload),
    ADMIT_AT_LOCKED_VERSION,
  );
  expectAccepted(result, "initialize Mara's body");
};

const cases: ReaderCase[] = [
  { reader: "readDurableEngagements", read: readDurableEngagements, commit: openEngagement },
  {
    reader: "readDurableActivities",
    read: readDurableActivities,
    commit: async (scene) => {
      const payload = { actionDefinitionId: scene.napActionId, actorId: scene.mara };
      const result = await submitDurableStartActivity(
        command(scene, "nap", "start_activity", payload, scene.mara),
        ADMIT_AT_LOCKED_VERSION,
      );
      expectAccepted(result, "start the nap");
    },
  },
  { reader: "readDurableBodies", read: readDurableBodies, commit: initializeBody },
  { reader: "readDurableBodyReads", read: readDurableBodyReads, commit: initializeBody },
  {
    reader: "readDurableCommitments",
    read: readDurableCommitments,
    commit: async (scene) => {
      const payload = {
        actorId: scene.mara,
        kind: "shift",
        destinationZoneId: scene.zoneB,
        window: { latestArrival: SEED_SECOND + 5_000 },
        priority: 10,
        flexibility: "firm",
        preparationSeconds: 100,
        reliabilityBufferSeconds: 0,
        noticeLeadSeconds: 500,
        knowledgeSource: { kind: "authored" },
      };
      const result = await submitDurableCreateCommitment(
        command(scene, "shift", "create_commitment", payload, scene.mara),
        ADMIT_AT_LOCKED_VERSION,
      );
      expectAccepted(result, "create the shift commitment");
    },
  },
  {
    reader: "readDurableKnowledge",
    read: readDurableKnowledge,
    commit: async (scene) => {
      const payload = {
        speakerActorId: scene.mara,
        targetActorIds: [scene.iris],
        content: { kind: "claim", propositionKey: "quitting_job", subjectIds: [scene.mara], claimedValue: { quitting: true } },
      };
      const result = await submitDurableMakeDisclosure(
        command(scene, "claim", "make_disclosure", payload, scene.mara),
        ADMIT_AT_LOCKED_VERSION,
      );
      expectAccepted(result, "confide the claim");
    },
  },
  {
    reader: "readDurableSpaceBranch",
    read: readDurableSpaceBranch,
    commit: async (scene) => {
      const payload = { actorId: scene.mara, destinationZoneId: scene.zoneB, travelMode: "walk" };
      const result = await submitDurableMoveActor(
        command(scene, "depart", "move_actor", payload, scene.mara),
        ADMIT_AT_LOCKED_VERSION,
      );
      expectAccepted(result, "start the walk");
    },
  },
  { reader: "readDurableBranchState", read: readDurableBranchState, commit: openEngagement },
];

describe.runIf(harness.ready)("standalone simulation readers read one snapshot", () => {
  it.each(cases)("$reader returns the pre-commit view when a command lands mid-read", async ({ read, commit }) => {
    const scene = await seedScene();
    const before = await read(scene.branchId, db());

    const { probe, state } = snapshotProbe(() => commit(scene));
    const during = await read(scene.branchId, probe);
    const after = await read(scene.branchId, db());

    expect(state.paused, "the concurrent command ran between the reader's statements").toBe(true);
    expect(after, "the concurrent command changes what the reader returns").not.toEqual(before);
    expect(during, "the view mixes pre- and post-commit data").toEqual(before);
    expect(state.transactions).toEqual([{ isolationLevel: "repeatable read", accessMode: "read only" }]);
  });
});
