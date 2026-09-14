import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  emptyItemGarmentStateSeed,
  replayItemGarmentStateHistory,
} from "@vesper/simulation-core/garments";
import {
  garmentBlueprintSchema,
  garmentInstanceStateSchema,
  garmentReadout,
  garmentStructuralFacts,
  successorGarmentBlueprint,
  successorWornSlotKey,
  GARMENT_UNIT_ONE,
  type GarmentBlueprint,
  type GarmentInstanceState,
} from "@/contracts";
import { newId } from "@/lib/ids";
import { db, simItemGarmentState } from "@/server/db";
import {
  ADMIT_AT_LOCKED_VERSION,
  expectAccepted,
  expectRejected,
  forkAtHead,
  npcPrincipal,
  readBranchEvents,
  seedSimBranch,
  simCommand,
  simulationSuiteHarness,
} from "@/server/test-support";
import { seedDurableActionDefinitions, submitDurableStartActivity } from "./activity-store";
import { submitDurableApplyGarmentOperation } from "./garment-store";
import { submitDurableTransferItem } from "./material-store";

/**
 * #296 — a successor clothing change is durable world history.
 *
 * The three things this suite exists to prove, in the order the issue states
 * them: a sequence of accepted changes lands as events AND as the projection
 * row; rebuilding the projection from those events alone reproduces the live
 * rows and the bands a reader would see; and a fork inherits that state and
 * then diverges from it. The fourth block is the negative space — a rejected
 * operation must leave the row and the stream exactly as they were.
 *
 * **The defect this suite kills: a projection that disagrees with its own
 * history.** `sim_item_garment_state` is a fold of `garment_operation_applied`,
 * so any implementation that re-runs the reducer at replay time, writes the row
 * from a local variable instead of the event payload, or records an event for
 * an operation it refused, produces a world whose every FORK is dressed
 * differently from its parent — and the disagreement only surfaces on the fork,
 * long after the write that caused it.
 *
 * Nothing in the successor lane produces these commands yet, which is why this
 * fixture is the proof rather than a narration consumer.
 */
const harness = await simulationSuiteHarness({
  suite: "garment-store.int.test",
  table: "sim_item_garment_state",
  legacyPlayerMode: false,
  cleanup: "afterEach",
});

const SEED_SECOND = 40_000;
const SEED_MINUTE = Math.floor(SEED_SECOND / 60);
const SHIRT_COVERAGE = ["chest", "shoulders", "upper_arms"] as const;
/**
 * The authored material kind the mending action's resource cost selects on.
 * Only `reservedShirtId` carries it, so the reservation the rejection case
 * arms lands on THAT garment and never on the shirt every other case operates
 * on.
 */
const MENDING_KIND = "e296-mending-garment";

interface Case {
  worldId: string;
  branchId: string;
  actorId: string;
  otherActorId: string;
  locationId: string;
  zoneId: string;
  shirtId: string;
  plainId: string;
  /** A strongbox the actor CARRIES but holds no key to (`allow_list: [otherActorId]`). */
  lockedBoxId: string;
  /** A second blueprint-bearing shirt, inside that strongbox. */
  boxedShirtId: string;
  /** A third blueprint-bearing shirt, held by the actor, reservable by an activity. */
  reservedShirtId: string;
}

function makeCase(): Case {
  const worldId = newId();
  const branchId = newId();
  return {
    worldId,
    branchId,
    actorId: newId(),
    otherActorId: newId(),
    locationId: `${worldId}-loc-home`,
    zoneId: `${branchId}-zone-room`,
    shirtId: newId(),
    plainId: newId(),
    lockedBoxId: newId(),
    boxedShirtId: newId(),
    reservedShirtId: newId(),
  };
}

/** A `top` blueprint: a fastenable front panel, rollable sleeves, a tuckable hem. */
function shirtBlueprintJson(): Record<string, unknown> {
  return successorGarmentBlueprint({
    id: "def-shirt",
    name: "linen shirt",
    category: "top",
    coverage: [...SHIRT_COVERAGE],
  });
}

function shirtBlueprint(): GarmentBlueprint {
  return garmentBlueprintSchema.parse(shirtBlueprintJson());
}

