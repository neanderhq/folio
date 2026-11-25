import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { GET as authGet, POST as authPost } from '../app/api/auth/route';
import { GET as crmGet, POST as crmPost, PATCH as crmPatch } from '../app/api/crm/route';
import { GET as ruleGet, POST as rulePost } from '../app/api/followups/route';
import { GET as inboxGet } from '../app/api/productivity/route';
import { dueDate } from '../server/followups';
const db = new Client({ connectionString: process.env.DATABASE_URL });
if (!process.env.DATABASE_URL) throw Error('Explicit disposable DATABASE_URL required');
type Account = { cookie: string; workspace: string; user: string; email: string };
type Handler = (r: Request) => Promise<Response>;
const origin = 'http://localhost';
async function call(handler: Handler, actor?: Account, body?: object, method = body ? 'POST' : 'GET', workspace?: string) {
 const r = await handler(new Request(origin+'/api/test', { method, headers: { ...(body ? { origin, 'content-type': 'application/json' } : {}), ...(actor ? { cookie: actor.cookie, 'x-workspace-id': workspace || actor.workspace } : {}) }, body: body ? JSON.stringify(body) : undefined }));return { status: r.status, data: await r.json() };
}
async function main() {
 await db.connect(); const accounts: Account[] = []; const tag = randomUUID();const trigger='followup_fault_'+Date.now();
 try {
  const register = async (label: string) => { const email=`${label}-${tag}@example.test`;const r=await call(authPost,undefined,{action:'register',email,password:'Fictional safe password 123!',workspaceName:`CFV3 ${label}`});assert.equal(r.status,201);
   const login=await authPost(new Request(origin+'/api/auth',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({action:'login',email,password:'Fictional safe password 123!'})}));assert.equal(login.status,200);
   const token=login.headers.get('set-cookie')!.split(';')[0];const me=await call(authGet,{cookie:token,workspace:'',user:'',email});const a={cookie:token,workspace:me.data.workspaces[0].id,user:me.data.user.id,email};accounts.push(a);return a; };
  const admin=await register('admin'),member=await register('member'),viewer=await register('viewer'),outsider=await register('outsider');
  for(const [a,role] of [[member,'Member'],[viewer,'Viewer']] as const)assert.equal((await call(authPost,admin,{action:'setMember',email:a.email,role})).status,200);
  const inWorkspace=(a:Account)=>({...a,workspace:admin.workspace});const m=inWorkspace(member),v=inWorkspace(viewer);
  assert.equal((await call(ruleGet)).status,401);assert.equal((await call(ruleGet,outsider,undefined,'GET',admin.workspace)).status,404);
  const company=(await call(crmPost,admin,{type:'company',name:'CFV3 Follow-up Company'})).data;
  const person=(await call(crmPost,admin,{type:'person',name:'CFV3 Rep',email:'rep.'+tag+'@example.test',companyId:company.id})).data;
  let deal=(await call(crmPost,admin,{type:'deal',name:'CFV3 Proposal',companyId:company.id,personId:person.id,stage:'Lead',owner:'Untrusted free text owner',valueCents:10000,currency:'USD'})).data;
  const input={name:'Proposal next step',stage:'Proposal',title:'Review fictional proposal',assigneeId:member.user,offsetDays:2,timeZone:'Asia/Kolkata',enabled:true};
  assert.equal((await call(rulePost,m,input)).status,403);assert.equal((await call(rulePost,v,input)).status,403);
  assert.equal((await call(rulePost,admin,{...input,timeZone:'Invalid/Zone'})).status,400);
  assert.equal((await call(rulePost,admin,{...input,assigneeId:outsider.user})).status,409);
  let created=await call(rulePost,admin,input);assert.equal(created.status,200);let rule=created.data.rule;
  let moved=await call(crmPatch,m,{type:'deal',id:deal.id,version:deal.version,stage:'Proposal'},'PATCH');assert.equal(moved.status,200);deal=moved.data;
  let snapshot=(await call(crmGet,admin)).data;let generated=snapshot.tasks.filter((t:any)=>t.targetId===deal.id);assert.equal(generated.length,1);assert.equal(generated[0].assigneeId,member.user);assert.equal(generated[0].dueDate,dueDate(new Date(),'Asia/Kolkata',2));
  // Actor/self assignment suppresses a notice; changing as Admin for a second entry creates one recipient notice.
  assert.equal((await call(inboxGet,m)).data.notifications.filter((n:any)=>n.taskId===generated[0].id).length,0);
  assert.equal((await call(crmPatch,m,{type:'deal',id:deal.id,version:1,stage:'Proposal'},'PATCH')).status,409);
  assert.equal((await call(crmPatch,m,{type:'deal',id:deal.id,version:deal.version,stage:'Proposal'},'PATCH')).status,200);
  assert.equal((await call(ruleGet,admin)).data.history.length,1);
  deal=(await call(crmPatch,admin,{type:'deal',id:deal.id,version:deal.version,stage:'Discovery'},'PATCH')).data;
  deal=(await call(crmPatch,admin,{type:'deal',id:deal.id,version:deal.version,stage:'Proposal'},'PATCH')).data;
  generated=(await call(crmGet,admin)).data.tasks.filter((t:any)=>t.targetId===deal.id);assert.equal(generated.length,2);
  assert.equal((await call(inboxGet,m)).data.notifications.filter((n:any)=>generated.some((t:any)=>t.id===n.taskId)).length,1);
  assert.equal((await call(inboxGet,v)).data.notifications.length,0);
  // A downgraded fixed assignee blocks the entire transition, with history/version intact.
  deal=(await call(crmPatch,admin,{type:'deal',id:deal.id,version:deal.version,stage:'Discovery'},'PATCH')).data;
  await call(authPost,admin,{action:'setMember',email:member.email,role:'Viewer'});
  const beforeEvents=Number((await db.query('select count(*) from deal_stage_events where deal_id=$1',[deal.id])).rows[0].count);
  assert.equal((await call(crmPatch,admin,{type:'deal',id:deal.id,version:deal.version,stage:'Proposal'},'PATCH')).status,409);
  assert.equal((await call(crmGet,admin)).data.deals.find((d:any)=>d.id===deal.id).stage,'Discovery');
  assert.equal(Number((await db.query('select count(*) from deal_stage_events where deal_id=$1',[deal.id])).rows[0].count),beforeEvents);
  await call(authPost,admin,{action:'setMember',email:member.email,role:'Member'});
  created=await call(rulePost,admin,{...rule,title:'Force fault '+tag});assert.equal(created.status,200);rule=created.data.rule;
  assert.equal((await call(rulePost,admin,{...rule,version:1})).status,409);
  // Actual PostgreSQL task failure proves rollback, rather than merely mocking an expected error.
  await db.query(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.title LIKE 'Force fault %' THEN RAISE EXCEPTION 'fictional task insert failure'; END IF; RETURN NEW; END $$`);
  await db.query(`CREATE TRIGGER ${trigger} BEFORE INSERT ON tasks FOR EACH ROW EXECUTE FUNCTION ${trigger}()`);
  assert.equal((await call(crmPatch,admin,{type:'deal',id:deal.id,version:deal.version,stage:'Proposal'},'PATCH')).status,503);
  assert.equal((await call(ruleGet,admin)).data.history.length,2);assert.equal((await call(crmGet,admin)).data.deals.find((d:any)=>d.id===deal.id).version,deal.version);
  await db.query(`DROP TRIGGER ${trigger} ON tasks`);await db.query(`DROP FUNCTION ${trigger}()`);
  rule=(await call(rulePost,admin,{...rule,title:'Recovered follow-up'})).data.rule;
  deal=(await call(crmPatch,admin,{type:'deal',id:deal.id,version:deal.version,stage:'Proposal'},'PATCH')).data;
  assert.equal((await call(ruleGet,admin)).data.history.length,3);
  await call(rulePost,admin,{...rule,enabled:false});
  deal=(await call(crmPatch,admin,{type:'deal',id:deal.id,version:deal.version,stage:'Discovery'},'PATCH')).data;
  deal=(await call(crmPatch,admin,{type:'deal',id:deal.id,version:deal.version,stage:'Proposal'},'PATCH')).data;
  assert.equal((await call(ruleGet,admin)).data.history.length,3);
  assert.equal(dueDate(new Date('2026-03-08T04:30:00Z'),'America/New_York',1),'2026-03-08');assert.equal(dueDate(new Date('2026-03-08T04:30:00Z'),'Asia/Kolkata',1),'2026-03-09');
  console.log('Follow-ups passed: persisted rule/task/history, roles/isolation, fixed identity, timezone/DST, no-op/replay/re-entry, notices, stale rule, downgraded assignee, actual task-failure atomic rollback/recovery and disable.');
 } finally {
  await db.query(`DROP TRIGGER IF EXISTS ${trigger} ON tasks`);await db.query(`DROP FUNCTION IF EXISTS ${trigger}()`);
  for(const a of accounts){
   await db.query('delete from crm_followup_executions where workspace_id=$1',[a.workspace]);await db.query('delete from crm_followup_rules where workspace_id=$1',[a.workspace]);
   for(const table of ['crm_notifications','crm_record_lifecycle_events','record_changes','deal_stage_events','notes','tasks','crm_workspace_seeds','crm_lists','crm_custom_fields'])await db.query(`delete from ${table} where workspace_id=$1`,[a.workspace]);
   await db.query('delete from deals where workspace_id=$1',[a.workspace]);await db.query('delete from people where workspace_id=$1',[a.workspace]);await db.query('delete from companies where workspace_id=$1',[a.workspace]);await db.query('delete from crm_memberships where workspace_id=$1',[a.workspace]);await db.query('delete from crm_workspaces where id=$1',[a.workspace]);
  }
  for(const a of accounts){await db.query('delete from crm_sessions where user_id=$1',[a.user]);await db.query('delete from crm_users where id=$1',[a.user]);}
  await db.end();
 }
}
main().then(()=>process.exit(0),e=>{console.error(e);process.exit(1)});
