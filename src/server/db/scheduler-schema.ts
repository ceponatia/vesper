import { sql } from "drizzle-orm";
import { bigint, check, foreignKey, index, integer, jsonb, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";
import type { TransferItemCommand } from "@/contracts/simulation/item-transfer";
import { simBranches, simWorlds } from "./schema";

export const simTriggers = pgTable(
  "sim_triggers",
  {
    id: text("id").primaryKey(),
    worldId: text("world_id").notNull(),
    branchId: text("branch_id").notNull(),
    kind: text("kind", { enum: ["scheduled_transfer_item"] }).notNull(),
    schemaVersion: integer("schema_version").notNull(),
    dueStorySecond: bigint("due_story_second", { mode: "number" }).notNull(),
    stableOrder: bigint("stable_order", { mode: "number" }).notNull(),
    uniquenessKey: text("uniqueness_key").notNull(),
    payload: jsonb("payload").$type<{ command: TransferItemCommand }>().notNull(),
    state: text("state", { enum: ["pending", "processing", "completed", "failed"] })
      .notNull()
      .default("pending"),
    attempts: integer("attempts").notNull().default(0),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    resultCommandId: text("result_command_id"),
    lastError: text("last_error"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "sim_triggers_branch_world_fk",
      columns: [t.branchId, t.worldId],
      foreignColumns: [simBranches.id, simBranches.worldId],
    }).onDelete("cascade"),
    unique("sim_triggers_branch_uniqueness_unique").on(t.branchId, t.uniquenessKey),
    unique("sim_triggers_branch_order_unique").on(t.branchId, t.stableOrder),
    index("sim_triggers_claim_idx").on(t.state, t.availableAt, t.dueStorySecond, t.stableOrder),
    index("sim_triggers_branch_due_idx").on(t.branchId, t.dueStorySecond, t.stableOrder),
    check("sim_triggers_schema_version_positive", sql`${t.schemaVersion} > 0`),
    check(
      "sim_triggers_due_story_second_safe",
      sql`${t.dueStorySecond} >= 0 AND ${t.dueStorySecond} <= 9007199254740991`,
    ),
    check(
      "sim_triggers_stable_order_safe",
      sql`${t.stableOrder} > 0 AND ${t.stableOrder} <= 9007199254740991`,
    ),
    check("sim_triggers_attempts_nonnegative", sql`${t.attempts} >= 0`),
    check(
      "sim_triggers_processing_has_lease",
      sql`${t.state} <> 'processing' OR (${t.leaseOwner} IS NOT NULL AND ${t.leaseExpiresAt} IS NOT NULL)`,
    ),
  ],
);

void simWorlds;
