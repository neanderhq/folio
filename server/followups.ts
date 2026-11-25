import { and, eq, sql } from 'drizzle-orm';
import { AccessError } from './auth';
import { getDb } from './db';
import { followupExecutions, followupRules, memberships, notifications, tasks } from './schema';
import { STAGES } from '../shared/crm';
type Tx = Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0];
export const followupLock = (workspaceId: string) => sql`select pg_advisory_xact_lock(hashtext(${workspaceId}), 73921)`;
const text = (value: unknown, label: string, max: number) => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new AccessError(`${label} must be 1–${max} characters.`, 400);
  return value.trim();
};
export function ruleInput(b: Record<string, unknown>) {
  const name = text(b.name, 'Rule name', 80), title = text(b.title, 'Task title', 160), timeZone = text(b.timeZone, 'Timezone', 80);
  if (!STAGES.includes(b.stage as typeof STAGES[number])) throw new AccessError('Choose a pipeline stage.', 400);
  if (!Number.isInteger(b.offsetDays) || Number(b.offsetDays) < 0 || Number(b.offsetDays) > 365) throw new AccessError('Due offset must be 0–365 whole calendar days.', 400);
  if (typeof b.enabled !== 'boolean') throw new AccessError('Choose enabled or disabled.', 400);
  if (typeof b.assigneeId !== 'string' || !/^[0-9a-f-]{36}$/i.test(b.assigneeId)) throw new AccessError('Choose a workspace member.', 400);
  try { new Intl.DateTimeFormat('en', { timeZone }).format(); } catch { throw new AccessError('Choose a valid IANA timezone.', 400); }
  return { name, title, timeZone, stage: b.stage as string, offsetDays: b.offsetDays as number, enabled: b.enabled, assigneeId: b.assigneeId };
}
export async function writableAssignee(tx: Tx, workspaceId: string, userId: string) {
  const [m] = await tx.select().from(memberships).where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, userId))).for('share').limit(1);
  if (!m || !['Admin', 'Member'].includes(m.role)) throw new AccessError('Follow-up assignee must be a current Admin or Member. Ask an Admin to correct the rule, then retry the stage change.', 409);
}
export function dueDate(now: Date, timeZone: string, offsetDays: number) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = (type: string) => Number(parts.find(p => p.type === type)!.value);
  return new Date(Date.UTC(get('year'), get('month') - 1, get('day') + offsetDays)).toISOString().slice(0, 10);
}
export async function runFollowups(tx: Tx, workspaceId: string, actorId: string, dealId: number, stage: string, stageEventId: number, now: Date) {
  const rules = await tx.select().from(followupRules).where(and(eq(followupRules.workspaceId, workspaceId), eq(followupRules.stage, stage), eq(followupRules.enabled, true))).orderBy(followupRules.id);
  if (!rules.length) return;
  const [{ count }] = await tx.select({ count: sql<number>`count(*)::int` }).from(tasks).where(eq(tasks.workspaceId, workspaceId));
  if (count + rules.length > 500) throw new AccessError('Stage not saved: follow-ups would exceed the 500-task limit. Remove completed tasks or disable a rule, then retry.', 409);
  for (const rule of rules) {
    await writableAssignee(tx, workspaceId, rule.assigneeId);
    const date = dueDate(now, rule.timeZone, rule.offsetDays);
    const [task] = await tx.insert(tasks).values({ workspaceId, targetType: 'deal', targetId: dealId, title: rule.title, assigneeId: rule.assigneeId, dueDate: date }).returning();
    await tx.insert(followupExecutions).values({ workspaceId, ruleId: rule.id, ruleVersion: rule.version, stageEventId, dealId, taskId: task.id, snapshot: { name: rule.name, title: rule.title, assigneeId: rule.assigneeId, dueDate: date, timeZone: rule.timeZone } });
    if (rule.assigneeId !== actorId) await tx.insert(notifications).values({ workspaceId, recipientId: rule.assigneeId, actorId, taskId: task.id, taskVersion: task.version, kind: 'task_assigned' });
  }
}
