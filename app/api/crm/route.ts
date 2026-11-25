import { NextResponse } from 'next/server';
import { eq, and, isNull, sql } from 'drizzle-orm';
import { getDb } from '../../../server/db';
import { companies, people, deals, dealStageEvents, notes, tasks, recordChanges, memberships, notifications } from '../../../server/schema';
import { STAGES, CURRENCIES } from '../../../shared/crm';
import { AccessError, sameOrigin, workspaceAccess } from '../../../server/auth';
import { CustomFieldError, customLock, saveCustomValues } from '../../../server/custom-fields';
import { runFollowups } from '../../../server/followups';
import { activeRecordIds } from '../../../server/record-lifecycle';

export const dynamic = 'force-dynamic';
type Target = 'company' | 'person' | 'deal';
class InputError extends Error { constructor(message: string, public status = 400) { super(message); } }
// The UI needs complete collections for its counts and board. Reject overflow instead of returning partial data.
const MAX_RECORDS_PER_COLLECTION = 500;
const MAX_BODY_BYTES = 16 * 1024;
const WRITE_WINDOW_MS = 60_000;
const MAX_WRITES_PER_WINDOW = 60;
let writeWindow = { started: 0, count: 0 };
function throttleWrite() {
  const now = Date.now();
  if (now - writeWindow.started >= WRITE_WINDOW_MS) writeWindow = { started: now, count: 0 };
  if (writeWindow.count >= MAX_WRITES_PER_WINDOW) {
    const retry = Math.max(1, Math.ceil((WRITE_WINDOW_MS - (now - writeWindow.started)) / 1000));
    throw new InputError(`Too many changes to the workspace. Try again in ${retry} seconds.`, 429);
  }
  writeWindow.count++;
}
const id = (value: unknown) => { const n = Number(value); if (!Number.isSafeInteger(n) || n <= 0) throw new InputError('Choose a valid record.'); return n; };
const versionOf = (value: unknown) => { const n = Number(value); if (!Number.isSafeInteger(n) || n <= 0) throw new InputError('Send the record version before saving.'); return n; };
const assigneeOf = (value: unknown) => { if (value == null || value === '') return null; if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new InputError('Choose a workspace member.'); return value; };
const identityLock = (workspaceId: string) => sql`select pg_advisory_xact_lock(hashtext(${workspaceId}), 73921)`;
const domainOf = (value: unknown) => { const domain = optional(value, 'Domain', 253)?.toLowerCase() || null; if (domain && !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) throw new InputError('Enter a valid company domain.'); return domain; };
const emailOf = (value: unknown) => { const email = optional(value, 'Email', 254)?.toLowerCase() || null; if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new InputError('Enter a valid email address.'); return email; };
const required = (value: unknown, label: string, max: number) => { if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new InputError(`${label} must be 1–${max} characters.`); return value.trim(); };
const optional = (value: unknown, label: string, max: number) => { if (value == null || value === '') return null; if (typeof value !== 'string' || value.trim().length > max) throw new InputError(`${label} must be at most ${max} characters.`); return value.trim() || null; };
const dueDateOf = (value: unknown) => { const dueDate=optional(value,'Due date',10); if (dueDate && (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate) || Number.isNaN(Date.parse(`${dueDate}T00:00:00Z`)) || new Date(`${dueDate}T00:00:00Z`).toISOString().slice(0,10) !== dueDate)) throw new InputError('Choose a valid due date.'); return dueDate; };
const tableFor = (type: Target) => ({ company: companies, person: people, deal: deals })[type];
function stage(value: unknown): typeof STAGES[number] { const found = STAGES.find(item => item === value); if (!found) throw new InputError('Choose a valid stage.'); return found; }
function currency(value: unknown): typeof CURRENCIES[number] { const found = CURRENCIES.find(item => item === value); if (!found) throw new InputError('Choose a supported currency.'); return found; }
function lostReason(value: unknown, selectedStage: string) { return selectedStage === 'Lost' ? required(value, 'Lost reason', 500) : null; }
function targetType(value: unknown): Target { if (value !== 'company' && value !== 'person' && value !== 'deal') throw new InputError('Choose a company, person, or deal.'); return value; }
async function exists(type: Target, targetId: number, workspaceId: string) { const rows = await getDb().select({ id: tableFor(type).id }).from(tableFor(type)).where(and(eq(tableFor(type).id, targetId), eq(tableFor(type).workspaceId, workspaceId), isNull(tableFor(type).deletedAt))).limit(1); if (!rows.length) throw new InputError('The linked record was not found.', 404); }
async function bodyOf(request: Request) {
  const length = Number(request.headers.get('content-length'));
  if (length > MAX_BODY_BYTES) throw new InputError('Form is too large (16 KiB maximum).', 413);
  if (!request.body) throw new InputError('Provide a valid JSON form.');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) { await reader.cancel().catch(() => {}); throw new InputError('Form is too large (16 KiB maximum).', 413); }
    chunks.push(value);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch { throw new InputError('Provide a valid JSON form.'); }
}
async function capacity(type: Target | 'note' | 'task', workspaceId: string) {
  const table = { ...{ company: companies, person: people, deal: deals }, note: notes, task: tasks }[type];
  const rows = type === 'company' ? await getDb().select({ id: companies.id }).from(companies).where(and(eq(companies.workspaceId, workspaceId), isNull(companies.deletedAt))).limit(MAX_RECORDS_PER_COLLECTION)
    : type === 'person' ? await getDb().select({ id: people.id }).from(people).where(and(eq(people.workspaceId, workspaceId), isNull(people.deletedAt))).limit(MAX_RECORDS_PER_COLLECTION)
    : type === 'deal' ? await getDb().select({ id: deals.id }).from(deals).where(and(eq(deals.workspaceId, workspaceId), isNull(deals.deletedAt))).limit(MAX_RECORDS_PER_COLLECTION)
    : await getDb().select({ id: table.id }).from(table).where(eq(table.workspaceId, workspaceId)).limit(MAX_RECORDS_PER_COLLECTION);
  if (rows.length >= MAX_RECORDS_PER_COLLECTION) throw new InputError(`The workspace has reached its ${MAX_RECORDS_PER_COLLECTION} ${type} record limit.`, 409);
}
function fail(error: unknown) {
  if (error instanceof AccessError) return NextResponse.json({ error: error.message }, { status: error.status });
  if (error instanceof CustomFieldError) return NextResponse.json({ error: error.message }, { status: error.status });
  if (error && typeof error === 'object' && 'cause' in error && error.cause && typeof error.cause === 'object' && 'constraint' in error.cause && error.cause.constraint === 'crm_custom_values_unique_idx') return NextResponse.json({ error: 'A custom field value must be unique in this workspace.' }, { status: 409 });
  if (error instanceof InputError) return NextResponse.json({ error: error.message }, { status: error.status, headers: error.status === 429 ? { 'Retry-After': String(Math.max(1, Math.ceil((WRITE_WINDOW_MS - (Date.now() - writeWindow.started)) / 1000))) } : undefined });
  console.error('CRM request failed', error);
  return NextResponse.json({ error: 'The workspace is unavailable. Check the database and try again.' }, { status: 503 });
}
export async function GET(request: Request) { try { const { workspaceId } = await workspaceAccess(request); const db = getDb(); const limit = MAX_RECORDS_PER_COLLECTION + 1; const [c,p,d,n,t] = await Promise.all([db.select().from(companies).where(and(eq(companies.workspaceId, workspaceId), isNull(companies.deletedAt))).orderBy(companies.name).limit(limit), db.select().from(people).where(and(eq(people.workspaceId, workspaceId), isNull(people.deletedAt))).orderBy(people.name).limit(limit), db.select().from(deals).where(and(eq(deals.workspaceId, workspaceId), isNull(deals.deletedAt))).orderBy(deals.createdAt).limit(limit), db.select().from(notes).where(eq(notes.workspaceId, workspaceId)).orderBy(notes.createdAt).limit(limit), db.select().from(tasks).where(eq(tasks.workspaceId, workspaceId)).orderBy(tasks.createdAt).limit(limit)]); if ([c,p,d,n,t].some(rows => rows.length > MAX_RECORDS_PER_COLLECTION)) throw new InputError('The workspace has exceeded its 500-record collection limit. Contact the demo owner to reduce the dataset.', 409); const visible = await activeRecordIds(workspaceId); return NextResponse.json({ companies:c, people:p, deals:d, notes:n.filter(item => visible(item.targetType, item.targetId)), tasks:t.filter(item => visible(item.targetType, item.targetId)) }); } catch (e) { return fail(e); } }
export async function POST(request: Request) { try {
  sameOrigin(request); const { workspaceId, user } = await workspaceAccess(request, true); throttleWrite();
  const b = await bodyOf(request);
  const db = getDb(); let row;
  switch (b.type) {
    case 'company': { const name=required(b.name,'Company name',120), description=optional(b.description,'Description',500), domain=domainOf(b.domain); await capacity('company', workspaceId); row = await db.transaction(async tx => { await tx.execute(identityLock(workspaceId)); if (domain) { const duplicate=await tx.select({id:companies.id}).from(companies).where(and(eq(companies.workspaceId,workspaceId),isNull(companies.deletedAt),sql`lower(${companies.domain}) = ${domain}`)).limit(1); if (duplicate.length) throw new InputError('A company with this domain already exists in this workspace.',409); } await tx.execute(customLock(workspaceId)); const inserted = await tx.insert(companies).values({ workspaceId, name, description, domain }).returning(); await saveCustomValues(tx, workspaceId, 'company', inserted[0].id, b.customValues, true); return inserted; }); break; }
    case 'person': { const companyId = id(b.companyId); const name=required(b.name,'Person name',120), email = emailOf(b.email); await capacity('person', workspaceId); row = await db.transaction(async tx => { await tx.execute(identityLock(workspaceId)); const [company] = await tx.select({id:companies.id}).from(companies).where(and(eq(companies.id,companyId),eq(companies.workspaceId,workspaceId),isNull(companies.deletedAt))).limit(1); if (!company) throw new InputError('The linked company changed. Review the person and try again.',409); if (email) { const duplicate=await tx.select({id:people.id}).from(people).where(and(eq(people.workspaceId,workspaceId),isNull(people.deletedAt),sql`lower(${people.email}) = ${email}`)).limit(1); if (duplicate.length) throw new InputError('A person with this email already exists in this workspace.',409); } await tx.execute(customLock(workspaceId)); const inserted = await tx.insert(people).values({ workspaceId, name, email, companyId }).returning(); await saveCustomValues(tx, workspaceId, 'person', inserted[0].id, b.customValues, true); return inserted; }); break; }
    case 'deal': { const companyId=id(b.companyId), personId=id(b.personId); await exists('company',companyId,workspaceId); const person = await db.select().from(people).where(and(eq(people.id,personId), eq(people.workspaceId, workspaceId), isNull(people.deletedAt))).limit(1); if (!person.length) throw new InputError('The linked person was not found.',404); if (person[0].companyId !== companyId) throw new InputError('The person must belong to the selected company.'); const selectedStage=stage(b.stage), selectedCurrency=currency(b.currency ?? 'USD'), reason=lostReason(b.lostReason, selectedStage); const valueCents = Number(b.valueCents); if (!Number.isSafeInteger(valueCents) || valueCents < 0 || valueCents > 2147483647) throw new InputError('Value must be a nonnegative whole number of currency minor units.'); const name=required(b.name,'Deal name',120), owner=required(b.owner,'Owner',80); await capacity('deal', workspaceId); row = await db.transaction(async tx => { await tx.execute(identityLock(workspaceId)); const [linkedCompany]=await tx.select({id:companies.id}).from(companies).where(and(eq(companies.id,companyId),eq(companies.workspaceId,workspaceId),isNull(companies.deletedAt))).limit(1); const [linkedPerson]=await tx.select({id:people.id,companyId:people.companyId}).from(people).where(and(eq(people.id,personId),eq(people.workspaceId,workspaceId),isNull(people.deletedAt))).limit(1); if(!linkedCompany||!linkedPerson||linkedPerson.companyId!==companyId) throw new InputError('The linked company or person changed. Review the deal and try again.',409); await tx.execute(customLock(workspaceId)); const now = new Date(); const inserted = await tx.insert(deals).values({ workspaceId, name, companyId, personId, stage:selectedStage, owner, valueCents, currency:selectedCurrency, lostReason:reason, wonClosedAt:selectedStage==='Won'?now:null }).returning(); await tx.insert(dealStageEvents).values({ workspaceId, dealId:inserted[0].id, fromStage:null, toStage:selectedStage, changedAt:now, lostReason:reason }); await saveCustomValues(tx, workspaceId, 'deal', inserted[0].id, b.customValues, true); return inserted; }); break; }
    case 'note': { const type=targetType(b.targetType), targetId=id(b.targetId); const body=required(b.body,'Note',2000); await capacity('note', workspaceId); row = await db.transaction(async tx => { await tx.execute(identityLock(workspaceId)); const table=tableFor(type); const [target]=await tx.select({id:table.id}).from(table).where(and(eq(table.id,targetId),eq(table.workspaceId,workspaceId),isNull(table.deletedAt))).limit(1); if (!target) throw new InputError('The linked record changed. Review the note and try again.',409); return tx.insert(notes).values({ workspaceId, targetType:type, targetId, body }).returning(); }); break; }
    case 'task': { const type=targetType(b.targetType), targetId=id(b.targetId), dueDate=dueDateOf(b.dueDate), title=required(b.title,'Task title',160), assigneeId=assigneeOf(b.assigneeId); await capacity('task', workspaceId); row = await db.transaction(async tx => { await tx.execute(identityLock(workspaceId)); const targetTable=tableFor(type); const [target]=await tx.select({id:targetTable.id}).from(targetTable).where(and(eq(targetTable.id,targetId),eq(targetTable.workspaceId,workspaceId),isNull(targetTable.deletedAt))).limit(1); if(!target) throw new InputError('The linked record was not found.',404); if(assigneeId){const [member]=await tx.select({userId:memberships.userId}).from(memberships).where(and(eq(memberships.workspaceId,workspaceId),eq(memberships.userId,assigneeId))).limit(1); if(!member) throw new InputError('Choose a member of this workspace.',404);} const inserted=await tx.insert(tasks).values({workspaceId,targetType:type,targetId,title,dueDate,assigneeId}).returning(); if(assigneeId && assigneeId!==user.id) await tx.insert(notifications).values({workspaceId,recipientId:assigneeId,actorId:user.id,taskId:inserted[0].id,kind:'task_assigned',taskVersion:inserted[0].version}); return inserted; }); break; }
    default: throw new InputError('Choose a valid record type.');
  }
  return NextResponse.json(row[0], { status:201 });
} catch(e) { return fail(e); } }
export async function PATCH(request: Request) { try {
  sameOrigin(request);
  const { workspaceId, user } = await workspaceAccess(request, true);
  throttleWrite();
  const b = await bodyOf(request), recordId = id(b.id), db = getDb();
  if (b.type === 'task') {
    const expectedVersion=versionOf(b.version);
    const fields=Object.keys(b).filter(key=>!['type','id','version'].includes(key));
    if (!fields.length || fields.some(key=>!['title','dueDate','done','assigneeId'].includes(key))) throw new InputError('Choose valid task fields to update.');
    const row=await db.transaction(async tx=>{
      const [current]=await tx.select().from(tasks).where(and(eq(tasks.id,recordId),eq(tasks.workspaceId,workspaceId))).for('update').limit(1);
      if(!current) throw new InputError('The record was not found.',404);
      if(current.version!==expectedVersion) throw new InputError('This task changed since you opened it. Your draft is still here; refresh before saving again.',409);
      const title='title' in b?required(b.title,'Task title',160):current.title;
      const dueDate='dueDate' in b?dueDateOf(b.dueDate):current.dueDate;
      const done='done' in b?b.done:current.done;
      if(typeof done!=='boolean') throw new InputError('Task completion must be true or false.');
      const assigneeId='assigneeId' in b?assigneeOf(b.assigneeId):current.assigneeId;
      if(assigneeId){const [member]=await tx.select({userId:memberships.userId}).from(memberships).where(and(eq(memberships.workspaceId,workspaceId),eq(memberships.userId,assigneeId))).limit(1);if(!member) throw new InputError('Choose a member of this workspace.',404);}
      if(title===current.title && dueDate===current.dueDate && done===current.done && assigneeId===current.assigneeId) return current;
      const [saved]=await tx.update(tasks).set({title,dueDate,done,assigneeId,version:current.version+1}).where(and(eq(tasks.id,recordId),eq(tasks.workspaceId,workspaceId),eq(tasks.version,expectedVersion))).returning();
      if(assigneeId && assigneeId!==current.assigneeId && assigneeId!==user.id) await tx.insert(notifications).values({workspaceId,recipientId:assigneeId,actorId:user.id,taskId:recordId,kind:'task_assigned',taskVersion:saved.version});
      return saved;
    });
    return NextResponse.json(row);
  }
  if (b.type !== 'company' && b.type !== 'person' && b.type !== 'deal' && b.type !== 'note') throw new InputError('Choose a company, person, deal, or note to update.');
  const type = b.type, expectedVersion = versionOf(b.version);
  const allowed = { company: ['name', 'domain', 'description'], person: ['name', 'email', 'companyId'], deal: ['name', 'companyId', 'personId', 'stage', 'owner', 'valueCents', 'currency', 'lostReason'], note: ['body'] }[type];
  const fields = Object.keys(b).filter(key => key !== 'type' && key !== 'id' && key !== 'version');
  if (!fields.length || fields.some(key => !allowed.includes(key))) throw new InputError('Choose valid fields to update.');
  const result = await db.transaction(async tx => {
    await tx.execute(identityLock(workspaceId));
    const changes: Record<string, { from: string | number | null; to: string | number | null }> = {};
    const track = (key: string, from: string | number | null, to: string | number | null) => { if (from !== to) changes[key] = { from, to }; };
    let saved: unknown;
    if (type === 'company') {
      const [current] = await tx.select().from(companies).where(and(eq(companies.id, recordId), eq(companies.workspaceId, workspaceId), isNull(companies.deletedAt))).for('update').limit(1);
      if (!current) throw new InputError('The record was not found.', 404);
      if (current.version !== expectedVersion) throw new InputError('This record changed since you opened it. Your draft is still here; refresh before saving again.', 409);
      const name = 'name' in b ? required(b.name, 'Company name', 120) : current.name;
      const domain = 'domain' in b ? domainOf(b.domain) : current.domain;
      const description = 'description' in b ? optional(b.description, 'Description', 500) : current.description;
      if (domain) {
        const matches = await tx.select({ id: companies.id }).from(companies).where(and(eq(companies.workspaceId, workspaceId), isNull(companies.deletedAt), sql`lower(${companies.domain}) = ${domain}`)).limit(2);
        if (matches.some(row => row.id !== recordId)) throw new InputError('A company with this domain already exists in this workspace.', 409);
      }
      track('name', current.name, name); track('domain', current.domain, domain); track('description', current.description, description);
      saved = Object.keys(changes).length ? (await tx.update(companies).set({ name, domain, description, version: current.version + 1 }).where(and(eq(companies.id, recordId), eq(companies.workspaceId, workspaceId), eq(companies.version, expectedVersion))).returning())[0] : current;
    } else if (type === 'person') {
      const [current] = await tx.select().from(people).where(and(eq(people.id, recordId), eq(people.workspaceId, workspaceId), isNull(people.deletedAt))).for('update').limit(1);
      if (!current) throw new InputError('The record was not found.', 404);
      if (current.version !== expectedVersion) throw new InputError('This record changed since you opened it. Your draft is still here; refresh before saving again.', 409);
      const name = 'name' in b ? required(b.name, 'Person name', 120) : current.name;
      const email = 'email' in b ? emailOf(b.email) : current.email;
      const companyId = 'companyId' in b ? id(b.companyId) : current.companyId;
      const linkedCompany = await tx.select({ id: companies.id }).from(companies).where(and(eq(companies.id, companyId), eq(companies.workspaceId, workspaceId), isNull(companies.deletedAt))).limit(1);
      if (!linkedCompany.length) throw new InputError('The linked company was not found.', 404);
      if (companyId !== current.companyId) {
        const linkedDeal = await tx.select({ id: deals.id }).from(deals).where(and(eq(deals.personId, recordId), eq(deals.workspaceId, workspaceId))).limit(1);
        if (linkedDeal.length) throw new InputError('Move this person’s deals before changing their company.', 409);
      }
      if (email) {
        const matches = await tx.select({ id: people.id }).from(people).where(and(eq(people.workspaceId, workspaceId), isNull(people.deletedAt), sql`lower(${people.email}) = ${email}`)).limit(2);
        if (matches.some(row => row.id !== recordId)) throw new InputError('A person with this email already exists in this workspace.', 409);
      }
      track('name', current.name, name); track('email', current.email, email); track('companyId', current.companyId, companyId);
      saved = Object.keys(changes).length ? (await tx.update(people).set({ name, email, companyId, version: current.version + 1 }).where(and(eq(people.id, recordId), eq(people.workspaceId, workspaceId), eq(people.version, expectedVersion))).returning())[0] : current;
    } else if (type === 'deal') {
      const [current] = await tx.select().from(deals).where(and(eq(deals.id, recordId), eq(deals.workspaceId, workspaceId), isNull(deals.deletedAt))).for('update').limit(1);
      if (!current) throw new InputError('The record was not found.', 404);
      if (current.version !== expectedVersion) throw new InputError('This record changed since you opened it. Your draft is still here; refresh before saving again.', 409);
      const name = 'name' in b ? required(b.name, 'Deal name', 120) : current.name;
      const companyId = 'companyId' in b ? id(b.companyId) : current.companyId;
      const personId = 'personId' in b ? id(b.personId) : current.personId;
      const selectedStage = 'stage' in b ? stage(b.stage) : current.stage;
      const owner = 'owner' in b ? required(b.owner, 'Owner', 80) : current.owner;
      const selectedCurrency = 'currency' in b ? currency(b.currency) : current.currency;
      const valueCents = 'valueCents' in b ? Number(b.valueCents) : current.valueCents;
      if (!Number.isSafeInteger(valueCents) || valueCents < 0 || valueCents > 2147483647) throw new InputError('Value must be a nonnegative whole number of currency minor units.');
      const [linkedCompany] = await tx.select({ id: companies.id }).from(companies).where(and(eq(companies.id, companyId), eq(companies.workspaceId, workspaceId), isNull(companies.deletedAt))).limit(1);
      const [linkedPerson] = await tx.select({ id: people.id, companyId: people.companyId }).from(people).where(and(eq(people.id, personId), eq(people.workspaceId, workspaceId), isNull(people.deletedAt))).limit(1);
      if (!linkedCompany || !linkedPerson) throw new InputError('The linked company or person was not found.', 404);
      if (linkedPerson.companyId !== companyId) throw new InputError('The person must belong to the selected company.');
      const reason = selectedStage === 'Lost' ? lostReason('lostReason' in b ? b.lostReason : current.stage === 'Lost' ? current.lostReason : undefined, selectedStage) : null;
      const now = new Date();
      const wonClosedAt = selectedStage === current.stage ? current.wonClosedAt : selectedStage === 'Won' ? now : null;
      track('name', current.name, name); track('companyId', current.companyId, companyId); track('personId', current.personId, personId);
      track('stage', current.stage, selectedStage); track('owner', current.owner, owner); track('valueCents', current.valueCents, valueCents);
      track('currency', current.currency, selectedCurrency); track('lostReason', current.lostReason, reason);
      saved = Object.keys(changes).length ? (await tx.update(deals).set({ name, companyId, personId, stage: selectedStage, owner, valueCents, currency: selectedCurrency, lostReason: reason, wonClosedAt, version: current.version + 1 }).where(and(eq(deals.id, recordId), eq(deals.workspaceId, workspaceId), eq(deals.version, expectedVersion))).returning())[0] : current;
      if (current.stage !== selectedStage) { const [event] = await tx.insert(dealStageEvents).values({ workspaceId, dealId: recordId, fromStage: current.stage, toStage: selectedStage, changedAt: now, lostReason: reason }).returning(); await runFollowups(tx, workspaceId, user.id, recordId, selectedStage, event.id, now); }
    } else {
      const [current] = await tx.select().from(notes).where(and(eq(notes.id, recordId), eq(notes.workspaceId, workspaceId))).for('update').limit(1);
      if (!current) throw new InputError('The record was not found.', 404);
      if (current.version !== expectedVersion) throw new InputError('This record changed since you opened it. Your draft is still here; refresh before saving again.', 409);
      const body = required(b.body, 'Note', 2000);
      track('body', current.body, body);
      saved = Object.keys(changes).length ? (await tx.update(notes).set({ body, version: current.version + 1 }).where(and(eq(notes.id, recordId), eq(notes.workspaceId, workspaceId), eq(notes.version, expectedVersion))).returning())[0] : current;
    }
    if (Object.keys(changes).length) await tx.insert(recordChanges).values({ workspaceId, actorId: user.id, recordType: type, recordId, version: expectedVersion + 1, changes });
    return saved;
  });
  return NextResponse.json(result);
} catch(e) { return fail(e); } }
export async function DELETE(request: Request) { try { sameOrigin(request); const { workspaceId } = await workspaceAccess(request, true); throttleWrite(); const b=await bodyOf(request), db=getDb(), recordId=id(b.id); let row;
  if (b.type==='note') { const expectedVersion=versionOf(b.version); row=await db.delete(notes).where(and(eq(notes.id,recordId), eq(notes.workspaceId,workspaceId), eq(notes.version,expectedVersion))).returning(); if (!row.length) { const current=await db.select({id:notes.id}).from(notes).where(and(eq(notes.id,recordId), eq(notes.workspaceId,workspaceId))).limit(1); if (current.length) throw new InputError('This note changed since you opened it. Refresh before removing it.',409); } }
  else if (b.type==='task') { const expectedVersion=versionOf(b.version); row=await db.delete(tasks).where(and(eq(tasks.id,recordId), eq(tasks.workspaceId,workspaceId), eq(tasks.version,expectedVersion))).returning(); if(!row.length){const current=await db.select({id:tasks.id}).from(tasks).where(and(eq(tasks.id,recordId),eq(tasks.workspaceId,workspaceId))).limit(1);if(current.length)throw new InputError('This task changed since you opened it. Refresh before removing it.',409);} }
  else throw new InputError('Only notes and tasks can be removed here.');
  if (!row.length) throw new InputError('The record was not found.',404); return NextResponse.json({deleted:true});
} catch(e) { return fail(e); } }
