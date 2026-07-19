CREATE TABLE "sim_assertions" (
	"branch_id" text NOT NULL,
	"assertion_id" text NOT NULL,
	"proposition_key" text NOT NULL,
	"subject_ids" jsonb NOT NULL,
	"claimed_value" jsonb NOT NULL,
	"source_actor_id" text,
	"source_event_id" text,
	"source_event_sequence" bigint,
	"asserted_at" bigint NOT NULL,
	"valid_from" bigint,
	"valid_until" bigint,
	"status" text NOT NULL,
	"status_changed_at" bigint,
	"status_cause_event_id" text,
	"derivation_version" text NOT NULL,
	"updated_sequence" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sim_assertions_branch_assertion_pk" PRIMARY KEY("branch_id","assertion_id"),
	CONSTRAINT "sim_assertions_asserted_at_safe" CHECK ("sim_assertions"."asserted_at" >= 0 AND "sim_assertions"."asserted_at" <= 9007199254740991),
	CONSTRAINT "sim_assertions_validity_order" CHECK ("sim_assertions"."valid_from" IS NULL OR "sim_assertions"."valid_until" IS NULL OR "sim_assertions"."valid_from" <= "sim_assertions"."valid_until")
);
--> statement-breakpoint
CREATE TABLE "sim_beliefs" (
	"branch_id" text NOT NULL,
	"belief_id" text NOT NULL,
	"holder_actor_id" text NOT NULL,
	"assertion_id" text NOT NULL,
	"confidence_fixed_point" integer NOT NULL,
	"basis_observation_ids" jsonb NOT NULL,
	"learned_from_actor_ids" jsonb NOT NULL,
	"believed_from" bigint NOT NULL,
	"believed_until" bigint,
	"status" text NOT NULL,
	"status_cause_event_id" text,
	"source_event_id" text NOT NULL,
	"source_event_sequence" bigint NOT NULL,
	"derivation_version" text NOT NULL,
	"updated_sequence" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sim_beliefs_branch_belief_pk" PRIMARY KEY("branch_id","belief_id"),
	CONSTRAINT "sim_beliefs_confidence_range" CHECK ("sim_beliefs"."confidence_fixed_point" >= 0 AND "sim_beliefs"."confidence_fixed_point" <= 10000),
	CONSTRAINT "sim_beliefs_sequence_safe" CHECK ("sim_beliefs"."source_event_sequence" > 0 AND "sim_beliefs"."source_event_sequence" <= 9007199254740991),
	CONSTRAINT "sim_beliefs_interval_order" CHECK ("sim_beliefs"."believed_until" IS NULL OR "sim_beliefs"."believed_from" <= "sim_beliefs"."believed_until")
);
--> statement-breakpoint
ALTER TABLE "sim_assertions" ADD CONSTRAINT "sim_assertions_branch_id_sim_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."sim_branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_beliefs" ADD CONSTRAINT "sim_beliefs_branch_id_sim_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."sim_branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_beliefs" ADD CONSTRAINT "sim_beliefs_branch_assertion_fk" FOREIGN KEY ("branch_id","assertion_id") REFERENCES "public"."sim_assertions"("branch_id","assertion_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sim_assertions_branch_proposition_idx" ON "sim_assertions" USING btree ("branch_id","proposition_key");--> statement-breakpoint
CREATE INDEX "sim_assertions_branch_source_event_idx" ON "sim_assertions" USING btree ("branch_id","source_event_id");--> statement-breakpoint
CREATE INDEX "sim_beliefs_branch_holder_status_idx" ON "sim_beliefs" USING btree ("branch_id","holder_actor_id","status");--> statement-breakpoint
CREATE INDEX "sim_beliefs_branch_assertion_idx" ON "sim_beliefs" USING btree ("branch_id","assertion_id");