/**
 * One actor wearing the blueprint-bearing shirt, plus an ordinary item with no
 * garment construction at all (the `garment_not_modelled` case) and the
 * topology every command path needs.
 */
async function seedCase(ids: Case): Promise<void> {
  harness.trackWorld(ids.worldId);
  await seedSimBranch({
    worldId: ids.worldId,
    branchId: ids.branchId,
    worldTypeId: "e296-garment-store-tests",
    rulesetVersion: "e296-garment-store-v1",
    originStorySecond: SEED_SECOND,
    actors: [
      { id: ids.actorId, name: "Mara" },
      { id: ids.otherActorId, name: "Iven" },
    ],
    items: [
      {
        id: ids.shirtId,
        name: "linen shirt",
        garmentBlueprint: shirtBlueprintJson(),
        locus: { kind: "worn", actorId: ids.actorId, slotKey: successorWornSlotKey("top", 0) },
      },
      // No `garmentBlueprint`: exactly how every pre-#295 seed reads.
      { id: ids.plainId, name: "tin cup", locus: { kind: "held", actorId: ids.actorId } },
      {
        id: ids.lockedBoxId,
        name: "strongbox",
        // HELD by the acting actor on purpose: the root then resolves to the
        // actor himself, so the co-location and root-actor checks both pass and
        // the container's OWN access rule is the guard that has to decide. A
        // box resting in the zone would be refused a step earlier and would
        // never exercise `containerAccessAllowed`.
        container: { capacityCount: 4, access: { kind: "allow_list", actorIds: [ids.otherActorId] } },
        locus: { kind: "held", actorId: ids.actorId },
      },
      {
        id: ids.boxedShirtId,
        name: "packed shirt",
        garmentBlueprint: shirtBlueprintJson(),
        locus: { kind: "container", containerItemId: ids.lockedBoxId },
      },
      {
        id: ids.reservedShirtId,
        name: "mending shirt",
        materialKindKey: MENDING_KIND,
        garmentBlueprint: shirtBlueprintJson(),
        locus: { kind: "held", actorId: ids.actorId },
      },
    ],
    locations: [{ id: ids.locationId, worldId: ids.worldId, kind: "home", defaultAccessPolicy: "private" }],
    zones: [{ id: ids.zoneId, locationId: ids.locationId, kind: "room", privacyPolicy: "private" }],
    links: [],
    placements: [
      { actorId: ids.actorId, locationId: ids.locationId, zoneId: ids.zoneId },
      { actorId: ids.otherActorId, locationId: ids.locationId, zoneId: ids.zoneId },
    ],
  });
}

/** Submit one garment operation on `branchId`, admitted at whatever version the lock finds. */
async function applyOperation(
  branchId: string,
  ids: Case,
  name: string,
  operation: Record<string, unknown>,
  itemId: string = ids.shirtId,
): ReturnType<typeof submitDurableApplyGarmentOperation> {
  return submitDurableApplyGarmentOperation(
    simCommand({
      branchId,
      // Command names are whitespace-free tokens (they seed the envelope ids).
      name: name.replace(/[^A-Za-z0-9_-]+/gu, "-"),
      type: "apply_garment_operation",
      principal: npcPrincipal(ids.actorId),
      payload: { actorId: ids.actorId, itemId, operation },
    }),
    ADMIT_AT_LOCKED_VERSION,
  );
}

/** The stored row, unparsed — what the command actually wrote into the two JSONB columns. */
async function rawGarmentRow(
  branchId: string,
  itemId: string,
): Promise<{ presentation: unknown; condition: unknown; updatedSequence: number } | undefined> {
  const [row] = await db()
    .select({
      presentation: simItemGarmentState.presentation,
      condition: simItemGarmentState.condition,
      updatedSequence: simItemGarmentState.updatedSequence,
    })
    .from(simItemGarmentState)
    .where(and(eq(simItemGarmentState.branchId, branchId), eq(simItemGarmentState.itemId, itemId)));
  return row;
}

