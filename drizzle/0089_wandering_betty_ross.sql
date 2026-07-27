CREATE TABLE "sim_provisioning_requests" (
	"owner_id" text NOT NULL,
	"request_id" text NOT NULL,
	"payload_hash" text NOT NULL,
	"state" text DEFAULT 'requested' NOT NULL,
	"world_id" text,
	"branch_id" text,
	"chat_id" text,
	"response" jsonb,
	"http_status" integer,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sim_provisioning_requests_owner_request_pk" PRIMARY KEY("owner_id","request_id")
);
--> statement-breakpoint
ALTER TABLE "sim_provisioning_requests" ADD CONSTRAINT "sim_provisioning_requests_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sim_provisioning_requests_owner_state_idx" ON "sim_provisioning_requests" USING btree ("owner_id","state");