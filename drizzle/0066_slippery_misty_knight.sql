CREATE TABLE "sim_memory_documents" (
	"branch_id" text NOT NULL,
	"doc_id" text NOT NULL,
	"source_kind" text NOT NULL,
	"source_id" text NOT NULL,
	"source_event_id" text,
	"first_sequence" bigint NOT NULL,
	"last_sequence" bigint NOT NULL,
	"story_second" bigint NOT NULL,
	"visibility" text NOT NULL,
	"eligible_actor_ids" jsonb NOT NULL,
	"about_entity_ids" jsonb NOT NULL,
	"valid_from_second" bigint NOT NULL,
	"valid_until_second" bigint,
	"superseded_at_second" bigint,
	"epistemic_label" text NOT NULL,
	"confidence_fixed_point" integer,
	"text" text NOT NULL,
	"embedding" vector(1536),
	"embedding_model" text,
	"doc_schema_version" integer NOT NULL,
	"updated_sequence" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sim_memory_documents_branch_doc_pk" PRIMARY KEY("branch_id","doc_id"),
	CONSTRAINT "sim_memory_documents_sequence_order" CHECK ("sim_memory_documents"."first_sequence" >= 0 AND "sim_memory_documents"."last_sequence" >= "sim_memory_documents"."first_sequence"),
	CONSTRAINT "sim_memory_documents_embedding_named" CHECK (("sim_memory_documents"."embedding" IS NULL) = ("sim_memory_documents"."embedding_model" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "sim_memory_documents" ADD CONSTRAINT "sim_memory_documents_branch_id_sim_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."sim_branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sim_memory_documents_branch_kind_idx" ON "sim_memory_documents" USING btree ("branch_id","source_kind");--> statement-breakpoint
CREATE INDEX "sim_memory_documents_branch_sequence_idx" ON "sim_memory_documents" USING btree ("branch_id","first_sequence");