/** Rebuild the branch's garment-state projection from its events alone. */
async function replayedGarmentState(branchId: string, options: { includeAncestry?: boolean } = {}) {
  const events = await readBranchEvents(branchId, options);
  return replayItemGarmentStateHistory({
    seed: emptyItemGarmentStateSeed(branchId, SEED_SECOND),
    events,
  });
}

/** Wrap a stored presentation/condition pair as the instance the readouts take. */
function instanceOf(ids: Case, state: { presentation: unknown; condition: unknown }): GarmentInstanceState {
  return garmentInstanceStateSchema.parse({
    id: ids.shirtId,
    blueprintHash: "fixture-hash",
    name: "linen shirt",
    locus: { kind: "held", actorId: ids.actorId },
    presentation: state.presentation,
    condition: state.condition,
    lastChange: { kind: "mint", atMinutes: 0 },
  });
}

/** The whole accepted sequence: a doff, two presentation changes, and three material ones. */
async function runAcceptedSequence(ids: Case): Promise<void> {
  expectAccepted(
    await submitDurableTransferItem(
      simCommand({
        branchId: ids.branchId,
        name: "doff-the-shirt",
        type: "transfer_item",
        principal: npcPrincipal(ids.actorId),
        payload: {
          actorId: ids.actorId,
          itemId: ids.shirtId,
          fromLocus: { kind: "worn", actorId: ids.actorId, slotKey: successorWornSlotKey("top", 0) },
          toLocus: { kind: "held", actorId: ids.actorId },
        },
      }),
      ADMIT_AT_LOCKED_VERSION,
    ),
    "doff the shirt",
  );

  expectAccepted(
    await applyOperation(ids.branchId, ids, "roll a sleeve", {
      kind: "set_roll",
      garmentId: ids.shirtId,
      partId: "sleeve_left",
      degree: "moderate",
    }),
    "set_roll",
  );
  expectAccepted(
    await applyOperation(ids.branchId, ids, "unfasten two buttons", {
      kind: "set_closure",
      garmentId: ids.shirtId,
      partId: "front_panel",
      state: { kind: "fastener_series", openFastenerIndexes: [0, 1] },
    }),
    "set_closure",
  );
  expectAccepted(
    await applyOperation(ids.branchId, ids, "rain on the shirt", {
      kind: "apply_condition",
      garmentId: ids.shirtId,
      partIds: [],
      channel: "wetness",
      change: { direction: "increase", degree: "substantial" },
    }),
    "apply_condition wetness",
  );
  expectAccepted(
    await applyOperation(ids.branchId, ids, "mud on the front", {
      kind: "deposit",
      garmentId: ids.shirtId,
      partIds: ["front_panel"],
      depositKind: "mud",
      degree: "moderate",
    }),
    "deposit",
  );
  expectAccepted(
    await applyOperation(ids.branchId, ids, "tear a sleeve", {
      kind: "damage",
      garmentId: ids.shirtId,
      partId: "sleeve_left",
      damageKind: "tear",
      degree: "slight",
    }),
    "damage",
  );
}

/**
 * Arm a LIVE activity holding a start-time reservation on `reservedShirtId` —
 * the same leg `material-store.int.test.ts` uses to prove `item_reserved` on
 * `consume_item`, pointed at a garment instead of a meal. The start appends its
 * own events (`activity_started` + the completion trigger), so a caller that
 * asserts "the stream is untouched" must snapshot AFTER calling this.
 */
async function reserveMendingShirt(ids: Case): Promise<void> {
  await seedDurableActionDefinitions({
    branchId: ids.branchId,
    definitions: [
      {
        id: "mend-a-garment",
        version: 1,
        controllerKinds: ["npc_policy"],
        duration: { kind: "fixed", seconds: 600 },
        preconditions: [],
        requiredClaims: [],
        interruptibility: "free",
        noticeability: "private",
        resourceCosts: [{ materialKindKey: MENDING_KIND, quantity: 1, disposition: "use" }],
      },
    ],
  });
  expectAccepted(
    await submitDurableStartActivity(
      simCommand({
        branchId: ids.branchId,
        name: "start-mending",
        type: "start_activity",
        principal: npcPrincipal(ids.actorId),
        payload: { actionDefinitionId: "mend-a-garment", actorId: ids.actorId },
      }),
      ADMIT_AT_LOCKED_VERSION,
    ),
    "start the mending activity",
  );
}

