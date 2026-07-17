CREATE TABLE "sim_commitments" (
	"branch_id" text NOT NULL,
	"commitment_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"kind" text NOT NULL,
	"destination_zone_id" text NOT NULL,
	"earliest_arrival" bigint,
	"target_arrival" bigint,
	"latest_arrival" bigint NOT NULL,
	"expected_duration_seconds" bigint,
	"priority" integer DEFAULT 0 NOT NULL,
	"flexibility" text NOT NULL,
	"preparation_seconds" bigint DEFAULT 0 NOT NULL,
	"reliability_buffer_seconds" bigint DEFAULT 0 NOT NULL,
	"notice_lead_seconds" bigint DEFAULT 0 NOT NULL,
	"status" text NOT NULL,
	"knowledge_source" jsonb NOT NULL,
	"source_command_id" text NOT NULL,
	"updated_sequence" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sim_commitments_branch_commitment_pk" PRIMARY KEY("branch_id","commitment_id"),
	CONSTRAINT "sim_commitments_latest_arrival_safe" CHECK ("sim_commitments"."latest_arrival" >= 0 AND "sim_commitments"."latest_arrival" <= 9007199254740991)
);
--> statement-breakpoint
CREATE TABLE "sim_temporal_pressures" (
	"branch_id" text NOT NULL,
	"pressure_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"source_commitment_id" text NOT NULL,
	"notice_at" bigint NOT NULL,
	"decide_by" bigint NOT NULL,
	"act_by" bigint NOT NULL,
	"severity" text NOT NULL,
	"acknowledged_at" bigint,
	"resolved_at" bigint,
	"updated_sequence" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sim_temporal_pressures_branch_pressure_pk" PRIMARY KEY("branch_id","pressure_id"),
	CONSTRAINT "sim_temporal_pressures_ordering" CHECK ("sim_temporal_pressures"."notice_at" <= "sim_temporal_pressures"."decide_by" AND "sim_temporal_pressures"."decide_by" <= "sim_temporal_pressures"."act_by")
);
--> statement-breakpoint
ALTER TABLE "sim_commitments" ADD CONSTRAINT "sim_commitments_branch_id_sim_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."sim_branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_commitments" ADD CONSTRAINT "sim_commitments_branch_zone_fk" FOREIGN KEY ("branch_id","destination_zone_id") REFERENCES "public"."sim_zones"("branch_id","zone_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_temporal_pressures" ADD CONSTRAINT "sim_temporal_pressures_branch_id_sim_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."sim_branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_temporal_pressures" ADD CONSTRAINT "sim_temporal_pressures_branch_commitment_fk" FOREIGN KEY ("branch_id","source_commitment_id") REFERENCES "public"."sim_commitments"("branch_id","commitment_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sim_commitments_branch_status_idx" ON "sim_commitments" USING btree ("branch_id","status");--> statement-breakpoint
CREATE INDEX "sim_temporal_pressures_branch_actor_idx" ON "sim_temporal_pressures" USING btree ("branch_id","actor_id");