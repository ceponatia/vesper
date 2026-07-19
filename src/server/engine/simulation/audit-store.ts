import { and, eq } from "drizzle-orm";
import {
  itemPlacementExplanationSchema,
  type ItemPlacementExplanation,
  type SimulationBranchEvent,
} from "@/contracts/simulation/branching";
import { commandPrincipalSchema } from "@/contracts/simulation/envelopes";
import { itemIdSchema, worldBranchIdSchema } from "@/contracts/simulation/identity";
import { db, simCommands, simItemHoldings, simTriggers, type Db } from "@/server/db";
import { loadBranchAncestry, readBranchAncestryEvents } from "./branch-store";
import { itemLocusFromHoldingRow } from "./material-store";

export interface ExplainOptions {
  database?: Db;
}

/**
 * Why is this item where it is (spec §35.3)? Walks back from the projection
 * fact through the event that placed it, the command that produced the event,
 * and — when the scheduler dispatched that command — the trigger, its setting
 * event, and the setting command. Read-only over immutable records; the chain
 * resolves through branch ancestry, so a fork child explains inherited facts
 * by pointing at its ancestors' history.
 */
export async function explainItemPlacement(
  rawBranchId: string,
  rawItemId: string,
  options: ExplainOptions = {},
): Promise<ItemPlacementExplanation> {
  const database = options.database ?? db();
  const branchId = worldBranchIdSchema.parse(rawBranchId);
  const itemId = itemIdSchema.parse(rawItemId);

  return database.transaction(
    async (tx) => {
      const ancestry = await loadBranchAncestry(tx, branchId);
      const [holding] = await tx
        .select()
        .from(simItemHoldings)
        .where(and(eq(simItemHoldings.branchId, branchId), eq(simItemHoldings.itemId, itemId)))
        .limit(1);
      if (!holding) throw new Error("Item not found on this branch");

      const locus = itemLocusFromHoldingRow(holding);
      const base = { branchId, itemId, locus };

      // `updatedSequence` is the item's last-TOUCHED sequence (a placement move
      // or an ownership reassignment — branch-store's fork materialization
      // stamps it from all three material event types), so the placing event is
      // not always exactly at that sequence. Search back through the
      // ancestry-bounded window for the latest item_transferred/item_destroyed
      // event naming this item; an ownership-only touch leaves none, and the
      // locus is then still explained by the (unrecorded) seed.
      const candidates =
        holding.updatedSequence === 0
          ? []
          : await readBranchAncestryEvents(tx, ancestry, {
              throughSequence: holding.updatedSequence,
              types: ["item_transferred", "item_destroyed"],
            });
      const event = candidates
        .filter(
          (
            candidate,
          ): candidate is Extract<SimulationBranchEvent, { type: "item_transferred" | "item_destroyed" }> =>
            (candidate.type === "item_transferred" || candidate.type === "item_destroyed") &&
            candidate.payload.itemId === itemId,
        )
        .at(-1);
      if (!event) {
        // Placement predates every recorded event: it is world-seed data the
        // event stream cannot explain (plan R3's accepted limitation).
        return itemPlacementExplanationSchema.parse({ ...base, origin: "seed" });
      }

      const explainedEvent = {
        id: event.id,
        branchId: event.branchId,
        sequence: event.sequence,
        storySecond: event.storySecond,
        type: event.type,
      };

      // Commands live on the branch that executed them, which for inherited
      // facts is the ancestor that recorded the event.
      const [commandRow] = await tx
        .select()
        .from(simCommands)
        .where(and(eq(simCommands.branchId, event.branchId), eq(simCommands.commandId, event.commandId)))
        .limit(1);
      const command = commandRow
        ? {
            id: commandRow.commandId,
            branchId: commandRow.branchId,
            type: commandRow.type,
            principal: commandPrincipalSchema.parse(commandRow.envelope.principal),
          }
        : undefined;

      const [triggerRow] = await tx
        .select()
        .from(simTriggers)
        .where(
          and(eq(simTriggers.branchId, event.branchId), eq(simTriggers.resultCommandId, event.commandId)),
        )
        .limit(1);

      let trigger: Record<string, unknown> | undefined;
      let schedulingEvent: Record<string, unknown> | undefined;
      let schedulingCommand: Record<string, unknown> | undefined;
      if (triggerRow) {
        trigger = {
          id: triggerRow.id,
          branchId: triggerRow.branchId,
          uniquenessKey: triggerRow.uniquenessKey,
          dueStorySecond: triggerRow.dueStorySecond,
        };
        const settingEvents = await readBranchAncestryEvents(tx, ancestry, {
          throughSequence: event.sequence,
          types: ["trigger_scheduled"],
        });
        const setting = settingEvents.find(
          (candidate): candidate is Extract<SimulationBranchEvent, { type: "trigger_scheduled" }> =>
            candidate.type === "trigger_scheduled" &&
            candidate.payload.uniquenessKey === triggerRow.uniquenessKey,
        );
        if (setting) {
          schedulingEvent = {
            id: setting.id,
            branchId: setting.branchId,
            sequence: setting.sequence,
            storySecond: setting.storySecond,
            type: setting.type,
          };
          const [settingCommandRow] = await tx
            .select()
            .from(simCommands)
            .where(
              and(
                eq(simCommands.branchId, setting.branchId),
                eq(simCommands.commandId, setting.commandId),
              ),
            )
            .limit(1);
          if (settingCommandRow) {
            schedulingCommand = {
              id: settingCommandRow.commandId,
              branchId: settingCommandRow.branchId,
              type: settingCommandRow.type,
              principal: commandPrincipalSchema.parse(settingCommandRow.envelope.principal),
            };
          }
        }
      }

      return itemPlacementExplanationSchema.parse({
        ...base,
        origin: "event",
        event: explainedEvent,
        ...(command ? { command } : {}),
        ...(trigger ? { trigger } : {}),
        ...(schedulingEvent ? { schedulingEvent } : {}),
        ...(schedulingCommand ? { schedulingCommand } : {}),
      });
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
