CREATE TABLE "sim_observations" (
	"branch_id" text NOT NULL,
	"observation_id" text NOT NULL,
	"source_event_id" text NOT NULL,
	"source_event_sequence" bigint NOT NULL,
	"witness_actor_id" text NOT NULL,
	"story_second" bigint NOT NULL,
	"channel" text NOT NULL,
	"evidence_class" text NOT NULL,
	"confidence_fixed_point" integer NOT NULL,
	"detail_tier" integer NOT NULL,
	"derivation_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sim_observations_branch_observation_pk" PRIMARY KEY("branch_id","observation_id"),
	CONSTRAINT "sim_observations_sequence_safe" CHECK ("sim_observations"."source_event_sequence" > 0 AND "sim_observations"."source_event_sequence" <= 9007199254740991),
	CONSTRAINT "sim_observations_story_second_safe" CHECK ("sim_observations"."story_second" >= 0 AND "sim_observations"."story_second" <= 9007199254740991),
	CONSTRAINT "sim_observations_confidence_range" CHECK ("sim_observations"."confidence_fixed_point" >= 0 AND "sim_observations"."confidence_fixed_point" <= 10000),
	CONSTRAINT "sim_observations_detail_tier_range" CHECK ("sim_observations"."detail_tier" >= 1 AND "sim_observations"."detail_tier" <= 3)
);
--> statement-breakpoint
ALTER TABLE "sim_observations" ADD CONSTRAINT "sim_observations_branch_id_sim_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."sim_branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sim_observations_branch_witness_sequence_idx" ON "sim_observations" USING btree ("branch_id","witness_actor_id","source_event_sequence");--> statement-breakpoint
CREATE INDEX "sim_observations_branch_event_idx" ON "sim_observations" USING btree ("branch_id","source_event_id");