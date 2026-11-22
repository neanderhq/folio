import { NextResponse } from 'next/server';
import { eq, sql } from 'drizzle-orm';
import { AccessError, currentUser, newSession, passwordHash, sameOrigin, sessionCookie, signOut, validPassword, workspaceAccess } from '../../../server/auth';
import { getDb } from '../../../server/db';
import { seedNewWorkspace } from '../../../server/demo-seed';
import { loginAttempts, memberships, users, workspaces } from '../../../server/schema';
export const dynamic = 'force-dynamic';
const json = (data: object, status = 200) => NextResponse.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
function fail(e: unknown) { if (e instanceof AccessError) return json({ error: e.message }, e.status); console.error('Auth request failed', e); return json({ error: 'Request failed.' }, 503); }
async function form(request: Request) { if (Number(request.headers.get('content-length')) > 4096) throw new AccessError('Form too large.', 413); const text = await request.text(); if (text.length > 4096) throw new AccessError('Form too large.', 413); try { const b = JSON.parse(text); if (b && typeof b === 'object' && !Array.isArray(b)) return b as Record<string, unknown>; } catch {} throw new AccessError('Invalid form.', 400); }
const emailOf = (v: unknown) => { if (typeof v !== 'string' || v.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) throw new AccessError('Enter a valid email.', 400); return v.trim().toLowerCase(); };
const nameOf = (v: unknown) => { if (typeof v !== 'string' || !v.trim() || v.trim().length > 120) throw new AccessError('Enter a workspace name.', 400); return v.trim(); };
export async function GET(request: Request) { try { const user = await currentUser(request); const workspaceRows = await getDb().select({ id: workspaces.id, name: workspaces.name, role: memberships.role }).from(memberships).innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId)).where(eq(memberships.userId, user.id)); return json({ user, workspaces: workspaceRows }); } catch (e) { return fail(e); } }
export async function POST(request: Request) { try {
  sameOrigin(request);
  const b = await form(request), db = getDb();
  if (b.action === 'register') {
    const email = emailOf(b.email), name = nameOf(b.workspaceName);
    if (typeof b.password !== 'string' || b.password.length < 12 || b.password.length > 128) throw new AccessError('Use a password of 12–128 characters.', 400);
    const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
    if (existing.length) throw new AccessError('This email is already registered.', 409);
    const password = passwordHash(b.password);
    const user = await db.transaction(async tx => {
      const [u] = await tx.insert(users).values({ email, passwordHash: password }).returning();
      const [w] = await tx.insert(workspaces).values({ name }).returning();
      await tx.insert(memberships).values({ userId: u.id, workspaceId: w.id, role: 'Admin' });
      await seedNewWorkspace(tx, w.id, u.id);
      return u;
    });
    const token = await newSession(user.id); const response = json({ ok: true }, 201); response.headers.set('Set-Cookie', sessionCookie(request, token)); return response;
  }
  if (b.action === 'login') {
    const email = emailOf(b.email);
    const [limit] = await db.insert(loginAttempts).values({ email, attempts: 1 }).onConflictDoUpdate({ target: loginAttempts.email, set: {
      attempts: sql`case when ${loginAttempts.windowStartedAt} < now() - interval '15 minutes' then 1 else ${loginAttempts.attempts} + 1 end`,
      windowStartedAt: sql`case when ${loginAttempts.windowStartedAt} < now() - interval '15 minutes' then now() else ${loginAttempts.windowStartedAt} end`,
    } }).returning({ attempts: loginAttempts.attempts });
    if (limit.attempts > 10) throw new AccessError('Too many sign-in attempts. Try again in 15 minutes.', 429);
    const rows = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (typeof b.password !== 'string' || !rows.length || !validPassword(b.password, rows[0].passwordHash)) throw new AccessError('Invalid email or password.', 401);
    await db.delete(loginAttempts).where(eq(loginAttempts.email, email));
    const token = await newSession(rows[0].id); const response = json({ ok: true }); response.headers.set('Set-Cookie', sessionCookie(request, token)); return response;
  }
  if (b.action === 'logout') { await signOut(request); const response = json({ ok: true }); response.headers.set('Set-Cookie', sessionCookie(request, '', true)); return response; }
  if (b.action === 'createWorkspace') { const user = await currentUser(request), name = nameOf(b.name); const workspace = await db.transaction(async tx => { const [w] = await tx.insert(workspaces).values({ name }).returning(); await tx.insert(memberships).values({ userId: user.id, workspaceId: w.id, role: 'Admin' }); await seedNewWorkspace(tx, w.id, user.id); return w; }); return json({ workspace }, 201); }
  if (b.action === 'setMember') { const access = await workspaceAccess(request); if (access.role !== 'Admin') throw new AccessError('Only admins can manage members.', 403); const email = emailOf(b.email); if (b.role !== 'Admin' && b.role !== 'Member' && b.role !== 'Viewer') throw new AccessError('Choose a valid role.', 400); const target = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1); if (!target.length) throw new AccessError('That person must create an account first.', 404); if (target[0].id === access.user.id && b.role !== 'Admin') throw new AccessError('Ask another admin to change your role.', 400); await db.insert(memberships).values({ workspaceId: access.workspaceId, userId: target[0].id, role: b.role }).onConflictDoUpdate({ target: [memberships.workspaceId, memberships.userId], set: { role: b.role } }); return json({ ok: true }); }
  throw new AccessError('Invalid action.', 400);
} catch (e) { return fail(e); } }
