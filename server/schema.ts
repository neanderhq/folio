import type { ListViewConfig } from '../shared/lists';
import { pgTable, serial, varchar, text, integer, timestamp, date, boolean, index, uuid, primaryKey, jsonb, uniqueIndex } from 'drizzle-orm/pg-core';

export const users = pgTable('crm_users', { id: uuid('id').defaultRandom().primaryKey(), email: varchar('email', { length: 254 }).notNull().unique(), passwordHash: text('password_hash').notNull(), createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull() });
export const workspaces = pgTable('crm_workspaces', { id: uuid('id').defaultRandom().primaryKey(), name: varchar('name', { length: 120 }).notNull(), createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull() });
export const memberships = pgTable('crm_memberships', { workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id), userId: uuid('user_id').notNull().references(() => users.id), role: varchar('role', { length: 10 }).notNull() }, t => [primaryKey({ columns: [t.workspaceId, t.userId] })]);
export const sessions = pgTable('crm_sessions', { id: uuid('id').defaultRandom().primaryKey(), userId: uuid('user_id').notNull().references(() => users.id), tokenHash: varchar('token_hash', { length: 64 }).notNull().unique(), expiresAt: timestamp('expires_at', { withTimezone: true }).notNull() });
export const loginAttempts = pgTable('crm_login_attempts', { email: varchar('email', { length: 254 }).primaryKey(), attempts: integer('attempts').notNull().default(0), windowStartedAt: timestamp('window_started_at', { withTimezone: true }).defaultNow().notNull() });