describe.runIf(harness.ready)("#296 — accepted garment operations become history", () => {
  it("records each change as one event and lands the projection row at the last sequence", async () => {
    const ids = makeCase();
    await seedCase(ids);
    await runAcceptedSequence(ids);

    const events = await readBranchEvents(ids.branchId);
    const types = events.map((event) => event.type);
    // The doff moves the garment; every arrangement and material change after
    // it is this command's own event, in the order they were submitted.
    expect(types.indexOf("item_transferred")).toBeGreaterThanOrEqual(0);
    expect(types.indexOf("item_transferred")).toBeLessThan(types.indexOf("garment_operation_applied"));
    const kinds = events.flatMap((event) =>
      event.type === "garment_operation_applied" ? [event.payload.operation.kind] : [],
    );
    expect(kinds).toEqual(["set_roll", "set_closure", "apply_condition", "deposit", "damage"]);

    const garmentEvents = events.filter((event) => event.type === "garment_operation_applied");
    const lastSequence = garmentEvents.at(-1)?.sequence;
    const row = await rawGarmentRow(ids.branchId, ids.shirtId);
    expect(row?.updatedSequence).toBe(lastSequence);

    // The row is the LAST event's `after`, not an accumulation of its own.
    const last = events.at(-1);
    if (last?.type !== "garment_operation_applied") throw new Error("expected a garment event last");
    expect(row?.presentation).toEqual(last.payload.after.presentation);
    expect(row?.condition).toEqual(last.payload.after.condition);

    // Every event names the story minute it integrated to — floor, not round.
    for (const event of garmentEvents) {
      if (event.type !== "garment_operation_applied") continue;
      expect(event.payload.derived.atStoryMinute).toBe(SEED_MINUTE);
      expect(event.payload.derived.blueprintHash.length).toBeGreaterThan(0);
    }
  });

  it("keeps cleanliness and wear at their defaults — the item-condition meters own them", async () => {
    const ids = makeCase();
    await seedCase(ids);
    await runAcceptedSequence(ids);

    const row = await rawGarmentRow(ids.branchId, ids.shirtId);
    const condition = garmentInstanceStateSchema.parse({
      id: ids.shirtId,
      blueprintHash: "fixture-hash",
      name: "linen shirt",
      locus: { kind: "held", actorId: ids.actorId },
      presentation: row?.presentation,
      condition: row?.condition,
    }).condition;

    // A mud deposit soils and a tear ages — in the chat lane. Here those two
    // channels belong to `item-condition-v1`, so the row records the FACTS and
    // leaves the channels at their defaults.
    expect(condition.base.cleanliness).toBe(GARMENT_UNIT_ONE);
    expect(condition.base.wear).toBe(0);
    expect(Object.values(condition.regionOverrides).some((override) => override?.cleanliness !== undefined)).toBe(
      false,
    );
    expect(condition.deposits.map((deposit) => deposit.kind)).toEqual(["mud"]);
    expect(condition.damageMarks.map((mark) => mark.partId)).toEqual(["sleeve_left"]);
    // The channels this projection DOES own moved.
    expect(condition.base.wetness).toBeGreaterThan(0);
  });
});

