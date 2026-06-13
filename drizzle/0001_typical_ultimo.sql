CREATE TABLE "participant_relationships" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"from_participant_id" text NOT NULL,
	"to_participant_id" text NOT NULL,
	"kind" text DEFAULT 'feeling' NOT NULL,
	"value" integer DEFAULT 0 NOT NULL,
	"stage" text DEFAULT 'stranger' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "facts" ADD COLUMN "canon" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "facts" ADD COLUMN "witnessed_by" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "scale" text DEFAULT 'room' NOT NULL;--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "affordances" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "session_links" ADD COLUMN "travel_minutes" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "session_links" ADD COLUMN "audibility" text;--> statement-breakpoint
ALTER TABLE "session_links" ADD COLUMN "access" jsonb DEFAULT '{"kind":"public"}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "session_links" ADD COLUMN "door_item_id" text;--> statement-breakpoint
ALTER TABLE "session_locations" ADD COLUMN "scale" text DEFAULT 'room' NOT NULL;--> statement-breakpoint
ALTER TABLE "session_locations" ADD COLUMN "area" text;--> statement-breakpoint
ALTER TABLE "session_locations" ADD COLUMN "affordances" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "session_participants" ADD COLUMN "tier" text DEFAULT 'minor' NOT NULL;--> statement-breakpoint
ALTER TABLE "world_cast" ADD COLUMN "tier" text DEFAULT 'minor' NOT NULL;--> statement-breakpoint
ALTER TABLE "world_links" ADD COLUMN "travel_minutes" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "world_links" ADD COLUMN "audibility" text;--> statement-breakpoint
ALTER TABLE "world_links" ADD COLUMN "access" jsonb DEFAULT '{"kind":"public"}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "world_links" ADD COLUMN "door_item_id" text;--> statement-breakpoint
ALTER TABLE "worlds" ADD COLUMN "player_start_world_location_id" text;--> statement-breakpoint
ALTER TABLE "participant_relationships" ADD CONSTRAINT "participant_relationships_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participant_relationships" ADD CONSTRAINT "participant_relationships_from_participant_id_session_participants_id_fk" FOREIGN KEY ("from_participant_id") REFERENCES "public"."session_participants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participant_relationships" ADD CONSTRAINT "participant_relationships_to_participant_id_session_participants_id_fk" FOREIGN KEY ("to_participant_id") REFERENCES "public"."session_participants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "participant_relationships_session_idx" ON "participant_relationships" USING btree ("session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "participant_relationships_edge_unique" ON "participant_relationships" USING btree ("session_id","from_participant_id","to_participant_id","kind");