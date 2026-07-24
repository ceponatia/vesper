CREATE TABLE "sim_command_requests" (
	"chat_id" text NOT NULL,
	"request_id" text NOT NULL,
	"kind" text NOT NULL,
	"payload_hash" text NOT NULL,
	"pre_clock_story_second" bigint,
	"state" text DEFAULT 'started' NOT NULL,
	"result_status" integer,
	"result_body" jsonb,
	"schema_tag" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sim_command_requests_chat_request_pk" PRIMARY KEY("chat_id","request_id")
);
--> statement-breakpoint
ALTER TABLE "sim_command_requests" ADD CONSTRAINT "sim_command_requests_chat_id_character_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."character_chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sim_command_requests_state_idx" ON "sim_command_requests" USING btree ("state","created_at");