describe.runIf(harness.ready)("#296 — the projection rebuilds from events alone", () => {
  it("replays to the same rows and the same visible bands", async () => {
    const ids = makeCase();
    await seedCase(ids);
    await runAcceptedSequence(ids);

    const live = await rawGarmentRow(ids.branchId, ids.shirtId);
    if (!live) throw new Error("expected a live garment-state row");
    const replayed = await replayedGarmentState(ids.branchId);
    const entry = replayed.items.find((item) => item.itemId === ids.shirtId);
    if (!entry) throw new Error("expected the shirt in the replayed projection");

    // The rows themselves, unparsed: what the command wrote IS what a fold of
    // its own events produces. Anything else would make every fork wrong.
    expect(entry.presentation).toEqual(live.presentation);
    expect(entry.condition).toEqual(live.condition);

    // And the bands a reader would see, which is what a silently-wrong
    // projection would actually cost: the same readout from both sides.
    const blueprint = shirtBlueprint();
    const liveReadout = garmentReadout(instanceOf(ids, live), blueprint, { atMinutes: SEED_MINUTE });
    const replayedReadout = garmentReadout(instanceOf(ids, entry), blueprint, { atMinutes: SEED_MINUTE });
    expect(replayedReadout.condition).toEqual(liveReadout.condition);
    expect(garmentStructuralFacts(replayedReadout)).toEqual(garmentStructuralFacts(liveReadout));

    // Not vacuously equal: the sequence really moved the garment off neutral,
    // so an implementation that replayed two empty projections would fail here.
    expect(liveReadout.condition.wetness).not.toBe("dry");
    expect(liveReadout.deposits.map((deposit) => deposit.kind)).toEqual(["mud"]);
    expect(liveReadout.damage.map((mark) => mark.partId)).toEqual(["sleeve_left"]);
    const liveFacts = garmentStructuralFacts(liveReadout);
    expect(liveFacts.find((fact) => fact.partId === "sleeve_left")).toMatchObject({
      channel: "roll",
      band: "rolled",
      deviation: true,
    });
    expect(liveFacts.find((fact) => fact.partId === "front_panel")).toMatchObject({
      channel: "closure",
      band: "partly_open",
      deviation: true,
    });
  });
});

describe.runIf(harness.ready)("#296 — forks inherit garment state and then diverge", () => {
  it("starts the child from the parent's state and keeps later changes on their own branch", async () => {
    const ids = makeCase();
    await seedCase(ids);
    await runAcceptedSequence(ids);

    const parentBefore = await rawGarmentRow(ids.branchId, ids.shirtId);
    const fork = await forkAtHead({ parentBranchId: ids.branchId, reason: "#296 garment fork parity" });
    const childAtFork = await rawGarmentRow(fork.childBranchId, ids.shirtId);

    // Parity: the child's row was rebuilt from inherited events, never copied.
    expect(childAtFork?.presentation).toEqual(parentBefore?.presentation);
    expect(childAtFork?.condition).toEqual(parentBefore?.condition);
    expect(childAtFork?.updatedSequence).toBe(parentBefore?.updatedSequence);

    // Divergence, child side.
    expectAccepted(
      await applyOperation(fork.childBranchId, ids, "child rolls the other sleeve", {
        kind: "set_roll",
        garmentId: ids.shirtId,
        partId: "sleeve_right",
        degree: "extreme",
      }),
      "child set_roll",
    );
    const childAfter = await rawGarmentRow(fork.childBranchId, ids.shirtId);
    expect(childAfter?.presentation).not.toEqual(parentBefore?.presentation);
    expect(await rawGarmentRow(ids.branchId, ids.shirtId)).toEqual(parentBefore);

    // Divergence, parent side.
    expectAccepted(
      await applyOperation(ids.branchId, ids, "parent tucks the hem", {
        kind: "set_tuck",
        garmentId: ids.shirtId,
        partId: "hem",
        state: "in",
      }),
      "parent set_tuck",
    );
    const parentAfter = await rawGarmentRow(ids.branchId, ids.shirtId);
    expect(parentAfter).not.toEqual(parentBefore);
    expect(await rawGarmentRow(fork.childBranchId, ids.shirtId)).toEqual(childAfter);

    // The child's own LOGICAL stream (inherited rows plus its own) still folds
    // to its live row — a fork is replayable, not just copied.
    const childReplay = await replayedGarmentState(fork.childBranchId, { includeAncestry: true });
    const childEntry = childReplay.items.find((item) => item.itemId === ids.shirtId);
    expect(childEntry?.presentation).toEqual(childAfter?.presentation);
    expect(childEntry?.condition).toEqual(childAfter?.condition);
  });
});

