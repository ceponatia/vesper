CREATE TABLE "sim_engagements" (
	"branch_id" text NOT NULL,
	"engagement_id" text NOT NULL,
	"participant_ids" jsonb NOT NULL,
	"channel" text NOT NULL,
	"location_id" text,
	"zone_id" text,
	"state" text NOT NULL,
	"opened_at" bigint NOT NULL,
	"attention_claim" jsonb NOT NULL,
	"source_command_id" text NOT NULL,
	"updated_sequence" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sim_engagements_branch_engagement_pk" PRIMARY KEY("branch_id","engagement_id"),
	CONSTRAINT "sim_engagements_co_present_has_zone" CHECK ("sim_engagements"."channel" <> 'co_present' OR "sim_engagements"."zone_id" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "sim_engagements" ADD CONSTRAINT "sim_engagements_branch_id_sim_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."sim_branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sim_engagements_branch_state_idx" ON "sim_engagements" USING btree ("branch_id","state");