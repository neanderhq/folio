import { NextResponse } from 'next/server';
import { and, eq, isNull, sql, inArray } from 'drizzle-orm';
import { AccessError, sameOrigin, workspaceAccess } from '../../../server/auth';
import { getDb } from '../../../server/db';
import { companies, crmListEntries, crmListGrants, crmLists, crmListViews, deals, memberships, users, customFields, customValues } from '../../../server/schema';
import { businessFields, evaluateView, normalizeViewConfig } from '../../../shared/list-business-views';
import { DEFAULT_VIEW, LIST_COLUMNS, LIST_STAGES, type ListViewConfig } from '../../../shared/lists';

export const dynamic = 'force-dynamic';
const uuid = (v: unknown) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const fail = (e: unknown) => {
  if (e instanceof AccessError) return NextResponse.json({ error: e.message }, { status: e.status });
  console.error('List request failed', e);
  return NextResponse.json({ error: 'The list is unavailable.' }, { status: 503 });
};
const nameOf = (v: unknown, label: string, max: number) => {
  if (typeof v !== 'string' || !v.trim() || v.trim().length > max) throw new AccessError(`${label} must be 1–${max} characters.`, 400);
  return v.trim();
};
async function bodyOf(request: Request) {
  if (Number(request.headers.get('content-length')) > 8192) throw new AccessError('Form is too large.', 413);
  const raw = await request.text();
  if (raw.length > 8192) throw new AccessError('Form is too large.', 413);
  try { const parsed: unknown = JSON.parse(raw); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>; } catch {}
  throw new AccessError('Provide a valid JSON form.', 400);
}
async function allowedList(request: Request, listId: unknown, write = false) {
  const access = await workspaceAccess(request);
  if (!uuid(listId)) throw new AccessError('List not found.', 404);
  const db = getDb();
  const [list] = await db.select().from(crmLists).where(and(eq(crmLists.id, listId as string), eq(crmLists.workspaceId, access.workspaceId))).limit(1);
  if (!list) throw new AccessError('List not found.', 404);
  const [grant] = await db.select().from(crmListGrants).where(and(eq(crmListGrants.listId, list.id), eq(crmListGrants.userId, access.user.id))).limit(1);
  const creator = list.creatorId === access.user.id;
  if (!creator && list.visibility !== 'shared' && !grant) throw new AccessError('List not found.', 404);
  if (write && (access.role === 'Viewer' || (!creator && grant?.access !== 'Editor' && list.visibility !== 'shared'))) throw new AccessError('You cannot change this list.', 403);
  return { ...access, list, creator, grant };
}
async function recordFor(list: typeof crmLists.$inferSelect, value: unknown) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw new AccessError('Choose a valid record.', 400);
  const table = list.objectType === 'company' ? companies : deals;
  const [record] = await getDb().select().from(table).where(and(eq(table.id, id), eq(table.workspaceId, list.workspaceId))).limit(1);
  if (!record) throw new AccessError('Record not found in this workspace.', 404);
  return record;
}
export async function GET(request: Request) { try {
  const access = await workspaceAccess(request);
  const db = getDb();
  const [allLists, grants] = await Promise.all([
    db.select().from(crmLists).where(eq(crmLists.workspaceId, access.workspaceId)).orderBy(crmLists.createdAt),
    db.select().from(crmListGrants).where(eq(crmListGrants.userId, access.user.id)),
  ]);
  const granted = new Set(grants.map(g => g.listId));
  const lists = allLists.filter(l => l.visibility === 'shared' || l.creatorId === access.user.id || granted.has(l.id));
  const listId = new URL(request.url).searchParams.get('listId');
  if (!listId) return NextResponse.json({ lists });
  const { list, creator, grant } = await allowedList(request, listId);
  const [entries, views, listGrants] = await Promise.all([
    db.select().from(crmListEntries).where(eq(crmListEntries.listId, list.id)).orderBy(crmListEntries.createdAt).limit(501),
    db.select().from(crmListViews).where(eq(crmListViews.listId, list.id)),
    creator ? db.select({ userId: crmListGrants.userId, email: users.email, access: crmListGrants.access }).from(crmListGrants).innerJoin(users, eq(users.id, crmListGrants.userId)).where(eq(crmListGrants.listId, list.id)) : Promise.resolve([]),
  ]);
  if (entries.length > 500) throw new AccessError('This list exceeds its 500-entry limit.', 409);
  const recordRows = list.objectType === 'company'
    ? await db.select().from(companies).where(and(eq(companies.workspaceId, access.workspaceId), isNull(companies.deletedAt)))
    : await db.select().from(deals).where(and(eq(deals.workspaceId, access.workspaceId), isNull(deals.deletedAt)));
  const records = new Map(recordRows.map(r => [r.id, r]));
  const definitions = list.objectType === 'deal' ? await db.select().from(customFields).where(and(eq(customFields.workspaceId, access.workspaceId), eq(customFields.objectType, 'deal'))) : [];
  const ids = definitions.map(f => f.id), recordIds = entries.filter(e => records.has(e.recordId)).map(e => e.recordId);
  const values = ids.length && recordIds.length ? await db.select().from(customValues).where(and(eq(customValues.workspaceId, access.workspaceId), inArray(customValues.fieldId, ids), inArray(customValues.recordId, recordIds))) : [];
  const enriched = entries.filter(e => records.has(e.recordId)).map(e => ({ ...e, record: { ...records.get(e.recordId)!, customValues: Object.fromEntries(values.filter(v => v.recordId === e.recordId).map(v => [v.fieldId, v.value])) } }));
  const fields = businessFields(definitions), viewResults = Object.fromEntries(views.map(v => { const evaluated = evaluateView(enriched, v.config, fields, list.objectType); return [v.id, { entryIds: evaluated.rows.map(e => e.id), issues: evaluated.issues }]; }));
  return NextResponse.json({ lists, list, entries: enriched, views, fields, viewResults, grants: listGrants, canWrite: access.role !== 'Viewer' && (creator || list.visibility === 'shared' || grant?.access === 'Editor'), canGrant: creator });
} catch (e) { return fail(e); } }
export async function POST(request: Request) { try {
  sameOrigin(request);
  const access = await workspaceAccess(request);
  const b = await bodyOf(request), db = getDb();
  if (b.action === 'create') {
    if (access.role === 'Viewer') throw new AccessError('Viewers cannot create lists.', 403);
    const name = nameOf(b.name, 'List name', 120);
    if (b.objectType !== 'company' && b.objectType !== 'deal') throw new AccessError('Choose Companies or Deals.', 400);
    if (b.visibility !== 'private' && b.visibility !== 'shared') throw new AccessError('Choose private or shared access.', 400);
    const list = await db.transaction(async tx => {
      const [created] = await tx.insert(crmLists).values({ workspaceId: access.workspaceId, creatorId: access.user.id, name, objectType: b.objectType as string, visibility: b.visibility as string }).returning();
      await tx.insert(crmListGrants).values({ listId: created.id, userId: access.user.id, access: 'Editor' });
      await tx.insert(crmListViews).values([{ listId: created.id, name: 'Table', kind: 'table', config: DEFAULT_VIEW }, { listId: created.id, name: 'Board', kind: 'board', config: DEFAULT_VIEW }]);
      return created;
    });
    return NextResponse.json({ list }, { status: 201 });
  }
  const context = await allowedList(request, b.listId, true);
  if (b.action === 'addEntry') {
    const [entry] = await db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${access.workspaceId}), 73921)`);
      const record = await recordFor(context.list, b.recordId);
      const existing = await tx.select({ id: crmListEntries.id }).from(crmListEntries).where(eq(crmListEntries.listId, context.list.id)).limit(500);
      if (existing.length >= 500) throw new AccessError('This list is limited to 500 entries.', 409);
      return tx.insert(crmListEntries).values({ listId: context.list.id, recordId: record.id }).onConflictDoNothing().returning();
    });
    if (!entry) throw new AccessError('This record is already in the list.', 409);
    return NextResponse.json({ entry }, { status: 201 });
  }
  if (b.action === 'saveView') {
    if (!uuid(b.viewId)) throw new AccessError('View not found.', 404);
    const view = await db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${access.workspaceId}), 73921)`);
      const [acting] = await tx.select().from(memberships).where(and(eq(memberships.workspaceId, access.workspaceId), eq(memberships.userId, access.user.id))).for('share');
      const [currentGrant] = await tx.select().from(crmListGrants).where(and(eq(crmListGrants.listId, context.list.id), eq(crmListGrants.userId, access.user.id))).for('share');
      if (!acting || acting.role === 'Viewer' || (!context.creator && context.list.visibility !== 'shared' && currentGrant?.access !== 'Editor')) throw new AccessError('You cannot change this list.', 403);
      const [current] = await tx.select().from(crmListViews).where(and(eq(crmListViews.id, b.viewId as string), eq(crmListViews.listId, context.list.id))).for('update').limit(1);
      if (!current) throw new AccessError('View not found.', 404);
      if (b.version !== undefined && b.version !== current.version) throw new AccessError('This shared view changed. Your draft is retained; reload the saved view before retrying.', 409);
      const definitions = context.list.objectType === 'deal' ? await tx.select().from(customFields).where(and(eq(customFields.workspaceId, access.workspaceId), eq(customFields.objectType, 'deal'))) : [];
      let config: ListViewConfig; try { config = normalizeViewConfig(b.config, context.list.objectType, businessFields(definitions)); } catch(e) { throw new AccessError(e instanceof Error ? e.message : 'Invalid view.', 400); }
      if(config.version === 2 && b.version === undefined) throw new AccessError('Reload the saved view before saving business filters.', 409);
      return (await tx.update(crmListViews).set({ config, version: current.version + 1 }).where(eq(crmListViews.id, current.id)).returning())[0];
    });
    return NextResponse.json({ view });
  }
  if (b.action === 'grant') {
    if (!context.creator) throw new AccessError('Only the list creator can grant access.', 403);
    if (typeof b.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email) || b.email.length > 254) throw new AccessError('Enter a valid email.', 400);
    if (b.access !== 'Reader' && b.access !== 'Editor') throw new AccessError('Choose Reader or Editor.', 400);
    const [member] = await db.select({ id: users.id }).from(users).innerJoin(memberships, eq(memberships.userId, users.id)).where(and(eq(users.email, b.email.trim().toLowerCase()), eq(memberships.workspaceId, access.workspaceId))).limit(1);
    if (!member) throw new AccessError('That account must be a workspace member.', 404);
    if (member.id === context.list.creatorId) throw new AccessError('The creator already has access.', 409);
    await db.insert(crmListGrants).values({ listId: context.list.id, userId: member.id, access: b.access as string }).onConflictDoUpdate({ target: [crmListGrants.listId, crmListGrants.userId], set: { access: b.access as string } });
    return NextResponse.json({ ok: true });
  }
  throw new AccessError('Invalid list action.', 400);
} catch (e) { return fail(e); } }
export async function PATCH(request: Request) { try {
  sameOrigin(request); const b = await bodyOf(request), { list, workspaceId } = await allowedList(request, b.listId, true);
  if (!uuid(b.entryId)) throw new AccessError('Entry not found.', 404);
  if (!LIST_STAGES.includes(b.stage as typeof LIST_STAGES[number])) throw new AccessError('Choose a valid list stage.', 400);
  if (b.note !== null && b.note !== undefined && (typeof b.note !== 'string' || b.note.length > 500)) throw new AccessError('List note must be at most 500 characters.', 400);
  const [entry] = await getDb().transaction(async tx => { await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${workspaceId}), 73921)`); return tx.update(crmListEntries).set({ stage: b.stage as string, note: typeof b.note === 'string' ? b.note.trim() || null : null }).where(and(eq(crmListEntries.id, b.entryId as string), eq(crmListEntries.listId, list.id))).returning(); });
  if (!entry) throw new AccessError('Entry not found.', 404);
  return NextResponse.json({ entry });
} catch (e) { return fail(e); } }
export async function DELETE(request: Request) { try {
  sameOrigin(request); const b = await bodyOf(request), { list, workspaceId } = await allowedList(request, b.listId, true);
  if (!uuid(b.entryId)) throw new AccessError('Entry not found.', 404);
  const [entry] = await getDb().transaction(async tx => { await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${workspaceId}), 73921)`); return tx.delete(crmListEntries).where(and(eq(crmListEntries.id, b.entryId as string), eq(crmListEntries.listId, list.id))).returning(); });
  if (!entry) throw new AccessError('Entry not found.', 404);
  return NextResponse.json({ removed: true });
} catch (e) { return fail(e); } }
