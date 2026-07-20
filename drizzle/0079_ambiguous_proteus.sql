CREATE TABLE "sim_actor_lods" (
	"branch_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"simulation_lod" text NOT NULL,
	"inference_lod" text NOT NULL,
	"registry_version" text NOT NULL,
	"assigned_at_story_second" bigint NOT NULL,
	"updated_sequence" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sim_actor_lods_branch_actor_pk" PRIMARY KEY("branch_id","actor_id")
);
--> statement-breakpoint
ALTER TABLE "sim_actor_lods" ADD CONSTRAINT "sim_actor_lods_branch_id_sim_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."sim_branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_actor_lods" ADD CONSTRAINT "sim_actor_lods_actor_fk" FOREIGN KEY ("branch_id","actor_id") REFERENCES "public"."sim_characters"("branch_id","character_id") ON DELETE no action ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;