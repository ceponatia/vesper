import { describe, expect, it } from "vitest";
import { garmentOperationAppliedEventSchema } from "../contracts/garments";
import { itemTransferredEventSchema } from "../contracts/materials";
import { bindSimEnvelopes } from "../test-support/sim-envelopes";
import {
  applyItemGarmentStateEvent,
  emptyItemGarmentStateSeed,
  replayItemGarmentStateHistory,
  sortItemGarmentStateProjection,
} from "./garments";

/**
 * #296 — the garment-state fold.
 *
 * The suite's centre of gravity is the record-the-result law: the projector
 * must LAND on the `after` an event recorded, never on anything it recomputes.
 * That is what makes a fork of a dressed world rebuild identically, and it is
 * the one property a wrong implementation would still pass a "does the row
 * change?" test with.
 */
const WORLD = "world-296-garments";
const BRANCH = "branch-296-garments";
const RULESET = "e296-garment-test-v1";
const ORIGIN_SECOND = 40_000;
const SHIRT = "shirt-1";
const SCARF = "scarf-1";
const ACTOR = "mara";

const env = bindSimEnvelopes({ worldId: WORLD, branchId: BRANCH, rulesetVersion: RULESET });

/** A presentation blob shaped like the app's, opaque to this package by design. */
function presentation(roll: Record<string, number>): Record<string, unknown> {
  return { closure: {}, roll, tuck: {}, displacement: [] };
}

function condition(wetness: number, atMinutes: number): Record<string, unknown> {
  return {
    base: { wetness, cleanliness: 10_000, crease_load: 0, wear: 0 },
    regionOverrides: {},
    deposits: [],
    damageMarks: [],
    integratedAtMinutes: atMinutes,
  };
}

interface AppliedSpec {
  sequence: number;
  itemId: string;
  commandId?: string;
  storySecond?: number;
  roll?: Record<string, number>;
  wetness?: number;
}

function applied(spec: AppliedSpec) {
  const storySecond = spec.storySecond ?? ORIGIN_SECOND;
  const atStoryMinute = Math.floor(storySecond / 60);
  return env.event(garmentOperationAppliedEventSchema, {
    type: "garment_operation_applied",
    idSlug: `garment-${spec.itemId}`,
    sequence: spec.sequence,
    storySecond,
    actorIds: [ACTOR],
    entityIds: [spec.itemId],
    commandId: spec.commandId ?? `cmd-garment-${spec.sequence}`,
    payload: {
      actorId: ACTOR,
      itemId: spec.itemId,
      operation: { kind: "set_roll", garmentId: spec.itemId, partId: "sleeve_left", degree: "moderate" },
      after: {
        presentation: presentation(spec.roll ?? {}),
        condition: condition(spec.wetness ?? 0, atStoryMinute),
      },
      derived: { atStoryMinute, blueprintHash: "hash-shirt" },
    },
  });
}

describe("#296 — applyItemGarmentStateEvent", () => {
  it("sets the named item's recorded result and advances the boundary", () => {
    const seed = emptyItemGarmentStateSeed(BRANCH, ORIGIN_SECOND);
    const event = applied({ sequence: 1, itemId: SHIRT, roll: { sleeve_left: 5_000 }, storySecond: ORIGIN_SECOND + 60 });

    const next = applyItemGarmentStateEvent(seed, event);
    expect(next.items).toEqual([
      {
        itemId: SHIRT,
        presentation: presentation({ sleeve_left: 5_000 }),
        condition: condition(0, Math.floor((ORIGIN_SECOND + 60) / 60)),
      },
    ]);
    expect(next.headSequence).toBe(1);
    expect(next.storySecond).toBe(ORIGIN_SECOND + 60);
  });

  it("REPLACES an item's entry rather than merging or duplicating it", () => {
    const seed = emptyItemGarmentStateSeed(BRANCH, ORIGIN_SECOND);
    let projection = applyItemGarmentStateEvent(
      seed,
      applied({ sequence: 1, itemId: SHIRT, roll: { sleeve_left: 5_000 }, wetness: 4_000 }),
    );
    projection = applyItemGarmentStateEvent(projection, applied({ sequence: 2, itemId: SHIRT }));

    // The second event recorded an empty roll and a dry base, so that is the
    // state — a fold that merged channels would still show the earlier roll.
    expect(projection.items).toHaveLength(1);
    expect(projection.items[0]).toEqual({
      itemId: SHIRT,
      presentation: presentation({}),
      condition: condition(0, Math.floor(ORIGIN_SECOND / 60)),
    });
  });

  it("re-applies the RECORDED result rather than re-deriving one", () => {
    // Two events carrying the SAME operation and different results. A projector
    // that re-ran the reducer would land on one value twice; this one lands on
    // whatever each event recorded, which is the whole point of the law.
    const seed = emptyItemGarmentStateSeed(BRANCH, ORIGIN_SECOND);
    const first = applied({ sequence: 1, itemId: SHIRT, roll: { sleeve_left: 2_500 } });
    const second = applied({ sequence: 2, itemId: SHIRT, roll: { sleeve_left: 9_000 } });
    expect(first.payload.operation).toEqual(second.payload.operation);

    const projection = applyItemGarmentStateEvent(applyItemGarmentStateEvent(seed, first), second);
    expect(projection.items[0]?.presentation).toEqual(presentation({ sleeve_left: 9_000 }));
  });

  it("passes a non-garment event through as a bare boundary advance", () => {
    // `item_transferred` is the pointed case: doffing a jacket moves it and must
    // not forget that it was left unbuttoned.
    const seed = emptyItemGarmentStateSeed(BRANCH, ORIGIN_SECOND);
    const dressed = applyItemGarmentStateEvent(seed, applied({ sequence: 1, itemId: SHIRT, roll: { sleeve_left: 7_500 } }));

    const doff = env.event(itemTransferredEventSchema, {
      type: "item_transferred",
      sequence: 2,
      storySecond: ORIGIN_SECOND + 120,
      actorIds: [ACTOR],
      entityIds: [SHIRT],
      commandId: "cmd-doff",
      overrides: { schemaVersion: 2 },
      payload: {
        actorId: ACTOR,
        itemId: SHIRT,
        fromLocus: { kind: "worn", actorId: ACTOR, slotKey: "top-0" },
        toLocus: { kind: "held", actorId: ACTOR },
        againstOwnership: false,
      },
    });

    const moved = applyItemGarmentStateEvent(dressed, doff);
    expect(moved.items).toEqual(dressed.items);
    expect(moved.headSequence).toBe(2);
    expect(moved.storySecond).toBe(ORIGIN_SECOND + 120);
  });
});

