ALTER TABLE "sim_commitments" ALTER COLUMN "destination_zone_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "sim_commitments" ADD COLUMN "promised_to_actor_id" text;--> statement-breakpoint
ALTER TABLE "sim_commitments" ADD COLUMN "repairs_commitment_id" text;--> statement-breakpoint
ALTER TABLE "sim_commitments" ADD CONSTRAINT "sim_commitments_repairs_commitment_fk" FOREIGN KEY ("branch_id","repairs_commitment_id") REFERENCES "public"."sim_commitments"("branch_id","commitment_id") ON DELETE no action ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;