describe.runIf(harness.ready)("#296 — a rejected operation writes nothing", () => {
  it("leaves the row and the stream untouched for every rejection kind", async () => {
    const ids = makeCase();
    await seedCase(ids);
    await runAcceptedSequence(ids);
    // Armed BEFORE the snapshot, because starting an activity is itself
    // history: everything asserted unchanged below is measured from here.
    await reserveMendingShirt(ids);

    const before = await rawGarmentRow(ids.branchId, ids.shirtId);
    const eventsBefore = await readBranchEvents(ids.branchId);

    // The opaque payload is not a garment operation at all.
    expectRejected(
      await applyOperation(ids.branchId, ids, "gibberish operation", { kind: "polish_the_buttons" }),
      "operation_invalid",
      "unknown operation kind",
    );

    // A move is `transfer_item`'s, and the rejection names it.
    const transfer = await applyOperation(ids.branchId, ids, "transfer through the wrong command", {
      kind: "transfer",
      garmentId: ids.shirtId,
      to: { kind: "held", actorId: ids.actorId },
    });
    expectRejected(transfer, "operation_unsupported", "transfer routing");
    expect(transfer).toMatchObject({ legalAlternativeCommandTypes: ["transfer_item"] });

    // Cleanliness and wear are the item-condition meters', likewise named.
    const clean = await applyOperation(ids.branchId, ids, "clean through the wrong command", {
      kind: "apply_condition",
      garmentId: ids.shirtId,
      partIds: [],
      channel: "cleanliness",
      change: { direction: "increase", degree: "moderate" },
    });
    expectRejected(clean, "operation_unsupported", "cleanliness routing");
    expect(clean).toMatchObject({ legalAlternativeCommandTypes: ["apply_item_condition_source"] });

    // An item with no blueprint has no construction to address.
    expectRejected(
      await applyOperation(
        ids.branchId,
        ids,
        "operate an unmodelled item",
        { kind: "set_roll", garmentId: ids.plainId, partId: "sleeve_left", degree: "moderate" },
        ids.plainId,
      ),
      "garment_not_modelled",
      "no blueprint",
    );

    // The shared reducer dropped it: a collar has no roll behavior.
    expectRejected(
      await applyOperation(ids.branchId, ids, "roll the collar", {
        kind: "set_roll",
        garmentId: ids.shirtId,
        partId: "collar",
        degree: "moderate",
      }),
      "operation_rejected",
      "channel unbound",
    );

    // Re-submitting a change that already landed changes nothing, so it is
    // refused rather than recorded: the stream never carries a no-op event.
    const repeat = await applyOperation(ids.branchId, ids, "roll the same sleeve again", {
      kind: "set_roll",
      garmentId: ids.shirtId,
      partId: "sleeve_left",
      degree: "moderate",
    });
    expectRejected(repeat, "operation_rejected", "no change");
    expect(repeat).toMatchObject({ publicReason: "garment_op.no_change" });

    // Inside a strongbox the actor carries but has no key to. The root-actor
    // check passes (it is his own carry), so the container's access rule is the
    // guard that decides — `container_access_denied`, exactly as
    // `resolveApplyItemConditionSource` refuses the same reach. This block is a
    // hand copy of that resolver's order, so each of its arms needs its own
    // case or a reordered copy passes the suite.
    expectRejected(
      await applyOperation(
        ids.branchId,
        ids,
        "operate a shirt inside a closed container",
        { kind: "set_roll", garmentId: ids.boxedShirtId, partId: "sleeve_left", degree: "moderate" },
        ids.boxedShirtId,
      ),
      "container_access_denied",
      "a container closed to the actor",
    );

    // Reserved by a LIVE activity: only that activity's own completion or
    // interruption machinery may move it, so a garment operation is refused
    // before the reducer ever runs — the last arm of the reach chain.
    expectRejected(
      await applyOperation(
        ids.branchId,
        ids,
        "operate a reserved garment",
        { kind: "set_roll", garmentId: ids.reservedShirtId, partId: "sleeve_left", degree: "moderate" },
        ids.reservedShirtId,
      ),
      "item_reserved",
      "a garment a live activity reserved",
    );

    // Neither refusal minted a projection row for the item it refused — a
    // rejected operation writes nothing ANYWHERE, not merely nothing new.
    expect(await rawGarmentRow(ids.branchId, ids.boxedShirtId)).toBeUndefined();
    expect(await rawGarmentRow(ids.branchId, ids.reservedShirtId)).toBeUndefined();
    expect(await rawGarmentRow(ids.branchId, ids.shirtId)).toEqual(before);
    expect((await readBranchEvents(ids.branchId)).length).toBe(eventsBefore.length);
  });

  it("refuses to operate on a garment-state row that would not parse", async () => {
    const ids = makeCase();
    await seedCase(ids);
    await runAcceptedSequence(ids);
    const eventsBefore = await readBranchEvents(ids.branchId);

    // Corrupt the row out of band, the way a hand edit or a bad migration would.
    await db()
      .update(simItemGarmentState)
      .set({ presentation: "nonsense" })
      .where(
        and(eq(simItemGarmentState.branchId, ids.branchId), eq(simItemGarmentState.itemId, ids.shirtId)),
      );
    const corrupted = await rawGarmentRow(ids.branchId, ids.shirtId);

    // Applying on top of the degraded read would record an `after` that does
    // not follow from the previous event's — corrupt history, not a repair.
    const outcome = await applyOperation(ids.branchId, ids, "operate on a corrupt row", {
      kind: "set_roll",
      garmentId: ids.shirtId,
      partId: "sleeve_right",
      degree: "moderate",
    });
    expectRejected(outcome, "operation_rejected", "unreadable row");
    expect(outcome).toMatchObject({ publicReason: "garment_op.state_unreadable" });

    // The corrupt row is left for an operator; the event stream is untouched,
    // which is what makes a rebuild able to repair it.
    expect(await rawGarmentRow(ids.branchId, ids.shirtId)).toEqual(corrupted);
    expect((await readBranchEvents(ids.branchId)).length).toBe(eventsBefore.length);

    // And a rebuild from those events does repair it: the fold lands on the
    // last recorded `after`, which is what the row should have held.
    const replayed = await replayedGarmentState(ids.branchId);
    const entry = replayed.items.find((item) => item.itemId === ids.shirtId);
    expect(entry?.presentation).not.toEqual("nonsense");
    const last = eventsBefore.at(-1);
    if (last?.type !== "garment_operation_applied") throw new Error("expected a garment event last");
    expect(entry?.presentation).toEqual(last.payload.after.presentation);
  });

  it("refuses an actor who cannot reach the garment, and one who does not control it", async () => {
    const ids = makeCase();
    await seedCase(ids);

    const before = await rawGarmentRow(ids.branchId, ids.shirtId);
    expect(before).toBeUndefined();

    // Worn by someone else: the other actor is co-located but it is not theirs.
    expectRejected(
      await submitDurableApplyGarmentOperation(
        simCommand({
          branchId: ids.branchId,
          name: "reach-into-another-wardrobe",
          type: "apply_garment_operation",
          principal: npcPrincipal(ids.otherActorId),
          payload: {
            actorId: ids.otherActorId,
            itemId: ids.shirtId,
            operation: { kind: "set_roll", garmentId: ids.shirtId, partId: "sleeve_left", degree: "moderate" },
          },
        }),
        ADMIT_AT_LOCKED_VERSION,
      ),
      "worn_by_other",
      "another actor's garment",
    );

    // A principal directing an actor it does not control.
    expectRejected(
      await submitDurableApplyGarmentOperation(
        simCommand({
          branchId: ids.branchId,
          name: "direct-an-uncontrolled-actor",
          type: "apply_garment_operation",
          principal: npcPrincipal(ids.otherActorId),
          payload: {
            actorId: ids.actorId,
            itemId: ids.shirtId,
            operation: { kind: "set_roll", garmentId: ids.shirtId, partId: "sleeve_left", degree: "moderate" },
          },
        }),
        ADMIT_AT_LOCKED_VERSION,
      ),
      "unauthorized_actor",
      "uncontrolled actor",
    );

    // Nothing was created by a refusal: an absent row is still absent.
    expect(await rawGarmentRow(ids.branchId, ids.shirtId)).toBeUndefined();
    expect(await readBranchEvents(ids.branchId)).toEqual([]);
  });
});