export const companies = pgTable('companies', {
  workspaceId: uuid('workspace_id').references(() => workspaces.id),
  id: serial('id').primaryKey(), name: varchar('name', { length: 120 }).notNull(),
  domain: varchar('domain', { length: 253 }),
  description: text('description'), version: integer('version').notNull().default(1), deletedAt: timestamp('deleted_at', { withTimezone: true }), mergedIntoId: integer('merged_into_id'), createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, t => [index('companies_name_idx').on(t.name)]);
export const people = pgTable('people', {
  workspaceId: uuid('workspace_id').references(() => workspaces.id),
  id: serial('id').primaryKey(), name: varchar('name', { length: 120 }).notNull(),
  email: varchar('email', { length: 254 }), companyId: integer('company_id').notNull().references(() => companies.id, { onDelete: 'restrict' }), version: integer('version').notNull().default(1),
  deletedAt: timestamp('deleted_at', { withTimezone: true }), mergedIntoId: integer('merged_into_id'), createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, t => [index('people_company_idx').on(t.companyId), index('people_name_idx').on(t.name)]);
export const deals = pgTable('deals', {
  workspaceId: uuid('workspace_id').references(() => workspaces.id),
  id: serial('id').primaryKey(), name: varchar('name', { length: 120 }).notNull(),
  companyId: integer('company_id').notNull().references(() => companies.id, { onDelete: 'restrict' }),
  personId: integer('person_id').notNull().references(() => people.id, { onDelete: 'restrict' }),
  stage: varchar('stage', { length: 20 }).notNull().default('Lead'),
  owner: varchar('owner', { length: 80 }).notNull(), valueCents: integer('value_cents').notNull().default(0),
  currency: varchar('currency', { length: 3 }).notNull().default('USD'),
  lostReason: varchar('lost_reason', { length: 500 }),
  wonClosedAt: timestamp('won_closed_at', { withTimezone: true }),
  version: integer('version').notNull().default(1),
  deletedAt: timestamp('deleted_at', { withTimezone: true }), mergedIntoId: integer('merged_into_id'), createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, t => [index('deals_company_idx').on(t.companyId), index('deals_person_idx').on(t.personId), index('deals_stage_idx').on(t.stage), index('deals_name_idx').on(t.name)]);
export const dealStageEvents = pgTable('deal_stage_events', {
  id: serial('id').primaryKey(),
  workspaceId: uuid('workspace_id').references(() => workspaces.id),
  dealId: integer('deal_id').notNull().references(() => deals.id, { onDelete: 'cascade' }),
  fromStage: varchar('from_stage', { length: 20 }),
  toStage: varchar('to_stage', { length: 20 }).notNull(),
  changedAt: timestamp('changed_at', { withTimezone: true }).defaultNow().notNull(),
  lostReason: varchar('lost_reason', { length: 500 }),
}, t => [index('deal_stage_events_workspace_idx').on(t.workspaceId, t.dealId, t.changedAt)]);
export const notes = pgTable('notes', {
  workspaceId: uuid('workspace_id').references(() => workspaces.id),
  id: serial('id').primaryKey(), targetType: varchar('target_type', { length: 20 }).notNull(),
  targetId: integer('target_id').notNull(), body: text('body').notNull(), version: integer('version').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, t => [index('notes_target_idx').on(t.targetType, t.targetId)]);
export const recordChanges = pgTable('record_changes', {
  id: serial('id').primaryKey(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id),
  actorId: uuid('actor_id').notNull().references(() => users.id),
  recordType: varchar('record_type', { length: 10 }).notNull(),
  recordId: integer('record_id').notNull(),
  version: integer('version').notNull(),
  changes: jsonb('changes').$type<Record<string, { from: string | number | null; to: string | number | null }>>().notNull(),
  changedAt: timestamp('changed_at', { withTimezone: true }).defaultNow().notNull(),
}, t => [index('record_changes_lookup_idx').on(t.workspaceId, t.recordType, t.recordId, t.id)]);
export const recordLifecycleEvents = pgTable('crm_record_lifecycle_events', {
  id: serial('id').primaryKey(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id),
  actorId: uuid('actor_id').notNull().references(() => users.id),
  recordType: varchar('record_type', { length: 10 }).notNull(),
  recordId: integer('record_id').notNull(),
  action: varchar('action', { length: 10 }).notNull(),
  details: jsonb('details').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, t => [index('crm_record_lifecycle_lookup_idx').on(t.workspaceId, t.recordType, t.recordId, t.id)]);
export const tasks = pgTable('tasks', {
  workspaceId: uuid('workspace_id').references(() => workspaces.id),
  id: serial('id').primaryKey(), targetType: varchar('target_type', { length: 20 }).notNull(),
  targetId: integer('target_id').notNull(), title: varchar('title', { length: 160 }).notNull(),
  dueDate: date('due_date'), done: boolean('done').notNull().default(false),
  assigneeId: uuid('assignee_id').references(() => users.id), version: integer('version').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, t => [index('tasks_target_idx').on(t.targetType, t.targetId), index('tasks_due_idx').on(t.done, t.dueDate), index('tasks_assignee_idx').on(t.workspaceId, t.assigneeId, t.done)]);

export const notifications = pgTable('crm_notifications', {
  id: serial('id').primaryKey(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id),
  recipientId: uuid('recipient_id').notNull().references(() => users.id),
  actorId: uuid('actor_id').notNull().references(() => users.id),
  taskId: integer('task_id').references(() => tasks.id, { onDelete: 'cascade' }),
  kind: varchar('kind', { length: 30 }).notNull(),
  taskVersion: integer('task_version').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  readAt: timestamp('read_at', { withTimezone: true }),
}, t => [index('crm_notifications_inbox_idx').on(t.workspaceId, t.recipientId, t.createdAt), uniqueIndex('crm_notifications_event_unique').on(t.taskId, t.kind, t.taskVersion, t.recipientId)]);

export const customFields = pgTable('crm_custom_fields', {
  id: uuid('id').defaultRandom().primaryKey(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id),
  objectType: varchar('object_type', { length: 10 }).notNull(),
  name: varchar('name', { length: 80 }).notNull(),
  kind: varchar('kind', { length: 20 }).notNull(),
  options: jsonb('options').$type<string[]>().notNull().default([]),
  required: boolean('required').notNull().default(false),
  unique: boolean('unique').notNull().default(false),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, t => [index('crm_custom_fields_workspace_idx').on(t.workspaceId, t.objectType)]);
export const customValues = pgTable('crm_custom_values', {
  fieldId: uuid('field_id').notNull().references(() => customFields.id, { onDelete: 'restrict' }),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id),
  recordId: integer('record_id').notNull(),
  value: jsonb('value').$type<string | number | boolean>().notNull(),
  uniqueKey: varchar('unique_key', { length: 500 }),
}, t => [primaryKey({ columns: [t.fieldId, t.recordId] }), index('crm_custom_values_record_idx').on(t.workspaceId, t.recordId), uniqueIndex('crm_custom_values_unique_idx').on(t.fieldId, t.uniqueKey)]);

export const crmLists = pgTable('crm_lists', {
  id: uuid('id').defaultRandom().primaryKey(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id),
  creatorId: uuid('creator_id').notNull().references(() => users.id),
  name: varchar('name', { length: 120 }).notNull(),
  objectType: varchar('object_type', { length: 10 }).notNull(),
  visibility: varchar('visibility', { length: 10 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, t => [index('crm_lists_workspace_idx').on(t.workspaceId)]);
export const crmListGrants = pgTable('crm_list_grants', {
  listId: uuid('list_id').notNull().references(() => crmLists.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id),
  access: varchar('access', { length: 10 }).notNull(),
}, t => [primaryKey({ columns: [t.listId, t.userId] })]);
export const crmListEntries = pgTable('crm_list_entries', {
  id: uuid('id').defaultRandom().primaryKey(),
  listId: uuid('list_id').notNull().references(() => crmLists.id, { onDelete: 'cascade' }),
  recordId: integer('record_id').notNull(),
  stage: varchar('stage', { length: 20 }).notNull().default('New'),
  note: varchar('note', { length: 500 }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, t => [uniqueIndex('crm_list_entry_unique').on(t.listId, t.recordId)]);
export const crmListViews = pgTable('crm_list_views', {
  id: uuid('id').defaultRandom().primaryKey(),
  listId: uuid('list_id').notNull().references(() => crmLists.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 80 }).notNull(),
  kind: varchar('kind', { length: 10 }).notNull(),
  config: jsonb('config').$type<ListViewConfig>().notNull(),
  version: integer('version').notNull().default(1),
}, t => [uniqueIndex('crm_list_view_name_unique').on(t.listId, t.name)]);

// Installing a template enables fictional data only for newly created workspaces.
export const templateSettings = pgTable('crm_template_settings', {
  id: varchar('id', { length: 80 }).primaryKey(),
  enabled: boolean('enabled').notNull().default(true),
});
export const workspaceSeeds = pgTable('crm_workspace_seeds', {
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  version: varchar('version', { length: 80 }).notNull(),
  appliedAt: timestamp('applied_at', { withTimezone: true }).defaultNow().notNull(),
}, t => [primaryKey({ columns: [t.workspaceId, t.version] })]);

export const followupRules = pgTable('crm_followup_rules', {
  id: uuid('id').defaultRandom().primaryKey(), workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id),
  name: varchar('name', { length: 80 }).notNull(), stage: varchar('stage', { length: 20 }).notNull(),
  title: varchar('title', { length: 160 }).notNull(), assigneeId: uuid('assignee_id').notNull().references(() => users.id),
  offsetDays: integer('offset_days').notNull(), timeZone: varchar('time_zone', { length: 80 }).notNull(),
  enabled: boolean('enabled').notNull().default(true), version: integer('version').notNull().default(1),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, t => [index('crm_followup_rules_workspace_idx').on(t.workspaceId)]);
export const followupExecutions = pgTable('crm_followup_executions', {
  id: serial('id').primaryKey(), workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id),
  ruleId: uuid('rule_id').notNull().references(() => followupRules.id), ruleVersion: integer('rule_version').notNull(),
  stageEventId: integer('stage_event_id').notNull().references(() => dealStageEvents.id), dealId: integer('deal_id').notNull().references(() => deals.id),
  taskId: integer('task_id').references(() => tasks.id, { onDelete: 'set null' }),
  snapshot: jsonb('snapshot').$type<{ name: string; title: string; assigneeId: string; dueDate: string; timeZone: string }>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, t => [uniqueIndex('crm_followup_event_unique').on(t.ruleId, t.stageEventId), index('crm_followup_history_idx').on(t.workspaceId, t.id)]);

// Personal mail is deliberately separate from shared CRM records.
export const mailConnections = pgTable('crm_mail_connections', {
 id: uuid('id').defaultRandom().primaryKey(), workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id), userId: uuid('user_id').notNull().references(() => users.id),
 mailbox: varchar('mailbox', {length:254}).notNull(), tokens: text('tokens').notNull(), labels: jsonb('labels').$type<{id:string;name:string}[]>().notNull().default([]),
 labelId: text('label_id'), labelName: text('label_name'), enabled: boolean('enabled').notNull().default(false), version: integer('version').notNull().default(1),
 status: varchar('status',{length:30}).notNull().default('disabled'), error: text('error'), generation: uuid('generation'), cursor: text('cursor'), scanned: integer('scanned').notNull().default(0), imported: integer('imported').notNull().default(0), skipped: integer('skipped').notNull().default(0), lastCompletedAt: timestamp('last_completed_at',{withTimezone:true}),
}, t => [uniqueIndex('crm_mail_personal_unique').on(t.workspaceId,t.userId)]);
export const mailMessages = pgTable('crm_mail_messages', {
 id: uuid('id').defaultRandom().primaryKey(), connectionId: uuid('connection_id').notNull().references(()=>mailConnections.id,{onDelete:'cascade'}), providerId: text('provider_id').notNull(), payload: text('payload').notNull(), seenGeneration: uuid('seen_generation').notNull(),
}, t=>[uniqueIndex('crm_mail_message_unique').on(t.connectionId,t.providerId)]);
export const mailStates = pgTable('crm_mail_states', {
 hash: varchar('hash',{length:64}).primaryKey(), workspaceId: uuid('workspace_id').notNull().references(()=>workspaces.id), userId: uuid('user_id').notNull().references(()=>users.id), sessionHash: varchar('session_hash',{length:64}).notNull(), verifier: text('verifier').notNull(), expiresAt: timestamp('expires_at',{withTimezone:true}).notNull(), claimed: boolean('claimed').notNull().default(false),
},t=>[index('crm_mail_states_owner_idx').on(t.workspaceId,t.userId)]);
