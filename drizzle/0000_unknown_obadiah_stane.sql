CREATE TABLE "characters" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"name" text NOT NULL,
	"profile" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"avatar_image_id" text,
	"search_embedding" vector(1536),
	"embedder" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "episodes" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"turn_number" integer NOT NULL,
	"summary" text NOT NULL,
	"thread_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"embedding" vector(1536),
	"embedder" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "facts" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"kind" text NOT NULL,
	"verb" text,
	"subject_kind" text DEFAULT 'character' NOT NULL,
	"subject_id" text,
	"subject_name" text NOT NULL,
	"text" text NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"confidence" real DEFAULT 0.5 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"superseded_by_id" text,
	"source_turn_id" text,
	"embedding" vector(1536),
	"embedder" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"superseded_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "images" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"kind" text NOT NULL,
	"entity_kind" text,
	"entity_id" text,
	"session_id" text,
	"path" text NOT NULL,
	"prompt" text DEFAULT '' NOT NULL,
	"source_image_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "item_instances" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"item_id" text,
	"name" text NOT NULL,
	"snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"holder_participant_id" text,
	"worn" boolean DEFAULT false NOT NULL,
	"location_id" text,
	"container_instance_id" text,
	"position_note" text,
	"state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "item_instances_one_placement" CHECK ((
        (CASE WHEN "item_instances"."holder_participant_id" IS NOT NULL THEN 1 ELSE 0 END) +
        (CASE WHEN "item_instances"."location_id" IS NOT NULL THEN 1 ELSE 0 END) +
        (CASE WHEN "item_instances"."container_instance_id" IS NOT NULL THEN 1 ELSE 0 END)
      ) = 1),
	CONSTRAINT "item_instances_worn_needs_holder" CHECK (NOT "item_instances"."worn" OR "item_instances"."holder_participant_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "items" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"definition" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"image_id" text,
	"search_embedding" vector(1536),
	"embedder" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text,
	"type" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"runner_id" text,
	"heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "locations" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"ambient" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"image_id" text,
	"search_embedding" vector(1536),
	"embedder" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lore_chunks" (
	"id" text PRIMARY KEY NOT NULL,
	"world_id" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"category" text DEFAULT 'history' NOT NULL,
	"tier" text DEFAULT 'scene' NOT NULL,
	"visibility" text DEFAULT 'public' NOT NULL,
	"unlock_tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"location_tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"character_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"manually_unlocked" boolean DEFAULT false NOT NULL,
	"embedding" vector(1536),
	"embedder" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session_links" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"from_id" text NOT NULL,
	"to_id" text NOT NULL,
	"label" text
);
--> statement-breakpoint
CREATE TABLE "session_locations" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"location_id" text,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"ambient" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"emergent" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session_participants" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"character_id" text,
	"is_user" boolean DEFAULT false NOT NULL,
	"display_name" text NOT NULL,
	"role" text DEFAULT 'npc' NOT NULL,
	"snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"location_id" text,
	"avatar_image_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"world_id" text NOT NULL,
	"title" text NOT NULL,
	"embodied" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'ready' NOT NULL,
	"clock_minutes" bigint DEFAULT 0 NOT NULL,
	"runtime" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"brief" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"scene" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "turn_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"turn_id" text NOT NULL,
	"seq" integer DEFAULT 0 NOT NULL,
	"role" text NOT NULL,
	"speaker" text,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "turns" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"number" integer NOT NULL,
	"author" text DEFAULT 'player' NOT NULL,
	"speaker_participant_id" text,
	"input" text NOT NULL,
	"narration" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
	"minutes" integer DEFAULT 0 NOT NULL,
	"agent_results" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"diagnostics" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"model" text,
	"usage" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"role" text DEFAULT 'user' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "world_cast" (
	"id" text PRIMARY KEY NOT NULL,
	"world_id" text NOT NULL,
	"character_id" text NOT NULL,
	"role" text DEFAULT 'npc' NOT NULL,
	"start_world_location_id" text
);
--> statement-breakpoint
CREATE TABLE "world_items" (
	"id" text PRIMARY KEY NOT NULL,
	"world_id" text NOT NULL,
	"item_id" text NOT NULL,
	"world_location_id" text,
	"cast_id" text,
	"worn" boolean DEFAULT false NOT NULL,
	"container_world_item_id" text,
	"quantity" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "world_links" (
	"id" text PRIMARY KEY NOT NULL,
	"world_id" text NOT NULL,
	"from_world_location_id" text NOT NULL,
	"to_world_location_id" text NOT NULL,
	"label" text
);
--> statement-breakpoint
CREATE TABLE "world_locations" (
	"id" text PRIMARY KEY NOT NULL,
	"world_id" text NOT NULL,
	"location_id" text NOT NULL,
	"overrides" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "worlds" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"style" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"lore" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"narrative_model" text DEFAULT '' NOT NULL,
	"image_id" text,
	"duplicated_from_world_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "characters" ADD CONSTRAINT "characters_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "episodes" ADD CONSTRAINT "episodes_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facts" ADD CONSTRAINT "facts_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "images" ADD CONSTRAINT "images_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "images" ADD CONSTRAINT "images_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_instances" ADD CONSTRAINT "item_instances_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_instances" ADD CONSTRAINT "item_instances_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_instances" ADD CONSTRAINT "item_instances_holder_participant_id_session_participants_id_fk" FOREIGN KEY ("holder_participant_id") REFERENCES "public"."session_participants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_instances" ADD CONSTRAINT "item_instances_location_id_session_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."session_locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "locations" ADD CONSTRAINT "locations_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lore_chunks" ADD CONSTRAINT "lore_chunks_world_id_worlds_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."worlds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_links" ADD CONSTRAINT "session_links_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_links" ADD CONSTRAINT "session_links_from_id_session_locations_id_fk" FOREIGN KEY ("from_id") REFERENCES "public"."session_locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_links" ADD CONSTRAINT "session_links_to_id_session_locations_id_fk" FOREIGN KEY ("to_id") REFERENCES "public"."session_locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_locations" ADD CONSTRAINT "session_locations_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_locations" ADD CONSTRAINT "session_locations_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_participants" ADD CONSTRAINT "session_participants_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_participants" ADD CONSTRAINT "session_participants_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_participants" ADD CONSTRAINT "session_participants_location_id_session_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."session_locations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_world_id_worlds_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."worlds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turn_messages" ADD CONSTRAINT "turn_messages_turn_id_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."turns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turns" ADD CONSTRAINT "turns_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turns" ADD CONSTRAINT "turns_speaker_participant_id_session_participants_id_fk" FOREIGN KEY ("speaker_participant_id") REFERENCES "public"."session_participants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "world_cast" ADD CONSTRAINT "world_cast_world_id_worlds_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."worlds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "world_cast" ADD CONSTRAINT "world_cast_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "world_cast" ADD CONSTRAINT "world_cast_start_world_location_id_world_locations_id_fk" FOREIGN KEY ("start_world_location_id") REFERENCES "public"."world_locations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "world_items" ADD CONSTRAINT "world_items_world_id_worlds_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."worlds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "world_items" ADD CONSTRAINT "world_items_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "world_items" ADD CONSTRAINT "world_items_world_location_id_world_locations_id_fk" FOREIGN KEY ("world_location_id") REFERENCES "public"."world_locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "world_items" ADD CONSTRAINT "world_items_cast_id_world_cast_id_fk" FOREIGN KEY ("cast_id") REFERENCES "public"."world_cast"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "world_links" ADD CONSTRAINT "world_links_world_id_worlds_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."worlds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "world_links" ADD CONSTRAINT "world_links_from_world_location_id_world_locations_id_fk" FOREIGN KEY ("from_world_location_id") REFERENCES "public"."world_locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "world_links" ADD CONSTRAINT "world_links_to_world_location_id_world_locations_id_fk" FOREIGN KEY ("to_world_location_id") REFERENCES "public"."world_locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "world_locations" ADD CONSTRAINT "world_locations_world_id_worlds_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."worlds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "world_locations" ADD CONSTRAINT "world_locations_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worlds" ADD CONSTRAINT "worlds_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "characters_owner_idx" ON "characters" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "episodes_session_idx" ON "episodes" USING btree ("session_id","turn_number");--> statement-breakpoint
CREATE INDEX "episodes_embedding_idx" ON "episodes" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "events_session_idx" ON "events" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE INDEX "events_type_idx" ON "events" USING btree ("type");--> statement-breakpoint
CREATE INDEX "facts_session_status_idx" ON "facts" USING btree ("session_id","status");--> statement-breakpoint
CREATE INDEX "facts_embedding_idx" ON "facts" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "images_owner_idx" ON "images" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "images_entity_idx" ON "images" USING btree ("entity_kind","entity_id");--> statement-breakpoint
CREATE INDEX "images_session_idx" ON "images" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "item_instances_session_idx" ON "item_instances" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "item_instances_holder_idx" ON "item_instances" USING btree ("holder_participant_id");--> statement-breakpoint
CREATE INDEX "item_instances_location_idx" ON "item_instances" USING btree ("location_id");--> statement-breakpoint
CREATE INDEX "items_owner_idx" ON "items" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "items_kind_idx" ON "items" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "jobs_queued_idx" ON "jobs" USING btree ("status","type");--> statement-breakpoint
CREATE INDEX "jobs_session_idx" ON "jobs" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "locations_owner_idx" ON "locations" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "lore_chunks_world_idx" ON "lore_chunks" USING btree ("world_id");--> statement-breakpoint
CREATE INDEX "lore_chunks_embedding_idx" ON "lore_chunks" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "session_links_session_idx" ON "session_links" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "session_locations_session_idx" ON "session_locations" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "session_participants_session_idx" ON "session_participants" USING btree ("session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "session_participants_name_unique" ON "session_participants" USING btree ("session_id","display_name");--> statement-breakpoint
CREATE INDEX "sessions_owner_idx" ON "sessions" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "sessions_world_idx" ON "sessions" USING btree ("world_id");--> statement-breakpoint
CREATE INDEX "turn_messages_turn_idx" ON "turn_messages" USING btree ("turn_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "turns_session_number_unique" ON "turns" USING btree ("session_id","number");--> statement-breakpoint
CREATE INDEX "world_cast_world_idx" ON "world_cast" USING btree ("world_id");--> statement-breakpoint
CREATE INDEX "world_items_world_idx" ON "world_items" USING btree ("world_id");--> statement-breakpoint
CREATE INDEX "world_links_world_idx" ON "world_links" USING btree ("world_id");--> statement-breakpoint
CREATE INDEX "world_locations_world_idx" ON "world_locations" USING btree ("world_id");--> statement-breakpoint
CREATE INDEX "worlds_owner_idx" ON "worlds" USING btree ("owner_id");