CREATE TABLE "sim_relationship_ledger" (
	"branch_id" text NOT NULL,
	"entry_id" text NOT NULL,
	"kind" text NOT NULL,
	"from_actor_id" text NOT NULL,
	"to_actor_id" text NOT NULL,
	"provenance" text NOT NULL,
	"payload" jsonb NOT NULL,
	"detail" text,
	"source_event_id" text NOT NULL,
	"sequence" bigint NOT NULL,
	"story_second" bigint NOT NULL,
	"derivation_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sim_relationship_ledger_branch_entry_pk" PRIMARY KEY("branch_id","entry_id"),
	CONSTRAINT "sim_relationship_ledger_distinct_actors" CHECK ("sim_relationship_ledger"."from_actor_id" <> "sim_relationship_ledger"."to_actor_id")
);
--> statement-breakpoint
ALTER TABLE "sim_relationship_ledger" ADD CONSTRAINT "sim_relationship_ledger_branch_id_sim_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."sim_branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_relationship_ledger" ADD CONSTRAINT "sim_relationship_ledger_from_actor_fk" FOREIGN KEY ("branch_id","from_actor_id") REFERENCES "public"."sim_characters"("branch_id","character_id") ON DELETE no action ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE "sim_relationship_ledger" ADD CONSTRAINT "sim_relationship_ledger_to_actor_fk" FOREIGN KEY ("branch_id","to_actor_id") REFERENCES "public"."sim_characters"("branch_id","character_id") ON DELETE no action ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
CREATE INDEX "sim_relationship_ledger_branch_dyad_idx" ON "sim_relationship_ledger" USING btree ("branch_id","from_actor_id","to_actor_id");--> statement-breakpoint
CREATE INDEX "sim_relationship_ledger_branch_kind_idx" ON "sim_relationship_ledger" USING btree ("branch_id","kind");