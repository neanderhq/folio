CREATE TABLE "crm_mail_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"mailbox" varchar(254) NOT NULL,
	"tokens" text NOT NULL,
	"labels" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"label_id" text,
	"label_name" text,
	"enabled" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"status" varchar(30) DEFAULT 'disabled' NOT NULL,
	"error" text,
	"generation" uuid,
	"cursor" text,
	"scanned" integer DEFAULT 0 NOT NULL,
	"imported" integer DEFAULT 0 NOT NULL,
	"skipped" integer DEFAULT 0 NOT NULL,
	"last_completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "crm_mail_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"provider_id" text NOT NULL,
	"payload" text NOT NULL,
	"seen_generation" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm_mail_states" (
	"hash" varchar(64) PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"session_hash" varchar(64) NOT NULL,
	"verifier" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"claimed" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE "crm_mail_connections" ADD CONSTRAINT "crm_mail_connections_workspace_id_crm_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."crm_workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_mail_connections" ADD CONSTRAINT "crm_mail_connections_user_id_crm_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."crm_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_mail_messages" ADD CONSTRAINT "crm_mail_messages_connection_id_crm_mail_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."crm_mail_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_mail_states" ADD CONSTRAINT "crm_mail_states_workspace_id_crm_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."crm_workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_mail_states" ADD CONSTRAINT "crm_mail_states_user_id_crm_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."crm_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "crm_mail_personal_unique" ON "crm_mail_connections" USING btree ("workspace_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "crm_mail_message_unique" ON "crm_mail_messages" USING btree ("connection_id","provider_id");--> statement-breakpoint
CREATE INDEX "crm_mail_states_owner_idx" ON "crm_mail_states" USING btree ("workspace_id","user_id");