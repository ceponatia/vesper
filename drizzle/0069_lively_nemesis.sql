-- E5.3 slice 1 (engine.spec §26): the Gate 1 item-transfer lane's dev/test data
-- cannot satisfy the new locus-model NOT NULL/CHECK constraints below, and it
-- has no app-route callers or production data (only tests/soak use it) — so it
-- is disposable, not migrated in place.
DELETE FROM "sim_item_transfer_feed";--> statement-breakpoint
DELETE FROM "sim_item_holdings";--> statement-breakpoint
DELETE FROM "sim_items";--> statement-breakpoint
ALTER TABLE "sim_item_holdings" ADD COLUMN "locus_kind" text NOT NULL;--> statement-breakpoint
ALTER TABLE "sim_item_holdings" ADD COLUMN "actor_id" text;--> statement-breakpoint
ALTER TABLE "sim_item_holdings" ADD COLUMN "slot_key" text;--> statement-breakpoint
ALTER TABLE "sim_item_holdings" ADD COLUMN "container_item_id" text;--> statement-breakpoint
ALTER TABLE "sim_item_holdings" ADD COLUMN "zone_id" text;--> statement-breakpoint
ALTER TABLE "sim_item_holdings" ADD COLUMN "gone_basis" text;--> statement-breakpoint
ALTER TABLE "sim_item_transfer_feed" ADD COLUMN "event_kind" text NOT NULL;--> statement-breakpoint
ALTER TABLE "sim_item_transfer_feed" ADD COLUMN "from_locus" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "sim_item_transfer_feed" ADD COLUMN "to_locus" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "sim_items" ADD COLUMN "material_kind_key" text;--> statement-breakpoint
ALTER TABLE "sim_items" ADD COLUMN "owner_actor_id" text;--> statement-breakpoint
ALTER TABLE "sim_items" ADD COLUMN "container_capacity_count" bigint;--> statement-breakpoint
ALTER TABLE "sim_items" ADD COLUMN "container_access" jsonb;--> statement-breakpoint
ALTER TABLE "sim_items" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
-- Drizzle cannot express FK deferrability (schema.ts comments on the three
-- sim_item_holdings_*_fk constraints below) — the 0054 precedent, hand-applied
-- to all three here: a world/branch teardown cascades sim_characters,
-- sim_items, and sim_zones from the SAME sim_branches delete, and Postgres
-- does not order sibling cascades against each other, so a non-deferred FK
-- can fire before the row it references is (about to be) gone too.
ALTER TABLE "sim_item_holdings" ADD CONSTRAINT "sim_item_holdings_actor_fk" FOREIGN KEY ("branch_id","actor_id") REFERENCES "public"."sim_characters"("branch_id","character_id") ON DELETE no action ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE "sim_item_holdings" ADD CONSTRAINT "sim_item_holdings_container_item_fk" FOREIGN KEY ("branch_id","container_item_id") REFERENCES "public"."sim_items"("branch_id","item_id") ON DELETE no action ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE "sim_item_holdings" ADD CONSTRAINT "sim_item_holdings_zone_fk" FOREIGN KEY ("branch_id","zone_id") REFERENCES "public"."sim_zones"("branch_id","zone_id") ON DELETE no action ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
CREATE INDEX "sim_item_holdings_container_item_idx" ON "sim_item_holdings" USING btree ("branch_id","container_item_id");--> statement-breakpoint
CREATE INDEX "sim_item_holdings_actor_idx" ON "sim_item_holdings" USING btree ("branch_id","actor_id");--> statement-breakpoint
CREATE INDEX "sim_item_holdings_zone_idx" ON "sim_item_holdings" USING btree ("branch_id","zone_id");--> statement-breakpoint
ALTER TABLE "sim_item_holdings" ADD CONSTRAINT "sim_item_holdings_held_shape" CHECK ("sim_item_holdings"."locus_kind" <> 'held' OR ("sim_item_holdings"."actor_id" IS NOT NULL AND "sim_item_holdings"."slot_key" IS NULL AND "sim_item_holdings"."container_item_id" IS NULL AND "sim_item_holdings"."zone_id" IS NULL AND "sim_item_holdings"."gone_basis" IS NULL));--> statement-breakpoint
ALTER TABLE "sim_item_holdings" ADD CONSTRAINT "sim_item_holdings_worn_shape" CHECK ("sim_item_holdings"."locus_kind" <> 'worn' OR ("sim_item_holdings"."actor_id" IS NOT NULL AND "sim_item_holdings"."slot_key" IS NOT NULL AND "sim_item_holdings"."container_item_id" IS NULL AND "sim_item_holdings"."zone_id" IS NULL AND "sim_item_holdings"."gone_basis" IS NULL));--> statement-breakpoint
ALTER TABLE "sim_item_holdings" ADD CONSTRAINT "sim_item_holdings_container_shape" CHECK ("sim_item_holdings"."locus_kind" <> 'container' OR ("sim_item_holdings"."container_item_id" IS NOT NULL AND "sim_item_holdings"."actor_id" IS NULL AND "sim_item_holdings"."slot_key" IS NULL AND "sim_item_holdings"."zone_id" IS NULL AND "sim_item_holdings"."gone_basis" IS NULL));--> statement-breakpoint
ALTER TABLE "sim_item_holdings" ADD CONSTRAINT "sim_item_holdings_zone_shape" CHECK ("sim_item_holdings"."locus_kind" <> 'zone' OR ("sim_item_holdings"."zone_id" IS NOT NULL AND "sim_item_holdings"."actor_id" IS NULL AND "sim_item_holdings"."slot_key" IS NULL AND "sim_item_holdings"."container_item_id" IS NULL AND "sim_item_holdings"."gone_basis" IS NULL));--> statement-breakpoint
ALTER TABLE "sim_item_holdings" ADD CONSTRAINT "sim_item_holdings_gone_shape" CHECK ("sim_item_holdings"."locus_kind" <> 'gone' OR ("sim_item_holdings"."gone_basis" IS NOT NULL AND "sim_item_holdings"."actor_id" IS NULL AND "sim_item_holdings"."slot_key" IS NULL AND "sim_item_holdings"."container_item_id" IS NULL AND "sim_item_holdings"."zone_id" IS NULL));--> statement-breakpoint
ALTER TABLE "sim_items" ADD CONSTRAINT "sim_items_container_capacity_safe" CHECK ("sim_items"."container_capacity_count" IS NULL OR ("sim_items"."container_capacity_count" >= 0 AND "sim_items"."container_capacity_count" <= 9007199254740991));--> statement-breakpoint
ALTER TABLE "sim_items" ADD CONSTRAINT "sim_items_container_shape" CHECK (("sim_items"."container_capacity_count" IS NULL) = ("sim_items"."container_access" IS NULL));