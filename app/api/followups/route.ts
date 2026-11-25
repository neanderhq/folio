import { NextResponse } from 'next/server';
import { and, desc, eq, sql } from 'drizzle-orm';
import { AccessError, sameOrigin, workspaceAccess } from '../../../server/auth';
import { getDb } from '../../../server/db';
import { deals, followupExecutions, followupRules, memberships, users } from '../../../server/schema';
import { followupLock, ruleInput, writableAssignee } from '../../../server/followups';
export const dynamic = 'force-dynamic';
const fail = (e: unknown) => e instanceof AccessError ? NextResponse.json({ error: e.message }, { status: e.status }) : NextResponse.json({ error: 'Follow-ups could not be saved. No partial changes were saved; retry after checking the rule.' }, { status: 503 });
export async function GET(request: Request) { try {
  const { workspaceId, role } = await workspaceAccess(request), db = getDb();
  const [rules, history, members] = await Promise.all([
    db.select().from(followupRules).where(eq(followupRules.workspaceId, workspaceId)).orderBy(followupRules.name),
    db.select({ id: followupExecutions.id, ruleVersion: followupExecutions.ruleVersion, taskId: followupExecutions.taskId, snapshot: followupExecutions.snapshot, createdAt: followupExecutions.createdAt, dealId: deals.id, dealName: deals.name, deletedAt: deals.deletedAt }).from(followupExecutions).innerJoin(deals, and(eq(deals.id, followupExecutions.dealId), eq(deals.workspaceId, workspaceId))).where(eq(followupExecutions.workspaceId, workspaceId)).orderBy(desc(followupExecutions.id)).limit(100),
    db.select({ id: users.id, email: users.email, role: memberships.role }).from(memberships).innerJoin(users, eq(users.id, memberships.userId)).where(eq(memberships.workspaceId, workspaceId)).orderBy(users.email),
  ]);
  return NextResponse.json({ rules, history: history.map(h => ({ ...h, dealName: h.deletedAt ? 'Deal in Trash' : h.dealName, dealId: h.deletedAt ? null : h.dealId })), members, canManage: role === 'Admin' });
} catch (e) { return fail(e); } }
export async function POST(request: Request) { try {
  sameOrigin(request); const { workspaceId, role } = await workspaceAccess(request, true);
  if (role !== 'Admin') throw new AccessError('Only Admins manage follow-up rules.', 403);
  const raw = await request.text(); if (raw.length > 4096) throw new AccessError('Rule is too large.', 413);
  let b: Record<string, unknown>; try { b = JSON.parse(raw); } catch { throw new AccessError('Provide a valid rule.', 400); }
  if (!b || typeof b !== 'object') throw new AccessError('Provide a valid rule.', 400);
  const input = ruleInput(b), db = getDb();
  const rule = await db.transaction(async tx => {
    await tx.execute(followupLock(workspaceId)); if (input.enabled) await writableAssignee(tx, workspaceId, input.assigneeId);
    if (b.id) {
      if (typeof b.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(b.id)) throw new AccessError('Rule not found.', 404);
      const [current] = await tx.select().from(followupRules).where(and(eq(followupRules.id, b.id), eq(followupRules.workspaceId, workspaceId))).limit(1);
      if (!current) throw new AccessError('Rule not found.', 404);
      if (b.version !== current.version) throw new AccessError('This rule changed. Your draft is retained; reload the saved rule before retrying.', 409);
      return (await tx.update(followupRules).set({ ...input, version: current.version + 1, updatedAt: new Date() }).where(eq(followupRules.id, current.id)).returning())[0];
    }
    const [{ count }] = await tx.select({ count: sql<number>`count(*)::int` }).from(followupRules).where(eq(followupRules.workspaceId, workspaceId));
    if (count >= 20) throw new AccessError('This workspace is limited to 20 rules. Edit or disable an existing rule.', 409);
    // Disabled rules also need a real workspace identity; Viewer is allowed only while disabled.
    const [member] = await tx.select().from(memberships).where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, input.assigneeId))).limit(1);
    if (!member) throw new AccessError('Choose a member of this workspace.', 400);
    return (await tx.insert(followupRules).values({ workspaceId, ...input }).returning())[0];
  }); return NextResponse.json({ rule });
} catch (e) { return fail(e); } }
