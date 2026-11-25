import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { Client } from 'pg';
import { STAGES } from '../shared/crm';

async function main() {
  const origin = new URL(process.env.NEANDER_TEMPLATE_UI_ORIGIN || 'http://127.0.0.1:8080');
  const database = process.env.DATABASE_URL;
  assert(origin.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(origin.hostname), 'UI checks require a loopback built app.');
  assert(database && database === process.env.NEANDER_TEMPLATE_TEST_DATABASE_URL, 'Explicitly select the same disposable test database.');
  const evidence = process.env.NEANDER_TEMPLATE_UI_EVIDENCE;
  if (evidence) mkdirSync(evidence, { recursive: true });
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, timezoneId: 'Asia/Kolkata' });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && /same key|unique.*key/i.test(message.text())) errors.push(message.text()); });
  let workspace = '', user = '';
  const capture = async (name: string) => { if (evidence) await page.screenshot({ path: join(evidence, `${name}.png`), fullPage: true }); };
  const request = async (method: 'get' | 'post' | 'patch', path: string, data?: object, status = 200) => {
    // The production session is Secure. Supply the real session explicitly for
    // loopback HTTP API assertions, as the existing image verifier does.
    const cookie = (await context.cookies()).map(item=>`${item.name}=${item.value}`).join('; ');
    const response = await context.request[method](new URL(path, origin).href, { headers: { origin: origin.origin, 'x-workspace-id': workspace, cookie }, ...(data ? { data } : {}) });
    assert.equal(response.status(), status, await response.text());
    return response.json();
  };
  try {
    await request('post', '/api/auth', { action: 'register', email: `editor-ui-${randomUUID()}@example.test`, password: randomUUID(), workspaceName: 'Fictional editor regression' }, 201);
    const account = await request('get', '/api/auth');
    workspace = account.workspaces[0].id; user = account.user.id;
    const company = await request('post', '/api/crm', { type: 'company', name: 'Cedar UI Demo', domain: 'cedar-ui.example' }, 201);
    const person = await request('post', '/api/crm', { type: 'person', name: 'Mira UI Demo', companyId: company.id }, 201);
    const deal = await request('post', '/api/crm', { type: 'deal', name: 'Cedar UI pilot', companyId: company.id, personId: person.id, owner: 'Sam Demo', stage: 'Lead', currency: 'USD', valueCents: 10000 }, 201);
    await page.goto(new URL(`/?workspace=${workspace}`, origin).href);
    await page.getByRole('heading', { name: /Good (morning|afternoon|evening)/ }).waitFor();
    for (const width of [1440, 1024]) {
      await page.setViewportSize({ width, height: 960 });
      const accountControl = page.getByRole('complementary').getByRole('button', { name: `Folio ${account.user.email}`, exact: true });
      assert.equal(await accountControl.evaluate(element => {
        const sidebar = element.closest('aside');
        if (!sidebar) return false;
        const control = element.getBoundingClientRect(), bounds = sidebar.getBoundingClientRect();
        return control.left >= bounds.left - 1 && control.right <= bounds.right + 1;
      }), true, `Long account identity overflowed the sidebar at ${width}px.`);
    }
    await page.setViewportSize({ width: 1440, height: 960 });
    await capture('sidebar-account-contained');
    const searchOpener = page.getByRole('button', { name: 'Search ⌘ K', exact: true });
    await searchOpener.focus(); await page.keyboard.press('Control+k');
    const search = page.getByRole('dialog', { name: 'Search workspace', exact: true });
    await search.getByRole('searchbox', { name: 'Search loaded records', exact: true }).fill('Cedar UI');
    const searchClose = search.getByRole('button', { name: 'Close dialog', exact: true });
    const lastResult = search.getByRole('button', { name: 'Cedar UI pilot deal · Cedar UI Demo', exact: true });
    await lastResult.focus(); await page.keyboard.press('Tab');
    assert.equal(await searchClose.evaluate(element => element === document.activeElement), true, 'Forward Tab escaped workspace search.');
    await searchClose.focus(); await page.keyboard.press('Shift+Tab');
    assert.equal(await lastResult.evaluate(element => element === document.activeElement), true, 'Reverse Tab escaped workspace search.');
    await capture('keyboard-search-contained');
    await page.keyboard.press('Escape'); await search.waitFor({ state: 'hidden' });
    assert.equal(await searchOpener.evaluate(element => element === document.activeElement), true);
    await page.goto(new URL(`/?workspace=${workspace}&recordType=deal&recordId=${deal.id}`, origin).href);
    await page.getByRole('heading', { name: 'Cedar UI pilot', exact: true }).waitFor();
    const pipeline = page.getByRole('combobox', { name: /^Pipeline stage/ });
    for (const stage of ['Discovery', 'Negotiation', 'Proposal']) {
      await pipeline.selectOption(stage);
      await page.getByText('Stage updated.', { exact: true }).first().waitFor();
      await page.getByRole('button', { name: 'Edit deal', exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Edit deal', exact: true }).count(), 1, 'Refresh duplicated record editor controls.');
      assert.equal(await page.getByRole('heading', { name: 'Custom fields', exact: true }).count(), 1, 'Refresh duplicated custom fields.');
    }
    await capture('record-after-refresh');
    await page.getByRole('button', { name: 'Edit deal', exact: true }).click();
    const editor = page.getByRole('dialog', { name: 'Edit deal', exact: true });
    assert.equal(await editor.getByRole('combobox', { name: /^Stage/ }).inputValue(), 'Proposal', 'Editor must start from the current pipeline stage.');
    const editorClose = editor.getByRole('button', { name: 'Close dialog', exact: true });
    const editorSave = editor.getByRole('button', { name: 'Save changes', exact: true });
    await editorSave.focus(); await page.keyboard.press('Tab');
    assert.equal(await editorClose.evaluate(element => element === document.activeElement), true, 'Forward Tab escaped the nested editor.');
    await editorClose.focus(); await page.keyboard.press('Shift+Tab');
    assert.equal(await editorSave.evaluate(element => element === document.activeElement), true, 'Reverse Tab escaped the nested editor.');
    await editor.getByLabel('Owner', { exact: true }).fill('Sam Revised');
    await editor.getByRole('button', { name: 'Save changes', exact: true }).click();
    await editor.getByRole('status').filter({ hasText: 'Saved.' }).waitFor();
    await page.keyboard.press('Escape');
    await editor.waitFor({ state: 'hidden' });
    assert.equal(await pipeline.inputValue(), 'Proposal', 'An owner edit reverted the saved stage.');
    await page.reload();
    await page.getByRole('heading', { name: 'Cedar UI pilot', exact: true }).waitFor();
    assert.equal(await pipeline.inputValue(), 'Proposal');
    await page.getByRole('button', { name: 'Edit deal', exact: true }).click();
    assert.equal(await editor.getByLabel('Owner', { exact: true }).inputValue(), 'Sam Revised');
    await editor.getByLabel('Owner', { exact: true }).fill('Cancelled draft');
    await page.keyboard.press('Escape');
    await editor.waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: 'Edit deal', exact: true }).click();
    assert.equal(await editor.getByLabel('Owner', { exact: true }).inputValue(), 'Sam Revised', 'Reopening resurrected a cancelled draft.');
    await editor.getByLabel('Owner', { exact: true }).fill('Reviewed draft');
    const current = (await request('get', '/api/crm')).deals.find((item: { id: number }) => item.id === deal.id);
    await request('patch', '/api/crm', { type: 'deal', id: deal.id, version: current.version, owner: 'Concurrent saved owner' });
    await editor.getByRole('button', { name: 'Save changes', exact: true }).click();
    await editor.getByRole('alert').waitFor();
    assert.equal(await editor.getByLabel('Owner', { exact: true }).inputValue(), 'Reviewed draft');
    await editor.getByRole('button', { name: 'Load latest version, keep draft', exact: true }).click();
    const review = editor.getByRole('region', { name: 'Latest saved values', exact: true });
    await review.getByText('Concurrent saved owner', { exact: true }).waitFor();
    assert.equal(await editor.getByLabel('Owner', { exact: true }).inputValue(), 'Reviewed draft');
    await capture('conflict-review');
    await editor.getByRole('button', { name: 'Save changes', exact: true }).click();
    await editor.getByRole('status').filter({ hasText: 'Saved.' }).waitFor();
    await page.keyboard.press('Escape');
    await editor.waitFor({ state: 'hidden' });
    const saved = (await request('get', '/api/crm')).deals.find((item: { id: number }) => item.id === deal.id);
    assert.equal(saved.owner, 'Reviewed draft'); assert.equal(saved.stage, 'Proposal');
    await page.getByRole('tab', { name: 'Notes', exact: true }).focus();
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.getByRole('tab', { name: 'Tasks', exact: true }).getAttribute('aria-selected'), 'true');
    await page.waitForFunction(() => document.activeElement?.getAttribute('role') === 'tab' && document.activeElement.textContent?.trim() === 'Tasks');
    await pipeline.focus();
    assert.equal(await pipeline.evaluate(element => element === document.activeElement), true);
    const keyboardSave = page.waitForResponse(response => response.url().endsWith('/api/crm') && response.request().method() === 'PATCH' && response.status() === 200);
    // Native select popups do not process arrow navigation in macOS headless
    // Chrome. Type-ahead plus Tab exercises the same real keyboard change on
    // macOS and Linux, without dispatching a synthetic change event.
    await page.keyboard.press('n'); await page.keyboard.press('Tab');
    await keyboardSave;
    const keyboardStage = STAGES[STAGES.indexOf('Proposal') + 1];
    assert.equal(await pipeline.inputValue(), keyboardStage);
    await page.reload();
    await page.getByRole('heading', { name: 'Cedar UI pilot', exact: true }).waitFor();
    assert.equal(await pipeline.inputValue(), keyboardStage, 'Keyboard stage change did not persist.');
    await page.setViewportSize({ width: 375, height: 812 });
    await page.getByRole('button', { name: 'Edit deal', exact: true }).focus();
    await page.keyboard.press('Enter');
    await editor.getByLabel('Name', { exact: true }).fill('');
    await editor.getByRole('button', { name: 'Save changes', exact: true }).focus(); await page.keyboard.press('Enter');
    assert.equal(await editor.getByLabel('Name', { exact: true }).evaluate(element => element === document.activeElement), true);
    await editor.getByLabel('Name', { exact: true }).fill('Cedar UI pilot corrected');
    await editor.getByRole('button', { name: 'Save changes', exact: true }).focus(); await page.keyboard.press('Enter');
    await editor.getByRole('status').filter({ hasText: 'Saved.' }).waitFor();
    await capture('phone-editor');
    assert.equal(await editor.evaluate(element => element.scrollWidth <= element.clientWidth + 1), true);
    await page.keyboard.press('Escape');
    await editor.waitFor({ state: 'hidden' });
    assert.equal(await page.getByRole('button', { name: 'Edit deal', exact: true }).evaluate(element => element === document.activeElement), true);
    await page.reload();
    await page.getByRole('heading', { name: 'Cedar UI pilot corrected', exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    await page.getByRole('tab', { name: 'Tasks', exact: true }).click();
    const taskTitle = 'Review dated UI proposal';
    await page.getByLabel('Task title', { exact: true }).fill(taskTitle);
    await page.getByLabel('Due date · optional', { exact: true }).fill('2026-11-24');
    await page.getByRole('combobox', { name: 'Assigned to', exact: true }).selectOption(user);
    await page.getByRole('button', { name: 'Add task', exact: true }).click();
    await page.getByRole('dialog', { name: 'Record details', exact: true }).getByRole('status').filter({ hasText: 'Task saved.' }).waitFor();
    const createdTask = (await request('get', '/api/crm')).tasks.find((item: { title: string }) => item.title === taskTitle);
    assert.equal(createdTask.dueDate, '2026-11-24', 'Creating a task discarded its entered deadline.');
    assert.equal(createdTask.assigneeId, user);
    await page.reload();
    await page.getByRole('heading', { name: 'Cedar UI pilot corrected', exact: true }).waitFor();
    await page.getByRole('tab', { name: 'Tasks', exact: true }).click();
    await page.getByRole('button', { name: `Edit task ${taskTitle}`, exact: true }).click();
    const taskEditor = page.getByRole('dialog', { name: 'Edit task', exact: true });
    assert.equal(await taskEditor.getByLabel('Due date', { exact: true }).inputValue(), '2026-11-24');
    await taskEditor.getByLabel('Due date', { exact: true }).fill('2026-11-25');
    await taskEditor.getByRole('checkbox', { name: 'Completed', exact: true }).check();
    await taskEditor.getByRole('button', { name: 'Save task', exact: true }).click();
    await taskEditor.getByRole('status').filter({ hasText: 'Saved.' }).waitFor();
    await capture('phone-dated-task');
    await page.reload();
    await page.getByRole('heading', { name: 'Cedar UI pilot corrected', exact: true }).waitFor();
    const savedTask = (await request('get', '/api/crm')).tasks.find((item: { id: number }) => item.id === createdTask.id);
    assert.equal(savedTask.dueDate, '2026-11-25', 'Editing/completing a task discarded its changed deadline.');
    assert.equal(savedTask.done, true);
    assert.deepEqual(errors, []);
    if (evidence) writeFileSync(join(evidence, 'record-editor-results.json'), JSON.stringify({ outcome: 'passed', checks: ['long account identity contained at 1440px and 1024px','workspace search forward/reverse Tab containment and Escape return','nested editor forward/reverse Tab containment','unique controls after repeated refresh','current-stage edit without rollback','saved/cancelled draft reopening','stale conflict preserves draft and shows saved values','explicit reviewed retry','keyboard tabs and persisted stage','phone validation correction and focus return','phone task deadline creation/edit/completion/reload'], viewport: { width: 375, height: 812 }, errors }, null, 2));
    console.log('Rendered record editor passed: sidebar containment, search/nested modal Tab loops, refresh uniqueness, current values, cancelled drafts, stale conflict review, keyboard stage/tabs, 375px validation, dated task creation/edit/completion and persistence.');
  } catch (error) {
    await capture('failure');
    throw error;
  } finally {
    await browser.close();
    if (workspace && user) {
      const client = new Client({ connectionString: database }); await client.connect();
      try {
        for (const table of ['record_changes','crm_notifications','tasks','notes','deal_stage_events','deals','people','companies','crm_workspace_seeds','crm_memberships','crm_workspaces']) await client.query(`DELETE FROM ${table} WHERE ${table === 'crm_workspaces' ? 'id' : 'workspace_id'}=$1`, [workspace]);
        await client.query('DELETE FROM crm_sessions WHERE user_id=$1', [user]); await client.query('DELETE FROM crm_users WHERE id=$1', [user]);
      } finally { await client.end(); }
    }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
