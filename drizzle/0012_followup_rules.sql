CREATE TABLE "crm_followup_executions" (
	"id" serial PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"rule_id" uuid NOT NULL,
	"rule_version" integer NOT NULL,
	"stage_event_id" integer NOT NULL,
	"deal_id" integer NOT NULL,
	"task_id" integer,
	"snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm_followup_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" varchar(80) NOT NULL,
	"stage" varchar(20) NOT NULL,
	"title" varchar(160) NOT NULL,
	"assignee_id" uuid NOT NULL,
	"offset_days" integer NOT NULL,
	"time_zone" varchar(80) NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "crm_followup_executions" ADD CONSTRAINT "crm_followup_executions_workspace_id_crm_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."crm_workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_followup_executions" ADD CONSTRAINT "crm_followup_executions_rule_id_crm_followup_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."crm_followup_rules"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_followup_executions" ADD CONSTRAINT "crm_followup_executions_stage_event_id_deal_stage_events_id_fk" FOREIGN KEY ("stage_event_id") REFERENCES "public"."deal_stage_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_followup_executions" ADD CONSTRAINT "crm_followup_executions_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_followup_executions" ADD CONSTRAINT "crm_followup_executions_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_followup_rules" ADD CONSTRAINT "crm_followup_rules_workspace_id_crm_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."crm_workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_followup_rules" ADD CONSTRAINT "crm_followup_rules_assignee_id_crm_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."crm_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "crm_followup_event_unique" ON "crm_followup_executions" USING btree ("rule_id","stage_event_id");--> statement-breakpoint
CREATE INDEX "crm_followup_history_idx" ON "crm_followup_executions" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE INDEX "crm_followup_rules_workspace_idx" ON "crm_followup_rules" USING btree ("workspace_id");