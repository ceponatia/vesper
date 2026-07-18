CREATE TABLE "sim_access_grants" (
	"branch_id" text NOT NULL,
	"grant_id" text NOT NULL,
	"grantee_actor_id" text NOT NULL,
	"location_id" text NOT NULL,
	"zone_ids" jsonb,
	"basis" text NOT NULL,
	"valid_from" bigint NOT NULL,
	"valid_until" bigint,
	"revoked_at" bigint,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sim_access_grants_branch_grant_pk" PRIMARY KEY("branch_id","grant_id")
);
--> statement-breakpoint
ALTER TABLE "sim_worlds" ADD COLUMN "permits_trespass" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sim_access_grants" ADD CONSTRAINT "sim_access_grants_branch_id_sim_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."sim_branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sim_access_grants_branch_actor_idx" ON "sim_access_grants" USING btree ("branch_id","grantee_actor_id");