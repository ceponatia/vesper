CREATE TABLE "character_creation_requests" (
	"owner_id" text NOT NULL,
	"request_id" text NOT NULL,
	"payload_hash" text NOT NULL,
	"character_id" text NOT NULL,
	"response" jsonb NOT NULL,
	"http_status" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "character_creation_requests_owner_request_pk" PRIMARY KEY("owner_id","request_id")
);
--> statement-breakpoint
ALTER TABLE "character_creation_requests" ADD CONSTRAINT "character_creation_requests_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "character_creation_requests" ADD CONSTRAINT "character_creation_requests_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "character_creation_requests_character_idx" ON "character_creation_requests" USING btree ("character_id");