CREATE TABLE "sim_item_garment_state" (
	"branch_id" text NOT NULL,
	"item_id" text NOT NULL,
	"presentation" jsonb NOT NULL,
	"condition" jsonb NOT NULL,
	"updated_sequence" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sim_item_garment_state_branch_item_pk" PRIMARY KEY("branch_id","item_id"),
	CONSTRAINT "sim_item_garment_state_updated_sequence_safe" CHECK ("sim_item_garment_state"."updated_sequence" >= 0 AND "sim_item_garment_state"."updated_sequence" <= 9007199254740991)
);
--> statement-breakpoint
ALTER TABLE "sim_items" ADD COLUMN "garment_blueprint" jsonb;--> statement-breakpoint
ALTER TABLE "sim_item_garment_state" ADD CONSTRAINT "sim_item_garment_state_item_fk" FOREIGN KEY ("branch_id","item_id") REFERENCES "public"."sim_items"("branch_id","item_id") ON DELETE cascade ON UPDATE no action;