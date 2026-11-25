import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';

const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 }).trim();
type Account = { cookie: string; workspace: string; user: string };
type Records = { companies: { id: number; name: string; version: number }[]; people: { id: number; companyId: number }[]; deals: { id: number; companyId: number; personId: number }[]; notes: unknown[]; tasks: unknown[] };

async function main() {
  const image = process.env.NEANDER_TEMPLATE_IMAGE, database = process.env.DATABASE_URL;
  assert(image && database, 'Run through neander-template verify with a disposable PostgreSQL database.');
  const origin = new URL(process.env.NEANDER_TEMPLATE_TEST_ORIGIN ?? 'http://127.0.0.1:8080');
  assert(origin.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(origin.hostname));
  const containerDatabase = new URL(database);
  if (['localhost', '127.0.0.1', '[::1]'].includes(containerDatabase.hostname)) containerDatabase.hostname = 'host.docker.internal';
  const name = `attio-template-${randomUUID()}`, directory = mkdtempSync(join(tmpdir(), 'attio-template-'));
  const bundle = join(directory, 'environment');
  writeFileSync(bundle, `DATABASE_URL=${containerDatabase}\n`, { mode: 0o444 });
  const client = new Client({ connectionString: database });
  const workspaceIds: string[] = [], userIds: string[] = [];
  let started = false;
  try {
    await client.connect();
    const emulated = process.arch === 'arm64' && docker('image', 'inspect', '--format', '{{.Architecture}}', image) === 'amd64';
    const start = () => {
      docker('run', '--detach', '--name', name, ...(emulated ? ['--env', 'NODE_OPTIONS=--jitless'] : []), '--add-host', 'host.docker.internal:host-gateway', '--publish', `127.0.0.1:${origin.port || '80'}:8080`, '--mount', `type=bind,source=${bundle},target=/run/secrets/neander_environment,readonly`, image);
      started = true;
    };
    const request = async (path: string, account?: Account, body?: object, method = body ? 'POST' : 'GET', status = 200) => {
      const response = await fetch(new URL(path, origin), { method, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30_000), headers: { connection: 'close', ...(body ? { origin: origin.origin, 'content-type': 'application/json' } : {}), ...(account ? { cookie: account.cookie, 'x-workspace-id': account.workspace } : {}) } });
      assert.equal(response.status, status, `${method} ${path}: ${await response.clone().text()}`);
      return response;
    };
    const ready = async () => {
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        try { const response = await fetch(new URL('/api/health', origin), { signal: AbortSignal.timeout(2000), headers: { connection: 'close' } }); const ok = response.ok; await response.body?.cancel(); if (ok) return; } catch {}
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      throw new Error('Built image did not become ready within 60 seconds.');
    };
    const register = async (label: string) => {
      const response = await request('/api/auth', undefined, { action: 'register', email: `${label}-${randomUUID()}@example.test`, password: randomUUID(), workspaceName: `Fictional ${label}` }, 'POST', 201);
      const cookie = response.headers.getSetCookie().map(item => item.split(';')[0]).join('; ');
      assert(cookie.includes('ledger_session='));
      const me = await (await request('/api/auth', { cookie, workspace: '', user: '' })).json();
      const account = { cookie, workspace: me.workspaces[0].id, user: me.user.id };
      workspaceIds.push(account.workspace); userIds.push(account.user);
      return account;
    };
    const records = async (account: Account) => await (await request('/api/crm', account)).json() as Records;
    start(); await ready();
    execFileSync('python3', ['scripts/test_entrypoint.py'], { stdio: 'inherit', env: { ...process.env, ...(emulated ? { DOCKER_DEFAULT_PLATFORM: 'linux/amd64', NEANDER_TEMPLATE_EMULATED: '1' } : {}) } });
    execFileSync('python3', ['scripts/smoke.py', origin.origin], { stdio: 'inherit' });
    if (process.env.NEANDER_TEMPLATE_BROWSER_TESTS === '1') {
      execFileSync('node', ['--import', 'tsx', 'scripts/check-record-editor-ui.ts'], {
        stdio: 'inherit', timeout: 180_000,
        env: { ...process.env, NEANDER_TEMPLATE_UI_ORIGIN: origin.origin },
      });
    }
    await request('/api/crm', undefined, undefined, 'GET', 401);
    // Existing/ordinary workspaces are unaffected; disabling initialization survives retries.
    await client.query("UPDATE crm_template_settings SET enabled=false WHERE id='attio-starter-v1'");
    execFileSync('node', ['--import', 'tsx', 'scripts/check-crm-api.ts'], { stdio: 'inherit', timeout: 120_000 });
    execFileSync('node', ['--import', 'tsx', 'scripts/check-followups.ts'], { stdio: 'inherit', timeout: 120_000 });
    const existing = await register('existing');
    execFileSync('node', ['scripts/initialize-template.mjs'], { stdio: 'inherit' });
    assert.equal((await client.query("SELECT enabled FROM crm_template_settings WHERE id='attio-starter-v1'")).rows[0].enabled, false);
    await client.query("UPDATE crm_template_settings SET enabled=true WHERE id='attio-starter-v1'");
    const owner = await register('owner'), other = await register('other');
    const seeded = await records(owner);
    assert.equal(seeded.companies.length, 3); assert.equal(seeded.people.length, 3); assert.equal(seeded.deals.length, 3); assert.equal(seeded.notes.length, 3); assert.equal(seeded.tasks.length, 3);
    assert(seeded.companies.every(item => item.name.endsWith('(demo)')));
    assert(seeded.people.every(person => seeded.companies.some(company => company.id === person.companyId)));
    assert(seeded.deals.every(deal => seeded.people.some(person => person.id === deal.personId && person.companyId === deal.companyId)));
    assert.equal((await records(existing)).companies.length, 0, 'Initialization must not add examples to an existing workspace.');
    await request('/api/crm', { ...other, workspace: owner.workspace }, undefined, 'GET', 404);
    const company = seeded.companies.find(item => item.name === 'Northstar Studio (demo)')!;
    assert(company);
    await request('/api/crm', owner, { type: 'company', id: company.id, version: company.version, name: 'My renamed company' }, 'PATCH');
    await request('/api/crm', { ...other, workspace: owner.workspace }, { type: 'company', id: company.id, version: 2, name: 'Unauthorized' }, 'PATCH', 404);
    const deletedNote = (await (await request('/api/crm', owner)).json()).notes[0];
    await request('/api/crm', owner, { type: 'note', id: deletedNote.id, version: deletedNote.version }, 'DELETE');
    execFileSync('node', ['scripts/initialize-template.mjs'], { stdio: 'inherit' });
    execFileSync('node', ['--import', 'tsx', 'scripts/seed.ts'], { stdio: 'inherit', env: { ...process.env, DEMO_WORKSPACE_ID: owner.workspace } });
    docker('rm', '--force', '--volumes', name); started = false;
    start(); await ready();
    const persisted = await records(owner);
    assert.equal(persisted.companies.length, 3);
    assert(persisted.companies.some(item => item.id === company.id && item.name === 'My renamed company'));
    assert.equal(persisted.notes.length, 2, 'Retry must not recreate deleted sample records.');
    assert.equal((await records(other)).companies.filter(item => item.name === 'My renamed company').length, 0);
    assert.equal((await records(existing)).companies.length, 0);
    const additional = await (await request('/api/auth', owner, { action: 'createWorkspace', name: 'Second private workspace' }, 'POST', 201)).json();
    workspaceIds.push(additional.workspace.id);
    assert.equal((await records({ ...owner, workspace: additional.workspace.id })).companies.length, 3);
    console.log('Verified production image: static assets, literal secrets, seeded private signup/workspaces, isolation, persistent edits/deletion, initialization retry and container replacement.');
  } catch (error) {
    if (started) console.error(docker('logs', '--tail', '50', name));
    throw error;
  } finally {
    if (started) docker('rm', '--force', '--volumes', name);
    rmSync(directory, { recursive: true, force: true });
    // Delete only the verification identities/workspaces, never other database rows.
    if (workspaceIds.length) for (const table of ['record_changes', 'crm_notifications', 'tasks', 'notes', 'deal_stage_events', 'deals', 'people', 'companies', 'crm_workspace_seeds', 'crm_memberships', 'crm_workspaces']) {
      await client.query(`DELETE FROM ${table} WHERE ${table === 'crm_workspaces' ? 'id' : 'workspace_id'} = ANY($1::uuid[])`, [workspaceIds]);
    }
    if (userIds.length) { await client.query('DELETE FROM crm_sessions WHERE user_id = ANY($1::uuid[])', [userIds]); await client.query('DELETE FROM crm_users WHERE id = ANY($1::uuid[])', [userIds]); }
    await client.end();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
