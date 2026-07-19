-- CASCADE already drops sim_item_holdings_container_fk (it references this
-- table); a separate ALTER TABLE ... DROP CONSTRAINT for it would 42704 on an
-- already-gone constraint, so drizzle-kit's redundant statement is removed.
ALTER TABLE "sim_holding_containers" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "sim_holding_containers" CASCADE;--> statement-breakpoint
DROP INDEX "sim_item_holdings_container_idx";--> statement-breakpoint
ALTER TABLE "sim_characters" DROP COLUMN "observed_container_ids";--> statement-breakpoint
ALTER TABLE "sim_item_holdings" DROP COLUMN "holding_container_id";--> statement-breakpoint
ALTER TABLE "sim_item_transfer_feed" DROP COLUMN "from_container_id";--> statement-breakpoint
ALTER TABLE "sim_item_transfer_feed" DROP COLUMN "to_container_id";