describe("#296 — replayItemGarmentStateHistory", () => {
  it("folds a mixed stream identically live and replayed, and versions by distinct command", () => {
    const seed = emptyItemGarmentStateSeed(BRANCH, ORIGIN_SECOND);
    const events = [
      applied({ sequence: 1, itemId: SHIRT, commandId: "cmd-roll", roll: { sleeve_left: 5_000 } }),
      applied({ sequence: 2, itemId: SCARF, commandId: "cmd-wet", wetness: 6_000 }),
      applied({ sequence: 3, itemId: SHIRT, commandId: "cmd-roll-2", roll: { sleeve_left: 9_000 } }),
    ];

    let live = seed;
    for (const event of events) live = applyItemGarmentStateEvent(live, event);

    const replayed = replayItemGarmentStateHistory({ seed, events });
    // Live folding never bumps version (that is replay's job) — normalize it
    // before comparing state, the parity shape material-condition.test.ts uses.
    expect(sortItemGarmentStateProjection({ ...live, version: replayed.version })).toEqual(replayed);
    expect(replayed.version).toBe(3);
    expect(replayed.items.map((item) => item.itemId)).toEqual([SCARF, SHIRT]);
  });

  it("counts DISTINCT command ids, so one command's events version the branch once", () => {
    const seed = emptyItemGarmentStateSeed(BRANCH, ORIGIN_SECOND);
    const replayed = replayItemGarmentStateHistory({
      seed,
      events: [
        applied({ sequence: 1, itemId: SHIRT, commandId: "cmd-one" }),
        applied({ sequence: 2, itemId: SCARF, commandId: "cmd-one" }),
      ],
    });
    expect(replayed.version).toBe(1);
    expect(replayed.items).toHaveLength(2);
  });

  it("rejects a sequence gap", () => {
    const seed = emptyItemGarmentStateSeed(BRANCH, ORIGIN_SECOND);
    expect(() =>
      replayItemGarmentStateHistory({ seed, events: [applied({ sequence: 3, itemId: SHIRT })] }),
    ).toThrow(/sequence gap/u);
  });

  it("orders out-of-order input by sequence before folding", () => {
    const seed = emptyItemGarmentStateSeed(BRANCH, ORIGIN_SECOND);
    const first = applied({ sequence: 1, itemId: SHIRT, commandId: "cmd-a", roll: { sleeve_left: 2_500 } });
    const second = applied({ sequence: 2, itemId: SHIRT, commandId: "cmd-b", roll: { sleeve_left: 9_000 } });
    const replayed = replayItemGarmentStateHistory({ seed, events: [second, first] });
    expect(replayed.items[0]?.presentation).toEqual(presentation({ sleeve_left: 9_000 }));
  });

  it("seeds empty: a branch that dressed nobody carries no rows", () => {
    const seed = emptyItemGarmentStateSeed(BRANCH, ORIGIN_SECOND);
    const replayed = replayItemGarmentStateHistory({ seed, events: [] });
    expect(replayed).toEqual(seed);
    expect(replayed.items).toEqual([]);
    expect(replayed.storySecond).toBe(ORIGIN_SECOND);
  });
});
